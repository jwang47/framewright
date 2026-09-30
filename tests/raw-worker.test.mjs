import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path = new URL('../framewright/web/vendor/libraw/index.js', import.meta.url);
const code = (await readFile(path, 'utf8')).replaceAll('import.meta.url', JSON.stringify(path.href));
const { default: LibRaw } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const originalWorker = globalThis.Worker;

class Worker {
  messages = [];
  stopped = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.stopped = true; }
  reply(out) { this.onmessage({ data: { id: this.messages.at(-1).id, out } }); }
}

function setup(t) {
  globalThis.Worker = Worker;
  const decoder = new LibRaw();
  t.after(() => { decoder.dispose(); globalThis.Worker = originalWorker; });
  return decoder;
}

test('worker failure rejects active and queued operations', async t => {
  const decoder = setup(t);
  const opened = decoder.open(new Uint8Array(4), {});
  const image = decoder.imageData();
  const checks = [assert.rejects(opened, /worker failed: out of memory/), assert.rejects(image, /worker failed/)];
  await Promise.resolve();
  decoder.worker.onerror({ message: 'out of memory', preventDefault() {} });
  await Promise.all(checks);
  assert.equal(decoder.worker.stopped, true);
  assert.equal(decoder.pending.size, 0);
});

test('an unresponsive worker is terminated and a fresh decoder can succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const decoder = setup(t);
  const opened = decoder.open(new Uint8Array(4), {});
  const check = assert.rejects(opened, /timed out during open/);
  await Promise.resolve();
  t.mock.timers.tick(60000);
  await check;
  assert.equal(decoder.worker.stopped, true);
  const retry = setup(t);
  const image = retry.imageData();
  await Promise.resolve();
  retry.worker.reply({ width: 8, height: 4 });
  assert.deepEqual(await image, { width: 8, height: 4 });
  t.mock.timers.tick(60000);
  assert.equal(retry.worker.stopped, false);
});

test('unreadable messages and postMessage errors settle requests', async t => {
  const decoder = setup(t);
  const image = decoder.imageData();
  const check = assert.rejects(image, /unreadable response/);
  await Promise.resolve();
  decoder.worker.onmessageerror();
  await check;
  const next = setup(t);
  next.worker.postMessage = () => { throw new Error('could not clone'); };
  await assert.rejects(next.imageData(), /could not clone/);
  assert.equal(next.pending.size, 0);
});
