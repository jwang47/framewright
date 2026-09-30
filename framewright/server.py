#!/usr/bin/env python3
"""A small Lightroom in the browser: cull a shoot, then develop the keepers.

    python -m framewright                  # opens http://localhost:8765
    python -m framewright --port 9000

Two tabs. Library scrolls through a shoot and marks picks; Develop edits one
frame at a time with live sliders, crop and straighten, and exports a JPEG.

Everything that is actual work lands on disk as text, next to the frames:

    shoots/<shoot>/picks.txt              one picked frame name per line
    shoots/<shoot>/raw/<frame>.edit.json  the develop recipe for that frame
    shoots/<shoot>/export/<frame>.jpg     the rendered export (not tracked)
    shoots/<shoot>/raw/<frame>.proposal.json
                                          a suggested edit, shown beside yours
                                          until accepted or discarded
    shoots/posts/<collection>/NN.jpg      exported post slides (not tracked)
    shoots/collections.json               collections: named, ordered sets of
                                          frames from any days, optionally
                                          including whole days by date range
    shoots/looks.json                     looks: named colour, tone and grain
                                          settings to apply to any frame
    shoots/luts/<name>.cube               3D LUTs (sRGB in and out), each one
                                          offered as a look of its own. Not
                                          tracked: user-supplied content

Import copies new frames off a plugged-in camera card into the library,
using import_photos.py's plan and verified copy; the header shows an Import
button whenever a card is in. With the external drive plugged in, the images
go onto it rather than into shoots/ (store.py); a shoot's store.json lists
them, so with the drive out the shoot still lists and shows its previews.

A recipe develops from the raw or from the camera JPEG, as its `source`
says. Raws are decoded in the page with LibRaw compiled to WebAssembly
(web/raw.js), taken through a camera profile fitted to that camera's own
JPEGs (web/camera-profiles.json, made by web/profile-fit.js) and, for
DNGs, the lens warp the file carries (web/dng.js). Edits from before raw
support have no `source` and stay on the JPEG, rendering as they always did.
darktable's .xmp files are left alone: their parameters are binary structs
only darktable can render. The page renders with WebGL, so the preview and
the full-size export go through the same shader.

Hot reload: Framewright runs the server as a child process and restarts it when
any Python file here changes, and the page keeps an event stream open, so it
reloads itself when the page code changes or the server restarts (a CSS-only
change is swapped in without a reload). --no-reload runs a single server.

Live edits: each recipe has a revision, a hash of its file. A save names the
revision it was based on and is refused if the file has changed since, so two
windows (or a window and someone editing the file) never silently overwrite
each other. The event stream also watches the open frame's recipe and its
proposal and tells the page when either changes, and the page loads the new
version in place, so a suggested edit pops up without a reload. Posts work
the same way: a collection's photos and layout have a revision too, and the
stream watches the collection whose post is open.

Previews are downscaled once with ImageMagick (sips as a fallback) and cached
in shoots/<shoot>/.preview/.

Stdlib only, no venv needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import math
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .luts import HASH_PATTERN, MAX_LUT_BYTES, install_lut, lut_hash, valid_name
from .lenses import profile_for  # noqa: E402
from .settings import lut_directories, user_lut_directory  # noqa: E402
from .import_photos import (  # noqa: E402
    IMAGE_EXTS,
    JPEG_EXTS,
    RAW_EXTS,
    ImportError_,
    find_card,
    delete_verified_source,
    frame_key,
    offload_file,
    offload_plan,
    place,
    plan,
)
from .store import drive_name, read_manifest, store_mounted, stored  # noqa: E402
from .settings import configured_port, configured_store, resolve_library, save_library, load_config, import_settings  # noqa: E402

STATIC = Path(__file__).resolve().parent / "web"
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
                ".css": "text/css", ".wasm": "application/wasm",
                ".json": "application/json"}

PREVIEW_PX = 2000
THUMB_PX = 480
PICKS_FILE = "picks.txt"
PREVIEW_DIR = ".preview"
EXPORT_DIR = "export"
EDIT_SUFFIX = ".edit.json"
PROPOSAL_SUFFIX = ".proposal.json"
COLLECTIONS_FILE = "collections.json"
TRIPS_FILE = "trips.json"   # the old format, migrated on first read
LOOKS_FILE = "looks.json"
LUTS_DIR = "luts"
MAX_EXPORT_BYTES = 256 * 1024 * 1024
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")

# Recipe fields and the range each is clamped to; anything else is dropped,
# so a recipe on disk only ever holds what the renderer understands.
EDIT_RANGES = {
    "exposure": (-4.0, 4.0),
    "contrast": (-100.0, 100.0),
    "highlights": (-100.0, 100.0),
    "shadows": (-100.0, 100.0),
    "whites": (-100.0, 100.0),
    "blacks": (-100.0, 100.0),
    "temp": (-300.0, 300.0),   # temp and tint run wide: warm bounce light needs it
    "tint": (-300.0, 300.0),
    "vibrance": (-100.0, 100.0),
    "saturation": (-100.0, 100.0),
    "vignette": (-100.0, 100.0),
    "grain": (0.0, 100.0),
    "grainSize": (0.0, 100.0),
    "sharpen": (0.0, 100.0),
    "sharpenRadius": (0.0, 3.0),
    "noise": (0.0, 100.0),
    "colorNoise": (0.0, 100.0),
    "splitShadowHue": (0.0, 360.0),
    "splitShadowSat": (0.0, 100.0),
    "splitHighlightHue": (0.0, 360.0),
    "splitHighlightSat": (0.0, 100.0),
    "splitBalance": (-100.0, 100.0),
    "angle": (-45.0, 45.0),
    "vertical": (-100.0, 100.0),
    "horizontal": (-100.0, 100.0),
    "distortion": (-100.0, 100.0),
    "groundShift": (-100.0, 100.0),
    "skyShift": (-100.0, 100.0),
    "horizon": (0.0, 100.0),
    "groundFeather": (0.0, 50.0),
}

# What a look carries: the colour, tone and grain of a recipe. Not exposure,
# which is per frame, and not geometry or masks, which are per composition.
# A recipe holds its look as a copy, {"name", "params"}, layered over the
# recipe's own settings, with lookAmount (0..100, default 100) mixing it in.
LOOK_FIELDS = ("temp", "tint", "contrast", "highlights", "shadows", "whites", "blacks",
               "vibrance", "saturation", "vignette", "grain", "grainSize", "curve",
               "splitShadowHue", "splitShadowSat", "splitHighlightHue", "splitHighlightSat",
               "splitBalance", "lut", "lutHash")

# Tone curves: per channel, 2 to 16 [x, y] points in 0..100, x increasing.
CURVE_CHANNELS = ("rgb", "r", "g", "b")
MAX_CURVE_POINTS = 16

# Masks: local adjustments. Geometry is 0..1 in the corrected, uncropped frame.
MAX_MASKS = 8
MASK_GEOMETRY = {
    "linear": ("x1", "y1", "x2", "y2"),
    "radial": ("cx", "cy", "rx", "ry"),
    "rect": ("cx", "cy", "rx", "ry"),   # rx, ry: half the width and height
    "subject": (),   # painted: strokes, bitmap and map, see clean_subject
}
MAX_MASK_NAME = 40
# Subject masks: the brush strokes they were found from, and the result as a
# greyscale PNG data URL, small enough to keep in the recipe.
MAX_STROKES = 200
MAX_STROKE_POINTS = 1000
MAX_MASK_BITMAP = 1_500_000
PNG_DATA_URL = "data:image/png;base64,"
MASK_RANGES = {
    "exposure": (-4.0, 4.0),
    "contrast": (-100.0, 100.0),
    "highlights": (-100.0, 100.0),
    "shadows": (-100.0, 100.0),
    "temp": (-300.0, 300.0),   # temp and tint run wide: warm bounce light needs it
    "tint": (-300.0, 300.0),
    "saturation": (-100.0, 100.0),
    "feather": (0.0, 100.0),
    "falloff": (0.0, 100.0),   # rect only: fades from the top end to the bottom
    "lumLo": (0.0, 100.0),
    "lumHi": (0.0, 100.0),
}

# Hot reload. BOOT_ID changes on every server start, so a page that sees a new
# one knows the server code changed under it.
BOOT_ID = uuid.uuid4().hex[:8]
HERE = Path(__file__).resolve().parent
SERVER_CODE = (HERE / "server.py", HERE / "lenses.py", HERE / "import_photos.py", HERE / "store.py", HERE / "settings.py")


def mtimes(paths) -> dict[str, float]:
    out = {}
    for f in paths:
        try:
            out[str(f)] = f.stat().st_mtime
        except OSError:
            pass
    return out


# One lock per preview file, so two requests for the same frame do not both
# render it, and one lock for writes to picks and recipes.
_render_locks: dict[Path, threading.Lock] = {}
_render_guard = threading.Lock()
_write_lock = threading.Lock()


# --- library -----------------------------------------------------------------


def image_files(shoot_dir: Path) -> dict[Path, float]:
    """A shoot's images -> capture time: those in its raw/, then those on
    the external store (store.py), listed whether the drive is in or not."""
    out = {}
    for f in sorted((shoot_dir / "raw").iterdir()):
        if f.suffix.lower() in IMAGE_EXTS:
            try:
                out[f] = f.stat().st_mtime
            except FileNotFoundError:   # just moved to the store by an offload
                pass
    names = {f.name for f in out}
    for name, (path, mtime) in sorted(stored(shoot_dir).items()):
        if name not in names and path.suffix.lower() in IMAGE_EXTS:
            out[path] = mtime
    return out


def shot_time(src: Path, shoot_dir: Path) -> float:
    """When a frame was shot, from its file, or the store's note of it."""
    try:
        return src.stat().st_mtime
    except OSError:
        return stored(shoot_dir).get(src.name, (src, 0.0))[1]


