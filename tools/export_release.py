#!/usr/bin/env python3
"""Export a code-only tree without Git history or personal library data.

The destination must not exist. This command does not initialize Git or publish.
Use --forbid TEXT for additional private strings to reject in every text file.
"""
import argparse
from pathlib import Path
import re
import shutil
import sys

from check_release import violations

FILES = ("README.md", "LICENSE", "THIRD_PARTY.md", "SECURITY.md", "CONTRIBUTING.md",
         "AGENTS.md", "CLAUDE.md", "pyproject.toml", "MANIFEST.in", ".gitignore")
DIRECTORIES = ("framewright", "tools", "tests", "docs", ".github", ".githooks")
SKIP = {"__pycache__", ".DS_Store"}


def export(source, destination, forbidden=()):
    source, destination = source.resolve(), destination.absolute()
    if destination.exists():
        raise ValueError("destination already exists; choose a new empty export path")
    paths = [source / name for name in FILES]
    for name in DIRECTORIES:
        folder = source / name
        if not folder.is_dir():
            raise ValueError(f"missing release directory: {name}")
        for path in folder.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"symlink in release tree: {path.relative_to(source)}")
            if path.is_file() and not (set(path.relative_to(folder).parts) & SKIP) and path.suffix != ".pyc":
                paths.append(path)
    entries = []
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing or unsafe release file: {path}")
        relative = path.relative_to(source).as_posix()
        data = path.read_bytes()
        errors = violations(relative, data)
        if errors:
            raise ValueError(f"{relative}: {'; '.join(errors)}")
        if path.suffix not in {".wasm", ".png", ".jpg", ".jpeg"}:
            text = data.decode("utf-8")
            if re.search(r"/(?:Users|home)/[A-Za-z0-9._-]+/", text):
                raise ValueError(f"{relative}: contains an absolute personal home path")
            for value in forbidden:
                if value and value.casefold() in text.casefold():
                    raise ValueError(f"{relative}: contains a forbidden private string")
        entries.append((path, relative))
    # Validate the full tree before creating or writing the destination.
    destination.mkdir(parents=True)
    for path, relative in entries:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--forbid", action="append", default=[])
    args = parser.parse_args()
    try:
        count = export(Path(__file__).resolve().parents[1], args.destination, args.forbid)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"export failed: {exc}\n")
    print(f"Exported {count} audited files to {args.destination}; no history or library copied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
