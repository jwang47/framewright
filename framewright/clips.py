"""Video clips in the library: listing, metadata, poster frames and playback.

Import puts a shoot's clips in <shoot>/video/ (or on the store, noted in
store.json, like images). Each Sony clip carries a <key>M01.XML sidecar with
its duration, frame rate, codec, picture profile and lens; that is read once
and cached beside the previews, so a shoot still lists its clips' details
with the drive unplugged.

Poster frames need ffmpeg (or macOS Quick Look as a fallback). Log footage
gets an approximate display conversion so the grid isn't a wall of grey; the
page applies the same curve during playback (web/videos.js). This is a
viewing aid, not a grade: no third-party LUT is involved.

Stdlib only.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from .import_photos import VIDEO_EXTS, frame_key
from .store import stored

CLIP_DIR = "clips"          # under the shoot's preview folder
POSTER_PX = 480
CHUNK = 1024 * 1024

_locks: dict[Path, threading.Lock] = {}
_guard = threading.Lock()


def _lock(path: Path) -> threading.Lock:
    with _guard:
        return _locks.setdefault(path, threading.Lock())


# --- finding clips -----------------------------------------------------------


def _files(shoot_dir: Path) -> dict[str, Path]:
    """File name -> path for everything in the shoot's video/, local then store."""
    out: dict[str, Path] = {}
    local = shoot_dir / "video"
    if local.is_dir():
        out.update({f.name: f for f in local.iterdir() if f.is_file()})
    for name, (path, _) in stored(shoot_dir, "video").items():
        out.setdefault(name, path)
    return out


def clip_files(shoot_dir: Path) -> dict[str, Path]:
    """Clip key -> its video file, whether or not the drive is plugged in."""
    return {frame_key(path): path for name, path in sorted(_files(shoot_dir).items())
            if path.suffix.lower() in VIDEO_EXTS}


def has_clips(shoot_dir: Path) -> bool:
    return bool(clip_files(shoot_dir))


def sidecar(shoot_dir: Path, key: str) -> Path | None:
    for name, path in _files(shoot_dir).items():
        if name.upper().startswith(key.upper()) and name.upper().endswith(".XML"):
            return path
    return None


# --- metadata ----------------------------------------------------------------


def _fps(text: str) -> float | None:
    match = re.match(r"([\d.]+)", text or "")
    return float(match.group(1)) if match else None


def parse_sidecar(text: str) -> dict:
    """The parts of a Sony NonRealTimeMeta sidecar worth showing."""
    def attr(tag: str, name: str) -> str | None:
        element = re.search(rf"<{tag}\b[^>]*>", text)
        value = element and re.search(rf'\b{name}="([^"]*)"', element.group())
        return value.group(1) if value else None

    def item(name: str) -> str | None:
        match = re.search(rf'<Item name="{name}" value="([^"]*)"', text)
        return match.group(1) if match else None

    meta: dict = {}
    frames, fps = attr("Duration", "value"), _fps(attr("VideoFrame", "formatFps") or "")
    capture = _fps(attr("VideoFrame", "captureFps") or "")
    if frames and fps:
        meta["duration"] = round(int(frames) / fps, 2)
    if fps:
        meta["fps"] = fps
    if capture and fps and abs(capture - fps) > 0.5:
        meta["captureFps"] = capture
    width, height = attr("VideoLayout", "pixel"), attr("VideoLayout", "numOfVerticalLine")
    if width and height:
        meta["size"] = f"{width}×{height}"
    codec = attr("VideoFrame", "videoCodec")
    if codec:
        meta["codec"] = codec.split("_", 1)[0]
    for key, value in (("gamma", item("CaptureGammaEquation")), ("gamut", item("CaptureColorPrimaries")),
                       ("lens", attr("Lens", "modelName")), ("created", attr("CreationDate", "value"))):
        if value:
            meta[key] = value
    camera = " ".join(filter(None, (attr("Device", "manufacturer"), attr("Device", "modelName"))))
    if camera:
        meta["camera"] = camera
    return meta


def is_log(meta: dict) -> bool:
    return "log" in meta.get("gamma", "").lower()


def clip_meta(shoot_dir: Path, key: str, path: Path) -> dict:
    """Sidecar details for one clip, cached so they survive an unplugged drive."""
    cache = shoot_dir / ".preview" / CLIP_DIR / f"{key}.json"
    try:
        return json.loads(cache.read_text())
    except (OSError, ValueError):
        pass
    side = sidecar(shoot_dir, key)
    try:
        meta = parse_sidecar(side.read_text(encoding="utf-8", errors="replace")) if side else {}
    except OSError:
        return {}           # drive unplugged and nothing cached yet
    try:
        meta["bytes"] = path.stat().st_size
    except OSError:
        return meta
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(meta))
    return meta


def shot_at(meta: dict, path: Path, shoot_dir: Path) -> datetime:
    if meta.get("created"):
        try:
            return datetime.fromisoformat(meta["created"]).replace(tzinfo=None)
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        when = stored(shoot_dir, "video").get(path.name, (path, 0.0))[1]
        return datetime.fromtimestamp(when)