def offline(src: Path) -> str:
    """Why an image can't be read, for a frame whose file is on an unplugged drive."""
    return f"{drive_name()} is not plugged in" if not store_mounted() else f"{src.name} is missing from {drive_name()}"


def shoot_date(name: str) -> str:
    """Extract the ISO date from either date-first or camera-first folders."""
    match = re.search(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)", name)
    if match:
        try:
            datetime.strptime(match.group(), "%Y-%m-%d")
            return match.group()
        except ValueError:
            pass
    return ""


def list_shoots(root: Path) -> list[str]:
    """Shoot folders holding at least one image, newest first."""
    shoots = [
        d.name for d in root.iterdir()
        if d.is_dir() and (d / "raw").is_dir()
        and (any(f.suffix.lower() in IMAGE_EXTS for f in (d / "raw").iterdir()) or read_manifest(d))
    ]
    return sorted(shoots, key=lambda name: (shoot_date(name), name), reverse=True)


SOURCES = ("raw", "jpeg")


def default_source(has_raw: bool) -> str:
    """What an unedited frame develops from: its raw when it has one.

    The page decides a frame's source with sourceOf() in web/source.js;
    this is the part of that rule the server needs.
    """
    return "raw" if has_raw else "jpeg"


def raw_sources(shoot_dir: Path) -> dict[str, Path]:
    """Frame key -> its raw file, for the frames that have one."""
    return {frame_key(f): f for f in image_files(shoot_dir) if f.suffix.lower() in RAW_EXTS}


def frame_sources(shoot_dir: Path) -> dict[str, Path]:
    """Frame key -> the file to render it from, preferring the camera JPEG."""
    sources: dict[str, Path] = {}
    for f in image_files(shoot_dir):
        ext = f.suffix.lower()
        key = frame_key(f)
        if key not in sources or ext in JPEG_EXTS:
            sources[key] = f
    return sources


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(text)
    tmp.replace(path)


def read_picks(shoot_dir: Path) -> set[str]:
    path = shoot_dir / PICKS_FILE
    if not path.is_file():
        return set()
    return {line.strip() for line in path.read_text().splitlines() if line.strip()}


def write_picks(shoot_dir: Path, picks: set[str]) -> None:
    """Replace picks.txt, or remove it once nothing is picked."""
    path = shoot_dir / PICKS_FILE
    if not picks:
        path.unlink(missing_ok=True)
        return
    atomic_write(path, "".join(f"{k}\n" for k in sorted(picks)))


# --- slide timestamps --------------------------------------------------------------


def with_capture_time(jpeg: bytes, when: datetime) -> bytes:
    """The JPEG with a minimal EXIF block giving it a capture time.

    Browser-made JPEGs carry no metadata, so a phone orders them by when they
    arrived, and two sends of the same slides interleave. With a capture time
    (slide n = export time + n-1 seconds) each export sorts as its own block,
    in carousel order.
    """
    stamp = when.strftime("%Y:%m:%d %H:%M:%S").encode() + b"\0"          # 20 bytes, ASCII
    # TIFF, little-endian: IFD0 (DateTime, pointer to the Exif IFD), the Exif
    # IFD (DateTimeOriginal, DateTimeDigitized), then the one shared string.
    ifd0, exif_ifd, data = 8, 8 + 30, 8 + 30 + 30
    entry = lambda tag, typ, count, value: struct.pack("<HHII", tag, typ, count, value)
    tiff = (b"II*\0" + struct.pack("<I", ifd0)
            + struct.pack("<H", 2) + entry(0x0132, 2, 20, data) + entry(0x8769, 4, 1, exif_ifd) + struct.pack("<I", 0)
            + struct.pack("<H", 2) + entry(0x9003, 2, 20, data) + entry(0x9004, 2, 20, data) + struct.pack("<I", 0)
            + stamp)
    app1 = b"Exif\0\0" + tiff
    return jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + jpeg[2:]


# --- taildrop ------------------------------------------------------------------

TAILSCALE_APP = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")


def tailscale() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    return str(TAILSCALE_APP) if TAILSCALE_APP.is_file() else None


def taildrop_targets() -> list[dict]:
    """Devices Taildrop can send to, as [{name, ip}]."""
    ts = tailscale()
    if not ts:
        return []
    res = subprocess.run([ts, "file", "cp", "--targets"], capture_output=True, text=True, timeout=15)
    out = []
    for line in res.stdout.splitlines():
        parts = line.split()
        # "<ip>\t<name>" per device; anything else (an error from a Tailscale
        # that can't reach its daemon, say) is not a device.
        if len(parts) >= 2 and re.fullmatch(r"[0-9a-fA-F:.]+", parts[0]) and any(c.isdigit() for c in parts[0]):
            out.append({"ip": parts[0], "name": parts[1]})
    return out


def taildrop(path: Path, device: str, name: str) -> str | None:
    """Send one file; None on success, else the error. The file goes in on
    stdin, since the sandboxed macOS app cannot read files itself."""
    with path.open("rb") as fh:
        res = subprocess.run([tailscale(), "file", "cp", "--name", name, "-", f"{device}:"],
                             stdin=fh, capture_output=True, text=True, timeout=180)
    return None if res.returncode == 0 else (res.stderr.strip() or f"exit {res.returncode}")


def reveal_exports(files: list[Path]) -> None:
    """Reveal verified export paths in the host's file manager."""
    if not files or any(not path.is_file() for path in files):
        raise ValueError("export the photos before revealing them")
    # One window per export folder avoids opening dozens for a batch.
    folders = {}
    for path in files:
        folders.setdefault(path.resolve().parent, path.resolve())
    for folder, path in folders.items():
        if sys.platform == "darwin":
            command = ["open", "-R", str(path)]
        elif sys.platform == "win32":
            command = ["explorer.exe", "/select,", str(path)]
        else:
            opener = shutil.which("xdg-open")
            if not opener:
                raise ValueError("no file manager found; install xdg-open or open the library's export folder")
            command = [opener, str(folder)]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError(f"could not open the file manager: {exc}") from exc
        # Explorer may return 1 when handing off to an existing window.
        if result.returncode and not (sys.platform == "win32" and result.returncode == 1):
            raise ValueError(result.stderr.strip() or "could not open the file manager")


# --- collections -------------------------------------------------------------
#
# A collection is a name, an ordered list of frames ("items", as shoot/key),
# and optionally a date range ("days") whose shoots it shows in full. A trip
# is a collection with days; a portfolio or a post is one without.


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def read_collections(root: Path) -> list[dict]:
    path = root / COLLECTIONS_FILE
    if path.is_file():
        return json.loads(path.read_text()).get("collections", [])
    old = root / TRIPS_FILE
    if not old.is_file():
        return []
    # trips.json held {name, from, to, selects}: the range becomes days and
    # the post set becomes the items, in the same order.
    collections = [
        {"name": t["name"], "days": {"from": t["from"], "to": t["to"]},
         "items": list(t.get("selects", []))}
        for t in json.loads(old.read_text()).get("trips", [])
    ]
    write_collections(root, collections)
    old.rename(old.with_name(TRIPS_FILE + ".migrated"))   # kept as a backup
    return collections


def write_collections(root: Path, collections: list[dict]) -> None:
    atomic_write(root / COLLECTIONS_FILE,
                 json.dumps({"collections": collections}, indent=2) + "\n")


def read_looks(root: Path) -> list[dict]:
    path = root / LOOKS_FILE
    if not path.is_file():
        path = HERE / "looks.example.json"
    return json.loads(path.read_text(encoding="utf-8")).get("looks", []) if path.is_file() else []


def write_looks(root: Path, looks: list[dict]) -> None:
    atomic_write(root / LOOKS_FILE, json.dumps({"looks": looks}, indent=2) + "\n")


def lut_files(root: Path) -> dict[str, Path]:
    """Installed LUTs by name; the first configured directory wins."""
    found = {}
    for directory in lut_directories(root):
        if directory.is_dir():
            for path in directory.glob("*.cube"):
                if path.is_file() and valid_name(path.name):
                    found.setdefault(path.name, path)
    return found


def list_luts(root: Path) -> list[str]:
    return sorted(lut_files(root), key=str.lower)


def resolve_lut(root: Path, name: str, fingerprint: str = "") -> tuple[Path | None, str]:
    if not valid_name(name) or (fingerprint and not HASH_PATTERN.fullmatch(fingerprint)):
        return None, ""
    if fingerprint:
        for directory in lut_directories(root):
            for path in directory.glob("*.cube"):
                if path.is_file() and lut_hash(path.read_bytes()) == fingerprint:
                    return path, ""
    path = lut_files(root).get(name)
    return path, "LUT fingerprint mismatch; rendered with the file found by name" if path and fingerprint else ""


def all_looks(root: Path) -> list[dict]:
    """Saved looks with availability metadata, then fingerprinted LUT files."""
    looks = []
    for look in read_looks(root):
        params = look.get("params", {})
        name = params.get("lut")
        path, warning = resolve_lut(root, name, params.get("lutHash", "")) if name else (None, "")
        flags = {"missingLut": name} if name and path is None else {"lutMismatch": True} if warning else {}
        looks.append({**look, **flags})
    return looks + [{"name": Path(n).stem, "params": {"lut": n, "lutHash": lut_hash(path.read_bytes())}, "file": True}
                    for n, path in sorted(lut_files(root).items(), key=lambda item: item[0].lower())]


