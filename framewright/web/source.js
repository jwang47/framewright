// Which file a frame develops from: its raw, or the camera JPEG. The choice is
// part of the recipe (`source`), so the library, develop, post and exports
// all render a frame from the same pixels.
import { loadBitmap } from './render.js';
import { loadRaw } from './raw.js';

export const SOURCE_LABEL = { raw: 'RAW', jpeg: 'JPEG' };

// frame: {raw, jpeg} (whether each file exists); params: the saved edit, or
// null when there is none. An edit without a source is from before raw
// support: it was made on the JPEG and stays there, so it renders as it always
// did. An unedited frame starts from its raw. studio.py's default_source()
// mirrors the last part.
export function sourceOf(frame, params) {
  if (!frame.raw) return 'jpeg';
  if (!frame.jpeg) return 'raw';
  if (params) return params.source === 'raw' ? 'raw' : 'jpeg';
  return 'raw';
}

// A JPEG edit on a frame that has a raw: the ones worth redoing from the raw.
export const onJpegWithRaw = (frame, params) => !!frame.raw && sourceOf(frame, params) === 'jpeg';

// Raw decodes take a CPU core and a few hundred MB each, so they run one at a
// time per lane: one lane for the frame on screen, one for work behind it
// (frames decoded ahead, the full-size redo, thumbnails, in that order of
// priority) so that work never makes the screen wait. `stale` is asked when a
// load's turn comes and while it decodes: a frame flown past is skipped or
// stopped (null) rather than decoded for nothing. A decode that never
// finishes holds the next one up for at most WAIT_MS, not forever.
const WAIT_MS = 15000;
function lane() {
  const waiting = [];
  let busy = false;
  function next() {
    if (busy || !waiting.length) return;
    busy = true;
    const top = Math.max(...waiting.map(w => w.priority));
    const { job, resolve, reject } = waiting.splice(waiting.findIndex(w => w.priority === top), 1)[0];
    let done = false;
    const free = () => { if (!done) { done = true; clearTimeout(timer); busy = false; next(); } };
    const timer = setTimeout(free, WAIT_MS);
    Promise.resolve().then(job).then(resolve, reject).finally(free);
  }
  return (job, priority = 0) => new Promise((resolve, reject) => { waiting.push({ job, priority, resolve, reject }); next(); });
}
const onScreen = lane(), behind = lane();
export const AHEAD = 2, REDO = 1;

// What Renderer.setImage() takes: a decoded raw ({linear, ...}, half size
// unless full) or an ImageBitmap of the camera JPEG (the preview unless full).
// A decode says so on the status line, unless quiet (background thumbnails),
// and quiet loads go in the background lane at `priority` unless told
// otherwise. keep: false leaves a decode out of the cache (a thumbnail's,
// which would push out the frames decoded ahead).
export function loadSource(app, frame, source,
  { full = false, stale = null, quiet = false, background = quiet, priority = 0, keep = true } = {}) {
  if (source !== 'raw') return loadBitmap(app.src(full ? 'original' : 'preview', frame));
  return (background ? behind : onScreen)(async () => {
    if (stale?.()) return null;
    const msg = `decoding raw ${frame.key}${full ? ' (full size)' : ''}…`;
    if (!quiet) app.status(msg, 0);
    try {
      return await loadRaw(frame.shoot, frame.key, { full, stale, keep });
    } finally {
      if (!quiet && document.querySelector('#status').textContent === msg) app.status('');
    }
  }, priority);
}

// Decode the frames either side of `at` in `frames` ahead of time, the next
// one first, so stepping onto them shows at once. Only frames developed from
// their raw need it; a JPEG loads fast enough on its own. current() names the
// frame on screen: a decode ahead is dropped once it is no longer next to it.
export function prefetch(app, frames, at, current) {
  const ids = frames.map(f => f.id);
  for (const i of [at + 1, at - 1]) {
    const f = frames[i];
    if (!f || sourceOf(f, f.params) !== 'raw') continue;
    const stale = () => Math.abs(ids.indexOf(current()) - i) > 1;
    loadSource(app, f, 'raw', { quiet: true, stale, priority: AHEAD }).catch(() => {});
  }
}

// The corner tag on a thumbnail: which file the frame develops from. Only
// frames with a raw get one, so JPEG-only cameras stay quiet; a JPEG edit of
// a frame that has a raw is marked, since that is one to redo.
export function paintSourceTag(el, frame, source) {
  el.hidden = !frame.raw;
  el.textContent = SOURCE_LABEL[source];
  el.classList.toggle('jpeg', source === 'jpeg');
  el.title = source === 'raw' ? 'Developed from the raw file' : 'Developed from the camera JPEG, not the raw';
}

// ImageBitmaps hold GPU memory until closed; a decoded raw is a plain object
// that raw.js may still be caching, so it is left alone.
export function release(img) {
  if (img && !img.linear) img.close();
}
