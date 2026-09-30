#!/usr/bin/env python3
"""Render a recipe to a JPEG without opening the studio: for an agent (or a
script) to look at an edit it made.

    python -m framewright render 2026-01-01_camera/FRAME0001
    python -m framewright render 2026-01-01_camera/FRAME0001 --recipe proposal
    python -m framewright render 2026-01-01_camera/FRAME0001 --recipe edit --recipe proposal
    python -m framewright render 2026-01-01_camera/FRAME0001 --recipe try.json -o /tmp/try.jpg
    python -m framewright render 2026-01-01_camera/FRAME0001 --full --max 0

It renders through the studio page's own code, in headless Chrome: the same
raw decoder, camera profile and WebGL shader as the Develop tab and its
export, so what the agent looks at is what the person sees. There is one
renderer, not a second one to drift from it.

--recipe says what to render, and may be given more than once:
    edit       the frame's saved recipe (the default; neutral when unedited)
    proposal   the suggested edit waiting beside it
    none       the frame as it comes, no adjustments
    FILE.json  any recipe, or a proposal file ({"params": ...}); - reads stdin
A recipe is checked the way the studio checks a save (server.py clean_edit),
so one the studio would refuse fails here too, with the same message.

Renders go to <library>/.review/<shoot>_<key>_<recipe>.jpg, the scratch folder
the studio's review exports use, or to -o (a file for one render, a folder
for several). By default they come from the preview-size source (the camera
JPEG's preview, or a half-size raw decode) and are scaled to 1600px on the
long edge: plenty to judge an edit, and quick. --full renders from the
full-size original, as the studio's export does.

A raw on a drive that is not plugged in is rendered on the camera JPEG's
cached preview instead, and the output line says so.

--check FILE validates a recipe or proposal offline with strict field and range
checks. SHOOT/KEY --propose FILE --note TEXT writes a cleaned proposal and leaves
the accepted edit untouched. Neither command needs a browser.

Rendering needs Chrome, Chromium, Edge or Brave (CHROME selects the executable).
Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .import_photos import ImportError_, default_library, frame_key  # noqa: E402
from .settings import resolve_library  # noqa: E402
from .server import (  # noqa: E402
    EDIT_RANGES,
    JPEG_EXTS,
    Handler,
    clean_edit,
    edit_path,
    proposal_path,
    raw_sources,
)
from .recipe_schema import validate_recipe

CHROMES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
    "microsoft-edge", "microsoft-edge-stable", "msedge", "brave", "brave-browser",
)
REVIEW_DIR = ".review"


def stop_browser(chrome) -> None:
    """Stop only this invocation's process tree, then reap its launcher."""
    if os.name == "nt":
        # Terminating chrome.exe alone leaves its renderer/utility children.
        # /T scopes cleanup to this exact PID's descendants, never browser names.
        try:
            subprocess.run(["taskkill", "/PID", str(chrome.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=False, timeout=10)
        finally:
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
                chrome.wait(timeout=5)
        return
    # Popen starts a dedicated session, so pid is our private process-group id.
    try:
        os.killpg(chrome.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        chrome.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # The launcher can exit before children finish. Always stop remaining
        # group members, even when wait() already returned successfully.
        try:
            os.killpg(chrome.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        chrome.wait(timeout=5)


def browser_session(browser: str, url: str, timeout: float) -> bool:
    profile = tempfile.TemporaryDirectory(prefix="studio-render-", ignore_cleanup_errors=True)
    chrome = None
    try:
        chrome = subprocess.Popen(
            [browser, "--headless=new", f"--user-data-dir={profile.name}", "--no-first-run",
             "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
             "--enable-unsafe-swiftshader", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            **({"start_new_session": True} if os.name != "nt" else {}))
        return RenderHandler.done.wait(timeout)
    finally:
        try:
            if chrome is not None:
                stop_browser(chrome)
        finally:
            # Antivirus/scanners and final child shutdown can hold profile files
            # briefly. A best-effort scratch-directory cleanup must not change a
            # successful render into a misleading browser-launch failure.
            try:
                profile.cleanup()
            except OSError as exc:
                print(f"warning: could not remove temporary browser profile: {exc}", file=sys.stderr)


def find_chrome() -> str:
    windows = [str(Path(base) / suffix) for base in
               (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA"))
               if base for suffix in ("Google/Chrome/Application/chrome.exe",
                                      "Microsoft/Edge/Application/msedge.exe",
                                      "BraveSoftware/Brave-Browser/Application/brave.exe")]
    for c in ([os.environ["CHROME"]] if os.environ.get("CHROME") else []) + list(CHROMES) + windows:
        path = c if Path(c).is_file() else shutil.which(c)
        if path:
            return path
    raise ValueError("no Chrome, Chromium, Edge or Brave found; install one or set CHROME to its executable path")


def recipe_file(filename: str) -> dict:
    text = sys.stdin.read() if filename == "-" else Path(filename).read_text(encoding="utf-8")
    body = json.loads(text)
    if isinstance(body, dict) and "params" in body:
        if set(body) - {"params", "note", "created"}:
            raise ValueError("proposal has unknown fields")
        for field in ("note", "created"):
            if field in body and not isinstance(body[field], str):
                raise ValueError(f"proposal {field} must be text")
        body = body["params"]
    validate_recipe(body)
    return body


def frame_location(root: Path, ref: str) -> tuple[Path, str]:
    shoot, _, key = ref.rpartition("/")
    if not shoot or not key or key in (".", "..") or "\\" in ref:
        raise ValueError(f"{ref}: expected SHOOT/KEY")
    d = (root / shoot).resolve()
    if not d.is_relative_to(root.resolve()) or d == root.resolve() or not (d / "raw").is_dir():
        raise ValueError(f"{ref}: no such shoot inside the library")
    if not (d / "raw").resolve().is_relative_to(root.resolve()):
        raise ValueError(f"{ref}: shoot raw folder points outside the library")
    if not any(frame_key(f) == key for f in (d / "raw").iterdir()) and key not in raw_sources(d):
        raise ValueError(f"{ref}: no such frame")
    return d, key


def write_proposal(root: Path, frame: str, filename: str, note: str = "", replace=False) -> Path:
    d, key = frame_location(root, frame)
    params = validate_recipe(recipe_file(filename))
    proposal = {"params": params, "note": note[:500], "created": datetime.now().isoformat(timespec="seconds")}
    path = proposal_path(d, key)
    if path.is_symlink():
        raise ValueError("refusing to write a proposal through a symlink")
    text = json.dumps(proposal, indent=2, allow_nan=False) + "\n"
    if replace:
        from .server import atomic_write
        atomic_write(path, text)
    else:
        try:
            with path.open("x", encoding="utf-8") as stream:
                stream.write(text)
        except FileExistsError:
            raise ValueError("proposal already exists; inspect it first, then use --replace-proposal if requested") from None
    return path


def source_of(has_raw: bool, has_jpeg: bool, params: dict | None) -> str:
    """Which file the frame develops from: sourceOf() in web/source.js."""
    if not has_raw:
        return "jpeg"
    if not has_jpeg:
        return "raw"
    if params:
        return "raw" if params.get("source") == "raw" else "jpeg"
    return "raw"


def read_recipe(which: str, shoot_dir: Path, key: str) -> tuple[dict | None, str]:
    """(recipe or None for none at all, a name for the output file)."""
    if which == "edit":
        path = edit_path(shoot_dir, key)
        return (json.loads(path.read_text()) if path.is_file() else None), "edit"
    if which == "proposal":
        path = proposal_path(shoot_dir, key)
        if not path.is_file():
            raise ValueError(f"{shoot_dir.name}/{key} has no proposal")
        return json.loads(path.read_text())["params"], "proposal"
    if which == "none":
        return None, "none"
    text = sys.stdin.read() if which == "-" else Path(which).read_text()
    body = json.loads(text)
    # A proposal file holds its recipe under "params".
    if isinstance(body, dict) and isinstance(body.get("params"), dict):
        body = body["params"]
    return body, "stdin" if which == "-" else Path(which).stem.removesuffix(".edit").removesuffix(".proposal")


class RenderHandler(Handler):
    """The studio's server, plus the job list and a place to put results."""

    jobs: list[dict] = []
    results: dict[str, dict] = {}
    done = threading.Event()

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/headless/jobs":
            self.send_json([{k: v for k, v in j.items() if k != "out"} for j in self.jobs])
            return
        super().do_GET()

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path not in ("/headless/result", "/headless/error"):
            super().do_POST()
            return
        query = parse_qs(url.query)
        job_id = query.get("id", [""])[0]
        body = self.read_body()
        if url.path == "/headless/error":
            self.results[job_id] = {"error": body.decode(errors="replace")}
        else:
            job = next((j for j in self.jobs if j["id"] == job_id), None)
            if not job or body[:3] != b"\xff\xd8\xff":
                self.send_json({"error": "bad result"}, HTTPStatus.BAD_REQUEST)
                return
            job["out"].parent.mkdir(parents=True, exist_ok=True)
            job["out"].write_bytes(body)
            self.results[job_id] = {"note": query.get("note", [""])[0]}
        self.send_json({"ok": True})
        if len(self.results) == len(self.jobs):
            self.done.set()


def plan(root: Path, frames: list[str], recipes: list[str], out: Path | None,
         full: bool, max_px: int) -> list[dict]:
    jobs = []
    for ref in frames:
        d, key = frame_location(root, ref)
        shoot = d.relative_to(root.resolve()).as_posix()
        files = [f for f in (d / "raw").iterdir() if frame_key(f) == key]
        raws = raw_sources(d)
        if not files and key not in raws:
            raise ValueError(f"{ref}: no such frame")
        has_raw = key in raws
        has_jpeg = any(f.suffix.lower() in JPEG_EXTS for f in files)
        for which in recipes:
            params, name = read_recipe(which, d, key)
            recipe = clean_edit(params) if params is not None else None
            if recipe is not None and isinstance(params, dict):
                dropped = sorted(set(params) - set(recipe) - {"version"})
                # Fields at their neutral value are left out too; only name the unknown ones.
                unknown = [k for k in dropped if k not in _KNOWN]
                if unknown:
                    print(f"warning: {ref} {name}: ignored unknown fields {', '.join(unknown)}", file=sys.stderr)
            source = source_of(has_raw, has_jpeg, recipe)
            if recipe and recipe.get("source") == "raw" and not has_raw:
                raise ValueError(f"{ref}: recipe asks for the raw, and this frame has none")
            jobs.append({
                "id": str(len(jobs)), "shoot": shoot, "key": key, "source": source,
                "params": recipe or {}, "full": full, "max": max_px,
                "name": name, "out": root / REVIEW_DIR / f"{shoot}_{key}_{name}.jpg",
            })
    if out is not None:
        if len(jobs) == 1 and out.suffix.lower() in (".jpg", ".jpeg"):
            jobs[0]["out"] = out
        else:
            for j in jobs:
                j["out"] = out / j["out"].name
    return jobs


# Every field clean_edit() knows, so a dropped one can be told apart from a typo.
_KNOWN = set(EDIT_RANGES) | {"orient", "flipH", "flipV", "masks", "lens", "groundArea", "curve",
                             "look", "lookAmount", "source", "crop"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("frames", nargs="*", metavar="SHOOT/KEY", help="frames to render or propose")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", metavar="FILE", help="strictly validate a recipe or proposal offline; - reads stdin")
    mode.add_argument("--propose", metavar="FILE", help="write a cleaned proposal for one frame without rendering")
    parser.add_argument("--note", default="", help="explanation stored with --propose (up to 500 characters)")
    parser.add_argument("--replace-proposal", action="store_true", help="explicitly replace an existing proposal")
    parser.add_argument("--recipe", action="append", metavar="WHICH",
                        help="edit (default), proposal, none, a recipe .json file, or - for stdin")
    parser.add_argument("-o", "--out", type=Path, help="output file (one render) or folder")
    parser.add_argument("--full", action="store_true", help="render from the full-size original")
    parser.add_argument("--max", type=int, default=1600, metavar="PX",
                        help="long edge of the output in px, 0 for as rendered (default 1600)")
    parser.add_argument("--library", help="directory holding shoot folders")
    parser.add_argument("--timeout", type=float, default=180, help="seconds to wait for all renders")
    args = parser.parse_args(argv)
    if args.check and (args.frames or args.recipe or args.out or args.note or args.replace_proposal):
        parser.error("--check takes only a recipe file; no frame, recipe, output or proposal options")
    if args.propose and (len(args.frames) != 1 or args.recipe or args.out):
        parser.error("--propose requires exactly one SHOOT/KEY and cannot be combined with --recipe or --out")
    if not args.propose and (args.note or args.replace_proposal):
        parser.error("--note and --replace-proposal require --propose")
    if not args.check and not args.frames:
        parser.error("give at least one SHOOT/KEY, or use --check FILE")
    if args.max < 0 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--max must be nonnegative and --timeout must be positive")

    try:
        if args.check:
            recipe_file(args.check)
            print(f"{args.check}: valid recipe")
            return 0
        root = resolve_library(args.library) or default_library()
        if args.propose:
            print(write_proposal(root, args.frames[0], args.propose, args.note, args.replace_proposal))
            return 0
        jobs = plan(root, args.frames, args.recipe or ["edit"], args.out, args.full, args.max)
        browser = find_chrome()
    except (ImportError_, ValueError, KeyError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    RenderHandler.root = root
    RenderHandler.jobs = jobs
    RenderHandler.results = {}
    RenderHandler.done.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), RenderHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/headless.html"

    try:
        finished = browser_session(browser, url, args.timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"error: browser session failed for {browser}: {exc}", file=sys.stderr)
        return 1
    finally:
        server.shutdown()
        server.server_close()

    failed = 0
    for j in jobs:
        ref = f"{j['shoot']}/{j['key']} {j['name']}"
        res = RenderHandler.results.get(j["id"])
        if res is None:
            failed += 1
            print(f"{ref}: timed out after {args.timeout:g}s", file=sys.stderr)
        elif "error" in res:
            failed += 1
            print(f"{ref}: {res['error']}", file=sys.stderr)
        else:
            print(f"{j['out']}" + (f"  ({res['note']})" if res["note"] else ""))
    if not finished and not failed:
        failed = 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