def clean_look(params: object) -> dict:
    """A look's settings: the look fields of a cleaned recipe, defaults left out."""
    if not isinstance(params, dict):
        raise ValueError("a look's params must be an object")
    recipe = clean_edit({k: params[k] for k in LOOK_FIELDS if k in params})
    out = {k: recipe[k] for k in LOOK_FIELDS if k in recipe}
    # A LUT by file name. It need not exist: a frame keeps its look, and
    # reports the missing LUT rather than removing it from the recipe.
    lut = params.get("lut")
    if lut is not None:
        if not valid_name(lut):
            raise ValueError("lut must be a safe .cube filename")
        out["lut"] = lut
    fingerprint = params.get("lutHash")
    if fingerprint is not None:
        if not lut or not isinstance(fingerprint, str) or not HASH_PATTERN.fullmatch(fingerprint):
            raise ValueError("lutHash requires lut and must be 16 lowercase SHA256 hex characters")
        out["lutHash"] = fingerprint
    return out


def find_collection(collections: list[dict], slug: str) -> dict | None:
    return next((c for c in collections if slugify(c["name"]) == slug), None)


def collection_shoots(root: Path, c: dict) -> list[str]:
    """Shoots inside the collection's date range, oldest first."""
    days = c.get("days")
    if not days:
        return []
    return sorted((s for s in list_shoots(root) if days["from"] <= shoot_date(s) <= days["to"]),
                  key=lambda name: (shoot_date(name), name))


# A post lays a collection out as slides: each slide is one layout (a single
# photo, or a collage) whose cells each hold a photo, positioned by pan/zoom.
POST_ASPECTS = ("4:5", "1:1", "1.91:1", "9:16")
POST_LAYOUTS = ("single", "2h", "2v", "1+2", "1+3b", "2+1", "1+3", "1+4", "3+1", "2x2", "3h", "3v", "2x3")
POST_MAX_CELLS = 6
POST_MAX_SLIDES = 20      # Instagram's carousel limit


