// WebGL develop pipeline. The live preview and the full-size export both go
// through this one shader, so what the sliders show is what gets written.

export const DEFAULTS = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0, vignette: 0, grain: 0, grainSize: 25, angle: 0,
  sharpen: 0, sharpenRadius: 1, noise: 0, colorNoise: 0,
  curve: null, splitShadowHue: 0, splitShadowSat: 0, splitHighlightHue: 0, splitHighlightSat: 0, splitBalance: 0,
  vertical: 0, horizontal: 0, distortion: 0, groundShift: 0, skyShift: 0, horizon: 50,
  groundArea: null, groundFeather: 4, lens: null, masks: [],
  look: null, lookAmount: 100,   // a look layered over the frame's own settings, see LOOK_KEYS
  orient: 0, flipH: false, flipV: false,   // applied first: rotate 0/90/180/270 clockwise, then mirror
  crop: { x: 0, y: 0, w: 1, h: 1 },
};

// What a look carries; studio.py keeps the same list as LOOK_FIELDS. A frame
// holds its look as a copy ({name, params}) layered over its own settings:
// the frame's sliders correct the photo underneath and the look grades the
// result, so tweaking one never changes the other.
export const LOOK_KEYS = ['temp', 'tint', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'vibrance', 'saturation', 'vignette', 'grain', 'grainSize', 'curve',
  'splitShadowHue', 'splitShadowSat', 'splitHighlightHue', 'splitHighlightSat', 'splitBalance', 'lut', 'lutHash'];

// A look's settings: only the look fields, with the curve tidied.
export function cleanLook(params) {
  const out = {};
  for (const k of LOOK_KEYS) if (params?.[k] !== undefined) out[k] = params[k];
  if ('curve' in out) out.curve = cleanCurve(out.curve);
  return out;
}

// --- 3D LUTs ---------------------------------------------------------------------

// A look can carry a 3D LUT: a .cube file in a configured LUT folder, by
// name, sRGB in and sRGB out. It grades first, before the look's sliders.
// Files load once and are shared by every renderer on the page.
const lutErrors = new Map();
const lutWarnings = new Map();
const lutKey = (name, hash = '') => `${name}#${hash}`;
export function clearLutCache() { luts.clear(); lutErrors.clear(); lutWarnings.clear(); }
const luts = new Map();   // name -> Promise of {size, data, min, max} or null

export function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1], data = null, n = 0;
  for (const line of text.split('\n')) {
    const t = line.split('#', 1)[0].trim();
    if (!t || t[0] === '#') continue;
    if (/^[-+.\d]/.test(t)) {
      if (!data) throw new Error('LUT values before LUT_3D_SIZE');
      const v = t.split(/\s+/).map(Number);
      if (v.length !== 3 || !v.every(x => Number.isFinite(x) && Math.abs(x) <= 3.402823466e38)) throw new Error('invalid LUT values');
      if (n + 3 > data.length) throw new Error('too many LUT values');
      data.set(v.slice(0, 3), n);
      n += 3;
      continue;
    }
    const [key, ...rest] = t.split(/\s+/);
    if (key === 'LUT_3D_SIZE') {
      if (size || rest.length !== 1) throw new Error('duplicate or invalid LUT size');
      size = +rest[0];
      if (!(Number.isInteger(size) && size >= 2 && size <= 129)) throw new Error(`bad LUT_3D_SIZE ${rest[0]}`);
      data = new Float32Array(size ** 3 * 3);
    } else if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported');
    else if (key === 'DOMAIN_MIN') min = rest.map(Number);
    else if (key === 'DOMAIN_MAX') max = rest.map(Number);
    else if (key !== 'TITLE') throw new Error(`unknown LUT header ${key}`);
  }
  if (!data || n !== data.length) throw new Error(`expected ${size ** 3} LUT entries, got ${n / 3}`);
  if (min.length !== 3 || max.length !== 3 || ![...min, ...max].every(x => Number.isFinite(x) && Math.abs(x) <= 3.402823466e38) || max.some((v, i) => v <= min[i])) throw new Error('invalid LUT domain');
  return { size, data, min, max };
}

