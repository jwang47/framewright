#!/usr/bin/env python3
"""Import new frames from a camera card into the shoot library.

Finds a camera card, works out which frames are not in the library yet,
copies them into <library>/<date>_<name>/raw/, and verifies every copy with
SHA256 before reporting success. The card is unchanged unless --delete-from-card is explicitly enabled.

Typical use, card plugged in:

    python -m framewright import                 # everything new
    python -m framewright import --last 12       # newest 12 frames only
    python -m framewright import --dry-run       # show the plan, copy nothing
    python -m framewright import --jpeg-only     # camera JPEGs only, raws stay on the card
    python -m framewright import --offload       # move every shoot's images to the drive
    python -m framewright import --offload 2026-09-27_camera   # just this one

With a configured store available, the images go straight onto it and the
shoot's store.json notes them; picks and recipes still live in the library.
Without it, or with --local, images land in the library, and --offload moves
them over later.

A "frame" is all files sharing a basename (DSC00023.ARW + DSC00023.JPG),
and frames are grouped into shoot folders by capture date, so a card holding
two days of shooting imports into two shoots. Each folder is named after the
camera that shot the day, as in 2026-09-02_camera; pass --name to override.

Stdlib only, no venv needed.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import re
import os
import shutil
import string
import struct
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from .store import drive_name, read_manifest, record, store_mounted, store_root  # noqa: E402
from .settings import resolve_library, import_settings, validate_shoot_pattern  # noqa: E402

RAW_EXTS = {".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw"}
JPEG_EXTS = {".jpg", ".jpeg", ".heic", ".heif"}
SIDECAR_EXTS = {".xmp", ".thm", ".lrv"}
VIDEO_EXTS = {".mp4", ".mov", ".mts", ".m2ts"}
IMAGE_EXTS = RAW_EXTS | JPEG_EXTS
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Sony names each clip's metadata sidecar <clip>M01.XML; that has to fold back
# onto the clip's own key or the sidecar imports as a frame of its own.
CLIP_SIDECAR = re.compile(r"^(C\d{4})M\d{2}$", re.IGNORECASE)

# Sony writes XAVC S clips to M4ROOT/CLIP, but where M4ROOT sits depends on the
# card: under PRIVATE/ on SD, at the card root on CFexpress Type A. Checking
# only one layout silently finds no card at all on the other.
M4ROOT_PARENTS = ("PRIVATE", ".")

CHUNK = 8 * 1024 * 1024

# Enough of a file to hold IFD0; the model sits near the top of both ARW and JPEG.
TIFF_SCAN = 256 * 1024


class ImportError_(Exception):
    """Anything that should stop the import with a readable message."""


# --- locating things ---------------------------------------------------------


def default_library() -> Path:
    """Resolve the configured library, never the application checkout."""
    library = resolve_library()
    if library is None:
        raise ImportError_(
            "no library configured; pass --library <path>, set STUDIO_LIBRARY, "
            "or choose a library in Framewright"
        )
    return library


def windows_removable(root: str) -> bool:
    """Ask Windows for DRIVE_REMOVABLE, excluding fixed and network drives."""
    import ctypes
    try:
        get_drive_type = ctypes.windll.kernel32.GetDriveTypeW
        get_drive_type.argtypes = [ctypes.c_wchar_p]
        get_drive_type.restype = ctypes.c_uint
        return get_drive_type(root) == 2
    except (AttributeError, OSError):
        return False


def candidate_card_roots() -> list[Path]:
    """Plausible mount points to search for a DCIM folder."""
    roots: list[Path] = []
    if sys.platform == "win32":
        roots += [Path(f"{letter}:\\") for letter in string.ascii_uppercase
                  if windows_removable(f"{letter}:\\")]
    else:
        for base in (Path("/Volumes"), Path("/media"), Path("/run/media")):
            if not base.is_dir():
                continue
            children = [p for p in base.iterdir() if p.is_dir()]
            roots += children
            # Linux mounts under <base>/<user>/<label>; macOS volumes sit
            # directly in /Volumes, and descending into them would report a
            # card's PRIVATE folder as a card of its own.
            if base != Path("/Volumes"):
                for p in children:
                    try:
                        roots += [q for q in p.iterdir() if q.is_dir()]
                    except PermissionError:
                        pass
    return roots


def clip_dir(root: Path) -> Path | None:
    """The card's CLIP folder, whichever M4ROOT layout it uses."""
    for parent in M4ROOT_PARENTS:
        candidate = root / parent / "M4ROOT" / "CLIP"
        if candidate.is_dir():
            return candidate
    return None


