"""Tool-free preview fallback: browser-decodable JPEG bytes from originals.

No color rendering or image conversion happens here. A camera JPEG is served
unchanged; for a RAW, the largest complete embedded JPEG is copied into the
preview cache. The browser decodes it using its normal image support.
"""
from pathlib import Path


SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg_end(data, start):
    cursor = start + 2
    dimensions = False
    scan = False
    while cursor + 1 < len(data):
        if data[cursor] != 0xFF:
            if not scan:
                return None
            cursor = data.find(b"\xff", cursor)
            if cursor < 0:
                return None
        while cursor < len(data) and data[cursor] == 0xFF:
            cursor += 1
        if cursor >= len(data):
            return None
        marker = data[cursor]
        cursor += 1
        if scan and (marker == 0 or 0xD0 <= marker <= 0xD7):
            continue
        if marker == 0xD9:
            return cursor if dimensions and scan else None
        if marker in (0, 0xD8) or cursor + 2 > len(data):
            return None
        if marker == 1:
            continue
        size = int.from_bytes(data[cursor:cursor + 2], "big")
        if size < 2 or cursor + size > len(data):
            return None
        if marker in SOF:
            if size < 8 or not int.from_bytes(data[cursor + 3:cursor + 5], "big") or not int.from_bytes(data[cursor + 5:cursor + 7], "big"):
                return None
            dimensions = True
        if marker == 0xDA:
            scan = True
        cursor += size
    return None


def embedded_jpeg(data):
    best = None
    cursor = 0
    while True:
        start = data.find(b"\xff\xd8\xff", cursor)
        if start < 0:
            break
        end = _jpeg_end(data, start)
        if end is not None and (best is None or end - start > best[1] - best[0]):
            best = (start, end)
        cursor = start + 3
    if best is None:
        raise ValueError("no embedded JPEG preview; install ImageMagick or use RAW development in the browser")
    return data[best[0]:best[1]]


def fallback_preview(src: Path, destination: Path) -> Path:
    if src.suffix.lower() in {".jpg", ".jpeg"}:
        return src
    image = embedded_jpeg(src.read_bytes())
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part.jpg")
    temporary.write_bytes(image)
    temporary.replace(destination)
    return destination