export function loadLut(name, hash = '') {
  const key = lutKey(name, hash);
  if (!luts.has(key)) {
    luts.set(key, fetch(`/luts/${encodeURIComponent(name)}${hash ? `?hash=${encodeURIComponent(hash)}` : ''}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        const warning = r.headers?.get('X-LUT-Warning');
        if (warning) lutWarnings.set(key, warning);
        return r.text();
      })
      .then(parseCube)
      .then(lut => (lutErrors.delete(key), luts.set(key, lut), lut))
      .catch(e => { lutErrors.set(key, e.message); console.warn(`LUT ${name}: ${e.message}`); luts.set(key, null); return null; }));
  }
  const v = luts.get(key);
  return v instanceof Promise ? v : Promise.resolve(v);
}

// Read after lutsReady() for exports, or after the renderer's load callback.
export function lutWarning(params) {
  const { lut: name, lutHash: hash = '' } = params?.look?.params || {};
  if (!name) return '';
  const key = lutKey(name, hash);
  if (lutErrors.has(key)) {
    const reason = lutErrors.get(key);
    return `${reason === '404' ? 'Missing' : 'Unavailable'} LUT: ${name} (${reason}); rendered without this LUT`;
  }
  return lutWarnings.has(key) ? `${name}: ${lutWarnings.get(key)}` : '';
}

// Resolves once every LUT and subject mask the edit needs is loaded (or has
// failed). Call lutWarning() to report any unavailable LUT.
export function lutsReady(params) {
  const name = params?.look?.params?.lut;
  return Promise.all([name ? loadLut(name, params?.look?.params?.lutHash) : null,
    ...(params?.masks || []).filter(m => m.bitmap).map(m => loadMaskImage(m.bitmap))]);
}

// Subject masks' PNGs, decoded, by data URL: an image source for texImage2D,
// a Promise while decoding, or null if it could not be read.
const maskImages = new Map();
export function loadMaskImage(url) {
  if (!maskImages.has(url)) {
    maskImages.set(url, fetch(url).then(r => r.blob()).then(b => createImageBitmap(b))
      .then(img => (maskImages.set(url, img), img))
      .catch(e => { console.warn(`subject mask: ${e.message}`); maskImages.set(url, null); return null; }));
  }
  const v = maskImages.get(url);
  return v instanceof Promise ? v : Promise.resolve(v);
}
// A mask just painted here: use its canvas as is, no decode.
export function putMaskImage(url, canvas) {
  maskImages.set(url, canvas);
  // Keep the cache from growing without end while brushing.
  if (maskImages.size > 64) maskImages.delete(maskImages.keys().next().value);
}

// Local adjustments. Geometry is in the corrected, uncropped frame (0..1), so
// a mask stays put when the crop changes. Adjustments use slider units.
export const MAX_MASKS = 8;
export const MASK_ADJUSTMENTS = ['exposure', 'contrast', 'highlights', 'shadows', 'temp', 'tint', 'saturation'];
export const IDENTITY_MAP = [1, 0, 0, 0, 1, 0];
export function newMask(type) {
  const base = { type, name: '', enabled: true, invert: false, lumLo: 0, lumHi: 100 };
  for (const k of MASK_ADJUSTMENTS) base[k] = 0;
  // A subject mask is painted by segment.js: the brush strokes it came from
  // (frame 0..1, radius a share of the long side), the result as a greyscale
  // PNG, and map, the affine from frame to the PNG's 0..1 (u = a x + b y + c,
  // v = d x + e y + f), which follows the frame through turns and mirrors.
  if (type === 'subject') return { ...base, strokes: [], bitmap: null, map: IDENTITY_MAP };
  if (type === 'linear') return { ...base, x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.45 };   // top-down, e.g. a sky
  if (type === 'rect') return { ...base, cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 50, falloff: 0 };
  return { ...base, cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, feather: 50 };
}

export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

// The frame's size once turned: a quarter turn swaps width and height.
export function orientedSize(p, w, h) {
  return ((p && p.orient) || 0) % 180 ? [h, w] : [w, h];
}

// Turn or mirror an edit as a whole: the image, and everything placed on it
// (crop, masks, ground-shift area) and the corrections that depend on
// direction (straighten, keystones). op: 'cw', 'ccw', '180', 'flipH', 'flipV'.
export function reorient(params, op) {
  const p = normalize(params);
  const pt = {
    cw: ([x, y]) => [1 - y, x],
    ccw: ([x, y]) => [y, 1 - x],
    '180': ([x, y]) => [1 - x, 1 - y],
    flipH: ([x, y]) => [1 - x, y],
    flipV: ([x, y]) => [x, 1 - y],
  }[op];
  const quarter = op === 'cw' || op === 'ccw';
  if (op === 'flipH' || op === 'flipV') {
    p[op] = !p[op];
    p.angle = -p.angle;
    if (op === 'flipH') p.horizontal = -p.horizontal; else p.vertical = -p.vertical;
  } else {
    p.orient = (p.orient + { cw: 90, ccw: 270, '180': 180 }[op]) % 360;
    // Turning a quarter moves the mirror to the other axis.
    if (quarter) [p.flipH, p.flipV] = [p.flipV, p.flipH];
    const [v, h] = [p.vertical, p.horizontal];
    if (op === 'cw') [p.vertical, p.horizontal] = [-h, v];
    else if (op === 'ccw') [p.vertical, p.horizontal] = [h, -v];
    else [p.vertical, p.horizontal] = [-v, -h];
  }
  const c = p.crop, corners = [[c.x, c.y], [c.x + c.w, c.y + c.h]].map(pt);
  const xs = corners.map(q => q[0]), ys = corners.map(q => q[1]);
  p.crop = { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
  // Each op's inverse, as an affine [a, b, c, d, e, f]: new frame -> old.
  const inv = {
    cw: [0, 1, 0, -1, 0, 1], ccw: [0, -1, 1, 1, 0, 0], '180': [-1, 0, 1, 0, -1, 1],
    flipH: [-1, 0, 1, 0, 1, 0], flipV: [1, 0, 0, 0, -1, 1],
  }[op];
  p.masks = p.masks.map(m => {
    if (m.type === 'subject') {
      const [a, b, c, d, e, f] = m.map || IDENTITY_MAP, [A, B, C, D, E, F] = inv;
      return {
        ...m,
        map: [a * A + b * D, a * B + b * E, a * C + b * F + c, d * A + e * D, d * B + e * E, d * C + e * F + f],
        strokes: (m.strokes || []).map(s => ({ ...s, pts: s.pts.map(pt) })),
      };
    }
    if (m.type === 'linear') {
      const [a, b] = [pt([m.x1, m.y1]), pt([m.x2, m.y2])];
      return { ...m, x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
    }
    const [cx, cy] = pt([m.cx, m.cy]);
    // A rect's angle is clockwise in frame pixels: a mirror reverses it, and a
    // quarter turn is the same as swapping its sides.
    if (m.type === 'rect' && !(op === 'cw' || op === 'ccw' || op === '180')) m = { ...m, angle: -m.angle };
    return quarter ? { ...m, cx, cy, rx: m.ry, ry: m.rx } : { ...m, cx, cy };
  });
  if (p.groundArea) p.groundArea = p.groundArea.map(pt);
  return p;
}

// Tone curves: points [x, y] in 0..100, one list per channel. 'rgb' bends all
// three channels, then 'r', 'g' and 'b' bend their own. A curve holds only the
// channels that differ from the straight line, or is null.
export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];
export const IDENTITY_CURVE = [[0, 0], [100, 100]];
const isIdentity = pts => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 100 && pts[1][1] === 100;

export function cleanCurve(c) {
  if (!c) return null;
  const out = {};
  for (const ch of CURVE_CHANNELS) if (c[ch] && !isIdentity(c[ch])) out[ch] = c[ch];
  return Object.keys(out).length ? out : null;
}

// Monotone cubic through the points (Fritsch-Carlson), so the curve never
// overshoots between points and never folds back. Flat past the end points.
export function curveFn(pts) {
  const xs = pts.map(q => q[0] / 100), ys = pts.map(q => q[1] / 100), n = pts.length;
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const hx = xs[i + 1] - xs[i], t = (x - xs[i]) / hx, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hx * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hx * m[i + 1];
  };
}

const LUT_SIZE = 1024;
// One row per curve: the frame's own, then its look's.
function curveLut(...curves) {
  const out = new Float32Array(LUT_SIZE * 4 * curves.length);
  curves.forEach((curve, row) => {
    const f = ch => curveFn(curve?.[ch] || IDENTITY_CURVE);
    const master = f('rgb'), rgb = [f('r'), f('g'), f('b')];
    for (let i = 0; i < LUT_SIZE; i++) {
      const y = master(i / (LUT_SIZE - 1)), o = 4 * (row * LUT_SIZE + i);
      for (let c = 0; c < 3; c++) out[o + c] = rgb[c](y);
      out[o + 3] = 1;
    }
  });
  return out;
}

// Split toning's tint for a hue: the colour's chroma alone, with no
// brightness of its own, scaled by saturation.
function tintFor(hue, sat) {
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = 1 - Math.abs(h % 2 - 1);
  const c = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map(v => (v - y) * 0.22 * sat / 100);
}

export function normalize(p) {
  const out = { ...DEFAULTS, ...(p || {}) };
  out.curve = cleanCurve(out.curve);
  out.crop = { ...FULL_CROP, ...((p && p.crop) || {}) };
  out.masks = ((p && p.masks) || []).map(m => ({ ...newMask(m.type), ...m }));
  out.look = p?.look ? { name: String(p.look.name || ''), params: cleanLook(p.look.params) } : null;
  delete out.version;
  return out;
}

const VERT = `#version 300 es
in vec2 pos;
out vec2 v_uv;
void main() {
  // v_uv.y = 0 at the top of the output, matching image row order.
  v_uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 color;
uniform sampler2D img;
uniform vec2 srcSize;
uniform vec4 crop;          // x, y, w, h in the straightened frame, 0..1
uniform float angle;        // radians
uniform float vertical, horizontal, distortion;                 // -1..1
uniform float groundShift, horizon;   // bottom-edge shift (-1..1), horizon height (0..1)
uniform float skyShift;               // top-edge shift (-1..1), the mirror of ground shift
#define MAX_AREA 8
uniform int areaCount;                // 0: shift everywhere below the horizon
uniform vec2 areaPts[MAX_AREA];       // polygon, frame 0..1
uniform float areaFeather;            // soft edge width, fraction of frame width
uniform float lensK[5];     // Lensfun profile, see lenses.py; identity is 1,0,0,0,0
uniform float lensScale;
uniform int orient;          // 0..3: quarter turns clockwise
uniform float flipH, flipV;  // mirror left-right, top-bottom (after the turn)
uniform float exposure;     // EV
uniform float contrast, highlights, shadows, whites, blacks;   // -1..1
uniform float temp, tint, vibrance, saturation, vignette;       // -1..1
uniform sampler2D curveLut;       // composed rgb then per-channel curves, perceptual; row 0 own, row 1 look
uniform int useCurve;
uniform vec3 splitShadow, splitHigh;   // tint added in the shadows and highlights
uniform float splitPivot;              // where shadows hand over to highlights
// The look, graded over the frame's own settings and mixed in by lookAmount.
uniform int useLook;
uniform float lookAmount;              // 0..1
uniform vec2 lookWb;                   // temp, tint
uniform vec4 lookTone;                 // contrast, highlights, shadows, whites
uniform float lookBlacks;
uniform vec2 lookPresence;             // saturation, vibrance
uniform int lookCurve;
uniform vec3 lookSplitShadow, lookSplitHigh;
uniform float lookSplitPivot;
uniform int useLut;
uniform highp sampler3D lut;           // sRGB in, sRGB out
uniform vec3 lutMin, lutScale;         // the file's domain
uniform float lutSize;
uniform float grain, grainSize;   // 0..1
uniform float pxSize;             // one output pixel, in frame long sides
uniform float seed;
uniform int linearSrc;       // 1: the source is decoded raw, already linear
// Camera profile (camera-profiles.json): turns a raw into what the camera's
// own JPEG engine would have made of it, before any of the edit.
uniform int useProfile;
uniform mat3 camMatrix;
uniform sampler2D baseCurve; // linear in, linear out, sampled over log2 exposure
uniform vec2 baseLog;        // log2 range the curve covers
// DNG lens warp (dng.js), per colour plane, in the stored image.
uniform int useWarp;
uniform vec4 warpKr[3];
uniform vec2 warpCentre;
// Detail, 0..1-ish, with a raw's base amounts already added in (render()).
uniform float sharpen, sharpenRadius, noiseLuma, noiseColor;

#define MAX_MASKS 8
uniform int maskCount;
uniform int maskType[MAX_MASKS];    // 0 none (still loading), 1 linear, 2 radial, 3 rect, 4 subject
uniform vec4 maskGeo[MAX_MASKS];    // linear x1 y1 x2 y2 | radial, rect cx cy rx ry, frame 0..1 | subject a b d e
uniform vec2 maskShift[MAX_MASKS];  // subject: c f, see newMask()
uniform sampler2D maskTex0, maskTex1, maskTex2, maskTex3, maskTex4, maskTex5, maskTex6, maskTex7;
uniform float maskAngle[MAX_MASKS]; // rect: radians clockwise, in frame pixels
uniform float maskFalloff[MAX_MASKS]; // rect: 0..1, fade from the top end to the bottom
uniform vec4 maskOpt[MAX_MASKS];    // invert, feather, luminance low, luminance high
uniform vec4 maskAdjA[MAX_MASKS];   // exposure EV, contrast, highlights, shadows
uniform vec4 maskAdjB[MAX_MASKS];   // temp, tint, saturation, unused
uniform int showMask;               // mask to tint red, or -1

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float KEYSTONE = 0.6;   // slider 100 -> strength of the perspective tilt
const float LENS = 0.25;      // slider 100 -> radial correction at the corners
const float GROUND = 0.2;     // slider 100 -> bottom edge moves a fifth of the width

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453);
}

// Film grain. Positions are in the output frame measured in long sides, so the
// grain sits in the same place and at the same size at any resolution: the
// preview, a thumbnail and the full-size export all show the same grain. When
// a pixel is bigger than a grain, it averages several, so the grain fades
// rather than turning into coarse speckle.
uint pcg(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x;
}
// The source at stored-image point t, linear: the raw (through its DNG lens
// warp, per colour plane, if it has one) or the camera JPEG.
vec3 sourceAt(vec2 t) {
  if (useWarp == 1) {
    vec2 S = vec2(textureSize(img, 0));
    vec2 C = warpCentre * (S - 1.0);
    float mw = length(max(C, S - 1.0 - C));
    vec2 d = (t * S - C) / mw;
    float r2 = dot(d, d);
    vec3 rgb;
    for (int ch = 0; ch < 3; ch++) {
      vec4 k = warpKr[ch];
      rgb[ch] = texture(img, (C + mw * d * (k.x + r2 * (k.y + r2 * (k.z + r2 * k.w)))) / S)[ch];
    }
    return rgb;
  }
  return linearSrc == 1 ? texture(img, t).rgb : toLinear(texture(img, t).rgb);
}

// Noise reduction and the detail sharpening adds back, from the source's
// neighbourhood. Steps are one output pixel (at least one source pixel), so
// the preview, thumbnails and the export each work at their own scale, the
// way the result is seen. Works on perceptual values, split into luminance
// and colour: luminance is smoothed only between similar neighbours (edges
// stay), colour more freely, since colour noise is blotchy and edges are
// carried by luminance. Returns the cleaned pixel; detail is the luminance
// the sharpening adds at the end, after the tone work.
// The source averaged over the footprint of one output pixel, px source
// pixels across, in up to maxK x maxK samples. Shrinking a big raw to slide
// size with one sample per pixel breaks thin lines (panel seams, railings)
// into dashes; averaging what the pixel covers keeps them whole.
vec3 sourceBox(vec2 t, float px, vec2 S, int maxK) {
  int k = min(maxK, int(ceil(px - 0.01)));
  if (k <= 1) return sourceAt(t);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= k) break;
    for (int j = 0; j < 6; j++) {
      if (j >= k) break;
      sum += sourceAt(t + (vec2(float(i), float(j)) + 0.5 - 0.5 * float(k)) * (px / float(k)) / S);
    }
  }
  return sum / float(k * k);
}

const float PI = 3.14159265;
vec3 cleanDetail(vec2 t, vec3 rgb, float px, vec2 S, out float detail) {
  vec3 Pc = pow(max(rgb, 0.0), vec3(1.0 / 2.2));
  float Yc = dot(Pc, LUMA);
  float sig = 0.01 + 0.1 * noiseLuma;
  float ys = Yc, yw = 1.0, cw = 1.0;
  vec3 cs = Pc - Yc;
  // Luminance from two close rings; colour from two wider ones, since colour
  // noise comes in blotches several pixels across. Once an output pixel covers
  // a few source pixels, averaging them has already done this.
  for (int i = 0; i < 24; i++) {
    if (px > 2.0) break;
    bool lum = i < 12;
    int j = i - (lum ? 0 : 12);
    float ring = (j < 6 ? 1.5 : 3.0) * (lum ? 1.0 : 2.7);
    float a = (float(j) + (j < 6 ? 0.0 : 0.5)) * PI / 3.0;
    vec3 P = pow(max(sourceAt(t + vec2(cos(a), sin(a)) * ring * px / S), 0.0), vec3(1.0 / 2.2));
    float Y = dot(P, LUMA), dy = Y - Yc;
    if (lum) {
      float wl = exp(-ring * ring / 8.0) * exp(-dy * dy / (2.0 * sig * sig));
      ys += wl * Y; yw += wl;
    } else {
      float wc = exp(-ring * ring / 60.0) * exp(-dy * dy / 0.01);
      cs += wc * (P - Y); cw += wc;
    }
  }
  float Y = mix(Yc, ys / yw, noiseLuma);
  vec3 C = mix(Pc - Yc, cs / cw, noiseColor);
  detail = 0.0;
  if (sharpen > 0.0) {
    float b = 0.0;
    for (int i = 0; i < 6; i++) {
      float a = float(i) * PI / 3.0 + 0.5;
      b += dot(pow(max(sourceBox(t + vec2(cos(a), sin(a)) * sharpenRadius * px / S, px, S, 3), 0.0), vec3(1.0 / 2.2)), LUMA);
    }
    float d = Y - b / 6.0;
    // Leave the smallest differences alone, so grain and noise are not
    // sharpened along with the edges; and cap the largest, against halos.
    detail = clamp(d, -0.12, 0.12) * smoothstep(0.001, 0.006, abs(d));
  }
  return pow(max(Y + C, 0.0), vec3(2.2));
}

float curveAt(float x, int c, float row) {
  float u = clamp(x, 0.0, 1.0) * (1023.0 / 1024.0) + 0.5 / 1024.0;
  return texture(curveLut, vec2(u, row))[c] + max(x - 1.0, 0.0);
}

vec3 applyLut(vec3 rgb) {
  vec3 c = clamp((toSrgb(rgb) - lutMin) * lutScale, 0.0, 1.0);
  c = c * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
  return toLinear(clamp(texture(lut, c).rgb, 0.0, 1.0));
}

// Curves and split toning work on perceptual values, like the tone sliders.
// row picks the curve: 0.25 the frame's own, 0.75 the look's.
vec3 colorGrade(vec3 rgb, bool curve, float row, vec3 sShadow, vec3 sHigh, float pivot) {
  vec3 P = pow(max(rgb, 0.0), vec3(1.0 / 2.2));
  if (curve) P = vec3(curveAt(P.r, 0, row), curveAt(P.g, 1, row), curveAt(P.b, 2, row));
  float t = clamp(dot(P, LUMA) - pivot + 0.5, 0.0, 1.0);
  float wh = t * t * (3.0 - 2.0 * t);
  P += sShadow * (1.0 - wh) + sHigh * wh;
  return pow(max(P, 0.0), vec3(2.2));
}

float lattice(vec2 i) {
  return float(pcg(uvec2(ivec2(i) + 65536))) / 4294967295.0 * 2.0 - 1.0;
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lattice(i), lattice(i + vec2(1.0, 0.0)), f.x),
             mix(lattice(i + vec2(0.0, 1.0)), lattice(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 filmGrain(vec3 rgb, vec2 q) {
  float cell = mix(0.0002, 0.0012, grainSize);
  float s = max(cell, pxSize);
  vec2 g = q / s;
  float n = 0.8 * valueNoise(g) + 0.5 * valueNoise(g * 1.93 + 17.3);
  n *= min(1.0, cell / pxSize);
  // Strongest in the midtones, as on film; a little left in the shadows.
  float Y = dot(rgb, LUMA);
  float P = pow(max(Y, 0.0), 1.0 / 2.2);
  float P2 = max(0.0, P + grain * 0.16 * n * (0.3 + 2.8 * P * (1.0 - P)));
  float Y2 = pow(P2, 2.2);
  return Y > 1e-6 ? rgb * (Y2 / Y) : vec3(Y2);
}

// How much of the ground shift applies at pixel p: 1 inside the area polygon,
// 0 outside, with a soft band across the edge so there is no seam.
float areaWeight(vec2 p) {
  if (areaCount < 3) return 1.0;
  bool inside = false;
  float d = 1e9;
  for (int i = 0; i < MAX_AREA; i++) {
    if (i >= areaCount) break;
    int j = i + 1 < areaCount ? i + 1 : 0;
    vec2 a = areaPts[i] * srcSize, b = areaPts[j] * srcSize;
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    d = min(d, length(p - a - ab * t));
  }
  float f = max(areaFeather * srcSize.x, 1.0);
  return smoothstep(-0.5 * f, 0.5 * f, inside ? d : -d);
}

// White balance, normalised so it shifts hue without shifting brightness.
vec3 whiteBalance(vec3 rgb, float t, float u) {
  vec3 gains = vec3(exp(0.35 * t), exp(-0.3 * u), exp(-0.35 * t));
  return rgb * gains / dot(gains, LUMA);
}

// Tone works on luminance in a perceptual space, then scales rgb by the
// luminance ratio, so pushing shadows or highlights never shifts hue.
vec3 tone(vec3 rgb, float ct, float hl, float sh, float wh, float bl) {
  float Y = dot(rgb, LUMA);
  float P = pow(max(Y, 0.0), 1.0 / 2.2);
  float wp = 1.0 - 0.3 * wh;
  float bp = -0.08 * bl;
  P = (P - bp) / (wp - bp);
  float Pc = clamp(P, 0.0, 1.0);
  P += sh * 1.4 * Pc * (1.0 - Pc) * (1.0 - Pc);
  P += hl * 1.2 * Pc * Pc * (1.0 - Pc);
  Pc = clamp(P, 0.0, 1.0);
  if (ct >= 0.0) {
    P = mix(P, Pc * Pc * (3.0 - 2.0 * Pc), ct);
  } else {
    P = mix(P, 0.5 + (P - 0.5) * 0.5, -ct);
  }
  float Y2 = pow(max(P, 0.0), 2.2);
  return Y > 1e-6 ? rgb * (Y2 / Y) : vec3(Y2);
}

// Saturation everywhere; vibrance mostly where colour is still muted.
vec3 presence(vec3 rgb, float s, float vib) {
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float sat = mx > 1e-6 ? (mx - mn) / mx : 0.0;
  float f = max(0.0, 1.0 + s + vib * (1.0 - sat));
  float Y = dot(rgb, LUMA);
  return max(vec3(0.0), Y + (rgb - Y) * f);
}

// A subject mask's painted weight. Samplers can't be indexed by a loop
// variable in GLSL ES 3.00, hence the ladder.
float subjectAt(int i, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  if (i == 0) return texture(maskTex0, uv).r;
  if (i == 1) return texture(maskTex1, uv).r;
  if (i == 2) return texture(maskTex2, uv).r;
  if (i == 3) return texture(maskTex3, uv).r;
  if (i == 4) return texture(maskTex4, uv).r;
  if (i == 5) return texture(maskTex5, uv).r;
  if (i == 6) return texture(maskTex6, uv).r;
  return texture(maskTex7, uv).r;
}

// How much mask i applies at frame point q (0..1), given the pixel so far.
float maskWeight(int i, vec2 q, vec3 rgb) {
  vec4 g = maskGeo[i], o = maskOpt[i];
  float w;
  if (maskType[i] == 0) return 0.0;
  if (maskType[i] == 4) {
    w = subjectAt(i, vec2(dot(g.xy, q) + maskShift[i].x, dot(g.zw, q) + maskShift[i].y));
  } else if (maskType[i] == 1) {
    // Full at the first point, fading to nothing at the second.
    vec2 a = g.xy * srcSize, ab = g.zw * srcSize - a;
    float t = dot(q * srcSize - a, ab) / max(dot(ab, ab), 1e-6);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (maskType[i] == 3) {
    // Turned into the rect's own axes, in pixels so the corners stay square.
    vec2 d = (q - g.xy) * srcSize;
    float cs = cos(maskAngle[i]), sn = sin(maskAngle[i]);
    d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y);
    vec2 h = max(g.zw * srcSize, vec2(0.5));
    // Signed distance to the edge, negative inside; feather fades inwards
    // from the edge by a share of the shorter half-side.
    vec2 e = abs(d) - h;
    float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
    float f = clamp(o.y, 0.01, 1.0) * min(h.x, h.y);
    w = 1.0 - smoothstep(-f, 0.0, sd);
    // Falloff along the length, like a shaft of light fading as it travels:
    // full at the top end (the turn handle's side), less towards the bottom.
    float along = clamp((d.y + h.y) / (2.0 * h.y), 0.0, 1.0);
    w *= 1.0 - maskFalloff[i] * smoothstep(0.0, 1.0, along);
  } else {
    float d = length((q - g.xy) / max(g.zw, vec2(1e-4)));
    w = 1.0 - smoothstep(1.0 - clamp(o.y, 0.01, 1.0), 1.0, d);
  }
  if (o.x > 0.5) w = 1.0 - w;
  // Luminance range: only where the pixel is between low and high, softly.
  float P = pow(max(dot(rgb, LUMA), 0.0), 1.0 / 2.2);
  if (o.z > 0.0) w *= smoothstep(o.z - 0.08, o.z + 0.08, P);
  if (o.w < 1.0) w *= 1.0 - smoothstep(o.w - 0.08, o.w + 0.08, P);
  return w;
}

void main() {
  // Geometry, undone in reverse: output pixel -> crop -> straighten ->
  // perspective -> lens distortion -> source. Mirrored by toSource() in JS.
  vec2 p = (crop.xy + v_uv * crop.zw) * srcSize;
  // Ground shift: stepping sideways moves ground points in proportion to how
  // far below the horizon they are, and leaves the horizon itself alone.
  p.x -= groundShift * GROUND * srcSize.x * max(0.0, p.y / srcSize.y - horizon) / max(1.0 - horizon, 0.05)
         * areaWeight(p);
  // Sky shift: the same above the horizon, growing towards the top edge.
  p.x -= skyShift * GROUND * srcSize.x * max(0.0, horizon - p.y / srcSize.y) / max(horizon, 0.05);
  vec2 c = srcSize * 0.5;
  vec2 d = p - c;
  float cs = cos(angle), sn = sin(angle);
  d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y);
  float R = 0.5 * max(srcSize.x, srcSize.y);
  vec2 n = d / R;
  float w = 1.0 - KEYSTONE * vertical * n.y + KEYSTONE * horizontal * n.x;
  n /= max(w, 1e-3);
  vec2 half_ = c / R;
  n *= 1.0 - LENS * distortion * dot(n, n) / dot(half_, half_);
  // Lens profile last: it undoes the first thing that happened to the light.
  // Lensfun measures radius in half the shorter side.
  float Rs = 0.5 * min(srcSize.x, srcSize.y);
  vec2 m = n * R / Rs * lensScale;
  float lr = length(m);
  m *= lensK[0] + lr * (lensK[1] + lr * (lensK[2] + lr * (lensK[3] + lr * lensK[4])));
  n = m / lensScale * Rs / R;
  vec2 uv = (n * R + c) / srcSize;
  if (w < 0.05 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // uv is in the turned, mirrored frame; find the stored pixel.
  vec2 t = uv;
  if (flipH > 0.5) t.x = 1.0 - t.x;
  if (flipV > 0.5) t.y = 1.0 - t.y;
  if (orient == 1) t = vec2(t.y, 1.0 - t.x);
  else if (orient == 2) t = 1.0 - t;
  else if (orient == 3) t = vec2(1.0 - t.y, t.x);
  // Each colour plane of a DNG has its own warp, which also takes out colour fringes.
  vec2 S = vec2(textureSize(img, 0));
  float px = max(1.0, pxSize * max(S.x, S.y));   // source pixels per output pixel
  vec3 rgb = sourceBox(t, px, S, 6);
  float detail = 0.0;
  if (sharpen > 0.0 || noiseLuma > 0.0 || noiseColor > 0.0) rgb = cleanDetail(t, rgb, px, S, detail);
  if (useProfile == 1) rgb = max(camMatrix * rgb, 0.0);

  rgb = whiteBalance(rgb, temp, tint) * exp2(exposure);
  if (useProfile == 1) {
    // The camera's tone curve, after exposure so pulling exposure down brings
    // back highlights the JPEG had already clipped.
    vec3 u = (log2(max(rgb, vec3(1e-9))) - baseLog.x) / (baseLog.y - baseLog.x);
    float n = float(textureSize(baseCurve, 0).x);
    u = clamp(u, 0.5 / n, 1.0 - 0.5 / n);
    rgb = vec3(texture(baseCurve, vec2(u.r, 0.5)).r, texture(baseCurve, vec2(u.g, 0.5)).r,
               texture(baseCurve, vec2(u.b, 0.5)).r);
  }
  rgb = tone(rgb, contrast, highlights, shadows, whites, blacks);
  rgb = presence(rgb, saturation, vibrance);
  if (useCurve == 1 || splitShadow != vec3(0.0) || splitHigh != vec3(0.0))
    rgb = colorGrade(rgb, useCurve == 1, 0.25, splitShadow, splitHigh, splitPivot);

  // Masks, in order, each blending its own adjustments in by its weight.
  vec2 q = crop.xy + v_uv * crop.zw;
  float overlay = 0.0;
  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= maskCount) break;
    float mw = maskWeight(i, q, rgb);
    if (i == showMask) overlay = mw;
    if (mw <= 0.0) continue;
    vec3 l = whiteBalance(rgb, maskAdjB[i].x, maskAdjB[i].y) * exp2(maskAdjA[i].x);
    l = tone(l, maskAdjA[i].y, maskAdjA[i].z, maskAdjA[i].w, 0.0, 0.0);
    l = presence(l, maskAdjB[i].z, 0.0);
    rgb = mix(rgb, l, mw);
  }

  // The look, over everything the frame corrects for itself.
  if (useLook == 1) {
    vec3 l = useLut == 1 ? applyLut(rgb) : rgb;
    l = whiteBalance(l, lookWb.x, lookWb.y);
    l = tone(l, lookTone.x, lookTone.y, lookTone.z, lookTone.w, lookBlacks);
    l = presence(l, lookPresence.x, lookPresence.y);
    l = colorGrade(l, lookCurve == 1, 0.75, lookSplitShadow, lookSplitHigh, lookSplitPivot);
    rgb = mix(rgb, l, lookAmount);
  }

  // Vignette measured across the cropped frame, corner = 1.
  vec2 outSize = crop.zw * srcSize;
  float r = length((v_uv - 0.5) * outSize) / (0.5 * length(outSize));
  rgb *= 1.0 + vignette * 0.8 * smoothstep(0.35, 1.0, r);
  if (detail != 0.0) {
    float Yd = dot(rgb, LUMA), Pd = pow(max(Yd, 0.0), 1.0 / 2.2);
    float Yd2 = pow(max(Pd + sharpen * 4.0 * detail, 0.0), 2.2);
    rgb = Yd > 1e-6 ? rgb * (Yd2 / Yd) : vec3(Yd2);
  }
  if (grain > 0.0) rgb = filmGrain(rgb, q * srcSize / max(srcSize.x, srcSize.y));

  // Half-step dither keeps smooth sunset gradients from banding in 8 bits.
  vec3 outc = toSrgb(rgb) + (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outc = mix(outc, vec3(1.0, 0.18, 0.18), overlay * 0.55);
  color = vec4(outc, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false, antialias: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.u = {};
    for (const name of ['img', 'srcSize', 'crop', 'angle', 'vertical', 'horizontal', 'distortion', 'groundShift', 'skyShift', 'horizon', 'areaCount', 'areaPts', 'areaFeather', 'lensK', 'lensScale', 'orient', 'flipH', 'flipV', 'maskCount', 'maskType', 'maskGeo', 'maskShift',
      'maskTex0', 'maskTex1', 'maskTex2', 'maskTex3', 'maskTex4', 'maskTex5', 'maskTex6', 'maskTex7', 'maskAngle', 'maskFalloff', 'maskOpt', 'maskAdjA', 'maskAdjB', 'showMask', 'exposure', 'contrast', 'highlights',
      'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'vignette', 'grain', 'grainSize', 'pxSize', 'seed', 'curveLut', 'useCurve', 'splitShadow', 'splitHigh', 'splitPivot', 'useLook', 'lookAmount', 'lookWb', 'lookTone', 'lookBlacks', 'lookPresence', 'lookCurve', 'lookSplitShadow', 'lookSplitHigh', 'lookSplitPivot', 'useLut', 'lut', 'lutMin', 'lutScale', 'lutSize', 'linearSrc', 'useProfile', 'camMatrix', 'baseCurve', 'baseLog', 'useWarp', 'warpKr', 'warpCentre', 'sharpen', 'sharpenRadius', 'noiseLuma', 'noiseColor']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.lut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.lutKey = undefined;
    this.base = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.base);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.lut3d = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.lut3d);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    }
    // A texture unit's 3D binding must never be left empty while sampled.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3));
    gl.activeTexture(gl.TEXTURE0);
    // Subject masks on texture units 4 and up, one per mask slot, each
    // remembering which PNG it holds.
    this.maskTex = [];
    this.maskTexUrl = [];
    for (let i = 0; i < MAX_MASKS; i++) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE4 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
      this.maskTex.push(t);
      this.maskTexUrl.push(null);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.lutName = undefined;
    this.renders = 0;
    this.profile = null;
    this.warp = null;
    this.w = this.h = 0;
  }

  // The look's LUT on texture unit 3; false while it is still loading or when
  // it could not be read. A render that went out without its LUT is redone
  // once it arrives (by onLutLoad, when the owner sets one), unless something
  // else was drawn in the meantime.
  setLut(name, hash, redo) {
    if (!name) return false;
    const key = lutKey(name, hash);
    const lut = luts.get(key);
    if (lut === undefined || lut instanceof Promise) {
      const n = this.renders;
      loadLut(name, hash).then(() => { if (this.renders === n) redo(); });
      return false;
    }
    if (!lut) return false;
    if (this.lutName !== key) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, this.lut3d);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.activeTexture(gl.TEXTURE0);
      this.lutName = key;
    }
    const gl = this.gl;
    gl.uniform3fv(this.u.lutMin, lut.min);
    gl.uniform3fv(this.u.lutScale, lut.max.map((v, i) => 1 / Math.max(v - lut.min[i], 1e-6)));
    gl.uniform1f(this.u.lutSize, lut.size);
    return true;
  }

  // A camera profile from camera-profiles.json, or null for none.
  setProfile(profile) {
    this.profile = profile || null;
    if (!profile) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.base);
    const v = profile.curve.values;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, v.length, 1, 0, gl.RED, gl.FLOAT, new Float32Array(v));
    gl.activeTexture(gl.TEXTURE0);
  }

  setCurve(curve, lookCurve) {
    const key = JSON.stringify([curve, lookCurve]);
    if (key === this.lutKey) return;
    this.lutKey = key;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 2, 0, gl.RGBA, gl.FLOAT, curveLut(curve, lookCurve));
    gl.activeTexture(gl.TEXTURE0);
  }

  // bitmap is an ImageBitmap (a camera JPEG, sRGB) or a decoded raw from
  // raw.js: {linear: true, width, height, half} with half-float RGB pixels.
  setImage(bitmap) {
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (bitmap.width > max || bitmap.height > max) {
      throw new Error(`image is ${bitmap.width}x${bitmap.height}; this GPU tops out at ${max}px`);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.linear = !!bitmap.linear;
    this.warp = (this.linear && bitmap.warp) || null;
    this.setProfile(this.linear ? bitmap.profile : null);
    if (this.linear) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, bitmap.width, bitmap.height, 0, gl.RGB, gl.HALF_FLOAT, bitmap.half);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    }
    this.w = bitmap.width;
    this.h = bitmap.height;
  }

  // opts.crop / opts.angle override the recipe's geometry (crop mode shows the
  // whole straightened frame); opts.tone === false renders the untouched image.
  render(params, opts = {}) {
    const gl = this.gl;
    this.renders++;
    const p = normalize(params);
    const crop = opts.crop || p.crop;
    const angle = opts.angle ?? p.angle;
    const tone = opts.tone !== false;
    // Everything after the turn works in the turned frame, so a quarter turn swaps sides.
    const [fw, fh] = orientedSize(p, this.w, this.h);
    let scale = Math.min(1, (opts.maxSize || Infinity) / Math.max(crop.w * fw, crop.h * fh));
    let outW = Math.max(1, Math.round(crop.w * fw * scale));
    let outH = Math.max(1, Math.round(crop.h * fh * scale));
    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== outH) this.canvas.height = outH;
    // The browser may quietly give a big canvas a smaller drawing buffer
    // (Chrome stops around 33MP), and a full-size viewport would then land
    // only its bottom-left corner in it: a tighter crop. Shrink to fit instead.
    const fit = Math.min(1, gl.drawingBufferWidth / outW, gl.drawingBufferHeight / outH);
    if (fit < 1) {
      scale *= fit;
      outW = Math.max(1, Math.min(gl.drawingBufferWidth, Math.floor(crop.w * fw * scale)));
      outH = Math.max(1, Math.min(gl.drawingBufferHeight, Math.floor(crop.h * fh * scale)));
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.prog);
    gl.uniform1i(this.u.img, 0);
    gl.uniform2f(this.u.srcSize, fw, fh);
    gl.uniform1i(this.u.orient, ((opts.tone === false ? 0 : p.orient) / 90) & 3);
    gl.uniform1f(this.u.flipH, opts.tone !== false && p.flipH ? 1 : 0);
    gl.uniform1f(this.u.flipV, opts.tone !== false && p.flipV ? 1 : 0);
    gl.uniform4f(this.u.crop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1f(this.u.angle, angle * Math.PI / 180);
    gl.uniform1f(this.u.vertical, p.vertical / 100);
    gl.uniform1f(this.u.horizontal, p.horizontal / 100);
    gl.uniform1f(this.u.distortion, p.distortion / 100);
    gl.uniform1f(this.u.groundShift, p.groundShift / 100);
    gl.uniform1f(this.u.horizon, p.horizon / 100);
    gl.uniform1f(this.u.skyShift, p.skyShift / 100);
    const area = (p.groundArea || []).slice(0, 8);
    const pts = new Float32Array(16);
    area.forEach(([x, y], i) => pts.set([x, y], 2 * i));
    gl.uniform1i(this.u.areaCount, area.length >= 3 ? area.length : 0);
    gl.uniform2fv(this.u.areaPts, pts);
    gl.uniform1f(this.u.areaFeather, p.groundFeather / 100);
    // A DNG that carries its own lens warp is corrected by that instead.
    const lens = this.warp ? null : p.lens;
    gl.uniform1fv(this.u.lensK, lens ? lens.k : [1, 0, 0, 0, 0]);
    gl.uniform1f(this.u.lensScale, lens ? lens.scale || 1 : 1);
    gl.uniform1f(this.u.exposure, tone ? p.exposure : 0);
    for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint',
      'vibrance', 'saturation']) {
      gl.uniform1f(this.u[k], tone ? p[k] / 100 : 0);
    }
    // The look, and how much of it. Vignette and grain have no layer of
    // their own: the look's adds to the frame's.
    const L = tone && p.look ? { ...DEFAULTS, ...p.look.params } : null;
    const amt = L ? Math.min(1, Math.max(0, p.lookAmount / 100)) : 0;
    gl.uniform1i(this.u.useLook, amt > 0 ? 1 : 0);
    gl.uniform1f(this.u.lookAmount, amt);
    if (L) {
      gl.uniform2f(this.u.lookWb, L.temp / 100, L.tint / 100);
      gl.uniform4f(this.u.lookTone, L.contrast / 100, L.highlights / 100, L.shadows / 100, L.whites / 100);
      gl.uniform1f(this.u.lookBlacks, L.blacks / 100);
      gl.uniform2f(this.u.lookPresence, L.saturation / 100, L.vibrance / 100);
      gl.uniform1i(this.u.lookCurve, L.curve ? 1 : 0);
      gl.uniform3fv(this.u.lookSplitShadow, tintFor(L.splitShadowHue, L.splitShadowSat));
      gl.uniform3fv(this.u.lookSplitHigh, tintFor(L.splitHighlightHue, L.splitHighlightSat));
      gl.uniform1f(this.u.lookSplitPivot, 0.5 - 0.4 * L.splitBalance / 100);
    }
    gl.uniform1i(this.u.lut, 3);
    gl.uniform1i(this.u.useLut, amt > 0 && this.setLut(L.lut, L.lutHash, this.onLutLoad || (() => this.render(params, opts))) ? 1 : 0);
    const vignette = tone ? p.vignette + (L ? L.vignette * amt : 0) : 0;
    gl.uniform1f(this.u.vignette, Math.max(-1, Math.min(1, vignette / 100)));
    const curve = tone ? p.curve : null;
    this.setCurve(curve, L?.curve || null);
    gl.uniform1i(this.u.curveLut, 1);
    gl.uniform1i(this.u.useCurve, curve ? 1 : 0);
    gl.uniform3fv(this.u.splitShadow, tone ? tintFor(p.splitShadowHue, p.splitShadowSat) : [0, 0, 0]);
    gl.uniform3fv(this.u.splitHigh, tone ? tintFor(p.splitHighlightHue, p.splitHighlightSat) : [0, 0, 0]);
    gl.uniform1f(this.u.splitPivot, 0.5 - 0.4 * p.splitBalance / 100);
    // Raws start with light sharpening and colour noise reduction, as the
    // camera's JPEG engine gives its JPEGs; the sliders add to that.
    const base = this.linear ? { sharpen: 0.3, color: 0.5 } : { sharpen: 0, color: 0 };
    gl.uniform1f(this.u.sharpen, base.sharpen + (tone ? p.sharpen / 100 : 0));
    gl.uniform1f(this.u.sharpenRadius, p.sharpenRadius);
    gl.uniform1f(this.u.noiseLuma, tone ? p.noise / 100 : 0);
    gl.uniform1f(this.u.noiseColor, Math.min(1, base.color + (tone ? p.colorNoise / 100 : 0)));
    // The frame's own grain size wins when it has grain of its own.
    const lookGrain = L ? L.grain * amt : 0;
    gl.uniform1f(this.u.grain, tone ? Math.min(1, (p.grain + lookGrain) / 100) : 0);
    gl.uniform1f(this.u.grainSize, (p.grain > 0 || !lookGrain ? p.grainSize : L.grainSize) / 100);
    gl.uniform1f(this.u.pxSize, crop.w * fw / outW / Math.max(fw, fh));
    gl.uniform1f(this.u.seed, 0.5);
    gl.uniform1i(this.u.linearSrc, this.linear ? 1 : 0);
    const prof = this.profile;
    gl.uniform1i(this.u.useProfile, prof ? 1 : 0);
    gl.uniform1i(this.u.baseCurve, 2);
    if (prof) {
      gl.uniformMatrix3fv(this.u.camMatrix, true, prof.matrix.flat());
      gl.uniform2f(this.u.baseLog, prof.curve.logMin, prof.curve.logMax);
    }
    const warp = this.warp;
    gl.uniform1i(this.u.useWarp, warp ? 1 : 0);
    if (warp) {
      const kr = new Float32Array(12);
      for (let c = 0; c < 3; c++) kr.set((warp.allPlanes[c] || warp.allPlanes[warp.allPlanes.length - 1]).kr, 4 * c);
      gl.uniform4fv(this.u.warpKr, kr);
      gl.uniform2f(this.u.warpCentre, warp.cx, warp.cy);
    }
    this.setMasks(tone && !opts.masksOff ? p.masks : [], opts.showMask ?? -1,
      this.onLutLoad || (() => this.render(params, opts)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { width: outW, height: outH };
  }

  // show is an index into the full list; switched-off masks are skipped, so
  // it is remapped to the mask's place among those that render.
  // A subject mask whose PNG is still decoding sits out, and the render is
  // redone once it arrives, as with a LUT.
  setMasks(all, show, redo) {
    const on = all.map((m, i) => [m, i]).filter(([m]) => m.enabled !== false);
    const masks = on.map(([m]) => m);
    show = on.findIndex(([, i]) => i === show);
    const gl = this.gl, n = Math.min(masks.length, MAX_MASKS);
    const type = new Int32Array(MAX_MASKS), geo = new Float32Array(4 * MAX_MASKS);
    const angle = new Float32Array(MAX_MASKS), falloff = new Float32Array(MAX_MASKS);
    const opt = new Float32Array(4 * MAX_MASKS), a = new Float32Array(4 * MAX_MASKS);
    const b = new Float32Array(4 * MAX_MASKS), shift = new Float32Array(2 * MAX_MASKS);
    masks.slice(0, n).forEach((m, i) => {
      const lin = m.type === 'linear';
      type[i] = lin ? 1 : m.type === 'rect' ? 3 : m.type === 'subject' ? 4 : 2;
      angle[i] = (m.angle || 0) * Math.PI / 180;
      falloff[i] = m.type === 'rect' ? (m.falloff || 0) / 100 : 0;
      if (m.type === 'subject') {
        const [ma, mb, mc, md, me, mf] = m.map || IDENTITY_MAP;
        geo.set([ma, mb, md, me], 4 * i);
        shift.set([mc, mf], 2 * i);
        if (!this.setMaskImage(i, m.bitmap, redo)) type[i] = 0;
      } else geo.set(lin ? [m.x1, m.y1, m.x2, m.y2] : [m.cx, m.cy, m.rx, m.ry], 4 * i);
      opt.set([m.invert ? 1 : 0, (m.feather ?? 50) / 100, m.lumLo / 100, m.lumHi / 100], 4 * i);
      a.set([m.exposure, m.contrast / 100, m.highlights / 100, m.shadows / 100], 4 * i);
      b.set([m.temp / 100, m.tint / 100, m.saturation / 100, 0], 4 * i);
    });
    gl.uniform1i(this.u.maskCount, n);
    gl.uniform1iv(this.u.maskType, type);
    gl.uniform4fv(this.u.maskGeo, geo);
    gl.uniform2fv(this.u.maskShift, shift);
    for (let i = 0; i < MAX_MASKS; i++) gl.uniform1i(this.u[`maskTex${i}`], 4 + i);
    gl.uniform1fv(this.u.maskAngle, angle);
    gl.uniform1fv(this.u.maskFalloff, falloff);
    gl.uniform4fv(this.u.maskOpt, opt);
    gl.uniform4fv(this.u.maskAdjA, a);
    gl.uniform4fv(this.u.maskAdjB, b);
    gl.uniform1i(this.u.showMask, show < n ? show : -1);
  }

  // Puts a subject mask's PNG on slot i's texture; false while it loads.
  setMaskImage(i, url, redo) {
    if (!url) return false;
    const img = maskImages.get(url);
    if (img === undefined || img instanceof Promise) {
      const n = this.renders;
      loadMaskImage(url).then(l => { if (l && this.renders === n) redo(); });
      return false;
    }
    if (!img) return false;
    if (this.maskTexUrl[i] !== url) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE4 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex[i]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.activeTexture(gl.TEXTURE0);
      this.maskTexUrl[i] = url;
    }
    return true;
  }

  // The corrected, uncropped frame with the frame's own settings but no masks,
  // as RGBA rows top first: what a subject mask is found in.
  readFrame(params, maxSize) {
    const { width, height } = this.render(params, { crop: FULL_CROP, maxSize, masksOff: true });
    const gl = this.gl, data = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const row = width * 4, tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * row, b = (height - 1 - y) * row;
      tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
    }
    return { w: width, h: height, data };
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// --- crop geometry -------------------------------------------------------------

