"""Lens distortion profiles from the Lensfun database.

Reads the lens and focal length a frame was shot with from its EXIF, finds
that lens in Lensfun, and returns the distortion polynomial for that focal
length. Lensfun ships with darktable, so its database is usually already on
disk; the places it is looked for are in LENSFUN_DIRS.

A profile maps a radius in the corrected image to a radius in the camera's
image, both measured from the centre in units of half the shorter image side
(the PanoTools convention Lensfun uses):

    r_camera = r * (k0 + k1 r + k2 r^2 + k3 r^3 + k4 r^4)

Lensfun's three models all fit that one polynomial:

    ptlens  a, b, c   ->  k = [1-a-b-c, c, b, a, 0]
    poly3   k1        ->  k = [1-k1, 0, k1, 0, 0]
    poly5   k1, k2    ->  k = [1, 0, k1, 0, k2]

The camera JPEG is used as-is: Sony only corrects distortion in-camera for
lenses it supports, and for the rest (the Sigma 10-18mm among them) the JPEG
carries the lens's full distortion, so the profile applies to it directly.

Fixed-lens cameras are the exception. Their lens has no name of its own in
Lensfun (the Q2's "SUMMILUX 1:1.7/28 ASPH." is listed as "LEICA Q2 &
compatibles"), so it is found through the camera's model and mount instead;
and they correct that lens in their own JPEGs (checked on a Q2 frame against
its DNG), so for a JPEG such a profile is reported as already applied.

Stdlib only.
"""

from __future__ import annotations

import re
import struct
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

LENSFUN_DIRS = [
    Path("/Applications/darktable.app/Contents/Resources/share/lensfun"),
    Path("C:/Program Files/darktable/share/lensfun"),
    Path("/usr/share/lensfun"),
    Path("/usr/local/share/lensfun"),
    Path("/opt/homebrew/share/lensfun"),
    Path.home() / ".local/share/lensfun",
]

EXIF_SCAN = 256 * 1024


# --- exif --------------------------------------------------------------------


def read_lens(path: Path) -> dict | None:
    """{'model', 'focal', 'focal35'} from a JPEG's or raw's EXIF, or None."""
    with path.open("rb") as fh:
        buf = fh.read(EXIF_SCAN)
    if buf[:2] == b"\xff\xd8":
        start = buf.find(b"Exif\x00\x00")
        if start < 0:
            return None
        buf = buf[start + 6:]
    if buf[:2] not in (b"II", b"MM"):
        return None
    end = "<" if buf[:2] == b"II" else ">"

    def ifd(off: int) -> dict[int, tuple[int, int, int]]:
        count = struct.unpack_from(end + "H", buf, off)[0]
        out = {}
        for i in range(count):
            entry = off + 2 + i * 12
            tag, typ, num = struct.unpack_from(end + "HHI", buf, entry)
            out[tag] = (typ, num, entry + 8)
        return out

    def value(entries, tag):
        if tag not in entries:
            return None
        typ, num, at = entries[tag]
        size = {2: 1, 3: 2, 4: 4, 5: 8}.get(typ, 1) * num
        if size > 4:
            at = struct.unpack_from(end + "I", buf, at)[0]
        if typ == 2:
            return buf[at:at + num].split(b"\0")[0].decode(errors="replace").strip()
        if typ == 3:
            return struct.unpack_from(end + "H", buf, at)[0]
        if typ == 4:
            return struct.unpack_from(end + "I", buf, at)[0]
        if typ == 5:
            num_, den = struct.unpack_from(end + "II", buf, at)
            return num_ / den if den else None
        return None

    try:
        ifd0 = ifd(struct.unpack_from(end + "I", buf, 4)[0])
        camera = " ".join(filter(None, (value(ifd0, 0x010F), value(ifd0, 0x0110))))  # Make, Model
        exif_off = value(ifd0, 0x8769)
        if exif_off is None:
            return None
        exif = ifd(exif_off)
        model = value(exif, 0xA434)          # LensModel
        focal = value(exif, 0x920A)          # FocalLength
        focal35 = value(exif, 0xA405)        # FocalLengthIn35mmFilm
    except (struct.error, IndexError):
        return None
    if not model or not focal:
        return None
    return {"model": model, "camera": camera, "focal": round(float(focal), 2), "focal35": focal35}


# --- lensfun -----------------------------------------------------------------


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9.]+", text.lower().replace("|", " ")))


