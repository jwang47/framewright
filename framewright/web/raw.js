// Raw decoding in the page, with LibRaw compiled to WebAssembly. A decoded
// raw is linear light in sRGB primaries, white balanced as shot, handed to
// the renderer as half floats so nothing is lost to 8 bits.
import LibRaw from './vendor/libraw/index.js?v=worker-lifecycle-2';
import { dngCorrections } from './dng.js';

// This build ignores the gamm setting and always writes dcraw's default
// BT.709-style curve (power 0.45, toe slope 4.5), so the output is undone to
// linear in halfTable() rather than asked for.
//
// Highlights are rebuilt (LibRaw's blend mode) rather than clipped: where one
// or two channels clipped, the others still carry the detail. That mode
// scales by the largest white-balance multiplier instead of the smallest,
// leaving headroom; decode() scales back so everything the sensor did not clip
// matches a clipped decode exactly (which is what the camera profiles were
// fitted on), and the rebuilt highlights land above 1 for the sliders to use.
const SETTINGS = {
  outputBps: 16, noAutoBright: true, useCameraWb: true,
  outputColor: 1, highlight: 2, userQual: 3,
};

// dcraw's gamma_curve(): the knee where the linear toe meets the power
// segment, found the same way dcraw finds it so the inverse is exact.
function dcrawGamma(pwr = 0.45, ts = 4.5) {
  const bnd = [0, 1];
  let g2 = 0;
  for (let i = 0; i < 48; i++) {
    g2 = (bnd[0] + bnd[1]) / 2;
    bnd[(Math.pow(g2 / ts, -pwr) - 1) / pwr - 1 / g2 > -1 ? 1 : 0] = g2;
  }
  const g4 = g2 * (1 / pwr - 1);
  return y => (y < g2 ? y / ts : Math.pow((y + g4) / (1 + g4), 1 / pwr));
}

// Encoded uint16 -> linear half-float bits, times scale. 0..65535 maps to
// 0..scale. Kept per scale: a camera's multipliers repeat from shot to shot.
const TABLES = new Map();
function halfTable(scale = 1) {
  if (TABLES.has(scale)) return TABLES.get(scale);
  const t = new Uint16Array(65536);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer), linear = dcrawGamma();
  for (let i = 0; i < 65536; i++) {
    f[0] = linear(i / 65535) * scale;
    const x = u[0], e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (e <= 0) t[i] = e < -10 ? 0 : (m | 0x800000) >> (14 - e);   // subnormal
    else t[i] = (e << 10) | (m >> 13);
  }
  if (TABLES.size > 8) TABLES.clear();
  TABLES.set(scale, t);
  return t;
}

// How much darker a highlight-rebuilding decode comes out than a clipped one:
// the spread of the white-balance multipliers it used.
function headroom(meta, highlight) {
  if (!highlight) return 1;
  const cd = meta.color_data || {};
  const mul = [0, 1, 2].map(c => cd.cam_mul?.[c] || 0);
  const use = mul.every(v => v > 0) ? mul : [0, 1, 2].map(c => cd.pre_mul?.[c] || 1);
  return Math.max(...use) / Math.min(...use);
}

// Camera profiles, fitted by profile-fit.js from each camera's own raw + JPEG
// pairs. A camera without one gets the default: the curve alone, no matrix.
let PROFILES = null;
async function profileFor(camera) {
  PROFILES = PROFILES || fetch('/camera-profiles.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const all = await PROFILES;
  return all[camera] || all.default || null;
}

// Recent decodes kept, up to a memory budget: stepping back to the last
// frame, or on to one decoded ahead of time, should not redecode. A half-size
// decode of a 47MP raw is ~70MB of half floats; a full one four times that.
const cache = new Map();   // id -> {job, bytes}; oldest first
const BUDGET = 640e6;

function trim() {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  for (const [id, e] of cache) {
    if (total <= BUDGET || cache.size <= 1) break;
    if (!e.bytes) continue;   // still decoding
    cache.delete(id);
    total -= e.bytes;
  }
}

// keep: false drops the decode from the cache once done, unless someone else
// asked for it meanwhile. stale: asked while the decode runs. Once it says so, the caller gets null
// at once, and a decode nobody else is waiting for is stopped (its worker
// killed) so the next frame does not queue behind it.
export async function loadRaw(shoot, key, { full = false, highlight = SETTINGS.highlight, stale = null, keep = true } = {}) {
  const id = `${shoot}/${key}/${full ? 'full' : 'half'}/${highlight}`;
  let entry = cache.get(id);
  if (entry) {
    cache.delete(id);
    cache.set(id, entry);
    entry.shared = true;
  } else {
    const ctl = new AbortController();
    entry = { job: decode(shoot, key, full, highlight, ctl.signal), bytes: 0, shared: false, ctl };
    cache.set(id, entry);
    entry.job.then(img => {
      entry.bytes = img.half.byteLength;
      if (!keep && !entry.shared && cache.get(id) === entry) cache.delete(id);
      trim();
    }, () => cache.get(id) === entry && cache.delete(id));
  }
  if (!stale) return entry.job;
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (!stale()) return;
      clearInterval(t);
      resolve(null);
      if (!entry.shared && !entry.bytes) {
        if (cache.get(id) === entry) cache.delete(id);
        entry.ctl.abort();
      }
    }, 50);
    entry.job.then(v => { clearInterval(t); resolve(v); }, e => { clearInterval(t); reject(e); });
  });
}

async function decode(shoot, key, full, highlight, signal) {
  const res = await fetch(`/rawfile/${encodeURIComponent(shoot)}/${encodeURIComponent(key)}`, { signal });
  if (!res.ok) throw new Error(res.status === 503 ? res.statusText : `raw ${key}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  signal.throwIfAborted();
  // A DNG may carry lens corrections LibRaw leaves undone (dng.js).
  let warp = null;
  if (/\.dng$/i.test(res.headers.get('X-Raw-Name') || '') || isDng(buffer)) {
    try { warp = dngCorrections(buffer).warp; } catch { /* no usable opcodes: leave the lens as shot */ }
  }
  const lr = new LibRaw();
  const stop = () => lr.dispose();
  signal.addEventListener('abort', stop);
  try {
    await lr.open(new Uint8Array(buffer), { ...SETTINGS, highlight, halfSize: !full });
    const meta = await lr.metadata(true);
    const img = await lr.imageData();
    if (img.colors !== 3 || img.bits !== 16) throw new Error(`raw ${key}: unexpected ${img.colors}x${img.bits}-bit output`);
    const scale = Math.round(headroom(meta, highlight) * 1e4) / 1e4;
    const t = halfTable(scale), src = img.data, half = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) half[i] = t[src[i]];
    // The camera picks the profile that makes the raw start out like its JPEG.
    const camera = `${meta.camera_make || ''} ${meta.camera_model || ''}`.trim();
    return { linear: true, width: img.width, height: img.height, half, camera, warp, profile: await profileFor(camera) };
  } finally {
    signal.removeEventListener('abort', stop);
    lr.dispose();
  }
}

// DNGs are TIFFs with a DNGVersion tag; cheap enough to look for it directly.
function isDng(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
  const le = b[0] === 0x49;
  for (let i = 8; i + 1 < b.length; i += 2) {
    if (le ? b[i] === 0x12 && b[i + 1] === 0xc6 : b[i] === 0xc6 && b[i + 1] === 0x12) return true;   // tag 0xC612
  }
  return false;
}
