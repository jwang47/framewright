"""Video cuts: an edit of clips from the library, kept as JSON, rendered with ffmpeg.

A cut lives at <library>/cuts/<slug>.cut.json:

    {"version": 1, "name": "Lansdown Ct reel", "log709": true,
     "clips": [{"shoot": "2026-10-12_sony-ilme-fx30", "key": "C0091",
                "in": 1.25, "out": 5.0}, ...]}

Phase one is a single video track whose audio follows its pictures: each clip
plays from `in` to `out` seconds, one after another. Like photo recipes, it's
plain JSON so an agent can propose a cut by writing one. Export renders it
with ffmpeg into <library>/export/cuts/<slug>.mp4, converting S-Log3 clips to
display gamma with clips.py's viewing curve when `log709` is on.

Stdlib only; export needs ffmpeg.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from . import clips

CUTS_DIR = "cuts"
SUFFIX = ".cut.json"
MAX_CLIPS = 500
SAFE = re.compile(r"^[A-Za-z0-9_.-]+$")
SIZES = {"source": None, "2160": 2160, "1080": 1080, "720": 720}
CODECS = ("h264", "hevc")


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def cut_path(root: Path, slug: str) -> Path:
    if not slug or not SAFE.match(slug) or slug.startswith("."):
        raise ValueError("bad cut name")
    return root / CUTS_DIR / f"{slug}{SUFFIX}"


def clean_cut(cut: object) -> dict:
    """A cut with only what the renderer understands, or ValueError."""
    if not isinstance(cut, dict):
        raise ValueError("a cut is an object")
    name = cut.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or not slugify(name):
        raise ValueError("a cut needs a name of up to 80 characters")
    items = cut.get("clips", [])
    if not isinstance(items, list) or len(items) > MAX_CLIPS:
        raise ValueError(f"clips must be a list of at most {MAX_CLIPS}")
    out = []
    for c in items:
        if not isinstance(c, dict):
            raise ValueError("each clip is an object")
        shoot, key = c.get("shoot"), c.get("key")
        if not all(isinstance(v, str) and SAFE.match(v) and not v.startswith(".") for v in (shoot, key)):
            raise ValueError("each clip needs a shoot and key")
        start, end = c.get("in", 0), c.get("out")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)):
            raise ValueError(f"{key}: in and out are seconds")
        if start < 0 or end <= start or end > 86400:
            raise ValueError(f"{key}: out must come after in")
        out.append({"shoot": shoot, "key": key, "in": round(float(start), 3), "out": round(float(end), 3)})
    return {"version": 1, "name": name.strip(), "log709": bool(cut.get("log709", True)), "clips": out}


def read_cut(root: Path, slug: str) -> dict | None:
    path = cut_path(root, slug)
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def write_cut(root: Path, cut: dict, old_slug: str | None = None) -> str:
    """Save a cleaned cut under its name's slug; renaming moves the file."""
    slug = slugify(cut["name"])
    path = cut_path(root, slug)
    if old_slug and old_slug != slug and path.exists():
        raise ValueError(f"there is already a cut called {cut['name']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps({**cut, "updated": datetime.now().isoformat(timespec="seconds")}, indent=2) + "\n")
    tmp.replace(path)
    if old_slug and old_slug != slug:
        cut_path(root, old_slug).unlink(missing_ok=True)
    return slug


def list_cuts(root: Path) -> list[dict]:
    folder = root / CUTS_DIR
    out = []
    for path in sorted(folder.glob(f"*{SUFFIX}")) if folder.is_dir() else []:
        try:
            cut = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        items = cut.get("clips", [])
        out.append({"slug": path.name[:-len(SUFFIX)], "name": cut.get("name", path.stem),
                    "clips": len(items), "duration": round(sum(c["out"] - c["in"] for c in items), 2),
                    "updated": cut.get("updated", "")})
    return sorted(out, key=lambda c: c["updated"], reverse=True)


# --- export ---------------------------------------------------------------------


def encoder(codec: str) -> list[str]:
    """Hardware encoding on a Mac, else x264/x265."""
    try:
        listing = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        listing = ""
    if codec == "hevc":
        if "hevc_videotoolbox" in listing:
            return ["-c:v", "hevc_videotoolbox", "-b:v", "40M", "-tag:v", "hvc1"]
        return ["-c:v", "libx265", "-crf", "20", "-preset", "medium", "-tag:v", "hvc1"]
    if "h264_videotoolbox" in listing:
        return ["-c:v", "h264_videotoolbox", "-b:v", "24M"]
    return ["-c:v", "libx264", "-crf", "18", "-preset", "medium"]


def has_audio(path: Path) -> bool:
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                                 "stream=index", "-of", "csv=p=0", str(path)],
                                capture_output=True, text=True, timeout=30)
        return bool(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


def render_command(root: Path, cut: dict, size: str, codec: str, out: Path) -> tuple[list[str], float]:
    """The ffmpeg command for a cut, and its running time in seconds."""
    if not cut["clips"]:
        raise ValueError("the cut is empty")
    if size not in SIZES or codec not in CODECS:
        raise ValueError("unknown size or codec")
    height = SIZES[size]
    sources, filters, joins = [], [], []
    first_meta = None
    for i, c in enumerate(cut["clips"]):
        d = root / c["shoot"]
        path = clips.clip_files(d).get(c["key"]) if d.is_dir() else None
        if path is None:
            raise ValueError(f"{c['shoot']}/{c['key']} is not in the library")
        if not path.is_file():
            raise ValueError(f"{path.name} is on a drive that is not plugged in")
        meta = clips.clip_meta(d, c["key"], path)
        first_meta = first_meta or meta
        length = c["out"] - c["in"]
        sources += ["-ss", f"{c['in']:.3f}", "-t", f"{length:.3f}", "-i", str(path)]
        chain = []
        if cut.get("log709") and clips.is_log(meta):
            folder = d / ".preview" / clips.CLIP_DIR
            folder.mkdir(parents=True, exist_ok=True)
            curve = str(clips._curve_file(folder)).replace("\\", "/").replace(":", "\\:")
            chain += ["format=rgb24", f"lut1d=file='{curve}'", "eq=saturation=1.25"]
        joins.append((i, has_audio(path), length))
        filters.append((i, chain))
    fps = first_meta.get("fps") or 30
    scale = f"scale=-2:{height}" if height else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    graph = []
    for i, chain in filters:
        graph.append(f"[{i}:v]" + ",".join([scale, "setsar=1", f"fps={fps}", *chain, "format=yuv420p"]) + f"[v{i}]")
    silent = len(cut["clips"])
    extra = []
    for i, audio, length in joins:
        if audio:
            graph.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
        else:
            extra += ["-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
            graph.append(f"[{silent}:a]anull[a{i}]")
            silent += 1
    graph.append("".join(f"[v{i}][a{i}]" for i in range(len(cut["clips"]))) + f"concat=n={len(cut['clips'])}:v=1:a=1[v][a]")
    total = sum(length for _, _, length in joins)
    cmd = ["ffmpeg", "-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-loglevel", "error",
           *sources, *extra, "-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]",
           *encoder(codec), "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)]
    return cmd, total


def export(root: Path, slug: str, size: str, codec: str, state: dict) -> None:
    """Render a cut, updating state ({progress, error, path}) as it goes."""
    try:
        if not shutil.which("ffmpeg"):
            raise ValueError("exporting needs ffmpeg: brew install ffmpeg")
        cut = read_cut(root, slug)
        if cut is None:
            raise ValueError("no such cut")
        out = root / "export" / "cuts" / f"{slug}.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_name(out.stem + ".part.mp4")
        cmd, total = render_command(root, clean_cut(cut), size, codec, part)
        state["total"] = total
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        state["pid"] = proc.pid
        for line in proc.stdout:
            if line.startswith("out_time_us=") and total:
                try:
                    state["progress"] = min(1.0, int(line.split("=", 1)[1]) / 1e6 / total)
                except ValueError:
                    pass
        err = proc.stderr.read()
        if proc.wait() != 0:
            part.unlink(missing_ok=True)
            raise ValueError(err.strip().splitlines()[-1] if err.strip() else "ffmpeg failed")
        part.replace(out)
        state.update(progress=1.0, path=str(out), name=out.name)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        state["error"] = str(exc)
    finally:
        state["running"] = False


def reveal(path: Path) -> None:
    if not path.is_file():
        raise ValueError("export the cut first")
    cmd = ["open", "-R", str(path)] if sys.platform == "darwin" else (
        ["explorer.exe", "/select,", str(path)] if sys.platform == "win32" else ["xdg-open", str(path.parent)])
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
