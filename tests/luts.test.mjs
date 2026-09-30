import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

// Data import keeps the application build-free without a package.json module flag.
const code = await readFile(new URL('../framewright/web/render.js', import.meta.url), 'utf8');
const { loadLut, lutsReady, lutWarning } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const recipe = name => ({ look: { name: 'Test', params: { lut: name } } });

test('missing and invalid LUTs remain visible after loading fails', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await lutsReady(recipe('missing.cube'));
    assert.match(lutWarning(recipe('missing.cube')), /Missing LUT: missing.cube.*rendered without/);
    assert.equal(lutWarning({}), '');
    globalThis.fetch = async () => ({ ok: true, text: async () => 'invalid' });
    await loadLut('invalid.cube');
    assert.match(lutWarning(recipe('invalid.cube')), /Unavailable LUT: invalid.cube/);
    // A tiny identity table generated here is test data, never a shipped asset.
    const cube = ['LUT_' + '3D_SIZE 2', ...Array.from({length: 8}, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`)].join('\n');
    globalThis.fetch = async () => ({ ok: true, text: async () => cube });
    await lutsReady(recipe('valid.cube'));
    assert.equal(lutWarning(recipe('valid.cube')), '');
  } finally {
    globalThis.fetch = previous;
  }
});

test('fingerprints isolate cached LUTs and report filename fallback mismatch', async () => {
  const previous = globalThis.fetch;
  try {
    const cube = ['LUT_' + '3D_SIZE 2', ...Array.from({length: 8}, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`)].join('\n');
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(url);
      return { ok: true, headers: { get: () => 'LUT fingerprint mismatch; rendered with the file found by name' }, text: async () => cube };
    };
    const params = recipe('valid.cube');
    params.look.params.lutHash = '0123456789abcdef';
    await lutsReady(params);
    assert.equal(urls[0], '/luts/valid.cube?hash=0123456789abcdef');
    assert.match(lutWarning(params), /fingerprint mismatch/);
    assert.equal(lutWarning(recipe('valid.cube')), '');
  } finally { globalThis.fetch = previous; }
});

test('cube parser refuses unsafe or ambiguous values', async () => {
  const { parseCube } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const header = 'LUT_' + '3D_SIZE ';
  assert.throws(() => parseCube(header + '2.5'));
  assert.throws(() => parseCube(header + '2\n0 0'));
  assert.throws(() => parseCube(header + '2\n0 Infinity 0'));
  assert.throws(() => parseCube(header + '2\n0 0 0\n' + header + '2'));
});

// A synthetic look profile: an RGB table of the given offsets from identity,
// encoded as Camera Raw does. Test data only, never a real film profile.
export function xmpProfile(offset = () => [0, 0, 0], { n = 2, primaries = 1, gamma = 3, amount = '1' } = {}) {
  const body = Buffer.alloc(16 + n ** 3 * 6 + 8);
  [1, 1, 3, n].forEach((v, i) => body.writeUInt32LE(v, i * 4));
  let o = 16;
  for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++) {
    for (const d of offset(r, g, b)) { body.writeUInt16LE(d & 0xffff, o); o += 2; }
  }
  body.writeUInt32LE(primaries, o); body.writeUInt32LE(gamma, o + 4);
  const z = deflateSync(body), bytes = Buffer.concat([Buffer.alloc(4), z]);
  bytes.writeUInt32LE(body.length, 0);
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`'|()[]{}@%$#";
  let text = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.subarray(i, i + 4);
    let v = 0;
    for (let j = chunk.length - 1; j >= 0; j--) v = v * 256 + chunk[j];
    for (let j = 0; j <= chunk.length; j++) { text += digits[v % 85]; v = Math.floor(v / 85); }
  }
  const esc = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const digest = '0123456789ABCDEF0123456789ABCDEF';
  return `<x:xmpmeta><rdf:RDF><rdf:Description crs:RGBTable="${digest}" crs:${'Table'}_${digest}="${esc}" crs:RGBTableAmount="${amount}"/></rdf:RDF></x:xmpmeta>`;
}

test('look profiles decode to an sRGB LUT at their own amount', async () => {
  const { parseXmpLook } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const identity = await parseXmpLook(xmpProfile());
  assert.equal(identity.size, 48);
  for (let k = 0; k < identity.data.length; k += 997) {
    const i = k / 3 | 0, want = [i % 48, (i / 48 | 0) % 48, i / 2304 | 0][k % 3] / 47;
    assert.ok(Math.abs(identity.data[k] - want) < 0.02, `identity at ${k}: ${identity.data[k]} vs ${want}`);
  }
  // Pull the white corner's blue down; half the amount moves it half as far.
  const warm = (r, g, b) => [0, 0, r && g && b ? -0x4000 : 0];
  const full = await parseXmpLook(xmpProfile(warm, { primaries: 0, gamma: 1 }));
  const half = await parseXmpLook(xmpProfile(warm, { primaries: 0, gamma: 1, amount: '0.5' }));
  const last = full.data.length - 1;
  assert.ok(Math.abs(full.data[last] - 0.75) < 0.01, `${full.data[last]}`);
  assert.ok(Math.abs(half.data[last] - 0.875) < 0.01, `${half.data[last]}`);
  assert.ok(Math.abs(full.data[last - 2] - 1) < 0.01);
  await assert.rejects(parseXmpLook('<x:xmpmeta/>'), /no RGB table/);
  await assert.rejects(parseXmpLook(xmpProfile(undefined, { gamma: 9 })), /gamma/);
  await assert.rejects(parseXmpLook(xmpProfile(undefined, { amount: 'x' })), /amount/);
});