@lru_cache(maxsize=1)
def _database() -> tuple[list[dict], list[dict]]:
    """(lenses with a distortion calibration, cameras) from the first Lensfun DB found."""
    lenses, cameras = [], []
    for base in LENSFUN_DIRS:
        files = sorted(base.glob("version_*/*.xml")) or sorted(base.glob("*.xml"))
        if not files:
            continue
        for xml in files:
            try:
                root = ET.parse(xml).getroot()
            except ET.ParseError:
                continue
            for cam in root.iter("camera"):
                cameras.append({
                    "name": f'{cam.findtext("maker") or ""} {cam.findtext("model") or ""}',
                    "mount": cam.findtext("mount") or "",
                })
            for lens in root.iter("lens"):
                model = lens.findtext("model")   # the untranslated name comes first
                calib = [d.attrib for d in lens.iter("distortion")]
                if not model or not calib:
                    continue
                lenses.append({
                    "maker": lens.findtext("maker") or "",
                    "model": model,
                    "crop": float(lens.findtext("cropfactor") or 1.0),
                    "mounts": [m.text for m in lens.findall("mount") if m.text],
                    "distortion": calib,
                })
        break
    return lenses, cameras


def _coefficients(d: dict) -> list[float] | None:
    f = {k: float(v) for k, v in d.items() if k in ("a", "b", "c", "k1", "k2")}
    model = d.get("model")
    if model == "ptlens":
        a, b, c = f.get("a", 0), f.get("b", 0), f.get("c", 0)
        return [1 - a - b - c, c, b, a, 0.0]
    if model == "poly3":
        k1 = f.get("k1", 0)
        return [1 - k1, 0.0, k1, 0.0, 0.0]
    if model == "poly5":
        return [1.0, 0.0, f.get("k1", 0), 0.0, f.get("k2", 0)]
    return None


def _closest(want: set[str], entries, name) -> dict | None:
    """The entry whose name holds every wanted token and the fewest others."""
    best = None
    for e in entries:
        have = _tokens(name(e))
        if want and want <= have and (best is None or len(have - want) < best[0]):
            best = (len(have - want), e)
    return best[1] if best else None


def _find_lens(model: str, camera: str | None) -> tuple[dict | None, bool]:
    """(Lensfun lens, whether it is a fixed lens found through the camera)."""
    lenses, cameras = _database()
    lens = _closest(_tokens(model), lenses, lambda l: l["maker"] + " " + l["model"])
    if lens or not camera:
        return lens, False
    cam = _closest(_tokens(camera), cameras, lambda c: c["name"])
    if not cam or not cam["mount"]:
        return None, False
    # A fixed lens shares its camera's own mount and nothing else.
    fixed = [l for l in lenses if cam["mount"] in l["mounts"]]
    return (fixed[0], True) if len(fixed) == 1 else (None, False)


def find_profile(model: str, focal: float, camera_crop: float | None = None,
                 camera: str | None = None) -> dict | None:
    """The distortion profile for a lens at a focal length, or None.

    A Lensfun model matches when it contains every token of the EXIF lens
    name ("10-18mm F2.8 DC DN | Contemporary 023" matches Lensfun's
    "Sigma 10-18mm F2.8 DC DN | Contemporary 023"); the closest such name
    wins. Failing that, a fixed-lens camera is matched by its own model.
    Coefficients are interpolated linearly between the two calibrated focal
    lengths either side, and held at the ends of the range.
    """
    lens, fixed = _find_lens(model, camera)
    if lens is None:
        return None

    calib = sorted(
        ((float(d["focal"]), k) for d in lens["distortion"] if "focal" in d
         for k in [_coefficients(d)] if k),
        key=lambda fk: fk[0],
    )
    if not calib:
        return None
    if focal <= calib[0][0]:
        k = calib[0][1]
    elif focal >= calib[-1][0]:
        k = calib[-1][1]
    else:
        for (f0, k0), (f1, k1) in zip(calib, calib[1:]):
            if f0 <= focal <= f1:
                t = (focal - f0) / (f1 - f0) if f1 > f0 else 0
                k = [a + (b - a) * t for a, b in zip(k0, k1)]
                break

    # Calibrated on one sensor size, used on another: the same physical radius
    # is a different fraction of the frame. The camera's crop is estimated from
    # a rounded 35mm-equivalent focal length, so within 10% counts as the same
    # sensor rather than turning rounding into a scale error.
    scale = lens["crop"] / camera_crop if camera_crop else 1.0
    if abs(scale - 1) < 0.1:
        scale = 1.0
    return {
        "model": lens["model"],
        "focal": focal,
        "k": [round(v, 7) for v in k],
        "scale": round(scale, 4),
        "fixed": fixed,
    }


def profile_for(path: Path, raw: bool = False) -> dict | None:
    """Lens info for a frame, with its profile if Lensfun has one.

    path is the file to read EXIF from (the JPEG or the raw: both carry it).
    raw says the frame is developed from its raw, which no camera corrects,
    so a fixed lens's profile is then not reported as already applied.
    """
    lens = read_lens(path)
    if lens is None:
        return None
    crop = lens["focal35"] / lens["focal"] if lens.get("focal35") and lens["focal"] else None
    profile = find_profile(lens["model"], lens["focal"], crop, lens.get("camera"))
    in_camera = bool(profile and profile.pop("fixed") and not raw
                     and path.suffix.lower() in (".jpg", ".jpeg"))
    if profile:
        profile.pop("fixed", None)
    return {**lens, "profile": profile, "inCamera": in_camera}
