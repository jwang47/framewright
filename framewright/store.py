"""Where the images live: an external drive mirroring the library's shoots.

The selected library keeps everything that is work -- picks,
recipes, previews -- while the images themselves can sit on the drive, at
<store>/<shoot>/raw/<file> (and video/ for clips). Each shoot's store.json
lists the files that live there, with their size and capture time, so the
studio can still list a shoot and show its cached previews while the drive
is unplugged; developing and exporting need it plugged in.

    STUDIO_STORE=/path/to/photos   # optional; PHOTO_STORE is also accepted

Stdlib only.
"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path

from .settings import configured_store
STORE_FILE = "store.json"


def store_root() -> Path | None:
    """The optional store folder, whether or not its drive is mounted."""
    return configured_store()


def store_mounted(root: Path | None = None) -> bool:
    """Whether the configured destination is safe to use.

    Removable paths must have an actual mount point: an orphan directory
    under /Volumes or /media must never receive writes on the internal disk.
    An explicitly configured ordinary folder is usable when it exists.
    """
    root = root if root is not None else store_root()
    if root is None:
        return False
    root = root.expanduser().absolute()
    # A mount above /media (such as a separate /run filesystem) does not
    # establish that the user's removable drive is present.
    # ntpath.ismount considers drive roots mount points even when that
    # drive letter is disconnected, so check its actual availability first.
    if os.name == "nt" and not Path(root.anchor).is_dir():
        return False
    candidates = [root, *root.parents]
    removable = (Path("/Volumes"), Path("/media"), Path("/run/media"))
    for base in removable:
        if root == base or base in root.parents:
            return any(os.path.ismount(p) for p in candidates if base in p.parents)
    # Windows drive and UNC roots are themselves mount points. POSIX's /
    # does not establish that a removable volume is present.
    if any(os.path.ismount(p) for p in candidates
           if os.name == "nt" or p != Path(p.anchor)):
        return True
    if os.name == "nt":
        return False
    return root.is_dir()


def drive_name(root: Path | None = None) -> str:
    """A configured destination's name for messages."""
    root = root if root is not None else store_root()
    if root is None:
        return "External storage"
    for p in [root, *root.parents]:
        if p.parent == Path("/Volumes"):
            return p.name
    return str(root)


def read_manifest(shoot_dir: Path, *, strict: bool = False) -> dict[str, dict]:
    """"raw/<file>" -> {"size", "mtime"} for the shoot's files on the store."""
    path = shoot_dir / STORE_FILE
    try:
        if not path.is_file():
            return {}
        document = json.loads(path.read_text())
        files = document.get("files", {}) if isinstance(document, dict) else None
        if not isinstance(files, dict) or any(not isinstance(meta, dict) for meta in files.values()):
            raise ValueError(f"invalid store manifest: {path}")
        return files
    except (OSError, ValueError):
        if strict:
            raise
        return {}


def record(shoot_dir: Path, rel: str, src: Path) -> None:
    """Note that rel (as in "raw/L1030512.DNG") now lives on the store."""
    files = read_manifest(shoot_dir, strict=True)
    st = src.stat()
    digest = hashlib.sha256()
    with src.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    files[rel] = {"size": st.st_size, "mtime": round(st.st_mtime, 3), "sha256": digest.hexdigest()}
    shoot_dir.mkdir(parents=True, exist_ok=True)
    tmp = shoot_dir / f"{STORE_FILE}.part"
    tmp.write_text(json.dumps({"files": dict(sorted(files.items()))}, indent=2) + "\n")
    tmp.replace(shoot_dir / STORE_FILE)


def stored(shoot_dir: Path, sub: str = "raw") -> dict[str, tuple[Path, float]]:
    """File name -> (its path on the store, capture time) for one subfolder."""
    configured = store_root()
    # Keep manifest entries visible even before this machine has a store
    # configured. The placeholder is read-only; write paths require a store.
    root = (configured / shoot_dir.name / sub if configured is not None
            else shoot_dir / ".offline-store" / sub)
    return {rel.split("/", 1)[1]: (root / rel.split("/", 1)[1], meta.get("mtime", 0.0))
            for rel, meta in read_manifest(shoot_dir).items() if rel.startswith(sub + "/")}
