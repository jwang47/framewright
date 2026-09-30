#!/usr/bin/env python3
"""Check tracked public-release files for accidentally bundled creative assets.

Default: inspect working-tree contents of tracked files in the release allowlist.
--staged: inspect the complete Git index (including partially staged files).
--all: inspect every tracked path; use in the fresh public repository/export.
No third-party libraries or image decoders are required.
"""

import argparse
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import sys


# This is the Phase A boundary, not authorization to publish the current repo.
# Phase D must audit and copy only intended release files into a fresh repo.
PUBLIC_DIRS = {"framewright", "tools", "scripts", "studio", "tests", "docs", ".github", ".githooks"}
PUBLIC_FILES = {
    "README.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY.md", "LICENSE",
    "LICENSE.txt", "LICENSE.md", "AGENTS.md", "CLAUDE.md", ".gitignore",
    "pyproject.toml", "MANIFEST.in", "render.py", "camera-profiles.json", "looks.example.json",
}
IMAGE_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".jpe", ".gif", ".bmp", ".tif", ".tiff",
    ".webp", ".avif", ".heic", ".heif", ".jxl", ".exr", ".hdr", ".ico",
    ".svg", ".svgz", ".icns", ".psd", ".xcf", ".jpf", ".jp2",
    ".arw", ".cr2", ".cr3", ".nef", ".nrw", ".dng", ".raf", ".rw2",
    ".orf", ".pef", ".srw", ".raw", ".ppm", ".pgm", ".pbm", ".pnm",
}
PNG = b"\x89PNG\r\n\x1a\n"
LUT_HEADER = re.compile(rb"(?mi)^[ \t]*(?:\xef\xbb\xbf)?LUT_3D_SIZE[ \t]+[0-9]+(?:[ \t]*(?:#[^\r\n]*)?)?\r?$")


def is_public(path):
    parts = PurePosixPath(path).parts
    return path in PUBLIC_FILES or bool(parts and parts[0] in PUBLIC_DIRS)


def image_bytes(data):
    return (
        data.startswith((PNG, b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"BM",
                         b"II*\0", b"MM\0*", b"II+\0", b"MM\0+", b"\x76\x2f\x31\x01",
                         b"\xff\x0a", b"\0\0\0\x0cJXL \r\n\x87\n"))
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
        or (data[4:8] == b"ftyp" and data[8:12] in
            {b"avif", b"avis", b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"crx "})
    )


def hald_png(data):
    """Conservatively identify Hald-compatible square, cubic PNG dimensions."""
    if not data.startswith(PNG) or data[12:16] != b"IHDR" or len(data) < 24:
        return False
    width, height = struct.unpack(">II", data[16:24])
    if width != height or width < 8:
        return False
    level = round(width ** (1 / 3))
    return level ** 3 == width


def violations(path, data):
    suffix = PurePosixPath(path).suffix.lower()
    errors = []
    if suffix in {".cube", ".3dl"}:
        errors.append("LUT files must stay outside the release")
    if LUT_HEADER.search(data):
        errors.append("contains a LUT_3D_SIZE header (possibly a renamed LUT)")
    if hald_png(data) or (suffix == ".png" and re.search(r"hald|clut", path, re.I)):
        errors.append("possible Hald CLUT PNG; Hald-compatible dimensions are prohibited")
    if (suffix in IMAGE_SUFFIXES or image_bytes(data)) and not path.startswith("docs/samples/"):
        errors.append("image files are allowed only in docs/samples/")
    return errors


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def check(root, staged=False, all_files=False):
    errors = []
    entries = git(root, "ls-files", "--stage", "-z").split(b"\0")
    checked = 0
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, object_id, stage = metadata.split()
        path = raw_path.decode("utf-8", "surrogateescape")
        if not all_files and not is_public(path):
            continue
        checked += 1
        if stage != b"0":
            errors.append(f"{path}: unresolved merge conflict")
            continue
        if mode not in {b"100644", b"100755"}:
            errors.append(f"{path}: symlinks and submodules require a separate release audit")
            continue
        try:
            if staged:
                data = git(root, "cat-file", "blob", object_id.decode("ascii"))
            else:
                file = root / path
                if file.is_symlink():
                    errors.append(f"{path}: symlinks require a separate release audit")
                    continue
                data = file.read_bytes()
        except (OSError, subprocess.CalledProcessError) as exc:
            errors.append(f"{path}: cannot read tracked file: {exc}")
            continue
        errors.extend(f"{path}: {reason}" for reason in violations(path, data))
    return checked, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="check exact index contents")
    parser.add_argument("--all", action="store_true", help="check all tracked paths in a public release")
    args = parser.parse_args()
    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        count, errors = check(root, args.staged, args.all)
    except subprocess.CalledProcessError as exc:
        print(f"Release check requires a Git working tree: {exc}", file=sys.stderr)
        return 2
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    scope = "all tracked paths" if args.all else "public release allowlist"
    print(f"Release guard passed: {count} files checked ({scope}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
