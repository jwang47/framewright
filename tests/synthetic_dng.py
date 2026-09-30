"""Generate an uncompressed Bayer DNG from synthetic gradients, using stdlib only.

No camera photograph or third-party creative asset is used. The file is created
only in a caller-provided temporary library, never included in the release.
"""
from pathlib import Path
import struct


def write_dng(path: Path, width: int = 256, height: int = 192) -> None:
    tags = []

    def add(tag, kind, values):
        if kind == 2:
            value = values.encode('ascii') + b'\0'
            count = len(value)
        elif kind == 1:
            value = bytes(values)
            count = len(values)
        elif kind in (3, 4):
            count = len(values)
            value = struct.pack('<' + ('H' if kind == 3 else 'I') * count, *values)
        else:
            count = len(values)
            value = b''.join(struct.pack('<' + ('ii' if kind == 10 else 'II'), n, d) for n, d in values)
        tags.append((tag, kind, count, value))

    add(254, 4, [0])                       # NewSubfileType: full image
    add(256, 4, [width]); add(257, 4, [height])
    add(258, 3, [16]); add(259, 3, [1])     # uncompressed 16-bit samples
    add(262, 3, [32803])                   # CFA photometric interpretation
    add(271, 2, 'Synthetic'); add(272, 2, 'Gradient Test')
    add(273, 4, [0])                       # StripOffsets patched below
    add(274, 3, [1]); add(277, 3, [1])
    add(278, 4, [height]); add(279, 4, [width * height * 2])
    add(284, 3, [1])
    add(33421, 3, [2, 2]); add(33422, 1, [0, 1, 1, 2])
    add(50706, 1, [1, 4, 0, 0]); add(50707, 1, [1, 1, 0, 0])
    add(50708, 2, 'Synthetic Gradient Test')
    add(50710, 1, [0, 1, 2]); add(50711, 3, [1])
    add(50714, 5, [(0, 1)]); add(50717, 4, [65535])
    add(50718, 5, [(1, 1), (1, 1)])
    add(50719, 4, [0, 0]); add(50720, 4, [width, height])
    add(50721, 10, [(1 if i % 4 == 0 else 0, 1) for i in range(9)])
    add(50728, 5, [(1, 1), (1, 1), (1, 1)])
    add(50778, 3, [21])                    # D65 calibration illuminant
    tags.sort()
    offset = 8 + 2 + len(tags) * 12 + 4
    entries, extra = [], bytearray()
    for tag, kind, count, value in tags:
        if len(value) <= 4:
            field = value.ljust(4, b'\0')
        else:
            field = struct.pack('<I', offset + len(extra))
            extra.extend(value)
            if len(extra) % 2:
                extra.append(0)
        entries.append(bytearray(struct.pack('<HHI', tag, kind, count) + field))
    pixel_offset = offset + len(extra)
    for index, (tag, *_rest) in enumerate(tags):
        if tag == 273:
            entries[index][8:12] = struct.pack('<I', pixel_offset)
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            colour = (0, 1, 1, 2)[(y % 2) * 2 + x % 2]
            channels = (0.15 + 0.65 * x / (width - 1),
                        0.15 + 0.65 * y / (height - 1),
                        0.15 + 0.65 * (x + y) / (width + height - 2))
            pixels.extend(struct.pack('<H', round(channels[colour] * 65535)))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'II*\0' + struct.pack('<I', 8) + struct.pack('<H', len(tags))
                     + b''.join(entries) + b'\0' * 4 + extra + pixels)
