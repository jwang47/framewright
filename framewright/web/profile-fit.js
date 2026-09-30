// Fits a camera profile: the colour matrix and tone curve that take this
// camera's decoded raw (linear, sRGB primaries, as-shot white balance) to what
// its own JPEG engine made of the same exposure. Applied to a raw, the profile
// makes it start out looking like the camera's JPEG, with the raw's latitude.
//
// A development tool, run from the browser console against a library of
// raw + JPEG pairs:
//   const { fitProfile } = await import('/profile-fit.js');
//   await fitProfile([['2026-09-24_a6700', 'DSC00612'], ...], { centre: 0.7 })
// and the result goes into camera-profiles.json.
import { loadRaw } from './raw.js';

const SIZE = 96;          // samples across the compared region
const BINS = 64;          // tone curve resolution, over log2 exposure
export const LOG_MIN = -12, LOG_MAX = 2;

const halfToFloat = x => {
  const e = (x >> 10) & 31, m = x & 1023;
  return e === 0 ? m / 1024 * 2 ** -14 : (1 + m / 1024) * 2 ** (e - 15);
};
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Average the central `centre` fraction of a picture down to SIZE wide.
// get(fx, fy) reads the picture at a point in 0..1, so the raw and the JPEG
// are sampled at the same places even when the raw needs its lens undone.
function boxDown(get, aspect, centre) {
  const ow = SIZE, oh = Math.round(SIZE / aspect), out = new Float64Array(ow * oh * 3), k = 6;
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < k; sy++) for (let sx = 0; sx < k; sx++) {
      const fx = 0.5 + ((ox + (sx + 0.5) / k) / ow - 0.5) * centre;
      const fy = 0.5 + ((oy + (sy + 0.5) / k) / oh - 0.5) * centre;
      const [pr, pg, pb] = get(fx, fy); r += pr; g += pg; b += pb;
    }
    out.set([r / k / k, g / k / k, b / k / k], (oy * ow + ox) * 3);
  }
  return out;
}

// Where a point of the corrected frame lies in the decoded raw, channel c,
// by the DNG warp (dng.js has the maths); the identity without one.
function unwarp(warp, W, H, fx, fy, c) {
  if (!warp) return [fx * W, fy * H];
  const kr = (warp.allPlanes[c] || warp.allPlanes[warp.allPlanes.length - 1]).kr;
  const Cx = warp.cx * (W - 1), Cy = warp.cy * (H - 1), m = Math.hypot(Math.max(Cx, W - 1 - Cx), Math.max(Cy, H - 1 - Cy));
  const dx = (fx * W - Cx) / m, dy = (fy * H - Cy) / m, r2 = dx * dx + dy * dy;
  const f = kr[0] + r2 * (kr[1] + r2 * (kr[2] + r2 * kr[3]));
  return [Cx + m * f * dx, Cy + m * f * dy];
}

async function samples(shoot, key, centre) {
  const raw = await loadRaw(shoot, key);
  const H = raw.half, W = raw.width, Ht = raw.height;
  const at = (x, y, c) => {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x))), yi = Math.min(Ht - 1, Math.max(0, Math.round(y)));
    return halfToFloat(H[(yi * W + xi) * 3 + c]);
  };
  const r = boxDown((fx, fy) => [0, 1, 2].map(c => at(...unwarp(raw.warp, W, Ht, fx, fy, c), c)), W / Ht, centre);
  const bmp = await createImageBitmap(await (await fetch(`/original/${shoot}/${key}.jpg`)).blob(),
    { imageOrientation: 'from-image' });
  const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data, BW = bmp.width;
  const j = boxDown((fx, fy) => {
    const i = (Math.min(bmp.height - 1, Math.floor(fy * bmp.height)) * BW + Math.min(BW - 1, Math.floor(fx * BW))) * 4;
    return [toLinear(px[i] / 255), toLinear(px[i + 1] / 255), toLinear(px[i + 2] / 255)];
  }, bmp.width / bmp.height, centre);
  bmp.close();
  return { camera: raw.camera, r, j };
}

// Least-violators pass: make ys non-decreasing, pooling runs that fall.
function isotonic(ys, ws) {
  const v = [], w = [], n = [];
  for (let i = 0; i < ys.length; i++) {
    v.push(ys[i]); w.push(ws[i]); n.push(1);
    while (v.length > 1 && v[v.length - 2] > v[v.length - 1]) {
      const b = v.pop(), bw = w.pop(), bn = n.pop();
      const a = v.pop(), aw = w.pop(), an = n.pop();
      v.push((a * aw + b * bw) / (aw + bw)); w.push(aw + bw); n.push(an + bn);
    }
  }
  return v.flatMap((x, i) => new Array(n[i]).fill(x));
}

function solve3(A, b) {
  const [a, bb, c, d, e, f, g, h, k] = A.flat();
  const det = a * (e * k - f * h) - bb * (d * k - f * g) + c * (d * h - e * g);
  const inv = [
    [e * k - f * h, c * h - bb * k, bb * f - c * e],
    [f * g - d * k, a * k - c * g, c * d - a * f],
    [d * h - e * g, bb * g - a * h, a * e - bb * d],
  ].map(r => r.map(x => x / det));
  return inv.map(r => r[0] * b[0] + r[1] * b[1] + r[2] * b[2]);
}