def list_clips(shoot_dir: Path, picks: set[str], rejects: frozenset[str] | set[str] = frozenset()) -> list[dict]:
    """A shoot's clips in recording order, for the Videos tab."""
    out = []
    for key, path in clip_files(shoot_dir).items():
        meta = clip_meta(shoot_dir, key, path)
        when = shot_at(meta, path, shoot_dir)
        out.append({"shoot": shoot_dir.name, "key": key, "name": path.name,
                    "at": when.isoformat(timespec="seconds"), "time": when.strftime("%H:%M:%S"),
                    "picked": key in picks, "rejected": key in rejects,
                    "online": path.is_file(), "log": is_log(meta),
                    "where": "local" if path.parent.parent == shoot_dir else "store",
                    **{k: v for k, v in meta.items() if k != "created"}})
    return sorted(out, key=lambda c: (c["at"], c["key"]))


# --- poster frames -----------------------------------------------------------


def log_preview(v: float) -> float:
    """Approximate S-Log3 code value -> display value, for viewing only.

    Decodes with Sony's published S-Log3 formula, then a soft filmic shoulder
    and a 2.2 display gamma. web/videos.js has the same curve as a shader.
    """
    code = v * 1023
    lin = (10 ** ((code - 420) / 261.5) * 0.19 - 0.01 if code >= 171.2102946929
           else (code - 95) * 0.01125 / (171.2102946929 - 95))
    x = max(lin, 0.0) * 1.4
    y = x * (1 + x / 36) / (1 + x)
    return min(max(y, 0.0), 1.0) ** (1 / 2.2)


def _curve_file(folder: Path) -> Path:
    path = folder / "log-preview.cube"
    if not path.is_file():
        rows = [f"{log_preview(i / 1023):.6f}" for i in range(1024)]
        path.write_text("LUT_1D_SIZE 1024\n" + "".join(f"{r} {r} {r}\n" for r in rows))
    return path


def poster(shoot_dir: Path, key: str) -> Path | None:
    """A cached JPEG still from early in the clip; None if no tool can make one."""
    path = clip_files(shoot_dir).get(key)
    if path is None:
        raise KeyError(key)
    folder = shoot_dir / ".preview" / CLIP_DIR
    out = folder / f"{key}.jpg"
    with _lock(out):
        if out.is_file():
            return out
        if not path.is_file():
            raise FileNotFoundError(f"{path.name} is on a drive that is not plugged in")
        folder.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".part.jpg")
        meta = clip_meta(shoot_dir, key, path)
        if shutil.which("ffmpeg"):
            vf = f"scale={POSTER_PX}:-2"
            if is_log(meta):
                curve = str(_curve_file(folder)).replace("\\", "/").replace(":", "\\:")
                vf += f",format=rgb24,lut1d=file='{curve}',eq=saturation=1.25"
            seek = str(min(1.0, meta.get("duration", 2) / 2))
            cmd = ["ffmpeg", "-v", "error", "-y", "-ss", seek, "-i", str(path),
                   "-frames:v", "1", "-vf", vf, "-q:v", "4", str(tmp)]
            subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        elif sys.platform == "darwin":
            # Quick Look renders the clip's first frame; no log conversion.
            subprocess.run(["qlmanage", "-t", "-s", str(POSTER_PX), "-o", str(folder), str(path)],
                           check=True, capture_output=True, timeout=60)
            png = folder / f"{path.name}.png"
            subprocess.run(["sips", "-s", "format", "jpeg", str(png), "--out", str(tmp)],
                           check=True, capture_output=True, timeout=60)
            png.unlink(missing_ok=True)
        else:
            return None
        tmp.replace(out)
        return out


def warm_posters(shoot_dir: Path) -> None:
    for key in clip_files(shoot_dir):
        try:
            poster(shoot_dir, key)
        except (subprocess.SubprocessError, OSError, KeyError):
            pass


# --- playback ----------------------------------------------------------------


def byte_range(header: str | None, size: int) -> tuple[int, int] | None:
    """(start, end inclusive) from a Range header, None for the whole file.

    Raises ValueError for a range that can't be satisfied. Browsers ask for
    ranges to seek; Safari and WKWebView won't play video served without them.
    """
    if not header:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match or match.groups() == ("", ""):
        raise ValueError("unsupported range")
    first, last = match.groups()
    if first == "":
        start, end = max(0, size - int(last)), size - 1
    else:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
    if start > end or start >= size:
        raise ValueError("unsatisfiable range")
    return start, end


def reveal(path: Path, open_it: bool = False) -> None:
    """Show a clip in the file manager, or open it in the default player."""
    if not path.is_file():
        raise ValueError(f"{path.name} is on a drive that is not plugged in")
    if sys.platform == "darwin":
        cmd = ["open", str(path)] if open_it else ["open", "-R", str(path)]
    elif sys.platform == "win32":
        cmd = ["explorer.exe", str(path)] if open_it else ["explorer.exe", "/select,", str(path)]
    else:
        opener = shutil.which("xdg-open")
        if not opener:
            raise ValueError("no file manager found; install xdg-open")
        cmd = [opener, str(path if open_it else path.parent)]
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise ValueError(f"could not open {path.name}: {exc}") from exc
