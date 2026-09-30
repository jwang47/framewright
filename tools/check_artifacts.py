#!/usr/bin/env python3
"""Inspect built wheels/source archives for private paths and creative assets."""
import argparse
from pathlib import Path
import tarfile
import zipfile

from check_release import violations


def check(path):
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            entries = [(i.filename, archive.read(i)) for i in archive.infolist() if not i.is_dir()]
    else:
        with tarfile.open(path) as archive:
            entries = []
            for member in archive.getmembers():
                if member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError(f"{path.name}: unsafe archive entry {member.name}")
                name = member.name.split("/", 1)[1]
                entries.append((name, archive.extractfile(member).read()))
    allowed = {"framewright", "tests", "tools", "docs", ".github", ".githooks"}
    roots = {"README.md", "LICENSE", "THIRD_PARTY.md", "SECURITY.md", "CONTRIBUTING.md",
             "AGENTS.md", "CLAUDE.md", "pyproject.toml", "MANIFEST.in", "PKG-INFO", "setup.cfg"}
    required = {"framewright/__main__.py", "framewright/server.py", "framewright/web/index.html",
                "framewright/web/vendor/libraw/libraw.wasm", "framewright/web/vendor/libraw/libraw.js",
                "framewright/web/vendor/libraw/LICENSE", "framewright/looks.example.json",
                "framewright/recipe.schema.json"}
    names = {n for n, _ in entries}
    if required - names:
        raise ValueError(f"{path.name}: missing packaged resources: {sorted(required - names)}")
    for name, data in entries:
        first = name.split("/", 1)[0]
        if first not in allowed and name not in roots and not first.endswith((".dist-info", ".egg-info")):
            raise ValueError(f"{path.name}: unexpected file {name}")
        if ".." in Path(name).parts or name.startswith("/"):
            raise ValueError(f"{path.name}: unsafe path {name}")
        errors = violations(name, data)
        if errors:
            raise ValueError(f"{path.name}: {name}: {'; '.join(errors)}")
    print(f"{path.name}: {len(entries)} files, package resources and content guard passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path, default=Path("dist"))
    args = parser.parse_args()
    paths = sorted(args.directory.glob("*.whl")) + sorted(args.directory.glob("*.tar.gz"))
    if not paths:
        parser.exit(1, "no release artifacts found\n")
    try:
        for path in paths:
            check(path)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"artifact check failed: {exc}\n")


if __name__ == "__main__":
    main()