def find_card() -> Path:
    """Return the root of the one plugged-in card."""
    found = [root for root in candidate_card_roots()
             if (root / "DCIM").is_dir() or clip_dir(root) is not None]
    if not found:
        raise ImportError_(
            "no camera card found (looked for a DCIM folder on removable volumes).\n"
            "Plug the card in, or pass --source <path to DCIM or card root>."
        )
    if len(found) > 1:
        listing = "\n".join(f"  {p}" for p in found)
        raise ImportError_(f"multiple cards found; pick one with --source:\n{listing}")
    return found[0]


def resolve_source(source: str | None) -> Path:
    if source is None:
        return find_card()
    path = Path(source)
    if not path.is_dir():
        raise ImportError_(f"source is not a directory: {path}")
    # Accept the card root, or the DCIM / CLIP folder itself.
    if path.name.upper() == "CLIP":
        # <card>/M4ROOT/CLIP, or <card>/PRIVATE/M4ROOT/CLIP.
        root = path.parent.parent
        return root.parent if root.name.upper() == "PRIVATE" else root
    if path.name.upper() == "DCIM":
        return path.parent
    return path


# --- what is already in the library ------------------------------------------


def frame_key(path: Path) -> str:
    """DSC00023.ARW -> DSC00023, DSC00023.ARW.xmp -> DSC00023, C0038M01.XML -> C0038."""
    stem = path.name.split(".")[0]
    match = CLIP_SIDECAR.match(stem)
    return match.group(1) if match else stem


def is_video(files: list[Path]) -> bool:
    return any(f.suffix.lower() in VIDEO_EXTS for f in files)


def media_dirs(root: Path) -> list[Path]:
    """Card directories holding media.

    Stills live in DCIM, but Sony writes XAVC S clips to PRIVATE/M4ROOT/CLIP,
    outside DCIM entirely, so scanning only DCIM silently misses every video on
    the card. A path pointing straight at a folder of files is used as-is, so
    --source still works for a loose directory.
    """
    candidates = [root / "DCIM", *(root / parent / "M4ROOT" / "CLIP" for parent in M4ROOT_PARENTS)]
    dirs = [d for d in candidates if d.is_dir()]
    return dirs or [root]


def shoots_root(library: Path) -> Path:
    """The selected library directly holds shoot folders."""
    return library


def imported_frames(library: Path) -> set[str]:
    """Basenames already present anywhere in the library.

    Recipes (.xmp) count as present: a shoot whose raws were archived off
    should not re-import on the next card dump. Clips live in video/ rather
    than raw/, so both are checked.
    """
    root = shoots_root(library)
    if not root.is_dir():
        return set()
    # Frames moved to the external store count too, plugged in or not.
    on_store = {frame_key(Path(rel)) for d in root.iterdir() if d.is_dir() for rel in read_manifest(d)}
    return on_store | {frame_key(f)
                       for sub in ("*/raw/*", "*/video/*")
                       for f in root.glob(sub) if f.is_file()}


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def already_copied(shoot: Path, kind: str, src: Path) -> bool:
    """Per-file identity keeps missing RAW/JPEG/sidecar siblings importable."""
    local = shoot / kind / src.name
    if local.is_file():
        return local.stat().st_size == src.stat().st_size and file_hash(local) == file_hash(src)
    metadata = read_manifest(shoot).get(f"{kind}/{src.name}")
    if not metadata or metadata.get("size") != src.stat().st_size:
        return False
    if metadata.get("sha256"):
        return metadata["sha256"] == file_hash(src)
    # Older manifests have no hash. Size and camera timestamp are stronger
    # than basename-only matching, and preserve offline-library behavior.
    return abs(metadata.get("mtime", -1) - src.stat().st_mtime) < 0.002


