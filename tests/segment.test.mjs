import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const code = await readFile(new URL('../framewright/web/segment.js', import.meta.url), 'utf8');
const { segmentSubject } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const w = 32, h = 32;
const image = { w, h, data: new Uint8Array(w * h * 4) };
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const inside = x >= 10 && x < 22 && y >= 10 && y < 22;
  image.data.set(inside ? [240, 30, 30, 255] : [20, 20, 180, 255], 4 * (y * w + x));
}
test('empty and subtract-only strokes select nothing', () => {
  for (const strokes of [[], [{ pts: [[0.5, 0.5]], r: 0.1, sub: true }]]) {
    assert.equal(segmentSubject(image, strokes).some(Boolean), false);
  }
});
test('subject stroke selects the contrasting center while excluding distant background', () => {
  const mask = segmentSubject(image, [{ pts: [[0.5, 0.5]], r: 0.15, sub: false }]);
  assert.equal(mask.length, w * h);
  assert.ok(mask[16 * w + 16] > 200);
  assert.equal(mask[0], 0);
  assert.equal(mask[w * h - 1], 0);
});