export async function fitProfile(pairs, { centre = 0.9, iterations = 6, chroma = 6 } = {}) {
  const R = [], J = [];
  let camera = null;
  for (const [shoot, key] of pairs) {
    const s = await samples(shoot, key, centre);
    camera = camera || s.camera;
    if (s.camera !== camera) throw new Error(`${key} is from ${s.camera}, not ${camera}`);
    for (let i = 0; i < s.r.length; i += 3) {
      const jr = s.j.subarray(i, i + 3), rr = s.r.subarray(i, i + 3);
      // Only where the JPEG is neither crushed nor clipped in any channel.
      if (Math.min(...jr) < toLinear(0.03) || Math.max(...jr) > toLinear(0.96) || Math.min(...rr) <= 0) continue;
      R.push([...rr]); J.push([...jr]);
    }
  }
  let M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], curve = null;
  const apply = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const bin = x => Math.min(BINS - 1, Math.max(0, Math.floor((Math.log2(Math.max(x, 1e-9)) - LOG_MIN) / (LOG_MAX - LOG_MIN) * BINS)));
  const binX = i => 2 ** (LOG_MIN + (i + 0.5) / BINS * (LOG_MAX - LOG_MIN));
  const T = x => {   // the curve, log-linear between bin centres
    const u = (Math.log2(Math.max(x, 1e-9)) - LOG_MIN) / (LOG_MAX - LOG_MIN) * BINS - 0.5;
    const i = Math.max(0, Math.min(BINS - 2, Math.floor(u))), t = Math.min(1, Math.max(0, u - i));
    return curve[i] + (curve[i + 1] - curve[i]) * t;
  };
  const Tinv = y => {
    let lo = LOG_MIN, hi = LOG_MAX;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (T(2 ** mid) < y) lo = mid; else hi = mid; }
    return 2 ** ((lo + hi) / 2);
  };
  for (let it = 0; it < iterations; it++) {
    // Tone curve: median JPEG value per bin of matrixed raw, all channels pooled.
    const buckets = Array.from({ length: BINS }, () => []);
    for (let n = 0; n < R.length; n++) {
      const x = apply(M, R[n]);
      for (let c = 0; c < 3; c++) if (x[c] > 0) buckets[bin(x[c])].push(J[n][c]);
    }
    const med = buckets.map(b => (b.length ? b.sort((a, c) => a - c)[b.length >> 1] : NaN));
    const wts = buckets.map(b => b.length);
    // Fill empty bins: below the data the curve heads to black, above it keeps
    // its last slope in log space so the raw's extra highlights stay usable.
    const enough = Math.max(50, R.length / 2000);
    const known = med.map((v, i) => (Number.isFinite(v) && wts[i] >= enough ? i : -1)).filter(i => i >= 0);
    const lo = known[0], hi = known[known.length - 1];
    const filled = med.map((v, i) => {
      if (i < lo) return med[lo] * binX(i) / binX(lo);
      if (i > hi) return med[hi];   // extended after smoothing, below
      if (known.includes(i)) return v;
      const a = known.filter(k => k < i).pop(), b = known.find(k => k > i);
      return med[a] + (med[b] - med[a]) * (i - a) / (b - a);
    });
    // Smooth across neighbouring bins (in log space) before forcing it to rise,
    // so sparse bins near the ends don't leave steps.
    const smooth = filled.map((_, i) => {
      let s = 0, w = 0;
      for (let d = -3; d <= 3; d++) {
        const k = Math.min(BINS - 1, Math.max(0, i + d)), g = Math.exp(-d * d / 4.5) * (wts[k] + 1);
        s += Math.log(Math.max(filled[k], 1e-6)) * g; w += g;
      }
      return Math.exp(s / w);
    });
    curve = isotonic(smooth, smooth.map((_, i) => wts[i] + 1));
    // Past the data the curve keeps rising gently from where it ended, so the
    // raw's extra highlights stay usable and there is no step.
    for (let i = hi + 1; i < BINS; i++) curve[i] = curve[hi] * (binX(i) / binX(hi)) ** 0.35;
    // Matrix: per output channel, least squares on the curve's inverse, weighted
    // for relative error so the shadows count as much as the highlights.
    const Z = J.map(j => j.map(Tinv));
    M = [0, 1, 2].map(c => {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (let n = 0; n < R.length; n++) {
        // Saturated colours weigh more: there are far fewer of them than
        // neutrals, and skies and foliage are where a matrix shows.
        const j = J[n], sat = (Math.max(...j) - Math.min(...j)) / Math.max(...j, 1e-6);
        const r = R[n], z = Z[n][c], w = (1 + chroma * sat) / (z + 0.005) ** 2;
        for (let a = 0; a < 3; a++) { b[a] += w * r[a] * z; for (let d = 0; d < 3; d++) A[a][d] += w * r[a] * r[d]; }
      }
      return solve3(A, b);
    });
    // Scale belongs to the curve, not the matrix: white stays at luminance 1.
    const Y = [0.2126, 0.7152, 0.0722].reduce((s, l, c) => s + l * M[c].reduce((a, b) => a + b, 0), 0);
    M = M.map(row => row.map(v => v / Y));
  }
  // Residual, in 8-bit sRGB steps, as a sanity check.
  const enc = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  let err = 0;
  for (let n = 0; n < R.length; n++) {
    const x = apply(M, R[n]);
    for (let c = 0; c < 3; c++) err += Math.abs(enc(T(x[c])) - enc(J[n][c]));
  }
  const round = v => Math.round(v * 1e5) / 1e5;
  return {
    camera, pairs: pairs.length, samples: R.length, meanError8bit: round(err / R.length / 3),
    matrix: M.map(r => r.map(round)),
    curve: { logMin: LOG_MIN, logMax: LOG_MAX, values: curve.map(round) },
  };
}