def matching_shoot(library: Path, files: list[Path], day: date) -> Path | None:
    if not library.is_dir():
        return None
    found = []
    for shoot in library.iterdir():
        if not shoot.is_dir():
            continue
        # Normal patterns contain the date; custom patterns must too.
        if day.isoformat() not in shoot.name:
            continue
        if any(already_copied(shoot, "video" if is_video(files) else "raw", f)
               for f in files if f.suffix.lower() in MEDIA_EXTS):
            found.append(shoot)
    return found[0] if len(found) == 1 else None


# --- planning ----------------------------------------------------------------


def scan_frames(dirs: list[Path]) -> dict[str, list[Path]]:
    frames: dict[str, list[Path]] = defaultdict(list)
    for d in dirs:
        for f in sorted(d.rglob("*")):
            if not f.is_file():
                continue
            ext = f.suffix.lower()
            # .XML is only taken when it is a clip's own sidecar, never loose.
            if ext in MEDIA_EXTS or (ext == ".xml" and CLIP_SIDECAR.match(f.name.split(".")[0])):
                frames[str(f.parent / frame_key(f))].append(f)
    # Sidecars only travel with a recognized media file, never on their own.
    for d in dirs:
        for f in sorted(d.rglob("*")):
            if f.is_file() and f.suffix.lower() in SIDECAR_EXTS and str(f.parent / frame_key(f)) in frames:
                frames[str(f.parent / frame_key(f))].append(f)
    return {key: files for key, files in frames.items()
            if any(f.suffix.lower() in MEDIA_EXTS for f in files)}


def shot_at(files: list[Path]) -> datetime:
    """Capture time, taken from mtime -- cameras write it as the shot time."""
    return datetime.fromtimestamp(min(f.stat().st_mtime for f in files if f.suffix.lower() in MEDIA_EXTS))


def camera_model(path: Path) -> str | None:
    """Read EXIF make and model from IFD0 in TIFF-based raws or JPEGs.

    Unknown container metadata safely falls back to the generic camera name.
    """
    with path.open("rb") as fh:
        buf = fh.read(TIFF_SCAN)
    if buf[:2] not in (b"II", b"MM"):
        exif = buf.find(b"Exif\x00\x00")
        if exif >= 0 and buf[exif + 6:exif + 8] in (b"II", b"MM"):
            buf = buf[exif + 6:]
        else:
            # CR3/HEIF containers can embed TIFF without JPEG's Exif prefix.
            offsets = [at for marker in (b"II*\x00", b"MM\x00*")
                       if (at := buf.find(marker)) >= 0]
            if not offsets:
                return None
            buf = buf[min(offsets):]
    if buf[:2] not in (b"II", b"MM"):
        return None
    end = "<" if buf[:2] == b"II" else ">"
    values = {}
    try:
        off = struct.unpack_from(end + "I", buf, 4)[0]
        count = struct.unpack_from(end + "H", buf, off)[0]
        for i in range(count):
            entry = off + 2 + i * 12
            tag, typ, num = struct.unpack_from(end + "HHI", buf, entry)
            if tag in (0x010F, 0x0110) and typ == 2:
                at = struct.unpack_from(end + "I", buf, entry + 8)[0] if num > 4 else entry + 8
                if at + num <= len(buf):
                    values[tag] = buf[at:at + num].split(b"\0")[0].decode(errors="replace").strip()
    except (struct.error, IndexError):
        return None
    make, model = values.get(0x010F, ""), values.get(0x0110, "")
    if make and model and not model.casefold().startswith(make.casefold()):
        return f"{make} {model}"
    return model or make or None


