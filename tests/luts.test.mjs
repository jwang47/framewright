import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
