"""In-memory source index; no database or photo-library writes.

Directory and manifest signatures detect imports, removals and offloads on the
next lookup. A periodic refresh also notices files modified in place, which do
not change their directory's timestamp. Recipes and picks are not cached here.
"""
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from time import monotonic
from types import MappingProxyType
from typing import Mapping


@dataclass(frozen=True)
class PhotoSnapshot:
    files: Mapping[Path, float]
    sources: Mapping[str, Path]
    raws: Mapping[str, Path]


def stamp(path: Path):
    try:
        s = path.stat()
        return (s.st_dev, s.st_ino, s.st_mtime_ns, s.st_ctime_ns, s.st_size)
    except FileNotFoundError:
        return None


class PhotoIndex:
    def __init__(self, scan, frame_key, raw_exts, jpeg_exts, refresh_seconds=30):
        self.scan = scan
        self.frame_key = frame_key
        self.raw_exts = raw_exts
        self.jpeg_exts = jpeg_exts
        self.refresh_seconds = refresh_seconds
        self.entries = {}
        self.lock = RLock()

    def get(self, shoot: Path, store_key=None) -> PhotoSnapshot:
        shoot = shoot.resolve()
        with self.lock:
            signature = (stamp(shoot / 'raw'), stamp(shoot / 'store.json'), store_key)
            now = monotonic()
            cached = self.entries.get(shoot)
            if cached and cached[0] == signature and now - cached[1] < self.refresh_seconds:
                return cached[2]
            files = self.scan(shoot)
            sources, raws = {}, {}
            for path in files:
                key, ext = self.frame_key(path), path.suffix.lower()
                if key not in sources or ext in self.jpeg_exts:
                    sources[key] = path
                if ext in self.raw_exts:
                    raws[key] = path
            snapshot = PhotoSnapshot(*(MappingProxyType(m) for m in (files, sources, raws)))
            # Retain the pre-scan signature: a concurrent import/offload will
            # differ on the next request, rather than caching a partial scan.
            self.entries[shoot] = (signature, now, snapshot)
            return snapshot

    def retain(self, root: Path, shoots):
        """Release cached days removed from this library, keeping others isolated."""
        root = root.resolve()
        keep = {root / name for name in shoots}
        with self.lock:
            for path in list(self.entries):
                if path.parent == root and path not in keep:
                    del self.entries[path]