// Same as the shader's areaWeight.
export function areaWeight(px, py, p, W, H) {
  const area = p.groundArea;
  if (!area || area.length < 3) return 1;
  let inside = false, d = Infinity;
  for (let i = 0; i < area.length; i++) {
    const [ax, ay] = [area[i][0] * W, area[i][1] * H];
    const [bx, by] = [area[(i + 1) % area.length][0] * W, area[(i + 1) % area.length][1] * H];
    if ((ay > py) !== (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;
    const abx = bx - ax, aby = by - ay;
    const t = Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / Math.max(abx * abx + aby * aby, 1e-6)));
    d = Math.min(d, Math.hypot(px - ax - abx * t, py - ay - aby * t));
  }
  const f = Math.max(p.groundFeather / 100 * W, 1);
  const x = (inside ? d : -d) / f + 0.5;
  const s = Math.min(1, Math.max(0, x));
  return s * s * (3 - 2 * s);
}

// Where a point of the corrected frame lands in the source, in pixels, or
// null when it lands nowhere. Same transform as the shader.
const KEYSTONE = 0.6, LENS = 0.25, GROUND = 0.2;
function toSource(px, py, params, W, H) {
  const p = normalize(params);
  const a = p.angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  px -= (p.groundShift / 100) * GROUND * W * Math.max(0, py / H - p.horizon / 100) / Math.max(1 - p.horizon / 100, 0.05)
        * areaWeight(px, py, p, W, H);
  px -= (p.skyShift / 100) * GROUND * W * Math.max(0, p.horizon / 100 - py / H) / Math.max(p.horizon / 100, 0.05);
  const dx = px - W / 2, dy = py - H / 2;
  const R = 0.5 * Math.max(W, H);
  let nx = (cs * dx + sn * dy) / R, ny = (-sn * dx + cs * dy) / R;
  const w = 1 - KEYSTONE * (p.vertical / 100) * ny + KEYSTONE * (p.horizontal / 100) * nx;
  if (w < 0.05) return null;
  nx /= w; ny /= w;
  const hx = W / 2 / R, hy = H / 2 / R;
  const k = 1 - LENS * (p.distortion / 100) * (nx * nx + ny * ny) / (hx * hx + hy * hy);
  nx *= k; ny *= k;
  if (p.lens) {
    const Rs = 0.5 * Math.min(W, H), s = p.lens.scale || 1, L = p.lens.k;
    const mx = nx * R / Rs * s, my = ny * R / Rs * s, r = Math.hypot(mx, my);
    const f = L[0] + r * (L[1] + r * (L[2] + r * (L[3] + r * L[4])));
    nx = mx * f / s * Rs / R; ny = my * f / s * Rs / R;
  }
  return [nx * R + W / 2, ny * R + H / 2];
}

