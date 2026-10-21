"""Copy an older library -- edits, picks, proposals, looks, cuts -- into the current one.

    framewright migrate /path/to/old/library --dry-run
    framewright migrate /path/to/old/library
    framewright migrate /path/to/old/library --metadata-only   # images stay where they are

The destination is the usual library (--library, STUDIO_LIBRARY, saved config,
otherwise ~/Pictures/Framewright). Files are copied, never moved, and a file
already in the destination is never overwritten: identical ones are skipped,
different ones are listed so you can decide. Stdlib only.
"""
from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

from .import_photos import CLIP_SIDECAR, MEDIA_EXTS
from .settings import resolve_library

SKIP_DIRS = {".git", "__pycache__", ".venv", ".trash"}


def is_media(path: Path) -> bool:
    ext = path.suffix.lower()
    return ext in MEDIA_EXTS or (ext == ".xml" and bool(CLIP_SIDECAR.match(path.name.split(".")[0])))


def plan(source: Path, library: Path, metadata_only: bool) -> tuple[list[tuple[Path, Path]], list[Path]]:
    """(copies to make, destination files that differ and are left alone)."""
    source, library = source.resolve(), library.resolve()
    if not source.is_dir():
        raise ValueError(f"{source} is not a folder")
    if source == library or library in source.parents or source in library.parents:
        raise ValueError("the old library and the current library must not contain each other")
    if (source / "framewright" / "server.py").is_file():
        raise ValueError(f"{source} is the app checkout; pass the library folder inside it (often {source / 'shoots'})")
    copies, conflicts = [], []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in SKIP_DIRS for part in relative.parts) or not path.is_file():
            continue
        if metadata_only and is_media(path):
            continue
        target = library / relative
        if target.exists():
            if not filecmp.cmp(path, target, shallow=False):
                conflicts.append(target)
            continue
        copies.append((path, target))
    return copies, conflicts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="the old library folder (its shoot folders sit directly inside)")
    parser.add_argument("--library", help="destination library (default: the configured one, or ~/Pictures/Framewright)")
    parser.add_argument("--metadata-only", action="store_true",
                        help="copy edits, picks and other work but not images, clips or their sidecars")
    parser.add_argument("--dry-run", action="store_true", help="list what would be copied without copying")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        library = resolve_library(args.library)
        copies, conflicts = plan(Path(args.source).expanduser(), library, args.metadata_only)
        for path, target in copies:
            if args.dry_run:
                print(f"would copy {target.relative_to(library.resolve())}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(target.name + ".part")
            shutil.copy2(path, partial)
            partial.replace(target)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for target in conflicts:
        print(f"kept existing {target} (differs from the old copy)", file=sys.stderr)
    verb = "would copy" if args.dry_run else "copied"
    print(f"{verb} {len(copies)} file(s) into {library}; {len(conflicts)} differing file(s) left alone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
