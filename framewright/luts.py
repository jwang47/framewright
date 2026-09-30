"""User-owned cube LUT validation, fingerprints and safe installation."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re

MAX_LUT_BYTES = 64 * 1024 * 1024
HASH_PATTERN = re.compile(r"[0-9a-f]{16}\Z")


def lut_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def valid_name(name: str) -> bool:
    return (isinstance(name, str) and 0 < len(name) <= 200 and name.endswith('.cube')
            and not name.startswith('.') and not re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', name, re.I)
            and not any(c in name for c in '/\\<>:"|?*')
            and all(ord(c) >= 32 and ord(c) != 127 for c in name))


def validate_cube(data: bytes) -> None:
    if not data or len(data) > MAX_LUT_BYTES:
        raise ValueError('LUT must be between 1 byte and 64 MiB')
    text = data.decode('utf-8-sig')
    size, count = 0, 0
    domain = {'DOMAIN_MIN': [0, 0, 0], 'DOMAIN_MAX': [1, 1, 1]}
    for line in text.splitlines():
        words = line.split('#', 1)[0].split()
        if not words:
            continue
        key, rest = words[0], words[1:]
        if key == 'TITLE':
            continue
        if key == 'LUT_3D_SIZE':
            if size or len(rest) != 1 or not rest[0].isdigit() or not 2 <= int(rest[0]) <= 129:
                raise ValueError('invalid or duplicate LUT_3D_SIZE')
            size = int(rest[0])
        elif key in domain:
            values = [float(x) for x in rest]
            if len(values) != 3 or not all(math.isfinite(x) and abs(x) <= 3.402823466e38 for x in values):
                raise ValueError('invalid LUT domain')
            domain[key] = values
        else:
            if not size or len(words) != 3:
                raise ValueError('expected three LUT values after LUT_3D_SIZE')
            values = [float(x) for x in words]
            if not all(math.isfinite(x) and abs(x) <= 3.402823466e38 for x in values):
                raise ValueError('LUT values must be finite float32 numbers')
            count += 1
            if count > size ** 3:
                raise ValueError('too many LUT entries')
    if not size or count != size ** 3:
        raise ValueError(f'expected {size ** 3} LUT entries, got {count}')
    if any(b <= a for a, b in zip(domain['DOMAIN_MIN'], domain['DOMAIN_MAX'])):
        raise ValueError('LUT domain maximum must exceed minimum')


def install_lut(directory: Path, name: str, data: bytes, app_root: Path) -> Path:
    if not valid_name(name):
        raise ValueError('use a safe .cube filename without path separators')
    validate_cube(data)
    directory = directory.resolve()
    if directory == app_root.resolve() or app_root.resolve() in directory.parents:
        raise ValueError('the user LUT folder must be outside the application repository')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    try:
        with target.open('xb') as stream:
            try:
                stream.write(data)
            except OSError:
                stream.close()
                target.unlink(missing_ok=True)
                raise
    except FileExistsError:
        if target.is_symlink() or not target.is_file() or target.read_bytes() != data:
            raise ValueError('a different LUT already has this name; rename the file before installing')
    return target