def clip_model(path: Path) -> str | None:
    """Camera model from a clip's M01.XML sidecar, or None.

    Clips carry no TIFF header, so a day of video alone has no model to read
    from the media itself; Sony records it in the sidecar instead.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = re.search(r'<Device[^>]*modelName="([^"]*)"', text)
    return (match.group(1).strip() or None) if match else None


def model_slug(model: str) -> str:
    """A portable name for any EXIF make/model."""
    return re.sub(r"[^A-Za-z0-9]+", "-", model).strip("-").lower()[:80] or "camera"


def shoot_name(files: list[Path]) -> str | None:
    """Portable EXIF make/model slug, then clip metadata, or None."""
    for f in files:
        if f.suffix.lower() in IMAGE_EXTS:
            model = camera_model(f)
            if model:
                return model_slug(model)
    for f in files:
        if f.suffix.lower() == ".xml":
            model = clip_model(f)
            if model:
                return model_slug(model)
    return None


def plan(
    root: Path,
    library: Path,
    name: str | None,
    last: int | None,
    force: bool,
    match: str | None = None,
    jpeg_only: bool = False,
    folder_pattern: str | None = None,
) -> dict[Path, list[Path]]:
    """Map destination dir -> source files to copy there.

    Stills land in the shoot's raw/, clips in its video/, so a card holding
    both splits into the two folders of the same shoot.

    jpeg_only keeps just each frame's camera JPEG, for looking through a card
    too big for the disk. Later imports still pick up missing raw siblings.
    """
    folder_pattern = validate_shoot_pattern(folder_pattern or import_settings()[0])
    dirs = media_dirs(root)
    frames = scan_frames(dirs)
    if jpeg_only:
        frames = {k: j for k, fs in frames.items()
                  if (j := [f for f in fs if f.suffix.lower() in JPEG_EXTS])}
    if not frames:
        listing = ", ".join(str(d) for d in dirs)
        raise ImportError_(f"no media files under {listing}")

    # --last means "the newest N frames on the card", so it is applied before
    # dropping already-imported ones -- otherwise re-running would keep walking
    # backwards and pull older frames instead of being a no-op.
    ordered = sorted(frames, key=lambda k: (shot_at(frames[k]), k))
    if last is not None:
        ordered = ordered[-last:]

    if match:
        ordered = [k for k in ordered if fnmatch.fnmatch(frame_key(frames[k][0]), match)]
        if not ordered:
            raise ImportError_(f"no frames on the card match {match!r}")


    # One name per day, read from that day's stills, so a day's clips land in
    # the same shoot folder as the frames rather than in one of their own.
    by_day: dict[date, list[str]] = defaultdict(list)
    for key in ordered:
        by_day[shot_at(frames[key]).date()].append(key)
    names = {
        day: model_slug(name) if name else shoot_name([f for k in keys for f in frames[k]])
        or "camera"
        for day, keys in by_day.items()
    }

    by_dest: dict[Path, list[Path]] = defaultdict(list)
    for key in ordered:
        day: date = shot_at(frames[key]).date()
        kind = "video" if is_video(frames[key]) else "raw"
        camera = model_slug(name) if name else shoot_name(frames[key]) or names[day]
        folder = folder_pattern.format(date=day.isoformat(), camera=camera)
        shoot = shoots_root(library) / folder
        # Continue an earlier/partial import into its original shoot even if
        # naming settings have changed. Match a sibling, not just a day.
        existing = matching_shoot(library, frames[key], day)
        if existing is not None:
            shoot = existing
        dest = shoot / kind
        pending = [f for f in sorted(frames[key]) if force or not already_copied(shoot, kind, f)]
        if pending:
            by_dest[dest] += pending
    return dict(by_dest)


# --- copying -----------------------------------------------------------------


def copy_verified(src: Path, dest_dir: Path) -> None:
    """Copy one file and confirm the bytes landed intact.

    Writes to a .part file first so an interrupted run cannot leave a
    truncated frame that later looks already-imported.
    """
    dest = dest_dir / src.name
    tmp = dest_dir / f"{src.name}.part"
    # Configured stores can alias the library, including through symlinks or
    # hardlinks. Reject before creating anything: offload removes src only
    # after this function succeeds, so copying onto itself would lose a photo.
    for target in (dest, tmp):
        same = src.resolve() == target.resolve()
        if not same:
            try:
                same = src.samefile(target)
            except FileNotFoundError:
                pass
        if same:
            raise ImportError_(f"source and destination are the same file: {src}")
    if dest.exists():
        if file_hash(dest) == file_hash(src):
            return
        raise ImportError_(f"destination already contains a different file: {dest}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    # A stale partial may be a symlink/hardlink. Remove the directory entry
    # rather than following it and truncating an unrelated file.
    tmp.unlink(missing_ok=True)
    src_hash = hashlib.sha256()
    with src.open("rb") as fh_in, tmp.open("xb") as fh_out:
        while chunk := fh_in.read(CHUNK):
            src_hash.update(chunk)
            fh_out.write(chunk)

    dest_hash = hashlib.sha256()
    with tmp.open("rb") as fh:
        while chunk := fh.read(CHUNK):
            dest_hash.update(chunk)

    if src_hash.hexdigest() != dest_hash.hexdigest():
        tmp.unlink(missing_ok=True)
        raise ImportError_(f"checksum mismatch copying {src.name}; card may be failing")

    shutil.copystat(src, tmp)
    tmp.replace(dest)


def place(src: Path, dest: Path, to_store: bool, delete_from_card: bool = False) -> None:
    """Copy one file into the library's dest (a shoot's raw/ or video/).

    to_store puts it on the external store instead, noted in the shoot's
    store.json; the shoot's own raw/ is still made, for recipes and picks.
    """
    if not to_store:
        copy_verified(src, dest)
        if delete_from_card:
            delete_verified_source(src, dest, False)
        return
    shoot_dir, kind = dest.parent, dest.name
    remote = require_store() / shoot_dir.name / kind
    copy_verified(src, remote)
    (shoot_dir / "raw").mkdir(parents=True, exist_ok=True)
    record(shoot_dir, f"{kind}/{src.name}", src)
    if delete_from_card:
        delete_verified_source(src, dest, True)


def delete_verified_source(src: Path, dest: Path, to_store: bool) -> None:
    """Recheck the durable copy before deleting a selected card source."""
    destination = ((require_store() / dest.parent.name / dest.name) if to_store else dest) / src.name
    if src.resolve() == destination.resolve() or src.samefile(destination):
        raise ImportError_(f"source and destination are the same file: {src}")
    if file_hash(src) != file_hash(destination):
        raise ImportError_(f"copy changed before card cleanup: {src.name}; source kept")
    src.unlink()


def is_media(path: Path) -> bool:
    """An image, clip or clip sidecar: what import brings in and offload moves."""
    ext = path.suffix.lower()
    return ext in (SIDECAR_EXTS - {".xmp"}) or ext in MEDIA_EXTS or (ext == ".xml" and bool(CLIP_SIDECAR.match(path.name.split(".")[0])))


def offload_plan(library: Path, shoots: list[str]) -> list[tuple[Path, str, Path]]:
    """(shoot dir, "raw" or "video", file) for every image and clip of these
    shoots (all of them when empty) still in the library."""
    root = shoots_root(library)
    dirs = [root / s for s in shoots] if shoots else sorted(
        d for d in root.iterdir() if d.is_dir() and (d / "raw").is_dir())
    for d in dirs:
        if not (d / "raw").is_dir():
            raise ImportError_(f"no shoot {d.name} in {root}")
    return [(d, sub, f) for d in dirs for sub in ("raw", "video") if (d / sub).is_dir()
            for f in sorted((d / sub).iterdir()) if f.is_file() and is_media(f)]


def require_store() -> Path:
    """Fail before any write when no store is configured or its drive is absent."""
    root = store_root()
    if root is None:
        raise ImportError_("no store configured; set STUDIO_STORE or the store setting")
    if not store_mounted(root):
        raise ImportError_(f"{drive_name(root)} is not available ({root})")
    return root


def offload_file(shoot_dir: Path, sub: str, f: Path) -> None:
    """Move one file to the store: copy and check it, note it in the shoot's
    store.json, and only then remove it from the library."""
    remote = require_store() / shoot_dir.name / sub
    copy_verified(f, remote)
    record(shoot_dir, f"{sub}/{f.name}", f)
    f.unlink()


def offload(library: Path, shoots: list[str], dry_run: bool) -> int:
    """Move shoots' images and clips to the external store.

    Each file is copied and checked with SHA256, noted in the shoot's
    store.json, and only then removed from the library. Picks, recipes,
    previews and exports stay put.
    """
    require_store()
    root = shoots_root(library)
    moves = offload_plan(library, shoots)
    dirs = sorted({d for d, _, _ in moves})

    print(f"library: {root}")
    print(f"store:   {store_root()}")
    if not moves:
        print("nothing to offload.")
        return 0
    for d in dirs:
        files = [f for sd, _, f in moves if sd == d]
        if files:
            print(f"  {d.name}  ->  {len(files)} files, {human_mb(files):.1f} MB")
    print(f"  total {human_mb([f for _, _, f in moves]) / 1024:.1f} GB")
    if dry_run:
        print("dry run; nothing moved.")
        return 0

    moved = 0
    try:
        for d, sub, f in moves:
            offload_file(d, sub, f)
            moved += 1
            print(f"\r  moved {moved}/{len(moves)}", end="", flush=True)
    except KeyboardInterrupt:
        print(f"\ninterrupted after {moved} files; the rest are still in the library.", file=sys.stderr)
        return 130
    print(f"\nmoved {moved} files to {drive_name()}, verified.")
    return 0


def human_mb(paths: list[Path]) -> float:
    return sum(p.stat().st_size for p in paths) / (1024 * 1024)


# --- cli ---------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--source",
        help="card root, DCIM or CLIP folder (default: autodetect the plugged-in card)",
    )
    parser.add_argument(
        "--library",
        help="directory holding shoot folders (default: STUDIO_LIBRARY or saved config)",
    )
    parser.add_argument(
        "--name",
        help="camera/shoot name for the folder pattern (default: EXIF make and model)",
    )
    parser.add_argument(
        "--last",
        type=int,
        metavar="N",
        help="import only the N most recent new frames",
    )
    parser.add_argument(
        "--match",
        metavar="GLOB",
        help="only frames whose name matches this glob, as in --match 'C003[789]'",
    )
    parser.add_argument(
        "--jpeg-only",
        action="store_true",
        help="copy only camera JPEGs, leaving raws and clips for a later import",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-import frames already in the library",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be copied and exit",
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="import into the library itself even when the configured store is available",
    )
    parser.add_argument(
        "--offload",
        nargs="*",
        metavar="SHOOT",
        help="move these shoots' images (default: every shoot's) to the configured store, "
             "verified, then exit",
    )
    parser.add_argument("--shoot-folder-pattern", help="folder pattern using {date} and {camera}")
    parser.add_argument("--delete-from-card", action=argparse.BooleanOptionalAction, default=None,
                        help="delete each source file only after its verified copy (default: off)")
    args = parser.parse_args(argv)

    try:
        pattern, delete_from_card = import_settings()
        if args.delete_from_card is not None:
            delete_from_card = args.delete_from_card
        library = resolve_library(args.library) if args.library else default_library()
        if args.offload is not None:
            return offload(library, args.offload, args.dry_run)
        card = resolve_source(args.source)
        by_dest = plan(card, library, args.name, args.last, args.force, args.match, args.jpeg_only, args.shoot_folder_pattern or pattern)
        root = store_root()
        to_store = not args.local and root is not None and store_mounted(root)
        image_location = str(root) if to_store else "in the library"
        if root is not None and not to_store and not args.local:
            image_location += f" ({drive_name(root)} not available)"
    except (ImportError_, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"card:    {card}")
    print(f"library: {library}")
    print(f"images:  {image_location}")

    if not by_dest:
        print("nothing new to import.")
        return 0

    total = [f for files in by_dest.values() for f in files]
    for dest, files in sorted(by_dest.items()):
        frames = sorted({frame_key(f) for f in files})
        span = f"{frames[0]}-{frames[-1]}" if len(frames) > 1 else frames[0]
        rel = dest.relative_to(library)
        print(
            f"  {rel}  <-  {len(frames)} frames ({span}), "
            f"{len(files)} files, {human_mb(files):.1f} MB"
        )

    if args.dry_run:
        print("dry run; nothing copied.")
        return 0

    copied = 0
    try:
        for dest, files in sorted(by_dest.items()):
            for src in files:
                place(src, dest, to_store)
                copied += 1
                print(f"\r  copied {copied}/{len(total)}", end="", flush=True)
        if delete_from_card:
            for dest, files in sorted(by_dest.items()):
                for src in files:
                    delete_verified_source(src, dest, to_store)
    except (ImportError_, ValueError, OSError) as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted; only completed verified copies may have been removed from the card.", file=sys.stderr)
        return 130

    print(f"\nimported {copied} files, verified. "
          + ("verified source files deleted." if delete_from_card else "card left untouched."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
