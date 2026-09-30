"""User-owned LUT validation, fingerprints and safe installation.

A LUT is a .cube file or a Camera Raw look profile (.xmp) whose RGB table the
browser bakes into a cube-like LUT; see render.js.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re
import struct
import zlib

MAX_LUT_BYTES = 64 * 1024 * 1024
HASH_PATTERN = re.compile(r"[0-9a-f]{16}\Z")
LUT_SUFFIXES = ('.cube', '.xmp')
XMP_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`'|()[]{}@%$#"
XMP_DIGITS = {c: i for i, c in enumerate(XMP_ALPHABET)}
XML_ENTITIES = {'quot': '"', 'apos': "'", 'lt': '<', 'gt': '>', 'amp': '&'}


def lut_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def valid_name(name: str) -> bool:
    return (isinstance(name, str) and 0 < len(name) <= 200 and name.endswith(LUT_SUFFIXES)
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


def _xmp_value(text: str, name: str) -> str | None:
    match = (re.search(rf'crs:{name}\s*=\s*"([^"]*)"', text)
             or re.search(rf'<crs:{name}>([^<]*)</crs:{name}>', text))
    if not match:
        return None
    return re.sub(r'&(#x[0-9a-fA-F]+|#[0-9]+|quot|apos|lt|gt|amp);', lambda m: (
        chr(int(m[1][2:], 16) if m[1][1] in 'xX' else int(m[1][1:])) if m[1][0] == '#'
        else XML_ENTITIES[m[1]]), match[1])


def decode_xmp_table(text: str) -> bytes:
    """Adobe's base-85: five digits, least significant first, to four bytes
    little-endian; a short last group gives one byte fewer than its digits."""
    out = bytearray()
    for i in range(0, len(text), 5):
        group = text[i:i + 5]
        value = 0
        for c in reversed(group):
            if c not in XMP_DIGITS:
                raise ValueError('bad character in the profile\'s RGB table')
            value = value * 85 + XMP_DIGITS[c]
        out += (value & 0xffffffff).to_bytes(4, 'little')[:len(group) - 1]
    return bytes(out)


def validate_xmp(data: bytes) -> None:
    """A look profile with a 3D RGB table: tag 1, version 1, 3 dimensions,
    2-64 divisions, then that many samples of three 16-bit channels."""
    if not data or len(data) > MAX_LUT_BYTES:
        raise ValueError('profile must be between 1 byte and 64 MiB')
    text = data.decode('utf-8-sig')
    digest = _xmp_value(text, 'RGBTable')
    if not digest or not re.fullmatch(r'[0-9A-Fa-f]{32}', digest):
        raise ValueError('no RGB table in this profile')
    encoded = _xmp_value(text, f'Table_{digest}')
    if not encoded:
        raise ValueError('RGB table data missing')
    raw = decode_xmp_table(re.sub(r'\s+', '', encoded))
    try:
        table = zlib.decompressobj().decompress(raw[4:], MAX_LUT_BYTES)
    except zlib.error as exc:
        raise ValueError('RGB table is not readable') from exc
    if len(table) < 16:
        raise ValueError('RGB table is truncated')
    tag, version, dims, divisions = struct.unpack('<4I', table[:16])
    if (tag, version) != (1, 1):
        raise ValueError('unknown RGB table format')
    if dims != 3:
        raise ValueError(f'{dims}D RGB tables are not supported')
    if not 2 <= divisions <= 64 or len(table) < 16 + divisions ** 3 * 6:
        raise ValueError('RGB table size does not match its data')
    amount = _xmp_value(text, 'RGBTableAmount')
    if amount is not None:
        try:
            ok = math.isfinite(float(amount))
        except ValueError:
            ok = False
        if not ok:
            raise ValueError('invalid RGB table amount')


def validate_lut(name: str, data: bytes) -> None:
    (validate_xmp if name.lower().endswith('.xmp') else validate_cube)(data)


def install_lut(directory: Path, name: str, data: bytes, app_root: Path) -> Path:
    if not valid_name(name):
        raise ValueError('use a safe .cube or .xmp filename without path separators')
    validate_lut(name, data)
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
