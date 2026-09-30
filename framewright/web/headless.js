// The headless page render.py drives: render recipes through the studio's own
// loaders and shader, with no UI, and hand each JPEG back to the server. The
// job list comes from /headless/jobs; each job is {id, shoot, key, params,
// source, full, max}. One page load renders every job, so a batch pays for
// the browser start once.
import { renderJpeg, lutWarning } from './render.js';
import { loadSource, release } from './source.js';

// What loadSource() needs from the app: where images live, and a status line.
const app = {
  src(kind, f) { return `/${kind}/${encodeURIComponent(f.shoot)}/${f.key}.jpg`; },
  status() {},
};

async function post(url, body, type) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
}

// A long edge of at most max px (0: as rendered), so an agent looking at the
// result is not handed a 40MP file.
async function fit(blob, max) {
  if (!max) return blob;
  const bmp = await createImageBitmap(blob);
  const s = max / Math.max(bmp.width, bmp.height);
  if (s >= 1) { bmp.close(); return blob; }
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

async function run(job) {
  const frame = { shoot: job.shoot, key: job.key, id: `${job.shoot}/${job.key}` };
  let img, note = '';
  try {
    img = await loadSource(app, frame, job.source, { full: job.full, quiet: true, background: false, keep: false });
  } catch (e) {
    // The raw is on a drive that is not plugged in: the cached preview still
    // shows the edit, near enough to judge it, and says so.
    if (job.source !== 'raw' || job.full) throw e;
    img = await loadSource(app, frame, 'jpeg', { quiet: true });
    note = `raw unavailable (${e.message}); rendered on the camera JPEG preview`;
  }
  try {
    const blob = await fit(await renderJpeg(img, job.params), job.max);
    note = [note, lutWarning(job.params)].filter(Boolean).join('; ');
    await post(`/headless/result?id=${job.id}&note=${encodeURIComponent(note)}`, blob, 'image/jpeg');
  } finally {
    release(img);
  }
}

(async () => {
  const jobs = await fetch('/headless/jobs').then(r => r.json());
  for (const job of jobs) {
    try {
      await run(job);
    } catch (e) {
      await post(`/headless/error?id=${job.id}`, String(e?.message || e), 'text/plain').catch(() => {});
    }
  }
})();