def clean_post(post: object) -> dict:
    if not isinstance(post, dict):
        raise ValueError("post must be an object")
    aspect = post.get("aspect", "4:5")
    if aspect not in POST_ASPECTS:
        raise ValueError(f"aspect must be one of {', '.join(POST_ASPECTS)}")
    bg = post.get("bg", "#ffffff")
    if not isinstance(bg, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", bg):
        raise ValueError("bg must be a colour like #ffffff")
    slides = post.get("slides", [])
    if not isinstance(slides, list) or len(slides) > POST_MAX_SLIDES:
        raise ValueError(f"at most {POST_MAX_SLIDES} slides")
    out_slides = []
    for sl in slides:
        if not isinstance(sl, dict) or sl.get("layout") not in POST_LAYOUTS:
            raise ValueError(f"slide layout must be one of {', '.join(POST_LAYOUTS)}")
        cells = sl.get("cells", [])
        if not isinstance(cells, list) or len(cells) > POST_MAX_CELLS:
            raise ValueError(f"a slide has at most {POST_MAX_CELLS} cells")
        out_cells = []
        for cell in cells:
            if not isinstance(cell, dict):
                raise ValueError("cell must be an object")
            ref = cell.get("ref")
            out_cells.append({
                "ref": ref if isinstance(ref, str) and "/" in ref else None,
                "x": _number(cell.get("x", 0), "cell x", -1.0, 1.0),
                "y": _number(cell.get("y", 0), "cell y", -1.0, 1.0),
                "zoom": _number(cell.get("zoom", 1), "cell zoom", 1.0, 4.0),
                "fit": cell.get("fit") if cell.get("fit") in ("contain", "square") else "cover",
            })
        slide = {"layout": sl["layout"], "cells": out_cells}
        if sl.get("split") is not None:
            # Where the layout's main divider sits, when it has been dragged.
            slide["split"] = _number(sl["split"], "split", 0.15, 0.85)
        out_slides.append(slide)
    return {
        "aspect": aspect,
        "gap": _number(post.get("gap", 12), "gap", 0.0, 120.0),
        "border": bool(post.get("border", False)),
        "bg": bg.lower(),
        "slides": out_slides,
    }


def clean_name(name: object) -> str:
    if not isinstance(name, str) or not slugify(name):
        raise ValueError("a collection needs a name with a letter or digit in it")
    return name.strip()[:80]


def clean_days(body: dict) -> dict | None:
    lo, hi = body.get("from"), body.get("to")
    if not lo and not hi:
        return None
    date = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    if not (isinstance(lo, str) and isinstance(hi, str) and date.match(lo) and date.match(hi)):
        raise ValueError("days need from and to as YYYY-MM-DD")
    return {"from": min(lo, hi), "to": max(lo, hi)}


def proposal_path(shoot_dir: Path, key: str) -> Path:
    return shoot_dir / "raw" / f"{key}{PROPOSAL_SUFFIX}"


def edit_path(shoot_dir: Path, key: str) -> Path:
    return shoot_dir / "raw" / f"{key}{EDIT_SUFFIX}"


def collection_rev(root: Path, slug: str) -> str:
    """A collection's revision: a hash of its photos and post layout."""
    c = find_collection(read_collections(root), slug)
    if c is None:
        return "none"
    data = json.dumps({"items": c.get("items", []), "post": c.get("post")}, sort_keys=True)
    return hashlib.sha1(data.encode()).hexdigest()[:12]


def edit_rev(path: Path) -> str:
    """A recipe's revision: a hash of the file, or "none" when there is none."""
    try:
        return hashlib.sha1(path.read_bytes()).hexdigest()[:12]
    except FileNotFoundError:
        return "none"


def _number(value: object, name: str, lo: float, hi: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{name} must be a number")
    return round(min(hi, max(lo, float(value))), 4)


def clean_mask(mask: object) -> dict:
    """One local adjustment, with only known fields, each clamped to range."""
    if not isinstance(mask, dict) or mask.get("type") not in MASK_GEOMETRY:
        raise ValueError("mask type must be linear, radial, rect or subject")
    out: dict = {
        "type": mask["type"],
        "enabled": bool(mask.get("enabled", True)),
        "invert": bool(mask.get("invert", False)),
    }
    name = mask.get("name") or ""
    if not isinstance(name, str):
        raise ValueError("mask name must be text")
    name = " ".join(name.split())[:MAX_MASK_NAME]
    if name:
        out["name"] = name
    if mask["type"] == "subject":
        out.update(clean_subject(mask))
    for name in MASK_GEOMETRY[mask["type"]]:
        # Handles may sit a little outside the frame, e.g. a gradient that
        # starts above the top edge.
        out[name] = _number(mask.get(name), f"mask {name}", -1.0, 2.0)
    if mask["type"] == "rect":
        # Degrees clockwise, in frame pixels.
        out["angle"] = _number(mask.get("angle", 0), "mask angle", -180.0, 180.0)
    for name, (lo, hi) in MASK_RANGES.items():
        default = {"feather": 50, "lumHi": 100}.get(name, 0)
        if name == "feather" and mask["type"] in ("linear", "subject"):
            continue
        if name == "falloff" and mask["type"] != "rect":
            continue
        out[name] = _number(mask.get(name, default), f"mask {name}", lo, hi)
    return out


def clean_subject(mask: dict) -> dict:
    """A subject mask's strokes, painted bitmap and frame-to-bitmap map."""
    strokes = mask.get("strokes") or []
    if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
        raise ValueError(f"subject mask takes at most {MAX_STROKES} strokes")
    clean = []
    for st in strokes:
        pts = st.get("pts") if isinstance(st, dict) else None
        if not isinstance(pts, list) or not 1 <= len(pts) <= MAX_STROKE_POINTS:
            raise ValueError(f"a stroke needs 1 to {MAX_STROKE_POINTS} points")
        if not all(isinstance(pt, list) and len(pt) == 2 for pt in pts):
            raise ValueError("stroke points must be [x, y]")
        clean.append({
            "pts": [[_number(v, "stroke point", -1.0, 2.0) for v in pt] for pt in pts],
            "r": _number(st.get("r"), "stroke radius", 0.0005, 0.5),
            "sub": bool(st.get("sub", False)),
        })
    bitmap = mask.get("bitmap")
    if bitmap is not None and (not isinstance(bitmap, str) or not bitmap.startswith(PNG_DATA_URL)
                               or len(bitmap) > MAX_MASK_BITMAP):
        raise ValueError("subject mask bitmap must be a PNG data URL")
    m = mask.get("map", [1, 0, 0, 0, 1, 0])
    if not isinstance(m, list) or len(m) != 6:
        raise ValueError("subject mask map needs 6 numbers")
    return {"strokes": clean, "bitmap": bitmap, "map": [_number(v, "mask map", -2.0, 2.0) for v in m]}


def clean_curve(curve: object) -> dict | None:
    """The channels that bend, as sorted points; None when all are straight."""
    if curve is None:
        return None
    if not isinstance(curve, dict):
        raise ValueError("curve must be an object")
    out = {}
    for ch in CURVE_CHANNELS:
        pts = curve.get(ch)
        if pts is None:
            continue
        if not isinstance(pts, list) or not 2 <= len(pts) <= MAX_CURVE_POINTS:
            raise ValueError(f"curve {ch} needs 2 to {MAX_CURVE_POINTS} points")
        if not all(isinstance(pt, list) and len(pt) == 2 for pt in pts):
            raise ValueError(f"curve {ch} points must be [x, y]")
        clean = sorted([_number(v, f"curve {ch} point", 0.0, 100.0) for v in pt] for pt in pts)
        if any(a[0] >= b[0] for a, b in zip(clean, clean[1:])):
            raise ValueError(f"curve {ch} has two points at the same x")
        if clean != [[0.0, 0.0], [100.0, 100.0]]:
            out[ch] = clean
    return out or None


def clean_edit(params: object) -> dict:
    """Keep only known recipe fields, as finite numbers inside their range."""
    if not isinstance(params, dict):
        raise ValueError("recipe must be an object")
    out: dict = {"version": 1}
    for name, (lo, hi) in EDIT_RANGES.items():
        value = params.get(name, 0)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError(f"{name} must be a number")
        value = round(min(hi, max(lo, float(value))), 3)
        if value:
            out[name] = value
    orient = params.get("orient", 0)
    if isinstance(orient, bool) or orient not in (0, 90, 180, 270):
        raise ValueError("orient must be 0, 90, 180 or 270")
    if orient:
        out["orient"] = orient
    for flip in ("flipH", "flipV"):
        if params.get(flip):
            out[flip] = True
    masks = params.get("masks") or []
    if not isinstance(masks, list) or len(masks) > MAX_MASKS:
        raise ValueError(f"masks must be a list of at most {MAX_MASKS}")
    if masks:
        out["masks"] = [clean_mask(m) for m in masks]
    lens = params.get("lens")
    if lens is not None:
        # A lens profile travels with the recipe, so a frame renders the same
        # on a machine without the Lensfun database.
        if not isinstance(lens, dict):
            raise ValueError("lens must be an object")
        k = lens.get("k")
        scale = lens.get("scale", 1.0)
        if (not isinstance(k, list) or len(k) != 5
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and abs(v) < 10 for v in k)
                or not isinstance(scale, (int, float)) or isinstance(scale, bool) or not 0.2 < scale < 5):
            raise ValueError("lens needs k (5 numbers) and a sane scale")
        focal = lens.get("focal", 0)
        if not isinstance(focal, (int, float)) or isinstance(focal, bool) or not math.isfinite(focal):
            raise ValueError("lens focal must be a finite number")
        out["lens"] = {
            "model": str(lens.get("model", ""))[:120],
            "focal": float(focal),
            "k": [float(v) for v in k],
            "scale": float(scale),
        }
    area = params.get("groundArea")
    if area is not None:
        if (not isinstance(area, list) or not 3 <= len(area) <= 8
                or not all(isinstance(pt, list) and len(pt) == 2 for pt in area)):
            raise ValueError("groundArea must be 3 to 8 [x, y] points")
        out["groundArea"] = [[_number(v, "groundArea point", -1.0, 2.0) for v in pt] for pt in area]
        # Feather defaults to 4, so a real 0 has to be kept, not dropped as unset.
        if "groundFeather" not in out:
            out["groundFeather"] = 0.0 if params.get("groundFeather") == 0 else 4.0
    # Horizon and the area feather only mean something with a ground shift or
    # an area; without one, leave their defaults out of the file.
    if "groundShift" not in out and "skyShift" not in out:
        out.pop("horizon", None)
    if "groundArea" not in out:
        out.pop("groundFeather", None)
    # Grain size defaults to 25 and only matters with some grain.
    if "grain" not in out:
        out.pop("grainSize", None)
    elif "grainSize" not in out:
        out["grainSize"] = 0.0 if params.get("grainSize") == 0 else 25.0
    # The sharpening radius defaults to 1 and only matters with sharpening.
    if "sharpen" not in out:
        out.pop("sharpenRadius", None)
    elif "sharpenRadius" not in out:
        out["sharpenRadius"] = 1.0
    elif out["sharpenRadius"] < 0.5:
        out["sharpenRadius"] = 0.5
    # A split-toning hue means nothing without its saturation, nor the balance
    # without either.
    for part in ("Shadow", "Highlight"):
        if f"split{part}Sat" not in out:
            out.pop(f"split{part}Hue", None)
    if "splitShadowSat" not in out and "splitHighlightSat" not in out:
        out.pop("splitBalance", None)
    if curve := clean_curve(params.get("curve")):
        out["curve"] = curve
    look = params.get("look")
    if look is not None:
        if not isinstance(look, dict):
            raise ValueError("look must be an object")
        out["look"] = {"name": str(look.get("name", "")).strip()[:80],
                       "params": clean_look(look.get("params") or {})}
        # Amount defaults to 100, so only a real change is kept, 0 included.
        amount = _number(params.get("lookAmount", 100), "lookAmount", 0.0, 100.0)
        if amount != 100:
            out["lookAmount"] = amount
    # Which file the edit develops from. Absent means an edit from before raw
    # support, which was made on the camera JPEG and stays on it.
    source = params.get("source")
    if source is not None:
        if source not in SOURCES:
            raise ValueError("source must be 'raw' or 'jpeg'")
        out["source"] = source
    # Horizon defaults to 50, so a real 0 has to be kept, not dropped as unset.
    if ("groundShift" in out or "skyShift" in out) and "horizon" not in out:
        out["horizon"] = 0.0 if params.get("horizon") == 0 else 50.0
    crop = params.get("crop")
    if crop is not None:
        if not isinstance(crop, dict):
            raise ValueError("crop must be an object")
        box = {}
        for side in ("x", "y", "w", "h"):
            value = crop.get(side)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise ValueError(f"crop.{side} must be a number")
            box[side] = round(min(1.0, max(0.0, float(value))), 5)
        if box["w"] <= 0 or box["h"] <= 0:
            raise ValueError("crop is empty")
        if box != {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}:
            out["crop"] = box
    return out


def preview(src: Path, shoot_dir: Path) -> Path:
    """A cached, upright, downscaled JPEG of src."""
    out = shoot_dir / PREVIEW_DIR / f"{frame_key(src)}.jpg"
    with _render_guard:
        lock = _render_locks.setdefault(out, threading.Lock())
    with lock:
        # An image on an unplugged drive still shows from its cached preview.
        if out.is_file() and out.stat().st_mtime >= shot_time(src, shoot_dir):
            return out
        if not src.is_file():
            raise FileNotFoundError(offline(src))
        if not shutil.which("magick") and not shutil.which("sips"):
            from .previews import fallback_preview
            return fallback_preview(src, out)
        out.parent.mkdir(exist_ok=True)
        tmp = out.with_suffix(".part.jpg")
        size = f"{PREVIEW_PX}x{PREVIEW_PX}"
        if shutil.which("magick"):
            # jpeg:size lets libjpeg decode at reduced scale, several times faster.
            cmd = ["magick", "-define", f"jpeg:size={size}", str(src),
                   "-auto-orient", "-resize", f"{size}>", "-quality", "82", str(tmp)]
        else:
            # sips does not honour EXIF orientation, so portrait frames may
            # come out sideways; install ImageMagick to fix that.
            cmd = ["sips", "-Z", str(PREVIEW_PX), "-s", "format", "jpeg",
                   "-s", "formatOptions", "82", str(src), "--out", str(tmp)]
        subprocess.run(cmd, check=True, capture_output=True)
        tmp.replace(out)
        return out


def thumb(src: Path, shoot_dir: Path) -> Path:
    """A cached grid thumbnail, cut from the preview rather than the original."""
    big = preview(src, shoot_dir)
    if not shutil.which("magick") and not shutil.which("sips"):
        return big
    out = shoot_dir / PREVIEW_DIR / "thumb" / big.name
    with _render_guard:
        lock = _render_locks.setdefault(out, threading.Lock())
    with lock:
        if out.is_file() and out.stat().st_mtime >= big.stat().st_mtime:
            return out
        out.parent.mkdir(exist_ok=True)
        tmp = out.with_suffix(".part.jpg")
        size = f"{THUMB_PX}x{THUMB_PX}"
        if shutil.which("magick"):
            cmd = ["magick", "-define", f"jpeg:size={size}", str(big),
                   "-resize", f"{size}>", "-quality", "80", str(tmp)]
        else:
            cmd = ["sips", "-Z", str(THUMB_PX), "-s", "formatOptions", "80",
                   str(big), "--out", str(tmp)]
        subprocess.run(cmd, check=True, capture_output=True)
        tmp.replace(out)
        return out


def warm_previews(root: Path, shoot: str) -> None:
    """Render a shoot's thumbnails and previews in the background.

    Thumbnails go first: they are what the grid asks for all at once.
    """
    shoot_dir = root / shoot
    for src in frame_sources(shoot_dir).values():
        try:
            thumb(src, shoot_dir)
        except (subprocess.CalledProcessError, OSError, ValueError):
            pass


# --- card import -------------------------------------------------------------
#
# The Import button runs import_photos.py's own plan and verified copy, so the
# page and the command line always agree on what is new and where it goes.
# One import at a time; the page polls /api/import for progress.

_import_lock = threading.Lock()
_import: dict = {"running": False}


def plugged_card() -> Path | None:
    """The one plugged-in card, or None (no card, or more than one)."""
    try:
        return find_card()
    except ImportError_:
        return None


def card_plan(root: Path, card: Path, jpeg_only: bool) -> dict[Path, list[Path]]:
    """What importing card would copy; empty when nothing on it is new."""
    try:
        return plan(card, root, None, None, False, jpeg_only=jpeg_only)
    except ImportError_ as exc:
        if str(exc).startswith("no media files"):
            return {}
        raise


def describe_plan(root: Path, by_dest: dict[Path, list[Path]]) -> list[dict]:
    return [
        {"shoot": dest.parent.name, "kind": dest.name,
         "frames": len({frame_key(f) for f in files}), "files": len(files),
         "mb": round(sum(f.stat().st_size for f in files) / (1024 * 1024), 1)}
        for dest, files in sorted(by_dest.items())
    ]


def run_import(root: Path, card: Path, jpeg_only: bool, delete_from_card: bool = False) -> None:
    """Copy everything new off card, updating _import as it goes. Images go
    to the external store when it is plugged in (store.py)."""
    state = _import
    try:
        by_dest = card_plan(root, card, jpeg_only)
        files = [(dest, f) for dest, fs in sorted(by_dest.items()) for f in fs]
        to_store = store_mounted()
        state.update(total=len(files), bytes_total=sum(f.stat().st_size for _, f in files),
                     groups=describe_plan(root, by_dest), to=drive_name() if to_store else "the library")
        for dest, src in files:
            state["current"] = src.name
            size = src.stat().st_size
            place(src, dest, to_store)
            state["copied"] += 1
            state["bytes"] += size
        if delete_from_card:
            for dest, src in files:
                state["current"] = f"Removing verified source: {src.name}"
                delete_verified_source(src, dest, to_store)
                state["deleted"] += 1
    except (ImportError_, OSError, ValueError) as exc:
        state["error"] = str(exc)
    finally:
        state["running"] = False
        state["current"] = None


# --- offload to the external drive ---------------------------------------------
#
# The Offload button runs import_photos.py's offload, one verified file at a
# time, the same as --offload. It never runs beside an import: both write the
# shoots' store.json. The page polls /api/offload for progress.

_offload: dict = {"running": False}


def offload_shoots(root: Path) -> list[dict]:
    """Shoots with images or clips still in the library, newest first."""
    sizes: dict[str, list[int]] = {}
    for d, _, f in offload_plan(root, []):
        sizes.setdefault(d.name, []).append(f.stat().st_size)
    return [{"shoot": s, "files": len(v), "mb": round(sum(v) / (1024 * 1024), 1)}
            for s, v in sorted(sizes.items(), reverse=True)]


def run_offload(root: Path, shoots: list[str]) -> None:
    """Move shoots' files to the drive, updating _offload as it goes."""
    state = _offload
    try:
        moves = offload_plan(root, shoots)
        state.update(total=len(moves), bytes_total=sum(f.stat().st_size for _, _, f in moves))
        # Previews first, from the files while they are still here, so the
        # shoots keep showing with the drive unplugged.
        state["phase"] = "previews"
        for d in sorted({d for d, _, _ in moves}):
            for src in frame_sources(d).values():
                if src.is_file():
                    state["current"] = src.name
                    try:
                        thumb(src, d)
                    except (subprocess.CalledProcessError, OSError):
                        pass
        state["phase"] = "moving"
        for d, sub, f in moves:
            state["current"] = f.name
            size = f.stat().st_size
            offload_file(d, sub, f)
            state["moved"] += 1
            state["bytes"] += size
    except (ImportError_, OSError, ValueError) as exc:
        state["error"] = str(exc)
    finally:
        state["running"] = False
        state["current"] = None


def eject(card: Path) -> str | None:
    """Unmount the card so it can be pulled; an error message, or None."""
    if sys.platform != "darwin":
        return "eject it from the system tray"
    result = subprocess.run(["diskutil", "eject", str(card)], capture_output=True, text=True)
    return None if result.returncode == 0 else (result.stderr or result.stdout).strip()


# --- http --------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def parse_request(self) -> bool:
        # Centralize this before dispatch so subclasses (including the headless
        # renderer) cannot bypass the browser-origin and rebinding boundary.
        if not super().parse_request():
            return False
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_address[1]
        allowed = {f"{host}:{port}" for host in ("localhost", "127.0.0.1", "[::1]")}
        if port == 80:
            allowed.update(("localhost", "127.0.0.1", "[::1]"))
        host = hosts[0].lower() if len(hosts) == 1 else ""
        if host not in allowed:
            self.send_error(HTTPStatus.FORBIDDEN, "Host must name this loopback server and port")
            return False
        origins = self.headers.get_all("Origin", [])
        if (len(origins) > 1 or (origins and origins[0].lower() != f"http://{host}")
                or self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site"):
            self.send_error(HTTPStatus.FORBIDDEN, "cross-origin requests are not allowed")
            return False
        if self.command == "POST":
            path = urlparse(self.path).path
            expected = {
                "/api/luts/install": "application/octet-stream",
                "/api/export": "image/jpeg", "/api/post-export": "image/jpeg",
                "/headless/result": "image/jpeg", "/headless/error": "text/plain",
            }.get(path, "application/json" if path.startswith("/api/") else None)
            types = self.headers.get_all("Content-Type", [])
            content_type = types[0].split(";", 1)[0].strip().lower() if len(types) == 1 else ""
            if expected and content_type != expected:
                self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, f"request requires {expected}")
                return False
        return True

    root: Path | None = None
    setup_token = uuid.uuid4().hex
    warmed: set[str] = set()

    def log_message(self, fmt: str, *args) -> None:  # quiet
        pass

    def end_headers(self) -> None:
        # LibRaw's pthread-enabled WebAssembly needs SharedArrayBuffer.
        # All app assets are served from this origin.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_bytes(self, data: bytes, ctype: str, cache: str = "no-cache") -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, body, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def shoot_dir(self, shoot: str) -> Path | None:
        if not SAFE_NAME.match(shoot) or shoot.startswith("."):
            return None
        d = self.root / shoot
        return d if (d / "raw").is_dir() else None

    def frame(self, shoot: str, key: str) -> tuple[Path, Path] | None:
        """(shoot dir, source file) for a frame that exists, else None."""
        d = self.shoot_dir(shoot)
        src = frame_sources(d).get(key) if d else None
        return (d, src) if src else None

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_EXPORT_BYTES:
            raise ValueError("body too large")
        return self.rfile.read(length)

    # GET

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if self.root is None:
            if url.path in ("/", "/index.html"):
                page = (STATIC / "setup.html").read_text(encoding="utf-8")
                self.send_bytes(page.replace("__SETUP_TOKEN__", self.setup_token).encode(), "text/html; charset=utf-8")
            else:
                self.send_json({"error": "choose a library folder first"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        query = parse_qs(url.query)
        parts = [unquote(p) for p in url.path.strip("/").split("/") if p]

        if not parts or (len(parts) == 1 and parts[0] in {p.name for p in STATIC.iterdir()}):
            path = STATIC / (parts[0] if parts else "index.html")
            self.send_bytes(path.read_bytes(), STATIC_TYPES.get(path.suffix, "text/plain"))
            return

        if parts[0] == "vendor":
            # Third-party code shipped with the page, e.g. the LibRaw decoder.
            path = (STATIC / "/".join(parts)).resolve()
            if not path.is_relative_to(STATIC / "vendor") or not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_bytes(path.read_bytes(), STATIC_TYPES.get(path.suffix, "application/octet-stream"),
                            "max-age=86400")
            return

        if len(parts) == 3 and parts[0] == "rawfile":
            # The raw file itself, for the page to decode.
            d = self.shoot_dir(parts[1])
            src = raw_sources(d).get(parts[2]) if d else None
            if not src:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if not src.is_file():
                self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, offline(src))
                return
            self.send_bytes(src.read_bytes(), "application/octet-stream", "max-age=3600")
            return

        if parts == ["api", "events"]:
            # Optionally watch one frame's recipe and proposal as well.
            found = self.frame(query.get("shoot", [""])[0], query.get("key", [""])[0]) \
                if "key" in query else None
            watch = {}
            if found:
                key = frame_key(found[1])
                watch = {"edit": (edit_path(found[0], key), edit_rev),
                         "proposal": (proposal_path(found[0], key), edit_rev)}
            # And one collection's photos and post layout.
            slug = query.get("collection", [""])[0]
            if slug and SAFE_NAME.match(slug):
                root = self.root
                watch["post"] = (root / COLLECTIONS_FILE, lambda _p, s=slug: collection_rev(root, s))
            self.api_events(watch)
            return

        if parts == ["api", "shoots"]:
            with _write_lock:
                collections = read_collections(self.root)
            self.send_json({
                "shoots": list_shoots(self.root),
                "collections": [
                    {"name": c["name"], "slug": slugify(c["name"]), "days": c.get("days"),
                     "shoots": collection_shoots(self.root, c), "items": len(c.get("items", []))}
                    for c in collections
                ],
            })
            return

        if parts == ["api", "frames"]:
            if "collection" in query:
                self.api_collection_frames(query["collection"][0])
            else:
                self.api_frames(query.get("shoot", [""])[0])
            return

        if parts == ["api", "edit"]:
            found = self.frame(query.get("shoot", [""])[0], query.get("key", [""])[0])
            if not found:
                self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
                return
            key = frame_key(found[1])
            path = edit_path(found[0], key)
            # What the frame has to develop from, so the page can work out its
            # source without the frame list (the Post tab has only refs).
            with _write_lock:
                params = json.loads(path.read_text()) if path.is_file() else None
                rev = edit_rev(path)
            self.send_json({"params": params, "rev": rev,
                            "raw": key in raw_sources(found[0]),
                            "jpeg": found[1].suffix.lower() in JPEG_EXTS})
            return

        if parts == ["api", "card"]:
            self.api_card(query.get("plan", [""])[0] == "1", query.get("jpeg", [""])[0] == "1")
            return

        if parts == ["api", "import"]:
            self.send_json(dict(_import))
            return

        if parts == ["api", "offload"]:
            self.api_offload_status(query.get("plan", [""])[0] == "1")
            return

        if parts == ["api", "looks"]:
            with _write_lock:
                self.send_json({"looks": all_looks(self.root)})
            return

        if len(parts) == 2 and parts[0] == "luts":
            path, warning = resolve_lut(self.root, parts[1], query.get("hash", [""])[0])
            if path is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            if warning:
                self.send_header("X-LUT-Warning", warning)
            self.end_headers()
            self.wfile.write(data)
            return

        if parts == ["api", "devices"]:
            try:
                self.send_json({"tailscale": bool(tailscale()), "devices": taildrop_targets()})
            except (OSError, subprocess.SubprocessError) as exc:
                self.send_json({"tailscale": False, "devices": [], "error": str(exc)})
            return

        if parts == ["api", "search"]:
            self.api_search(query.get("q", [""])[0])
            return

        if parts == ["api", "collection"]:
            c = find_collection(read_collections(self.root), query.get("slug", [""])[0])
            if c is None:
                self.send_json({"error": "no such collection"}, HTTPStatus.NOT_FOUND)
                return
            self.send_json({"name": c["name"], "items": c.get("items", []), "post": c.get("post"),
                            "rev": collection_rev(self.root, query.get("slug", [""])[0])})
            return

        if parts == ["api", "proposal"]:
            found = self.frame(query.get("shoot", [""])[0], query.get("key", [""])[0])
            if not found:
                self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
                return
            path = proposal_path(found[0], frame_key(found[1]))
            self.send_json({"proposal": json.loads(path.read_text()) if path.is_file() else None})
            return

        if parts == ["api", "lens"]:
            found = self.frame(query.get("shoot", [""])[0], query.get("key", [""])[0])
            if not found:
                self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
                return
            # A raw is uncorrected even where the camera corrects its JPEGs.
            raw = query.get("source", ["jpeg"])[0] == "raw"
            self.send_json({"lens": profile_for(found[1], raw=raw) if found[1].is_file() else None})
            return

        if len(parts) == 3 and parts[0] in ("preview", "original", "thumb"):
            found = self.frame(parts[1], parts[2].removesuffix(".jpg"))
            if not found:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            d, src = found
            if parts[0] == "original" and src.suffix.lower() in JPEG_EXTS:
                if not src.is_file():
                    self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, offline(src))
                    return
                path = src
            else:
                # A raw-only frame develops from its preview rather than not at all.
                try:
                    path = thumb(src, d) if parts[0] == "thumb" else preview(src, d)
                except FileNotFoundError as exc:
                    self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, str(exc))
                    return
                except ValueError as exc:
                    self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, str(exc))
                    return
                except (subprocess.CalledProcessError, OSError):
                    self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "preview failed")
                    return
            self.send_bytes(path.read_bytes(), "image/jpeg", "max-age=3600")
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def shoot_frames(self, shoot: str) -> list[dict]:
        """Every frame of one shoot, in capture order."""
        d = self.root / shoot
        if shoot not in self.warmed:
            self.warmed.add(shoot)
            threading.Thread(target=warm_previews, args=(self.root, shoot), daemon=True).start()
        picks = read_picks(d)
        raws = raw_sources(d)
        times = image_files(d)
        sources = sorted(frame_sources(d).items(), key=lambda kv: (times[kv[1]], kv[0]))
        def recipe(key: str) -> dict | None:
            path = edit_path(d, key)
            try:
                return json.loads(path.read_text()) if path.is_file() else None
            except (OSError, ValueError):
                return None

        return [
            {
                "shoot": shoot,
                "key": key,
                "params": recipe(key),     # so thumbnails can show the edit
                "time": datetime.fromtimestamp(times[src]).strftime("%H:%M:%S"),
                "picked": key in picks,
                "raw": key in raws,                   # a raw file to develop from
                "jpeg": src.suffix.lower() in JPEG_EXTS,
                "edited": edit_path(d, key).is_file(),
                "proposed": proposal_path(d, key).is_file(),
                "exported": (d / EXPORT_DIR / f"{key}.jpg").is_file(),
            }
            for key, src in sources
        ]

    def api_events(self, watch: dict | None = None) -> None:
        """Server-sent events for hot reload: hello with the boot id, then a
        change event naming "css" or "page" whenever the page code changes.
        watch maps event names to (file, revision function), e.g. {"edit":
        (recipe, edit_rev)}: each sends its event, with the new revision,
        when the file changes and the revision with it."""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(f"retry: 500\nevent: hello\ndata: {BOOT_ID}\n\n".encode())
            self.wfile.flush()
            seen = mtimes(STATIC.iterdir())
            quiet = 0.0
            watch = watch or {}
            revs = {name: rev_of(path) for name, (path, rev_of) in watch.items()}
            stamps = {name: mtimes([path]) for name, (path, _) in watch.items()}
            while True:
                time.sleep(0.4)
                for name, (path, rev_of) in watch.items():
                    if mtimes([path]) == stamps[name]:
                        continue
                    stamps[name] = mtimes([path])
                    rev = rev_of(path)
                    if rev != revs[name]:
                        revs[name] = rev
                        self.wfile.write(f"event: {name}\ndata: {rev}\n\n".encode())
                        self.wfile.flush()
                now = mtimes(STATIC.iterdir())
                changed = {f for f in now.keys() | seen.keys() if now.get(f) != seen.get(f)}
                seen = now
                if changed:
                    kind = "css" if all(f.endswith(".css") for f in changed) else "page"
                    self.wfile.write(f"event: change\ndata: {kind}\n\n".encode())
                    self.wfile.flush()
                    quiet = 0.0
                else:
                    quiet += 0.4
                    if quiet >= 15:   # keep the connection from idling out
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        quiet = 0.0
        except (BrokenPipeError, ConnectionResetError):
            return

    def api_search(self, q: str) -> None:
        """Frames whose name or day contains q, best matches first: exact name,
        then names starting with q, then the rest, newest day first."""
        q = q.strip().lower()
        if not q:
            self.send_json({"results": []})
            return
        hits = []
        for shoot in list_shoots(self.root):
            d = self.root / shoot
            for key in frame_sources(d):
                name = key.lower()
                if q in name or q in shoot.lower():
                    rank = 0 if name == q else 1 if name.startswith(q) or name.endswith(q) else 2
                    hits.append((rank, shoot, key, edit_path(d, key).is_file()))
        hits.sort(key=lambda h: (h[0], [-ord(c) for c in h[1]], h[2]))
        self.send_json({"total": len(hits), "results": [
            {"shoot": shoot, "key": key, "edited": edited} for _, shoot, key, edited in hits[:40]]})

    def api_frames(self, shoot: str) -> None:
        if self.shoot_dir(shoot) is None:
            self.send_json({"error": "no such shoot"}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({"shoot": shoot, "frames": self.shoot_frames(shoot)})

    def api_collection_frames(self, slug: str) -> None:
        """The collection's days in full, then any items from other days, in item order."""
        c = find_collection(read_collections(self.root), slug)
        if c is None:
            self.send_json({"error": "no such collection"}, HTTPStatus.NOT_FOUND)
            return
        items = c.get("items", [])
        order = {ref: i + 1 for i, ref in enumerate(items)}
        days = collection_shoots(self.root, c)
        frames = [f for shoot in days for f in self.shoot_frames(shoot)]
        by_shoot: dict[str, dict[str, dict]] = {}
        for ref in items:
            shoot, _, key = ref.partition("/")
            if shoot in days or not self.shoot_dir(shoot):
                continue
            if shoot not in by_shoot:
                by_shoot[shoot] = {f["key"]: f for f in self.shoot_frames(shoot)}
            if key in by_shoot[shoot]:
                frames.append(by_shoot[shoot][key])
        for f in frames:
            f["selected"] = order.get(f"{f['shoot']}/{f['key']}", 0)
        self.send_json({"collection": slug, "name": c["name"], "days": c.get("days"),
                        "frames": frames})

    # POST

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path == "/api/setup":
            self.api_setup()
            return
        if self.root is None:
            self.send_json({"error": "choose a library folder first"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            if url.path == "/api/luts/install":
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
                    raise ValueError("LUT upload requires application/octet-stream")
                if self.headers.get("Transfer-Encoding"):
                    raise ValueError("LUT uploads require a fixed Content-Length")
                length_text = self.headers.get("Content-Length", "")
                if not re.fullmatch(r"[0-9]{1,10}", length_text):
                    raise ValueError("invalid LUT Content-Length")
                length = int(length_text)
                if not 0 < length <= MAX_LUT_BYTES:
                    raise ValueError("LUT must be between 1 byte and 64 MiB")
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("incomplete LUT upload")
                name = parse_qs(url.query).get("name", [""])[0]
                with _write_lock:
                    try:
                        install_lut(user_lut_directory(), name, data, Path(__file__).resolve().parents[1])
                    except OSError as exc:
                        raise ValueError(f"could not install LUT: {exc}") from exc
                self.send_json({"look": {"name": Path(name).stem, "params": {"lut": name, "lutHash": lut_hash(data)}, "file": True},
                                "looks": all_looks(self.root)})
            elif url.path == "/api/pick":
                self.api_pick(json.loads(self.read_body()))
            elif url.path.startswith("/api/collections/"):
                self.api_collections(url.path.rsplit("/", 1)[1], json.loads(self.read_body()))
            elif url.path.startswith("/api/looks/"):
                self.api_looks(url.path.rsplit("/", 1)[1], json.loads(self.read_body()))
            elif url.path == "/api/select":
                self.api_select(json.loads(self.read_body()))
            elif url.path == "/api/reorder":
                self.api_reorder(json.loads(self.read_body()))
            elif url.path == "/api/send":
                self.api_send(json.loads(self.read_body()))
            elif url.path == "/api/post":
                self.api_post(json.loads(self.read_body()))
            elif url.path == "/api/post-export":
                query = parse_qs(url.query)
                self.api_post_export(query.get("collection", [""])[0], query.get("n", ["0"])[0],
                                     query.get("of", ["0"])[0], query.get("single", [""])[0] == "1")
            elif url.path == "/api/import":
                self.api_import(json.loads(self.read_body() or b"{}"))
            elif url.path == "/api/eject":
                self.api_eject()
            elif url.path == "/api/offload":
                self.api_offload(json.loads(self.read_body() or b"{}"))
            elif url.path == "/api/proposal":
                self.api_proposal(json.loads(self.read_body()))
            elif url.path == "/api/edit":
                self.api_edit(json.loads(self.read_body()))
            elif url.path == "/api/export":
                query = parse_qs(url.query)
                self.api_export(query.get("shoot", [""])[0], query.get("key", [""])[0],
                                query.get("review", [""])[0] == "1", query.get("tag", [""])[0])
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, TypeError) as exc:
            self.send_json({"error": str(exc) or "bad request"}, HTTPStatus.BAD_REQUEST)

    def api_setup(self) -> None:
        # The token is only in the first-run page. Cross-origin sites cannot
        # read it or submit the custom header without a successful preflight.
        if self.headers.get("X-Studio-Setup") != self.setup_token:
            self.send_json({"error": "reload the setup page and try again"}, HTTPStatus.FORBIDDEN)
            return
        try:
            with _write_lock:
                if self.root is not None:
                    self.send_json({"error": "library already configured; restart with --library to change it"}, HTTPStatus.CONFLICT)
                    return
                body = json.loads(self.read_body())
                value = body.get("library") if isinstance(body, dict) else None
                if not isinstance(value, str) or not value.strip():
                    raise ValueError("enter a folder path")
                library = Path(value.strip()).expanduser()
                if not library.is_absolute():
                    raise ValueError("enter an absolute folder path")
                library = library.resolve()
                library.mkdir(parents=True, exist_ok=True)
                save_library(library)
                type(self).root = library
            self.send_json({"library": str(library)})
        except (ValueError, OSError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def api_card(self, with_plan: bool, jpeg_only: bool) -> None:
        """The plugged-in card, and with plan=1 what importing it would copy.

        Presence alone is cheap, so the page can poll it; the plan reads every
        file's date off the card and is only asked for when the card appears.
        """
        card = plugged_card()
        if card is None:
            self.send_json({"card": None})
            return
        body: dict = {"card": card.name, "eject": sys.platform == "darwin",
                      "deleteFromCard": import_settings()[1],
                      "to": drive_name() if store_mounted() else (f"the library ({drive_name()} not plugged in)" if configured_store() else "the library")}
        if with_plan:
            try:
                body["groups"] = describe_plan(self.root, card_plan(self.root, card, jpeg_only))
            except (ImportError_, OSError) as exc:
                body["error"] = str(exc)
        self.send_json(body)

    def api_import(self, body: dict) -> None:
        delete_from_card = body.get("deleteFromCard", import_settings()[1])
        if not isinstance(delete_from_card, bool):
            self.send_json({"error": "deleteFromCard must be a boolean"}, HTTPStatus.BAD_REQUEST)
            return
        card = plugged_card()
        if card is None:
            self.send_json({"error": "no camera card plugged in"}, HTTPStatus.CONFLICT)
            return
        with _import_lock:
            if _import.get("running"):
                self.send_json({"error": "an import is already running"}, HTTPStatus.CONFLICT)
                return
            if _offload.get("running"):
                self.send_json({"error": "wait for the offload to finish"}, HTTPStatus.CONFLICT)
                return
            _import.clear()
            _import.update(running=True, card=card.name, copied=0, total=0, bytes=0,
                           bytes_total=0, groups=[], error=None, current=None, deleted=0)
        threading.Thread(target=run_import, args=(self.root, card, bool(body.get("jpegOnly")), delete_from_card),
                         daemon=True).start()
        self.send_json(_import)

    def api_offload_status(self, with_plan: bool) -> None:
        """Whether the drive is in, the offload's progress, and with plan=1
        which shoots still have files to move."""
        mounted = store_mounted()
        body: dict = {"drive": drive_name(), "configured": configured_store() is not None,
                      "mounted": mounted, "state": dict(_offload)}
        if with_plan and mounted and not _offload.get("running"):
            try:
                body["shoots"] = offload_shoots(self.root)
            except (ImportError_, OSError) as exc:
                body["error"] = str(exc)
        self.send_json(body)

    def api_offload(self, body: dict) -> None:
        shoots = body.get("shoots")
        # Always a named list: an empty one would mean every shoot.
        if not isinstance(shoots, list) or not shoots or not all(
                isinstance(s, str) and SAFE_NAME.match(s) and self.shoot_dir(s) for s in shoots):
            raise ValueError("shoots must name at least one shoot")
        if not store_mounted():
            self.send_json({"error": f"{drive_name()} is not plugged in"}, HTTPStatus.CONFLICT)
            return
        with _import_lock:
            if _offload.get("running"):
                self.send_json({"error": "an offload is already running"}, HTTPStatus.CONFLICT)
                return
            if _import.get("running"):
                self.send_json({"error": "wait for the import to finish"}, HTTPStatus.CONFLICT)
                return
            _offload.clear()
            _offload.update(running=True, shoots=shoots, moved=0, total=0, bytes=0, bytes_total=0,
                            phase="planning", error=None, current=None)
        threading.Thread(target=run_offload, args=(self.root, shoots), daemon=True).start()
        self.send_json(_offload)

    def api_eject(self) -> None:
        card = plugged_card()
        if card is None:
            self.send_json({"error": "no camera card plugged in"}, HTTPStatus.CONFLICT)
            return
        if _import.get("running"):
            self.send_json({"error": "wait for the import to finish"}, HTTPStatus.CONFLICT)
            return
        error = eject(card)
        if error:
            self.send_json({"error": error}, HTTPStatus.BAD_GATEWAY)
            return
        self.send_json({"ejected": card.name})

    def api_pick(self, body: dict) -> None:
        shoot, key, picked = body["shoot"], body["key"], bool(body["picked"])
        found = self.frame(shoot, key)
        if not found:
            self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
            return
        with _write_lock:
            picks = read_picks(found[0])
            (picks.add if picked else picks.discard)(key)
            write_picks(found[0], picks)
        self.send_json({"key": key, "picked": picked, "count": len(picks)})

    def api_looks(self, action: str, body: dict) -> None:
        """Save a look (replacing one of the same name) or delete one."""
        name = body.get("name")
        if not isinstance(name, str) or not slugify(name):
            raise ValueError("a look needs a name with a letter or digit in it")
        name = name.strip()[:80]
        with _write_lock:
            looks = [lk for lk in read_looks(self.root) if slugify(lk["name"]) != slugify(name)]
            if action == "save":
                looks.append({"name": name, "params": clean_look(body.get("params"))})
                looks.sort(key=lambda lk: lk["name"].lower())
            elif action != "delete":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            write_looks(self.root, looks)
            self.send_json({"looks": all_looks(self.root)})

    def api_collections(self, action: str, body: dict) -> None:
        """Create, rename or delete a collection."""
        with _write_lock:
            collections = read_collections(self.root)
            if action == "create":
                name = clean_name(body.get("name"))
                if find_collection(collections, slugify(name)):
                    self.send_json({"error": f"there is already a collection called {name}"},
                                   HTTPStatus.CONFLICT)
                    return
                c = {"name": name, "items": []}
                if days := clean_days(body):
                    c["days"] = days
                collections.append(c)
            elif action in ("rename", "delete"):
                c = find_collection(collections, body.get("collection", ""))
                if c is None:
                    self.send_json({"error": "no such collection"}, HTTPStatus.NOT_FOUND)
                    return
                if action == "delete":
                    collections.remove(c)
                else:
                    name = clean_name(body.get("name"))
                    other = find_collection(collections, slugify(name))
                    if other is not None and other is not c:
                        self.send_json({"error": f"there is already a collection called {name}"},
                                       HTTPStatus.CONFLICT)
                        return
                    c["name"] = name
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            write_collections(self.root, collections)
        slug = slugify(body.get("name", "")) if action != "delete" else None
        self.send_json({"ok": True, "slug": slug})

    def api_post(self, body: dict) -> None:
        """Save a collection's post layout (null clears it back to one photo per slide).
        With a base revision, a save made from an older version than the
        collection holds is refused, with the current one sent back."""
        post = body.get("post")
        cleaned = clean_post(post) if post is not None else None

        def change(c):
            if "base" in body and body["base"] != collection_rev(self.root, body["collection"]):
                return ({"error": "changed elsewhere", "rev": collection_rev(self.root, body["collection"]),
                         "items": c.get("items", []), "post": c.get("post")}, HTTPStatus.CONFLICT)
            if cleaned is None:
                c.pop("post", None)
            else:
                c["post"] = cleaned

        self._with_collection(body["collection"], change)

    def api_post_export(self, slug: str, n: str, of: str, single: bool = False) -> None:
        """Save slide n (1-based) of `of` as shoots/posts/<slug>/NN.jpg.

        Slide 1 of a full export clears the folder first, so a shorter
        re-export leaves no stale slides behind. A single-slide export replaces
        just that file and is stamped with the current time.
        """
        if not find_collection(read_collections(self.root), slug):
            self.send_json({"error": "no such collection"}, HTTPStatus.NOT_FOUND)
            return
        if not (n.isdigit() and of.isdigit() and 1 <= int(n) <= int(of) <= POST_MAX_SLIDES):
            raise ValueError("n and of must be slide numbers")
        data = self.read_body()
        if data[:3] != b"\xff\xd8\xff":
            raise ValueError("slides must be JPEGs")
        folder = self.root / "posts" / slug
        folder.mkdir(parents=True, exist_ok=True)
        batch = folder / ".exported"            # this export's time, shared by its slides
        if single:
            when = datetime.now()
        else:
            if n == "1":
                for old in folder.glob("*.jpg"):
                    old.unlink()
                atomic_write(batch, datetime.now().isoformat(timespec="seconds"))
            start = datetime.fromisoformat(batch.read_text().strip()) if batch.is_file() else datetime.now()
            when = start + timedelta(seconds=int(n) - 1)
        out = folder / f"{int(n):02d}.jpg"
        tmp = out.with_suffix(".part.jpg")
        tmp.write_bytes(with_capture_time(data, when))
        tmp.replace(out)
        self.send_json({"path": str(out.relative_to(self.root))})

    def api_send(self, body: dict) -> None:
        """Taildrop exports to one of your devices: a collection's slides
        ({collection, slide?}) or photos' exports ({frames: [{shoot, key}]})."""
        device = body["device"]
        reveal = device == "__reveal__"
        if not reveal and not tailscale():
            self.send_json({"error": "Tailscale isn't installed on this computer"}, HTTPStatus.CONFLICT)
            return
        # Only a device Taildrop itself lists: never an arbitrary name.
        if not reveal and device not in {d["name"] for d in taildrop_targets()}:
            self.send_json({"error": f"{device} isn't one of your Taildrop devices"}, HTTPStatus.BAD_REQUEST)
            return
        if "frames" in body:
            self._send_frames(body["frames"], device)
            return
        slug = body["collection"]
        folder = self.root / "posts" / slug
        slides = sorted(folder.glob("[0-9][0-9].jpg")) if SAFE_NAME.match(slug) else []
        only = body.get("slide")          # one slide number, or all of them
        if only is not None:
            slides = [f for f in slides if f.name == f"{int(only):02d}.jpg"]
        if not slides:
            self.send_json({"error": "no exported slides yet: export first"}, HTTPStatus.CONFLICT)
            return
        if reveal:
            reveal_exports(slides)
            self.send_json({"provider": "reveal", "sent": [f.name for f in slides], "failed": []})
            return
        # Name each export by its time, so a second send never collides with the first.
        batch = folder / ".exported"
        stamp = datetime.now() if only is not None else (
            datetime.fromisoformat(batch.read_text().strip()) if batch.is_file() else datetime.now())
        tag = stamp.strftime("%Y%m%d-%H%M%S")
        sent, failed = [], []
        for f in slides:
            error = taildrop(f, device, f"{slug}-{tag}-{f.name}")
            (failed.append({"file": f.name, "error": error}) if error else sent.append(f.name))
        self.send_json({"device": device, "sent": sent, "failed": failed},
                       HTTPStatus.OK if not failed else HTTPStatus.BAD_GATEWAY)

    def _send_frames(self, frames: object, device: str) -> None:
        """Taildrop each frame's export, named <key>-<time>.jpg."""
        if not isinstance(frames, list) or not frames:
            raise ValueError("frames must be a non-empty list")
        files = []
        for ref in frames:
            found = self.frame(str(ref.get("shoot", "")), str(ref.get("key", ""))) \
                if isinstance(ref, dict) else None
            if not found:
                self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
                return
            out = found[0] / EXPORT_DIR / f"{frame_key(found[1])}.jpg"
            if not out.is_file():
                self.send_json({"error": f"{out.stem} isn't exported yet: export first"}, HTTPStatus.CONFLICT)
                return
            files.append(out)
        if device == "__reveal__":
            reveal_exports(files)
            self.send_json({"provider": "reveal", "sent": [f.name for f in files], "failed": []})
            return
        tag = datetime.now().strftime("%Y%m%d-%H%M%S")
        sent, failed = [], []
        for f in files:
            error = taildrop(f, device, f"{f.stem}-{tag}.jpg")
            (failed.append({"file": f.name, "error": error}) if error else sent.append(f.name))
        self.send_json({"device": device, "sent": sent, "failed": failed},
                       HTTPStatus.OK if not failed else HTTPStatus.BAD_GATEWAY)

    def _with_collection(self, slug: str, change) -> None:
        """Load collections, apply change(c) -> response or None, save, reply."""
        with _write_lock:
            collections = read_collections(self.root)
            c = find_collection(collections, slug)
            if c is None:
                self.send_json({"error": "no such collection"}, HTTPStatus.NOT_FOUND)
                return
            error = change(c)
            if error:
                self.send_json(*error)
                return
            write_collections(self.root, collections)
            rev = collection_rev(self.root, slug)
        self.send_json({"selects": c.get("items", []), "rev": rev})

    def api_select(self, body: dict) -> None:
        """Add a frame to a collection, or take it out. Order is kept; new ones go last."""
        shoot, key, selected = body["shoot"], body["key"], bool(body["selected"])
        if not self.frame(shoot, key):
            self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
            return
        ref = f"{shoot}/{key}"

        def change(c):
            items = [r for r in c.get("items", []) if r != ref]
            c["items"] = items + [ref] if selected else items

        self._with_collection(body["collection"], change)

    def api_reorder(self, body: dict) -> None:
        """Put a collection in a new order. Only reorders, never adds or drops."""
        order = body["selects"]
        if not isinstance(order, list) or not all(isinstance(r, str) for r in order):
            raise ValueError("selects must be a list of shoot/key strings")

        def change(c):
            current = c.get("items", [])
            if sorted(order) != sorted(current):
                # Changed meanwhile, e.g. from another window: send it back rather than guess.
                return ({"error": "collection changed; reload", "selects": current},
                        HTTPStatus.CONFLICT)
            c["items"] = list(order)

        self._with_collection(body["collection"], change)

    def api_proposal(self, body: dict) -> None:
        """Store a suggested edit next to the frame, or clear it (params null)."""
        found = self.frame(body["shoot"], body["key"])
        if not found:
            self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
            return
        path = proposal_path(found[0], body["key"])
        with _write_lock:
            if body.get("params") is None:
                path.unlink(missing_ok=True)
                self.send_json({"proposal": None})
                return
            proposal = {
                "params": clean_edit(body["params"]),
                "note": str(body.get("note", ""))[:500],
                "created": datetime.now().isoformat(timespec="seconds"),
            }
            atomic_write(path, json.dumps(proposal, indent=2) + "\n")
        self.send_json({"proposal": proposal})

    def api_edit(self, body: dict) -> None:
        found = self.frame(body["shoot"], body["key"])
        if not found:
            self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
            return
        path = edit_path(found[0], body["key"])
        params = body.get("params")
        recipe = clean_edit(params) if params is not None else None
        has_raw = body["key"] in raw_sources(found[0])
        if recipe and recipe.get("source") == "raw" and not has_raw:
            raise ValueError("this frame has no raw file")
        with _write_lock:
            # Refuse a save made from an older version than the file holds:
            # send the current one back for the page to take up instead.
            current = edit_rev(path)
            if "base" in body and body["base"] != current:
                self.send_json({"error": "changed elsewhere", "rev": current,
                                "params": json.loads(path.read_text()) if path.is_file() else None},
                               HTTPStatus.CONFLICT)
                return
            # A recipe that changes nothing is no recipe: keep the folder clean.
            # Naming the source an unedited frame would use anyway changes nothing.
            if recipe is None or recipe in ({"version": 1},
                                            {"version": 1, "source": default_source(has_raw)}):
                path.unlink(missing_ok=True)
                recipe = None
            else:
                atomic_write(path, json.dumps(recipe, indent=2, sort_keys=True) + "\n")
            rev = edit_rev(path)
        self.send_json({"key": body["key"], "params": recipe, "rev": rev})

    def api_export(self, shoot: str, key: str, review: bool = False, tag: str = "") -> None:
        """Save a rendered JPEG: the frame's export, or with review a scratch
        copy in shoots/.review/ that leaves the real export alone."""
        found = self.frame(shoot, key)
        if not found:
            self.send_json({"error": "no such frame"}, HTTPStatus.NOT_FOUND)
            return
        data = self.read_body()
        if data[:3] != b"\xff\xd8\xff":
            raise ValueError("export must be a JPEG")
        tag = re.sub(r"[^A-Za-z0-9_-]", "", tag)[:40]
        name = f"{shoot}_{key}" + (f"_{tag}" if tag else "")
        out = (self.root / ".review" / f"{name}.jpg") if review else found[0] / EXPORT_DIR / f"{key}.jpg"
        out.parent.mkdir(exist_ok=True)
        tmp = out.with_suffix(".part.jpg")
        tmp.write_bytes(data)
        tmp.replace(out)
        self.send_json({"key": key, "path": str(out.relative_to(self.root)), "bytes": len(data)})


# --- cli ---------------------------------------------------------------------


def supervise(argv: list[str], url: str, open_browser: bool) -> int:
    """Run the server as a child and restart it whenever the server code changes.

    A child that fails to start (a syntax error mid-edit, say) is simply
    started again after the next save. This loop itself is only reloaded by
    restarting Framewright by hand.
    """
    import signal
    import subprocess as sp

    # Stopped by kill rather than ctrl-c: take the child down too.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    cmd = [sys.executable, "-m", "framewright", *argv, "--no-reload", "--no-browser"]
    seen = mtimes(SERVER_CODE)
    child = sp.Popen(cmd)
    if open_browser:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(0.5)
            now = mtimes(SERVER_CODE)
            if now != seen:
                seen = now
                print("server code changed; restarting", flush=True)
                child.terminate()
                try:
                    child.wait(timeout=5)
                except sp.TimeoutExpired:
                    child.kill()
                child = sp.Popen(cmd)
    except KeyboardInterrupt:
        child.terminate()
        print()
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--library", help="directory holding shoot folders")
    parser.add_argument("--port", type=int, help="server port (config port, otherwise 8765)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    parser.add_argument("--no-reload", action="store_true",
                        help="run one server, without restarting it when the code changes")
    raw = sys.argv[1:] if argv is None else argv
    args = parser.parse_args(raw)
    try:
        load_config()  # Report malformed config before starting the supervisor.
        args.port = configured_port(args.port)
        library = resolve_library(args.library)
        if library is not None:
            library.mkdir(parents=True, exist_ok=True)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    url = f"http://localhost:{args.port}"
    if not args.no_reload:
        return supervise([a for a in raw if a != "--no-browser"], url, not args.no_browser)

    Handler.root = library
    ThreadingHTTPServer.allow_reuse_address = True   # restart straight onto the same port
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"library: {Handler.root}" if library else "choose a library folder in the browser")
    print(f"serving {url}  (ctrl-c to stop; boot {BOOT_ID})", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
