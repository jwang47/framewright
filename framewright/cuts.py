"""Video cuts: an edit of clips from the library, kept as JSON, rendered with ffmpeg.

A cut lives at <library>/cuts/<slug>.cut.json:

    {"version": 1, "name": "Lansdown Ct reel", "log709": true,
     "clips": [{"shoot": "2026-10-12_sony-ilme-fx30", "key": "C0091",
                "in": 1.25, "out": 5.0}, ...]}

One video track whose audio follows its pictures: each clip plays from `in`
to `out` seconds of its file, at `speed` (0.2 plays 120p footage as 24p slow
motion, silently), joined by a cut or by a `trans` into it ({"type": "cross"
or "dip", "dur": seconds}). Optional: `clipGain` (dB, the clips' own sound),
`music` ({"file" in <library>/music, "start" seconds into it, "gain" dB,
"fade" seconds at both ends}) and `titles` ([{"text", "at", "dur", "style":
"center" or "lower"}], in seconds of the finished cut). Like photo recipes, it's
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
MAX_TITLES = 50
MUSIC_DIR = "music"
MUSIC_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac"}
TRANSITIONS = ("cross", "dip")
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
        clip = {"shoot": shoot, "key": key, "in": round(float(start), 3), "out": round(float(end), 3)}
        speed = c.get("speed", 1)
        if not isinstance(speed, (int, float)) or isinstance(speed, bool) or not 0.05 <= speed <= 4:
            raise ValueError(f"{key}: speed runs from 0.05 to 4")
        if speed != 1:
            clip["speed"] = round(float(speed), 4)
        trans = c.get("trans")
        if trans and out:
            if not isinstance(trans, dict) or trans.get("type") not in TRANSITIONS:
                raise ValueError(f"{key}: a transition is cross or dip")
            dur = trans.get("dur", 0.5)
            longest = min(length(clip), length(out[-1])) / 2
            if not isinstance(dur, (int, float)) or isinstance(dur, bool) or dur <= 0:
                raise ValueError(f"{key}: a transition needs a length")
            clip["trans"] = {"type": trans["type"], "dur": round(min(float(dur), longest), 3)}
        out.append(clip)
    result = {"version": 1, "name": name.strip(), "log709": bool(cut.get("log709", True)), "clips": out}
    gain = cut.get("clipGain", 0)
    if not isinstance(gain, (int, float)) or isinstance(gain, bool) or not -60 <= gain <= 12:
        raise ValueError("clipGain runs from -60 to 12 dB")
    if gain:
        result["clipGain"] = round(float(gain), 1)
    music = cut.get("music")
    if music:
        if not isinstance(music, dict) or not isinstance(music.get("file"), str) or not SAFE.match(music["file"]) \
                or Path(music["file"]).suffix.lower() not in MUSIC_EXTS:
            raise ValueError("music needs a file from the library's music folder")
        nums = {k: music.get(k, d) for k, d in (("start", 0), ("gain", 0), ("fade", 1.5))}
        if any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in nums.values()) \
                or nums["start"] < 0 or not -60 <= nums["gain"] <= 12 or not 0 <= nums["fade"] <= 30:
            raise ValueError("music start, gain (dB) and fade are numbers in range")
        result["music"] = {"file": music["file"], **{k: round(float(v), 3) for k, v in nums.items()}}
    titles = cut.get("titles", [])
    if not isinstance(titles, list) or len(titles) > MAX_TITLES:
        raise ValueError(f"titles must be a list of at most {MAX_TITLES}")
    clean_titles = []
    for t in titles:
        if not isinstance(t, dict) or not isinstance(t.get("text"), str) or not t["text"].strip() or len(t["text"]) > 200:
            raise ValueError("each title needs text of up to 200 characters")
        at, dur = t.get("at", 0), t.get("dur", 3)
        if any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in (at, dur)) or at < 0 or not 0.2 <= dur <= 600:
            raise ValueError("a title's at and dur are seconds")
        style = t.get("style", "center")
        if style not in ("center", "lower"):
            raise ValueError("a title's style is center or lower")
        clean_titles.append({"text": t["text"].strip(), "at": round(float(at), 3), "dur": round(float(dur), 3), "style": style})
    if clean_titles:
        result["titles"] = sorted(clean_titles, key=lambda t: t["at"])
    return result


def length(clip: dict) -> float:
    """Seconds a clip runs in the cut, after its speed."""
    return (clip["out"] - clip["in"]) / clip.get("speed", 1)


def starts(items: list[dict]) -> list[float]:
    """Where each clip begins in the cut; a transition overlaps the clip before."""
    out, t = [], 0.0
    for i, c in enumerate(items):
        if i:
            t -= c.get("trans", {}).get("dur", 0)
        out.append(t)
        t += length(c)
    return out


def running_time(items: list[dict]) -> float:
    return (starts(items)[-1] + length(items[-1])) if items else 0.0


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
        try:
            duration = running_time(items)
        except (KeyError, TypeError):
            duration = 0.0
        out.append({"slug": path.name[:-len(SUFFIX)], "name": cut.get("name", path.stem),
                    "clips": len(items), "duration": round(duration, 2),
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


FONTS = ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/arialbd.ttf")


def music_files(root: Path) -> list[str]:
    folder = root / MUSIC_DIR
    return sorted(f.name for f in folder.iterdir() if f.suffix.lower() in MUSIC_EXTS) if folder.is_dir() else []


def _esc(path: Path | str) -> str:
    """A path inside an ffmpeg filter argument."""
    return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def title_filter(t: dict, text_file: Path) -> str:
    end, fade = t["at"] + t["dur"], min(0.3, t["dur"] / 3)
    alpha = (f"if(lt(t\\,{t['at'] + fade:.3f})\\,(t-{t['at']:.3f})/{fade:.3f}\\,"
             f"if(gt(t\\,{end - fade:.3f})\\,({end:.3f}-t)/{fade:.3f}\\,1))")
    font = next((f for f in FONTS if Path(f).is_file()), None)
    parts = [f"textfile='{_esc(text_file)}'", "fontcolor=white", f"alpha='{alpha}'",
             f"enable='between(t\\,{t['at']:.3f}\\,{end:.3f})'", "x=(w-text_w)/2"]
    if font:
        parts.append(f"fontfile='{_esc(font)}'")
    if t["style"] == "lower":
        parts += ["fontsize=h/18", "y=h*0.80", "box=1", "boxcolor=black@0.45", "boxborderw=h/60"]
    else:
        parts += ["fontsize=h/11", "y=(h-text_h)/2", "shadowcolor=black@0.5", "shadowx=2", "shadowy=2"]
    return "drawtext=" + ":".join(parts)


def render_command(root: Path, cut: dict, size: str, codec: str, out: Path) -> tuple[list[str], float]:
    """The ffmpeg command for a cut, and its running time in seconds."""
    items = cut["clips"]
    if not items:
        raise ValueError("the cut is empty")
    if size not in SIZES or codec not in CODECS:
        raise ValueError("unknown size or codec")
    height = SIZES[size]
    scale = f"scale=-2:{height}" if height else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    inputs, graph, fps = [], [], None
    lengths = []
    for i, c in enumerate(items):
        d = root / c["shoot"]
        path = clips.clip_files(d).get(c["key"]) if d.is_dir() else None
        if path is None:
            raise ValueError(f"{c['shoot']}/{c['key']} is not in the library")
        if not path.is_file():
            raise ValueError(f"{path.name} is on a drive that is not plugged in")
        meta = clips.clip_meta(d, c["key"], path)
        fps = fps or meta.get("fps") or 30
        speed, span = c.get("speed", 1), c["out"] - c["in"]
        lengths.append(span / speed)
        inputs += ["-ss", f"{c['in']:.3f}", "-t", f"{span:.3f}", "-i", str(path)]
        chain = [f"setpts=(PTS-STARTPTS)/{speed}", scale, "setsar=1", f"fps={fps}"]
        if cut.get("log709") and clips.is_log(meta):
            folder = d / ".preview" / clips.CLIP_DIR
            folder.mkdir(parents=True, exist_ok=True)
            chain += ["format=rgb24", f"lut1d=file='{_esc(clips._curve_file(folder))}'", "eq=saturation=1.25"]
        graph.append(f"[{len(inputs) // 6 - 1}:v]" + ",".join([*chain, "format=yuv420p", "settb=AVTB"]) + f"[v{i}]")
        graph.append((i, path, speed))
    # Sound: each clip's own (slow motion is silent), at clipGain.
    gain = cut.get("clipGain", 0)
    n_clips = len(items)
    audio_graph = []
    extra = []
    for entry in [g for g in graph if isinstance(g, tuple)]:
        i, path, speed = entry
        if speed == 1 and has_audio(path):
            audio_graph.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,volume={gain}dB,asetpts=PTS-STARTPTS[a{i}]")
        else:
            idx = n_clips + len(extra) // 6
            extra += ["-f", "lavfi", "-t", f"{lengths[i]:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
            audio_graph.append(f"[{idx}:a]anull[a{i}]")
    graph = [g for g in graph if not isinstance(g, tuple)] + audio_graph
    # Join: a cut concatenates, a transition overlaps the end of what came before.
    v, a, run = "v0", "a0", lengths[0]
    for i in range(1, n_clips):
        trans = items[i].get("trans")
        if trans:
            d = trans["dur"]
            kind = "fadeblack" if trans["type"] == "dip" else "fade"
            graph.append(f"[{v}][v{i}]xfade=transition={kind}:duration={d:.3f}:offset={run - d:.3f}[vj{i}]")
            graph.append(f"[{a}][a{i}]acrossfade=d={d:.3f}[aj{i}]")
            run += lengths[i] - d
        else:
            graph.append(f"[{v}][{a}][v{i}][a{i}]concat=n=2:v=1:a=1[vj{i}][aj{i}]")
            run += lengths[i]
        v, a = f"vj{i}", f"aj{i}"
    total = run
    titles = cut.get("titles", [])
    if titles:
        folder = root / ".preview" / "titles"
        folder.mkdir(parents=True, exist_ok=True)
        draws = []
        for k, t in enumerate(titles):
            text_file = folder / f"{slugify(cut['name']) or 'cut'}-{k}.txt"
            text_file.write_text(t["text"])
            draws.append(title_filter(t, text_file))
        graph.append(f"[{v}]" + ",".join(draws) + "[vt]")
        v = "vt"
    music = cut.get("music")
    if music:
        song = root / MUSIC_DIR / music["file"]
        if not song.is_file():
            raise ValueError(f"music file {music['file']} is missing from the library")
        idx = n_clips + len(extra) // 6
        extra += ["-ss", f"{music['start']:.3f}", "-i", str(song)]
        fade = min(music["fade"], total / 2)
        chain = [f"[{idx}:a]aresample=48000", "aformat=channel_layouts=stereo", f"volume={music['gain']}dB",
                 f"atrim=0:{total:.3f}"]
        if fade:
            chain += [f"afade=t=in:d={fade:.3f}", f"afade=t=out:st={total - fade:.3f}:d={fade:.3f}"]
        graph.append(",".join(chain) + "[mus]")
        graph.append(f"[{a}][mus]amix=inputs=2:duration=first:normalize=0[am]")
        a = "am"
    cmd = ["ffmpeg", "-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-loglevel", "error",
           *inputs, *extra, "-filter_complex", ";".join(graph), "-map", f"[{v}]", "-map", f"[{a}]",
           *encoder(codec), "-c:a", "aac", "-b:a", "256k", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)]
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