// True when the crop's corners and edge midpoints all fall on real image, not
// black fill. Midpoints matter once lens correction bows the edges.
export function cropValid(crop, params, W, H) {
  const eps = 1e-6;
  if (crop.w <= 0 || crop.h <= 0 || crop.x < -eps || crop.y < -eps ||
      crop.x + crop.w > 1 + eps || crop.y + crop.h > 1 + eps) return false;
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
    const s = toSource((crop.x + u * crop.w) * W, (crop.y + v * crop.h) * H, params, W, H);
    if (!s || s[0] < -0.5 || s[1] < -0.5 || s[0] > W + 0.5 || s[1] > H + 0.5) return false;
  }
  return true;
}

// Shrink a crop about its centre until it sits inside the corrected image.
export function fitCrop(crop, params, W, H) {
  if (cropValid(crop, params, W, H)) return crop;
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  const at = s => ({ x: cx - crop.w * s / 2, y: cy - crop.h * s / 2, w: crop.w * s, h: crop.h * s });
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (cropValid(at(mid), params, W, H)) lo = mid; else hi = mid;
  }
  return at(lo);
}

// --- full-size export ------------------------------------------------------------

export async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 503 ? res.statusText : `${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
}

export async function renderJpeg(bitmap, params, quality = 0.95) {
  const canvas = document.createElement('canvas');
  const r = new Renderer(canvas);
  try {
    r.setImage(bitmap);
    await lutsReady(params);
    r.render(params);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
  } finally {
    r.dispose();
  }
}
