// Sync settings: copy a look, and whichever groups of sliders are ticked, from
// the focused frame onto every frame chosen in the library (⌘/⇧-click).
// Each target keeps everything else of its own: exposure unless asked,
// crop, straighten, masks and geometry always.
import { normalize, cleanLook, cleanCurve } from './render.js';
import { sourceOf } from './source.js';

const $ = s => document.querySelector(s);

export const SYNC_GROUPS = [
  { id: 'wb', label: 'White balance', keys: ['temp', 'tint'], on: true },
  { id: 'exposure', label: 'Exposure', keys: ['exposure'], on: false },
  { id: 'tone', label: 'Contrast, highlights, shadows, whites, blacks',
    keys: ['contrast', 'highlights', 'shadows', 'whites', 'blacks'], on: true },
  { id: 'presence', label: 'Vibrance and saturation', keys: ['vibrance', 'saturation'], on: true },
  { id: 'curve', label: 'Tone curve', keys: ['curve'], on: true },
  { id: 'split', label: 'Split toning',
    keys: ['splitShadowHue', 'splitShadowSat', 'splitHighlightHue', 'splitHighlightSat', 'splitBalance'], on: true },
  { id: 'effects', label: 'Vignette and grain', keys: ['vignette', 'grain', 'grainSize'], on: true },
  { id: 'detail', label: 'Sharpening and noise', keys: ['sharpen', 'sharpenRadius', 'noise', 'colorNoise'], on: false },
  { id: 'lens', label: 'Lens correction', keys: ['lens', 'distortion'], on: false },
];

function stored() {
  try { return JSON.parse(localStorage.getItem('studio.syncGroups')) || null; } catch { return null; }
}
function store(groups) {
  try { localStorage.setItem('studio.syncGroups', JSON.stringify(groups)); } catch { /* fine */ }
}

// The target's recipe with the source's ticked settings laid over it. look is
// {name, params} to apply, null to take the look off, or undefined to leave
// the target's own look alone.
export function merged(target, source, groups, look, lookAmount) {
  const out = { ...target };
  for (const g of SYNC_GROUPS) {
    if (!groups.includes(g.id)) continue;
    for (const k of g.keys) out[k] = k === 'curve' ? cleanCurve(source[k]) : source[k];
  }
  if (look !== undefined) {
    out.look = look ? { name: look.name, params: cleanLook(look.params) } : null;
    out.lookAmount = look ? lookAmount : 100;
  }
  return out;
}

async function getEdit(f) {
  const r = await fetch(`/api/edit?shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`);
  if (!r.ok) throw new Error(`${f.key}: ${r.status}`);
  return r.json();
}

async function putEdit(f, params, base) {
  const r = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shoot: f.shoot, key: f.key, params, base }),
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(res.error || r.status), { status: r.status });
  return res;
}

// A frame's recipe as the renderer sees it, with the source it develops from
// named so saving it never moves a frame between its raw and its JPEG.
const recipeOf = (f, params) => normalize({ ...params, source: sourceOf(f, params) });

export function createSync(app, { onSaved }) {
  const dlg = $('#syncDlg');
  let looks = [], last = null;   // last: [{f, before}] for undo

  async function open() {
    const source = app.frame(app.focusKey);
    const targets = [...app.chosen].map(id => app.frame(id)).filter(Boolean);
    if (!source || targets.length < 2) return app.status('⌘-click or ⇧-click frames to choose them first', 3000);
    let src;
    try {
      [src, looks] = await Promise.all([
        getEdit(source).then(e => recipeOf(source, e.params)),
        fetch('/api/looks').then(r => r.json()).then(r => r.looks),
      ]);
    } catch (e) {
      return app.status(`could not read ${source.key}: ${e.message}`, 0);
    }
    $('#syncSource').textContent = source.key;
    $('#syncCount').textContent = targets.length;

    const sel = $('#syncLook');
    const own = src.look ? `${src.look.name}${src.lookAmount !== 100 ? ` at ${Math.round(src.lookAmount)}%` : ''}` : 'no look';
    sel.innerHTML = '<option value="keep">Leave each frame\'s look alone</option>' +
      `<option value="source"></option>` +
      looks.map((l, i) => `<option value="${i}"></option>`).join('') +
      '<option value="none">Take the look off</option>';
    sel.options[1].textContent = `As ${source.key}: ${own}`;
    looks.forEach((l, i) => (sel.options[i + 2].textContent = l.missingLut ? `${l.name} (missing LUT)` : l.lutMismatch ? `${l.name} (LUT mismatch)` : l.file ? `${l.name} (LUT)` : l.name));
    sel.value = src.look ? 'source' : 'keep';

    const on = stored() || SYNC_GROUPS.filter(g => g.on).map(g => g.id);
    $('#syncGroups').innerHTML = SYNC_GROUPS.map(g =>
      `<label><input type="checkbox" value="${g.id}"${on.includes(g.id) ? ' checked' : ''}> ${g.label}</label>`).join('');
    $('#syncProgress').hidden = true;
    $('#syncGo').disabled = false;
    dlg.src = src;
    dlg.targets = targets;
    dlg.showModal();
  }

  async function go() {
    const { src, targets } = dlg;
    const groups = [...$('#syncGroups').querySelectorAll('input:checked')].map(i => i.value);
    store(groups);
    const v = $('#syncLook').value;
    const look = v === 'keep' ? undefined : v === 'none' ? null : v === 'source' ? src.look : looks[+v];
    const amount = v === 'source' ? src.lookAmount : 100;
    if (!groups.length && look === undefined) return app.status('nothing ticked to sync', 2000);
    $('#syncGo').disabled = true;
    $('#syncProgress').hidden = false;
    const bar = $('#syncBar');
    bar.max = targets.length;
    const undo = [], failed = [];
    for (const [i, f] of targets.entries()) {
      bar.value = i;
      $('#syncNow').textContent = f.key;
      try {
        // One retry: a save elsewhere between read and write is taken up.
        for (let tries = 0; ; tries++) {
          const cur = await getEdit(f);
          try {
            const res = await putEdit(f, merged(recipeOf(f, cur.params), src, groups, look, amount), cur.rev);
            undo.push({ f, before: cur.params });
            onSaved(f, res.params);
            break;
          } catch (e) {
            if (e.status !== 409 || tries) throw e;
          }
        }
      } catch (e) {
        failed.push(`${f.key} (${e.message})`);
      }
    }
    bar.value = targets.length;
    last = undo;
    dlg.close();
    app.status(failed.length ? `synced ${undo.length}; failed: ${failed.join(', ')}`
      : `synced ${undo.length} frames — ⌘Z to undo`, failed.length ? 0 : 5000);
  }

  // Put back what the last sync replaced, frame by frame.
  async function undoLast() {
    if (!last?.length) return false;
    const batch = last;
    last = null;
    let n = 0;
    for (const { f, before } of batch) {
      try {
        const cur = await getEdit(f);
        const res = await putEdit(f, before, cur.rev);
        onSaved(f, res.params);
        n++;
      } catch { /* leave it; reported below */ }
    }
    app.status(n === batch.length ? `undid sync on ${n} frames` : `undid ${n} of ${batch.length}`, 3000);
    return true;
  }

  $('#syncGo').addEventListener('click', go);
  $('#syncClose').addEventListener('click', () => dlg.close());
  return { open, undoLast };
}
