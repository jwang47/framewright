// The lens corrections a DNG asks for but LibRaw does not apply. Some
// cameras (the Leica Q2 among them) ship an uncorrected lens and leave the
// barrel distortion and vignetting to DNG opcodes, which every raw
// developer is expected to run. LibRaw hands us the image without them, so
// we read the opcodes here and let the renderer apply them on the GPU.
//
// Everything below follows the DNG 1.4+ specification (chapter 7, "Opcode
// List Processing"); the formulas are written out so the shader can match.
//
// Which image the coordinates refer to
//   OpcodeList1 runs on the raw as stored (whole IFD, masked borders too),
//   OpcodeList2 on the linearised raw, cropped to ActiveArea, before
//   demosaic, OpcodeList3 on the demosaiced image, still the ActiveArea
//   size. So for list 2 and 3 the "image" is the active area: pixel (0, 0)
//   is ActiveArea's top-left and it is W x H = (right - left) x (bottom -
//   top). LibRaw's output is also the active area (it crops the margins),
//   so the coordinates line up with what raw.js decodes. A half-size
//   decode is the same picture at half the pixels; since everything below
//   is in normalised coordinates it carries over unchanged.
//   DefaultCrop is applied after all opcodes, in active-area coordinates,
//   and gives the framing of the camera's JPEG.
//
// Order in the pipeline
//   linearise -> OpcodeList2 -> demosaic -> OpcodeList3 (in the order
//   listed) -> DefaultCrop -> colour. The vignette gain is a multiplier on
//   linear camera values, so apply it before any tone or gamma; the warp is
//   a resample. (Q2 files carry only a WarpRectilinear in list 3: Leica
//   corrects the vignetting in the raw data itself.)
//
// Normalisation (shared by both opcodes)
//   (cx, cy) is the optical centre as a fraction of the image, (0, 0) the
//   top-left corner and (1, 1) the bottom-right; in pixels
//     Cx = cx * (W - 1),  Cy = cy * (H - 1)    (SDK: x0 + cx * (x1 - x0))
//   The radius is Euclidean in pixels and normalised by one constant m, the
//   largest distance from the centre to any of the four corners, so it is 1
//   at the farthest corner. x and y share m (square pixels; the SDK scales
//   y by the pixel aspect ratio, which is 1 here), so there is no separate
//   per-axis scaling:
//     m  = max over corners (0|W-1, 0|H-1) of hypot(X - Cx, Y - Cy)
//     dx = (x - Cx) / m,  dy = (y - Cy) / m,  r2 = dx*dx + dy*dy
//   With the centre at 0.5 that is m = hypot(W - 1, H - 1) / 2.
//
// FixVignetteRadial (opcode 3): multiply every channel by
//     g = 1 + k0 r2 + k1 r2^2 + k2 r2^3 + k3 r2^4 + k4 r2^5
//   i.e. 1 + k0 r^2 + k1 r^4 + k2 r^6 + k3 r^8 + k4 r^10.
//
// WarpRectilinear (opcode 1): for each destination pixel, find the source
// pixel to sample (an inverse map, so a shader can use it directly):
//     f   = kr0 + kr1 r2 + kr2 r2^2 + kr3 r2^3
//     dxr = f * dx,  dyr = f * dy
//     dxt = 2 kt0 dx dy + kt1 (r2 + 2 dx^2)
//     dyt = 2 kt1 dx dy + kt0 (r2 + 2 dy^2)
//     xs  = Cx + m (dxr + dxt),  ys = Cy + m (dyr + dyt)
//   There is one coefficient set per plane (R, G, B for list 3); when there
//   are fewer sets than planes the last one covers the rest. Differing sets
//   correct lateral chromatic aberration.

const OPCODES = {
  1: 'WarpRectilinear', 2: 'WarpFisheye', 3: 'FixVignetteRadial',
  4: 'FixBadPixelsConstant', 5: 'FixBadPixelsList', 6: 'TrimBounds',
  7: 'MapTable', 8: 'MapPolynomial', 9: 'GainMap', 10: 'DeltaPerRow',
  11: 'DeltaPerColumn', 12: 'ScalePerRow', 13: 'ScalePerColumn',
  14: 'WarpRectilinear2',
};
const OPCODE_LISTS = { 0xc740: 1, 0xc741: 2, 0xc74e: 3 };
const TAG = {
  newSubFileType: 0xfe, width: 0x100, height: 0x101, subIfds: 0x14a,
  defaultCropOrigin: 0xc61f, defaultCropSize: 0xc620, activeArea: 0xc68d,
};
// TIFF type -> bytes per value.
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };

export function dngCorrections(buffer) {
  const v = new DataView(buffer);
  const order = v.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('dng: not a TIFF');
  const le = order === 0x4949;
  if (v.getUint16(2, le) !== 42) throw new Error('dng: not a TIFF');

  const ifds = collectIfds(v, le, v.getUint32(4, le));
  // The raw is the full-resolution image; IFD0 is usually a thumbnail.
  const raw = ifds.find((d) => d.has(TAG.newSubFileType) && value(v, le, d.get(TAG.newSubFileType))[0] === 0)
    ?? ifds[0];
  const num = (tag) => (raw.has(tag) ? value(v, le, raw.get(tag)) : null);

  const width = num(TAG.width)[0], height = num(TAG.height)[0];
  const [top, left, bottom, right] = num(TAG.activeArea) ?? [0, 0, height, width];
  const active = { x: left, y: top, w: right - left, h: bottom - top };

  // Opcodes belong to the raw IFD; look in IFD0 too, some writers put them there.
  const opcodes = [];
  for (const [tag, list] of Object.entries(OPCODE_LISTS)) {
    const e = raw.get(+tag) ?? ifds[0].get(+tag);
    if (e) opcodes.push(...parseOpcodes(v, e.offset, e.count, list));
  }

  // Prefer list 3 (the demosaiced image, which is what we render) if an
  // opcode turns up in more than one list.
  const pick = (id) => opcodes.filter((o) => o.id === id).sort((a, b) => b.list - a.list)[0] ?? null;
  const warpOp = pick(1), vigOp = pick(3);

  let warp = null;
  if (warpOp) {
    const { planes, cx, cy } = warpOp.params;
    const same = planes.every((p) => p.kr.every((k, i) => k === planes[0].kr[i]) && p.kt.every((k, i) => k === planes[0].kt[i]));
    warp = { ...planes[0], cx, cy, planes: planes.length, planesDiffer: !same, list: warpOp.list, allPlanes: planes };
  }
  const vignette = vigOp ? { ...vigOp.params, list: vigOp.list } : null;

  let defaultCrop = null;
  const origin = num(TAG.defaultCropOrigin), size = num(TAG.defaultCropSize);
  if (origin && size) {
    defaultCrop = {
      x: origin[0] / active.w, y: origin[1] / active.h, w: size[0] / active.w, h: size[1] / active.h,
      px: { x: origin[0], y: origin[1], w: size[0], h: size[1] },
    };
  }

  return {
    warp, vignette, defaultCrop, activeArea: active, rawSize: { w: width, h: height },
    opcodes: opcodes.map(({ list, id, name, flags, optional, preview }) => ({ list, id, name, flags, optional, preview })),
  };
}

// Every IFD reachable from IFD0: the next-IFD chain and SubIFDs, as maps of
// tag -> { type, count, offset } where offset points at the value bytes.
function collectIfds(v, le, first) {
  const out = [], seen = new Set(), queue = [first];
  while (queue.length) {
    const at = queue.shift();
    if (!at || seen.has(at) || at + 2 > v.byteLength) continue;
    seen.add(at);
    const n = v.getUint16(at, le), ifd = new Map();
    for (let i = 0; i < n; i++) {
      const p = at + 2 + i * 12;
      const type = v.getUint16(p + 2, le), count = v.getUint32(p + 4, le);
      const bytes = (SIZE[type] ?? 1) * count;
      ifd.set(v.getUint16(p, le), { type, count, offset: bytes <= 4 ? p + 8 : v.getUint32(p + 8, le) });
    }
    out.push(ifd);
    if (ifd.has(TAG.subIfds)) queue.push(...value(v, le, ifd.get(TAG.subIfds)));
    queue.push(v.getUint32(at + 2 + n * 12, le));
  }
  return out;
}

// Numeric tag values as plain numbers; rationals are divided out.
function value(v, le, { type, count, offset }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = offset + i * SIZE[type];
    switch (type) {
      case 1: case 7: out.push(v.getUint8(p)); break;
      case 3: out.push(v.getUint16(p, le)); break;
      case 4: case 13: out.push(v.getUint32(p, le)); break;
      case 8: out.push(v.getInt16(p, le)); break;
      case 9: out.push(v.getInt32(p, le)); break;
      case 5: out.push(v.getUint32(p, le) / v.getUint32(p + 4, le)); break;
      case 10: out.push(v.getInt32(p, le) / v.getInt32(p + 4, le)); break;
      case 11: out.push(v.getFloat32(p, le)); break;
      case 12: out.push(v.getFloat64(p, le)); break;
      default: throw new Error(`dng: unexpected tag type ${type}`);
    }
  }
  return out;
}

// An opcode list is always big-endian, whatever the file's byte order:
// count, then per opcode id, DNG version, flags, byte length, parameters.
function parseOpcodes(v, start, length, list) {
  const out = [], end = start + length;
  const n = v.getUint32(start);
  let p = start + 4;
  for (let i = 0; i < n && p + 16 <= end; i++) {
    const id = v.getUint32(p), flags = v.getUint32(p + 8), bytes = v.getUint32(p + 12);
    const at = p + 16;
    p = at + bytes;
    const op = {
      list, id, name: OPCODES[id] ?? `Unknown${id}`, flags,
      optional: !!(flags & 1), preview: !(flags & 2),   // bit 1: skip for previews
    };
    const d = (k) => v.getFloat64(at + k * 8);
    if (id === 1) {
      const planes = [];
      const count = v.getUint32(at);
      for (let j = 0; j < count; j++) {
        const q = at + 4 + j * 48, f = (k) => v.getFloat64(q + k * 8);
        planes.push({ kr: [f(0), f(1), f(2), f(3)], kt: [f(4), f(5)] });
      }
      const c = at + 4 + count * 48;
      op.params = { planes, cx: v.getFloat64(c), cy: v.getFloat64(c + 8) };
    } else if (id === 3) {
      op.params = { k: [d(0), d(1), d(2), d(3), d(4)], cx: d(5), cy: d(6) };
    }
    out.push(op);
  }
  return out;
}
