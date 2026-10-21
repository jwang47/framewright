"""Moving photos and clips to the Trash, so they can be put back.

Framewright never deletes media outright. On macOS the system `trash`
command (14+) or Finder moves files to the Trash of their own volume, where
Finder's Put Back restores them; on Linux `gio trash` does the same.
Elsewhere, files go to <library>/.trash/<when>/, to be emptied by hand.

Stdlib only.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def to_trash(paths: list[Path], library: Path) -> None:
    """Move every path to the Trash; raise ValueError if any can't be."""
    paths = [p for p in paths if p.exists()]
    if not paths:
        return
    try:
        if sys.platform == "darwin" and shutil.which("trash"):
            subprocess.run(["trash", *map(str, paths)], check=True, capture_output=True, timeout=120)
            return
        if sys.platform == "darwin":
            items = ", ".join(f'POSIX file "{p}"' for p in paths)
            subprocess.run(["osascript", "-e", f'tell application "Finder" to delete {{{items}}}'],
                           check=True, capture_output=True, timeout=120)
            return
        if shutil.which("gio"):
            subprocess.run(["gio", "trash", *map(str, paths)], check=True, capture_output=True, timeout=120)
            return
    except (subprocess.SubprocessError, OSError) as exc:
        detail = getattr(exc, "stderr", b"") or b""
        raise ValueError(f"couldn't move to the Trash: {detail.decode(errors='replace').strip() or exc}") from exc
    folder = library / ".trash" / datetime.now().strftime("%Y%m%d-%H%M%S")
    for p in paths:
        dest = folder / p.parent.parent.name / p.parent.name / p.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), dest)
