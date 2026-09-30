// Develop tab: live sliders, crop and straighten, before/after, undo, export.
import {
  Renderer, normalize, cropValid, fitCrop, renderJpeg, FULL_CROP,
  MAX_MASKS, newMask, orientedSize, reorient, DEFAULTS, putMaskImage, IDENTITY_MAP,
  CURVE_CHANNELS, IDENTITY_CURVE, cleanCurve, curveFn, LOOK_KEYS, cleanLook, lutWarning, parseCube, clearLutCache,
} from './render.js';
import { sourceOf, loadSource, prefetch, release, paintSourceTag, SOURCE_LABEL } from './source.js';

const $ = s => document.querySelector(s);

// Geometry takes hundredths: typed values keep two decimals, ↑/↓ nudge by
// `nudge` (⌥ for 0.01, ⇧ for ten nudges), and dragging the label scrubs at
// `scrub` per pixel (⌥ ten times finer, ⇧ ten times faster).
const fine = v => (v > 0 ? '+' : '') + String(+v.toFixed(2));
const SLIDERS = [
  { g: 'look', k: 'lookAmount', label: 'Amount', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, neutral: 100 },
  { g: 'geo', k: 'angle', label: 'Straighten', min: -20, max: 20, step: 0.01, nudge: 0.05, scrub: 0.01, fine: true, fmt: v => `${v.toFixed(2)}°` },
  { g: 'geo', k: 'vertical', label: 'Vertical', min: -100, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: fine },
  { g: 'geo', k: 'horizontal', label: 'Horizontal', min: -100, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: fine },
  { g: 'geo', k: 'distortion', label: 'Distortion', min: -100, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: fine },
  { g: 'geo', k: 'groundShift', label: 'Ground shift', min: -100, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: fine },
  { g: 'geo', k: 'skyShift', label: 'Sky shift', min: -100, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: fine },
  { g: 'geo', k: 'horizon', label: 'Horizon', min: 0, max: 100, step: 0.01, nudge: 0.5, scrub: 0.05, fine: true, fmt: v => String(+v.toFixed(2)), neutral: 50 },
  { g: 'area', k: 'groundFeather', label: 'Area feather', min: 0, max: 50, step: 0.5, fmt: v => v.toFixed(1), neutral: 4 },
  { g: 'wb', k: 'temp', label: 'Temp', min: -300, max: 300, step: 1, cls: 'temp' },
  { g: 'wb', k: 'tint', label: 'Tint', min: -300, max: 300, step: 1 },
  { g: 'tone', k: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) },
  { g: 'tone', k: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  { g: 'tone', k: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
  { g: 'tone', k: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
  { g: 'tone', k: 'whites', label: 'Whites', min: -100, max: 100, step: 1 },
  { g: 'tone', k: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1 },
  { g: 'presence', k: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
  { g: 'presence', k: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
  { g: 'split', k: 'splitHighlightHue', label: 'Highlights', min: 0, max: 360, step: 1, cls: 'hue', fmt: v => `${Math.round(v)}°` },
  { g: 'split', k: 'splitHighlightSat', label: 'Amount', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'split', k: 'splitShadowHue', label: 'Shadows', min: 0, max: 360, step: 1, cls: 'hue', fmt: v => `${Math.round(v)}°` },
  { g: 'split', k: 'splitShadowSat', label: 'Amount', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'split', k: 'splitBalance', label: 'Balance', min: -100, max: 100, step: 1 },
  { g: 'detail', k: 'sharpen', label: 'Sharpening', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'detail', k: 'sharpenRadius', label: 'Radius', min: 0.5, max: 3, step: 0.1, fmt: v => v.toFixed(1), neutral: 1 },
  { g: 'detail', k: 'noise', label: 'Noise', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'detail', k: 'colorNoise', label: 'Colour noise', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'fx', k: 'vignette', label: 'Vignette', min: -100, max: 100, step: 1 },
  { g: 'fx', k: 'grain', label: 'Grain', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}` },
  { g: 'fx', k: 'grainSize', label: 'Grain size', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, neutral: 25 },
];
// Sliders that move pixels around: they refit the crop and show the guide grid.
const WARPS = ['angle', 'vertical', 'horizontal', 'distortion', 'groundShift', 'skyShift', 'horizon', 'groundFeather'];
// Not pasted between frames: crops differ, a lens profile is per focal length,
// and each frame keeps the source it develops from.
const GEOMETRY = [...WARPS, 'crop', 'lens', 'orient', 'flipH', 'flipV', 'groundArea', 'source'];
const same = (k, a, b) => (k === 'curve' ? JSON.stringify(cleanCurve(a)) === JSON.stringify(cleanCurve(b)) : a === b);
const signed = v => (v > 0 ? '+' : '') + Math.round(v);

export function createDevelop(app) {
  const view = $('#view');
  let renderer = null;
  const st = {
    key: null, W: 0, H: 0, params: normalize(), committed: null,
    undo: [], redo: [], cropMode: false, before: false, baseCrop: null, lens: null,
    clipboard: null, loadToken: 0, saveT: null, rafPending: false,
    shownSource: null, srcToken: 0, legacy: false,
    rev: null, saving: false,   // the recipe's revision on the server; a save in flight
  };

  // --- sliders ---------------------------------------------------------------

  const inputs = {};
  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider' + (s.cls ? ' ' + s.cls : '');
    row.innerHTML = `<label for="s-${s.k}">${s.label}</label>
      <input type="range" id="s-${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="0">
      <input type="text" class="num" inputmode="decimal" aria-label="${s.label} value" spellcheck="false">`;
    const input = row.querySelector('input');
    const out = row.querySelector('.num');
    inputs[s.k] = { input, out, row, spec: s };
    // Typed values: Enter applies, Escape reverts, ↑/↓ nudge (Shift for 10x).
    const apply = () => {
      const v = parseFloat(out.value.replace(/[^0-9.+-]/g, ''));
      if (Number.isFinite(v)) {
        const clamped = Math.min(s.max, Math.max(s.min, v));
        if (WARPS.includes(s.k)) st.baseCrop = st.params.crop;
        set(s.k, s.fine ? +clamped.toFixed(2) : Math.round(clamped / s.step) * s.step);
        st.baseCrop = null;
        commit();
      }
      out.value = (s.fmt || signed)(st.params[s.k]);
    };
    out.addEventListener('focus', () => { out.select(); activate(s.k); });
    out.addEventListener('change', apply);
    out.addEventListener('keydown', e => {
      if (e.key === 'Enter') { apply(); out.blur(); }
      else if (e.key === 'Escape') { out.value = (s.fmt || signed)(st.params[s.k]); out.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const base = s.fine && e.altKey ? 0.01 : (s.nudge ?? s.step);
        const step = base * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        out.value = String(+(st.params[s.k] + step).toFixed(3));
        apply();
        out.select();
      }
    });
    input.addEventListener('pointerdown', () => activate(s.k));
    input.addEventListener('input', () => {
      if (WARPS.includes(s.k)) {
        if (!st.baseCrop) st.baseCrop = st.params.crop;
        st.dragGuides = true;
        paintGuides();
      }
      set(s.k, parseFloat(input.value));
    });
    input.addEventListener('change', () => {
      st.baseCrop = null;
      st.dragGuides = false;
      paintGuides();
      commit();
      input.blur();
    });
    // Scrub: drag on the label for slow, precise changes.
    if (s.scrub) {
      const label = row.querySelector('label');
      label.classList.add('scrub');
      label.title = 'Drag left/right to fine-tune (⌥ finer, ⇧ faster)';
      let drag = null;
      label.addEventListener('pointerdown', e => {
        e.preventDefault();
        try { label.setPointerCapture(e.pointerId); } catch { /* synthetic pointer: drag still works */ }
        drag = { x: e.clientX, v: st.params[s.k], moved: false };
        activate(s.k);
        if (WARPS.includes(s.k)) { st.baseCrop = st.params.crop; st.dragGuides = true; paintGuides(); }
      });
      label.addEventListener('pointermove', e => {
        if (!drag) return;
        const rate = s.scrub * (e.altKey ? 0.1 : 1) * (e.shiftKey ? 10 : 1);
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) < 1 && !drag.moved) return;
        drag.moved = true;
        // Rebase on modifier changes so switching to fine mode doesn't jump.
        if (drag.rate !== undefined && drag.rate !== rate) { drag.v = st.params[s.k]; drag.x = e.clientX; }
        drag.rate = rate;
        const v = Math.min(s.max, Math.max(s.min, drag.v + (e.clientX - drag.x) * rate));
        set(s.k, +v.toFixed(2));
      });
      const end = () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        st.baseCrop = null;
        st.dragGuides = false;
        paintGuides();
        if (moved) commit();
      };
      label.addEventListener('pointerup', end);
      label.addEventListener('pointercancel', end);
    }
    row.addEventListener('dblclick', e => {
      if (e.target === out) return;   // double-click selects the typed value instead
      set(s.k, s.neutral ?? 0); st.baseCrop = null; commit();
    });
    $('#sliders-' + s.g).appendChild(row);
  }

  // --- grid overlay ------------------------------------------------------------

  // Off, thirds, or a fine grid for checking straight lines. Geometry sliders
  // always show the fine grid while dragging.
  const GRIDS = ['off', 'thirds', 'fine'];
  const GRID_LABEL = { off: 'Grid: off', thirds: 'Grid: thirds', fine: 'Grid: fine' };
  st.grid = (() => { try { return localStorage.getItem('studio.grid') || 'off'; } catch { return 'off'; } })();
  if (!GRIDS.includes(st.grid)) st.grid = 'off';

  function paintHorizon() {
    const line = $('#horizonLine'), c = st.params.crop;
    const y = (st.params.horizon / 100 - (st.cropMode ? 0 : c.y)) / (st.cropMode ? 1 : c.h);
    const show = !st.before && st.compare === 'yours' &&
      (st.dragGuides || ((st.params.groundShift !== 0 || st.params.skyShift !== 0) && st.grid !== 'off')) && y >= 0 && y <= 1;
    line.hidden = !show;
    if (show) line.style.top = (y * 100) + '%';
  }

  function paintGuides() {
    paintHorizon();
    // While cropping, the grid belongs to the crop box (thirds unless fine is
    // chosen) and the whole-photo grid steps aside.
    $('#cropgrid').className = st.grid === 'fine' ? 'fine' : 'thirds';
    const mode = st.dragGuides ? 'fine' : st.grid;
    const g = $('#guides');
    g.hidden = mode === 'off' || st.before || (st.cropMode && !st.dragGuides);
    g.className = mode;
    $('#gridBtn').textContent = GRID_LABEL[st.grid];
    $('#gridBtn').setAttribute('aria-pressed', st.grid !== 'off');
  }

  function cycleGrid() {
    st.grid = GRIDS[(GRIDS.indexOf(st.grid) + 1) % GRIDS.length];
    try { localStorage.setItem('studio.grid', st.grid); } catch { /* fine */ }
    paintGuides();
  }
  $('#gridBtn').addEventListener('click', e => { e.target.blur(); cycleGrid(); });

  // --- crosshair ---------------------------------------------------------------

  st.crosshair = (() => { try { return localStorage.getItem('studio.crosshair') === '1'; } catch { return false; } })();
  // While cropping, the crosshair marks the centre of the crop box instead.
  function paintCrosshair() {
    $('#crosshair').hidden = !st.crosshair || st.before || st.cropMode;
    $('#cropcross').hidden = !st.crosshair;
    $('#crossBtn').setAttribute('aria-pressed', st.crosshair);
  }
  function toggleCrosshair() {
    st.crosshair = !st.crosshair;
    try { localStorage.setItem('studio.crosshair', st.crosshair ? '1' : '0'); } catch { /* fine */ }
    paintCrosshair();
  }
  $('#crossBtn').addEventListener('click', e => { e.target.blur(); toggleCrosshair(); });
  paintCrosshair();

  // --- masks -------------------------------------------------------------------

  // Local adjustments: a linear or radial gradient or a turnable rect, optionally limited to a
  // luminance range, with its own exposure, tone and colour. Geometry lives in
  // the corrected, uncropped frame (0..1); the handles convert to and from the
  // view, which shows only the crop.
  const MASK_SLIDERS = [
    { k: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) },
    { k: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
    { k: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
    { k: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
    { k: 'temp', label: 'Temp', min: -300, max: 300, step: 1, cls: 'temp' },
    { k: 'tint', label: 'Tint', min: -300, max: 300, step: 1 },
    { k: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
    { k: 'feather', label: 'Feather', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, shaped: true, neutral: 50 },
    { k: 'falloff', label: 'Falloff', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, rectOnly: true, neutral: 0 },
    { k: 'lumLo', label: 'Range low', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, neutral: 0 },
    { k: 'lumHi', label: 'Range high', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, neutral: 100 },
  ];
  st.maskSel = -1;
  st.showMask = false;
  st.masksOff = false;   // preview only: compare with and without every mask
  const mask = () => st.params.masks[st.maskSel];

  const maskInputs = {};
  for (const s of MASK_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider' + (s.cls ? ' ' + s.cls : '');
    row.innerHTML = `<label for="m-${s.k}">${s.label}</label>
      <input type="range" id="m-${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="0">
      <input type="text" class="num" inputmode="decimal" aria-label="Mask ${s.label} value" spellcheck="false">`;
    const range = row.querySelector('input[type=range]'), out = row.querySelector('.num');
    const fmt = v => (s.fmt || signed)(v);
    const setv = v => {
      if (!mask()) return;
      mask()[s.k] = Math.min(s.max, Math.max(s.min, v));
      paintMaskSliders();
      draw();
      scheduleSave();
    };
    range.addEventListener('input', () => setv(parseFloat(range.value)));
    range.addEventListener('change', () => { commit(); range.blur(); });
    row.addEventListener('dblclick', e => { if (e.target !== out) { setv(s.neutral ?? 0); commit(); } });
    out.addEventListener('focus', () => out.select());
    const apply = () => {
      const v = parseFloat(out.value.replace(/[^0-9.+-]/g, ''));
      if (Number.isFinite(v)) { setv(v); commit(); } else paintMaskSliders();
    };
    out.addEventListener('change', apply);
    out.addEventListener('keydown', e => {
      if (e.key === 'Enter') { apply(); out.blur(); }
      else if (e.key === 'Escape') { out.blur(); paintMaskSliders(); }
    });
    maskInputs[s.k] = { row, range, out, fmt, spec: s };
    $('#sliders-mask').appendChild(row);
  }

  function paintMaskSliders() {
    const m = mask();
    $('#maskEdit').hidden = !m;
    if (!m) return;
    $('#maskInvert').checked = !!m.invert;
    if (document.activeElement !== $('#maskName')) $('#maskName').value = m.name || '';
    $('#maskName').placeholder = `Name this mask (${MASK_NAMES[m.type]})`;
    for (const { row, range, out, fmt, spec } of Object.values(maskInputs)) {
      row.hidden = (spec.shaped && (m.type === 'linear' || m.type === 'subject')) || (spec.rectOnly && m.type !== 'rect');
      const v = m[spec.k] ?? spec.neutral ?? 0;
      range.value = v;
      if (document.activeElement !== out) out.value = fmt(v);
      row.classList.toggle('changed', v !== (spec.neutral ?? 0));
    }
  }

  const MASK_NAMES = { linear: 'Linear', radial: 'Radial', rect: 'Rect', subject: 'Subject' };
  const maskLabel = (m, i) => `${i + 1} · ${m.name || MASK_NAMES[m.type]}${m.invert ? ' (inverted)' : ''}`;

  function paintMasks() {
    const list = $('#maskList');
    const masks = st.params.masks;
    if (st.maskSel >= masks.length) st.maskSel = masks.length - 1;
    list.innerHTML = '';
    masks.forEach((m, i) => {
      const on = m.enabled !== false;
      const row = document.createElement('div');
      row.className = 'mask-item' + (i === st.maskSel ? ' active' : '') + (on ? '' : ' off');
      row.innerHTML = `<button class="eye" aria-pressed="${on}" title="${on ? 'Turn this mask off' : 'Turn this mask on'}">${on ? '●' : '○'}</button>
        <button class="name"></button>`;
      row.querySelector('.name').textContent = maskLabel(m, i);
      row.querySelector('.name').title = maskLabel(m, i);
      row.querySelector('.name').addEventListener('click', e => { e.target.blur(); selectMask(i === st.maskSel ? -1 : i); });
      row.querySelector('.eye').addEventListener('click', e => {
        e.target.blur();
        m.enabled = !on;
        commit();
        paintMasks();
        draw();
      });
      list.appendChild(row);
    });
    for (const b of ['#addLinear', '#addRadial', '#addRect', '#addSubject']) $(b).disabled = masks.length >= MAX_MASKS;
    $('#maskShow').setAttribute('aria-pressed', st.showMask);
    $('#maskAll').disabled = !masks.length;
    $('#maskAll').textContent = st.masksOff ? 'Masks: off' : 'Masks: on';
    $('#maskAll').setAttribute('aria-pressed', !st.masksOff && masks.length > 0);
    $('#maskOffBadge').hidden = !st.masksOff || !masks.length;
    if (st.brush.on && mask()?.type !== 'subject') st.brush.on = false;
    paintMaskSliders();
    paintBrush();
  }

  function selectMask(i) {
    st.maskSel = i;
    paintMasks();
    draw();
  }

  function addMask(type) {
    if (st.params.masks.length >= MAX_MASKS) return;
    const m = newMask(type), c = st.params.crop;
    // Start inside what is visible: a sky gradient over the top of the crop,
    // or a circle or square in the middle of it.
    if (type === 'subject') {
      // Nothing yet: it is painted. Straight into the brush.
      st.brush.on = true;
      app.status('brush over the subject; the mask snaps to its edges', 4000);
    } else if (type === 'linear') {
      Object.assign(m, { x1: c.x + c.w / 2, y1: c.y + c.h * 0.05, x2: c.x + c.w / 2, y2: c.y + c.h * 0.45 });
    } else {
      // Equal sides in pixels, whatever the frame's shape.
      const r = 0.25 * Math.min(c.w * st.W, c.h * st.H);
      Object.assign(m, { cx: c.x + c.w / 2, cy: c.y + c.h / 2, rx: r / st.W, ry: r / st.H });
    }
    st.params.masks = [...st.params.masks, m];
    st.maskSel = st.params.masks.length - 1;
    commit();
    paintMasks();
    draw();
  }

  $('#addLinear').addEventListener('click', e => { e.target.blur(); addMask('linear'); });
  $('#addRadial').addEventListener('click', e => { e.target.blur(); addMask('radial'); });
  $('#addRect').addEventListener('click', e => { e.target.blur(); addMask('rect'); });
  $('#addSubject').addEventListener('click', e => { e.target.blur(); addMask('subject'); });
  $('#maskName').addEventListener('input', e => {
    if (!mask()) return;
    mask().name = e.target.value;
    const label = $('#maskList .mask-item.active .name');
    if (label) label.textContent = label.title = maskLabel(mask(), st.maskSel);
    scheduleSave();
  });
  $('#maskName').addEventListener('change', () => commit());
  $('#maskName').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
  });
  $('#maskShow').addEventListener('click', e => { e.target.blur(); st.showMask = !st.showMask; paintMasks(); draw(); });
  function toggleAllMasks() { st.masksOff = !st.masksOff; paintMasks(); draw(); }
  $('#maskAll').addEventListener('click', e => { e.target.blur(); toggleAllMasks(); });
  $('#maskInvert').addEventListener('change', e => {
    e.target.blur();
    if (!mask()) return;
    mask().invert = e.target.checked;
    commit();
    paintMasks();
    draw();
  });
  $('#maskDelete').addEventListener('click', e => {
    e.target.blur();
    if (!mask()) return;
    st.params.masks = st.params.masks.filter((_, i) => i !== st.maskSel);
    st.maskSel = -1;
    st.brush.on = false;
    commit();
    paintMasks();
    draw();
  });

  // On-photo handles, drawn in view pixels.
  const svg = $('#maskHandles');
  const toView = (fx, fy) => {
    const c = st.params.crop, r = view.getBoundingClientRect();
    return [(fx - c.x) / c.w * r.width, (fy - c.y) / c.h * r.height];
  };
  const toFrame = (vx, vy) => {
    const c = st.params.crop, r = view.getBoundingClientRect();
    return [c.x + vx / r.width * c.w, c.y + vy / r.height * c.h];
  };

  // A rect's own x and y axes, as unit vectors in frame pixels.
  const rectAxes = m => {
    const a = (m.angle || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[c, s], [-s, c]];
  };

  function paintHandles() {
    const m = mask();
    const show = m && !st.cropMode && !st.before;
    svg.toggleAttribute('hidden', !show);   // SVG elements have no .hidden property
    if (!show) return;
    const r = view.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    svg.classList.toggle('brushing', m.type === 'subject' && st.brush.on);
    if (m.type === 'subject') { svg.innerHTML = brushSvg(); return; }
    let h = '';
    const dot = (x, y, role, cls = '') => `<circle class="h ${cls}" data-role="${role}" cx="${x}" cy="${y}" r="7"/>`;
    if (m.type === 'linear') {
      const [ax, ay] = toView(m.x1, m.y1), [bx, by] = toView(m.x2, m.y2);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const px = -dy / len * 4000, py = dx / len * 4000;   // long perpendicular lines
      h += `<line class="edge" x1="${ax - px}" y1="${ay - py}" x2="${ax + px}" y2="${ay + py}"/>`;
      h += `<line class="edge soft" x1="${bx - px}" y1="${by - py}" x2="${bx + px}" y2="${by + py}"/>`;
      h += `<line class="axis" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/>`;
      h += dot((ax + bx) / 2, (ay + by) / 2, 'move', 'center') + dot(ax, ay, 'a') + dot(bx, by, 'b');
    } else if (m.type === 'rect') {
      // Corners worked out in frame pixels, where the rect is square-cornered.
      const [ux, uy] = rectAxes(m), hx = m.rx * st.W, hy = m.ry * st.H;
      const at = (sx, sy) => toView(m.cx + (ux[0] * sx + uy[0] * sy) / st.W, m.cy + (ux[1] * sx + uy[1] * sy) / st.H);
      const poly = k => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => at(a * hx * k, b * hy * k).join(',')).join(' ');
      const f = (m.feather ?? 50) / 100 * Math.min(hx, hy);
      const innerPoly = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        .map(([a, b]) => at(a * Math.max(hx - f, 0), b * Math.max(hy - f, 0)).join(',')).join(' ');
      h += `<polygon class="edge" points="${poly(1)}"/>`;
      h += `<polygon class="edge soft" points="${innerPoly}"/>`;
      // The turn handle stands off the top edge by a fixed distance on screen.
      const scale = r.width / (st.params.crop.w * st.W), stand = 28 / scale;
      const [tx, ty] = at(0, -hy), [rx, ry] = at(0, -hy - stand);
      h += `<line class="axis" x1="${tx}" y1="${ty}" x2="${rx}" y2="${ry}"/>`;
      const [cx, cy] = toView(m.cx, m.cy);
      h += dot(cx, cy, 'move', 'center') + dot(...at(hx, 0), 'rx') + dot(...at(0, hy), 'ry') + dot(rx, ry, 'turn', 'turn');
    } else {
      const [cx, cy] = toView(m.cx, m.cy);
      const rx = m.rx / st.params.crop.w * r.width, ry = m.ry / st.params.crop.h * r.height;
      const inner = 1 - (m.feather ?? 50) / 100;
      h += `<ellipse class="edge" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
      h += `<ellipse class="edge soft" cx="${cx}" cy="${cy}" rx="${rx * inner}" ry="${ry * inner}"/>`;
      h += dot(cx, cy, 'move', 'center') + dot(cx + rx, cy, 'rx') + dot(cx, cy + ry, 'ry');
    }
    svg.innerHTML = h;
  }

  let hdrag = null;
  svg.addEventListener('pointerdown', e => {
    const role = e.target.dataset?.role;
    if (!role || !mask()) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const r = view.getBoundingClientRect();
    hdrag = { role, start: toFrame(e.clientX - r.left, e.clientY - r.top), m0: { ...mask() } };
    st.handleDrag = true;
    draw();
  });
  svg.addEventListener('pointermove', e => {
    if (!hdrag) return;
    const r = view.getBoundingClientRect();
    const [fx, fy] = toFrame(e.clientX - r.left, e.clientY - r.top);
    const dx = fx - hdrag.start[0], dy = fy - hdrag.start[1], m0 = hdrag.m0, m = mask();
    if (hdrag.role === 'move') {
      if (m.type === 'linear') Object.assign(m, { x1: m0.x1 + dx, y1: m0.y1 + dy, x2: m0.x2 + dx, y2: m0.y2 + dy });
      else Object.assign(m, { cx: m0.cx + dx, cy: m0.cy + dy });
    } else if (hdrag.role === 'a') Object.assign(m, { x1: fx, y1: fy });
    else if (hdrag.role === 'b') Object.assign(m, { x2: fx, y2: fy });
    else if (m.type === 'rect' && hdrag.role !== 'turn') {
      // Side handles measure along the rect's own axes.
      const [ux, uy] = rectAxes(m), px = (fx - m.cx) * st.W, py = (fy - m.cy) * st.H;
      if (hdrag.role === 'rx') m.rx = Math.max(0.005, Math.abs(px * ux[0] + py * ux[1]) / st.W);
      else m.ry = Math.max(0.005, Math.abs(px * uy[0] + py * uy[1]) / st.H);
    } else if (hdrag.role === 'turn') {
      // The handle points along the rect's -y axis; Shift snaps to 15°.
      let a = Math.atan2((fx - m.cx) * st.W, -(fy - m.cy) * st.H) * 180 / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      m.angle = Math.round(a * 10) / 10;
    }
    else if (hdrag.role === 'rx') m.rx = Math.max(0.005, Math.abs(fx - m.cx));
    else if (hdrag.role === 'ry') m.ry = Math.max(0.005, Math.abs(fy - m.cy));
    // Shift keeps a radial round.
    if (e.shiftKey && m.type !== 'linear') {
      if (hdrag.role === 'rx') m.ry = m.rx * st.W / st.H;
      if (hdrag.role === 'ry') m.rx = m.ry * st.H / st.W;
    }
    draw();
    scheduleSave();
  });
  const endHandle = () => {
    if (!hdrag) return;
    hdrag = null;
    st.handleDrag = false;
    commit();
    draw();
  };
  svg.addEventListener('pointerup', endHandle);
  svg.addEventListener('pointercancel', endHandle);

  // --- subject brush -------------------------------------------------------------

  // Brush roughly over a subject and segment.js finds its edges, in a worker.
  // Each stroke is kept, so the whole mask is found again from all of them:
  // an Erase stroke marks background, which the next pass respects.
  st.brush = { on: false, erase: false, size: 4, stroke: null, at: null, busy: false, alt: false };
  try { st.brush.size = +localStorage.getItem('studio.brushSize') || 4; } catch { /* fine */ }
  let worker = null, segId = 0;
  const segFrame = { key: null, img: null };

  const brushR = () => st.brush.size / 100;   // share of the frame's long side
  const viewScale = () => view.getBoundingClientRect().width / (st.params.crop.w * st.W);   // view px per frame px

  function paintBrush() {
    const m = mask(), subj = m?.type === 'subject';
    $('#brushRow').hidden = $('#brushSizeRow').hidden = !subj;
    $('#brushBtn').setAttribute('aria-pressed', st.brush.on);
    $('#brushErase').setAttribute('aria-pressed', st.brush.erase);
    $('#brushBusy').hidden = !st.brush.busy;
    $('#brushSize').value = st.brush.size;
    $('#brushSizeOut').textContent = `${st.brush.size}`;
  }

  function setBrush(on) {
    if (on && mask()?.type !== 'subject') return;
    st.brush.on = on;
    st.brush.stroke = null;
    paintBrush();
    draw();
  }

  function setBrushSize(v) {
    st.brush.size = Math.min(25, Math.max(0.5, Math.round(v * 2) / 2));
    try { localStorage.setItem('studio.brushSize', st.brush.size); } catch { /* fine */ }
    paintBrush();
    paintHandles();
  }

  // The brush circle under the pointer, and the stroke being painted.
  function brushSvg() {
    if (!st.brush.on) return '';
    const L = Math.max(st.W, st.H), sc = viewScale();
    let h = '';
    const s = st.brush.stroke;
    if (s && s.pts.length) {
      const pts = s.pts.map(([x, y]) => toView(x, y).join(',')).join(' ');
      const d = s.pts.length === 1 ? `${pts} ${pts}` : pts;
      h += `<polyline class="stroke${s.sub ? ' sub' : ''}" points="${d}" stroke-width="${2 * s.r * L * sc}"/>`;
    }
    if (st.brush.at) {
      const sub = st.brush.erase !== st.brush.alt;
      h += `<circle class="brush${sub ? ' sub' : ''}" cx="${st.brush.at[0]}" cy="${st.brush.at[1]}" r="${brushR() * L * sc}"/>`;
    }
    return h;
  }

  function brushEvent(e) {
    const r = view.getBoundingClientRect(), vx = e.clientX - r.left, vy = e.clientY - r.top;
    st.brush.at = [vx, vy];
    st.brush.alt = e.altKey;
    return toFrame(vx, vy);
  }

  svg.addEventListener('pointerdown', e => {
    if (!st.brush.on || mask()?.type !== 'subject' || e.button !== 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const q = brushEvent(e);
    st.brush.stroke = { pts: [q], r: brushR(), sub: st.brush.erase !== e.altKey };
    paintHandles();
  });
  svg.addEventListener('pointermove', e => {
    if (!st.brush.on) return;
    const q = brushEvent(e), s = st.brush.stroke;
    if (s) {
      // A point every fifth of a radius is plenty for the path.
      const [px, py] = s.pts[s.pts.length - 1], L = Math.max(st.W, st.H);
      if (Math.hypot((q[0] - px) * st.W, (q[1] - py) * st.H) > s.r * L * 0.2) s.pts.push(q);
    }
    paintHandles();
  });
  svg.addEventListener('pointerleave', () => { if (st.brush.on && !st.brush.stroke) { st.brush.at = null; paintHandles(); } });
  const endStroke = () => {
    const s = st.brush.stroke, m = mask();
    if (!s || m?.type !== 'subject') return;
    st.brush.stroke = null;
    s.pts = simplify(s.pts, s.r * Math.max(st.W, st.H) * 0.1).map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
    s.r = +s.r.toFixed(4);
    m.strokes = [...(m.strokes || []), s];
    findSubject(m);
  };
  svg.addEventListener('pointerup', endStroke);
  svg.addEventListener('pointercancel', endStroke);

  // Fewer points along a stroke (Ramer-Douglas-Peucker), tol in frame pixels.
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const px = ([x, y]) => [x * st.W, y * st.H];
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = px(pts[a]), [bx, by] = px(pts[b]), l = Math.hypot(bx - ax, by - ay) || 1;
      let far = -1, fd = tol;
      for (let i = a + 1; i < b; i++) {
        const [x, y] = px(pts[i]);
        const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / l;
        if (d > fd) { fd = d; far = i; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // The frame as the mask sees it: the edit without masks, uncropped, at a
  // working size. Kept while the edit underneath stays the same.
  function frameForSegment() {
    const { masks, crop, ...rest } = st.params;
    const key = st.key + JSON.stringify(rest);
    if (segFrame.key !== key) {
      segFrame.img = renderer.readFrame(st.params, 1280);
      segFrame.key = key;
      draw();   // the view canvas was borrowed for that
    }
    return segFrame.img;
  }

  // Works the mask out again from all its strokes. A newer stroke or an undo
  // while the worker is busy makes the answer stale; the newest one wins.
  function findSubject(m) {
    if (!renderer) return;
    worker ||= new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
    const id = ++segId, strokes = m.strokes, img = frameForSegment();
    st.brush.busy = true;
    paintBrush();
    paintHandles();
    const done = ({ data }) => {
      if (data.id !== id) return;
      worker.removeEventListener('message', done);
      if (id === segId) { st.brush.busy = false; paintBrush(); }
      if (data.error) { app.status(`couldn't find the subject: ${data.error}`, 0); return; }
      if (id !== segId || !st.params.masks.includes(m) || m.strokes !== strokes) return;
      const c = document.createElement('canvas');
      c.width = img.w; c.height = img.h;
      const ctx = c.getContext('2d'), px = ctx.createImageData(img.w, img.h);
      let any = false;
      for (let i = 0; i < data.alpha.length; i++) {
        const v = data.alpha[i];
        if (v) any = true;
        px.data[4 * i] = px.data[4 * i + 1] = px.data[4 * i + 2] = v;
        px.data[4 * i + 3] = 255;
      }
      ctx.putImageData(px, 0, 0);
      const url = any ? c.toDataURL('image/png') : null;
      if (url) putMaskImage(url, c);
      m.bitmap = url;
      m.map = IDENTITY_MAP;
      if (!any && strokes.some(s => !s.sub)) app.status('no subject found there: try a bigger brush over it', 4000);
      commit();
      draw();
    };
    worker.addEventListener('message', done);
    worker.postMessage({ id, img, strokes });
  }

  $('#brushBtn').addEventListener('click', e => { e.target.blur(); setBrush(!st.brush.on); });
  $('#brushErase').addEventListener('click', e => {
    e.target.blur();
    st.brush.erase = !st.brush.erase;
    if (!st.brush.on) st.brush.on = true;
    paintBrush();
    draw();
  });
  $('#brushSize').addEventListener('input', e => setBrushSize(parseFloat(e.target.value)));
  $('#brushSize').addEventListener('change', e => e.target.blur());
  addEventListener('keydown', e => { if (e.key === 'Alt' && st.brush.on && !st.brush.alt) { st.brush.alt = true; paintHandles(); } });
  addEventListener('keyup', e => { if (e.key === 'Alt' && st.brush.on) { st.brush.alt = false; paintHandles(); } });

  // --- turn and mirror -------------------------------------------------------------

  // Geometry (crop fitting, handles) works in the turned frame, whose size
  // swaps with a quarter turn.
  function syncSize() {
    [st.W, st.H] = orientedSize(st.params, st.bw || 0, st.bh || 0);
  }

  function turn(op) {
    if (!renderer || !st.bw) return;
    if (st.compare !== 'yours') showCompare('yours');
    st.params = reorient(st.params, op);
    syncSize();
    st.params.crop = fitCrop(st.params.crop, st.params, st.W, st.H);
    commit();
    paintSliders();
    draw();
    const said = { cw: 'turned right', ccw: 'turned left', '180': 'turned 180°', flipH: 'mirrored left–right', flipV: 'mirrored top–bottom' };
    app.status(said[op]);
  }
  for (const b of document.querySelectorAll('[data-turn]')) {
    b.addEventListener('click', () => { b.blur(); turn(b.dataset.turn); });
  }

  // --- ground shift area ---------------------------------------------------------

  // Ground shift can be limited to a polygon (the courtyard floor, say) so the
  // buildings standing on it are left alone. It starts as a wedge from the
  // horizon's centre to the bottom corners; the corners drag on the photo.
  st.areaEdit = false;
  st.areaSel = -1;
  const areaSvg = $('#areaHandles');

  function paintArea() {
    const area = st.params.groundArea;
    $('#areaOn').checked = !!area;
    $('#areaEdit').disabled = $('#areaAdd').disabled = !area;
    $('#areaDel').disabled = !area || area.length <= 3 || st.areaSel < 0;
    $('#areaEdit').setAttribute('aria-pressed', st.areaEdit && !!area);
    $('#sliders-area').hidden = !area;
    const show = area && st.areaEdit && !st.cropMode && !st.before && st.compare === 'yours';
    areaSvg.toggleAttribute('hidden', !show);
    if (!show) return;
    const r = view.getBoundingClientRect();
    areaSvg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    const pts = area.map(([x, y]) => toView(x, y));
    areaSvg.innerHTML = `<polygon class="edge" points="${pts.map(p => p.join(',')).join(' ')}"/>` +
      pts.map(([x, y], i) => `<circle class="h${i === st.areaSel ? ' center' : ''}" data-i="${i}" cx="${x}" cy="${y}" r="7"/>`).join('');
  }

  function setArea(on) {
    st.params.groundArea = on ? [[0.5, st.params.horizon / 100], [1.02, 1.02], [-0.02, 1.02]] : null;
    st.areaEdit = on;
    st.areaSel = -1;
    st.params.crop = fitCrop(st.params.crop, st.params, st.W, st.H);
    commit();
    paintArea();
    draw();
  }

  $('#areaOn').addEventListener('change', e => { e.target.blur(); setArea(e.target.checked); });
  $('#areaEdit').addEventListener('click', e => { e.target.blur(); st.areaEdit = !st.areaEdit; paintArea(); });
  $('#areaAdd').addEventListener('click', e => {
    e.target.blur();
    const a = st.params.groundArea;
    if (!a || a.length >= 8) return;
    // Split the longest edge, where a new corner is most likely wanted.
    let best = 0, len = -1;
    a.forEach(([x, y], i) => {
      const [x2, y2] = a[(i + 1) % a.length], l = Math.hypot((x2 - x) * st.W, (y2 - y) * st.H);
      if (l > len) { len = l; best = i; }
    });
    const [x1, y1] = a[best], [x2, y2] = a[(best + 1) % a.length];
    a.splice(best + 1, 0, [(x1 + x2) / 2, (y1 + y2) / 2]);
    st.areaSel = best + 1;
    st.areaEdit = true;
    commit(); paintArea(); draw();
  });
  $('#areaDel').addEventListener('click', e => {
    e.target.blur();
    const a = st.params.groundArea;
    if (!a || a.length <= 3 || st.areaSel < 0) return;
    a.splice(st.areaSel, 1);
    st.areaSel = -1;
    st.params.crop = fitCrop(st.params.crop, st.params, st.W, st.H);
    commit(); paintArea(); draw();
  });

  let adrag = null;
  areaSvg.addEventListener('pointerdown', e => {
    const i = e.target.dataset?.i;
    if (i === undefined) return;
    e.preventDefault();
    areaSvg.setPointerCapture(e.pointerId);
    adrag = +i;
    st.areaSel = +i;
    paintArea();
  });
  areaSvg.addEventListener('pointermove', e => {
    if (adrag === null) return;
    const r = view.getBoundingClientRect();
    st.params.groundArea[adrag] = toFrame(e.clientX - r.left, e.clientY - r.top).map(v => +v.toFixed(4));
    draw();
  });
  const endArea = () => {
    if (adrag === null) return;
    adrag = null;
    st.params.crop = fitCrop(st.params.crop, st.params, st.W, st.H);
    commit();
    draw();
  };
  areaSvg.addEventListener('pointerup', endArea);
  areaSvg.addEventListener('pointercancel', endArea);

  function paintLens() {
    const box = $('#lensOn'), info = st.lens;
    box.checked = !!st.params.lens;
    // Already corrected in the camera's JPEG: offer nothing, unless an old
    // edit applied it anyway and needs a way to switch it off.
    const usable = info?.profile && !info.inCamera && !st.dngLens;
    box.disabled = !usable && !st.params.lens;
    $('#lensInfo').textContent = st.dngLens ? 'corrected from the lens data in the DNG'
      : info?.inCamera ? `${info.profile.model}: already applied by the camera`
      : info?.profile ? `${info.model} @ ${info.focal}mm`
      : info ? `no profile for ${info.model}` : 'no lens info';
  }

  $('#lensOn').addEventListener('change', e => {
    e.target.blur();
    st.params.lens = e.target.checked && st.lens?.profile ? st.lens.profile : null;
    // Correcting barrel pulls the corners in from outside the frame: refit.
    st.params.crop = fitCrop(st.params.crop, st.params, st.W, st.H);
    commit();
    draw();
  });

  // The slider last touched takes ↑/↓ (instead of the panel scrolling), with
  // the same steps as its value box. Esc lets go.
  function activate(k) {
    st.active = k;
    for (const { row, spec } of Object.values(inputs)) row.classList.toggle('active', spec.k === k);
  }

  function nudgeActive(dir, e) {
    const spec = SLIDERS.find(x => x.k === st.active);
    if (!spec) return;
    const base = spec.fine && e.altKey ? 0.01 : (spec.nudge ?? spec.step);
    const v = Math.min(spec.max, Math.max(spec.min, st.params[spec.k] + base * (e.shiftKey ? 10 : 1) * dir));
    if (WARPS.includes(spec.k)) st.baseCrop = st.params.crop;
    set(spec.k, +v.toFixed(2));
    st.baseCrop = null;
    clearTimeout(st.nudgeT);
    st.nudgeT = setTimeout(commit, 600);   // one undo step per burst of nudges
  }

  // --- looks -------------------------------------------------------------------

  // A look is a saved set of colour, tone and grain settings. Applying one
  // layers a copy of it over the frame's own settings (render.js), so the
  // sliders keep adjusting the photo underneath and never change the look.
  // Looks swap rather than stack: a frame has at most one.
  st.looks = [];
  const lookSel = $('#look');
  const sameLook = (a, b) => LOOK_KEYS.every(k => same(k, a[k] ?? DEFAULTS[k], b[k] ?? DEFAULTS[k]));
  // The saved look the frame's copy came from, if it is still the same.
  const savedLook = () => {
    const l = st.params.look;
    return l ? st.looks.findIndex(s => s.name === l.name && sameLook(s.params, l.params)) : -1;
  };

  function fillLooks() {
    lookSel.innerHTML = '<option value="">None</option>' +
      st.looks.map((l, i) => `<option value="${i}"></option>`).join('') +
      '<option value="frame" hidden></option>';
    st.looks.forEach((l, i) => (lookSel.options[i + 1].textContent = l.name + (l.missingLut ? ' (missing LUT)' : '')));
    paintLook();
  }

  function paintLook() {
    st.looks.forEach((look, index) => {
      const unavailable = lutWarning({ look });
      lookSel.options[index + 1].textContent = look.name +
        (look.missingLut ? ' (missing LUT)' : look.lutMismatch ? ' (LUT mismatch)' : unavailable ? ' (unavailable LUT)' : '');
    });
    const l = st.params.look, i = savedLook();
    // A copy whose look was since changed or deleted still shows, by name.
    const own = lookSel.querySelector('option[value="frame"]');
    own.hidden = !l || i >= 0;
    if (l && i < 0) {
      own.textContent = `${l.name || 'Look'} (${st.looks.some(s => s.name === l.name) ? 'older copy' : 'this frame only'})` + (lutWarning(st.params) ? ' (unavailable LUT)' : '');
    }
    lookSel.value = !l ? '' : i < 0 ? 'frame' : String(i);
    // A LUT's look comes from its file in luts/ and goes when the file does.
    $('#lookDelete').disabled = !l || !st.looks.some(s => s.name === l.name && !s.file);
    $('#sliders-look').hidden = !l;
  }

  function applyLook(look) {
    if (st.compare !== 'yours') showCompare('yours');
    st.params.look = look ? { name: look.name, params: cleanLook(look.params) } : null;
    if (!look) st.params.lookAmount = 100;
    paintSliders();
    commit();
    draw();
    app.status(look ? `applied ${look.name}` : 'look cleared');
  }

  // Saves the frame's own colour, tone and grain, not the look layered on it.
  async function saveLook() {
    const name = prompt("Name for a look made from this frame's own colour, tone and grain sliders " +
      '(not exposure or crop, and not the look already on it):', '');
    if (!name?.trim()) return;
    const params = Object.fromEntries(LOOK_KEYS.map(k => [k, st.params[k]]));
    try {
      st.looks = (await app.post('/api/looks/save', { name, params })).looks;
      fillLooks();
      app.status(`saved look ${name.trim()}`);
    } catch (e) {
      app.status(`save failed: ${e.message}`, 0);
    }
  }

  async function deleteLook() {
    const look = st.looks.find(s => s.name === st.params.look?.name && !s.file);
    if (!look || !confirm(`Delete the look "${look.name}"? Frames already using it keep their copy.`)) return;
    try {
      st.looks = (await app.post('/api/looks/delete', { name: look.name })).looks;
      fillLooks();
      app.status(`deleted look ${look.name}`);
    } catch (e) {
      app.status(`delete failed: ${e.message}`, 0);
    }
  }

  lookSel.addEventListener('change', () => {
    if (lookSel.value !== 'frame') applyLook(lookSel.value === '' ? null : st.looks[+lookSel.value]);
    lookSel.blur();
  });
  async function addLuts(files) {
    for (const file of files) {
      try {
        if (!file.name.endsWith('.cube') || file.size > 64 * 1024 * 1024) throw new Error('choose a .cube file up to 64 MiB');
        parseCube(await file.text());
        const response = await fetch(`/api/luts/install?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || response.status);
        clearLutCache();
        if (renderer) renderer.lutName = undefined;
        st.looks = result.looks;
        fillLooks();
        applyLook(result.look);
        app.status(`installed ${file.name} in your LUT folder`);
      } catch (error) {
        app.status(`could not install ${file.name}: ${error.message}`, 0);
      }
    }
    $('#lutFile').value = '';
  }
  $('#lookAdd').addEventListener('click', () => $('#lutFile').click());
  $('#lutFile').addEventListener('change', event => addLuts([...event.target.files]));
  const drop = $('#lookDrop');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('lut-drop'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('lut-drop'));
  drop.addEventListener('drop', event => {
    event.preventDefault(); drop.classList.remove('lut-drop'); addLuts([...event.dataTransfer.files]);
  });
  $('#lookSave').addEventListener('click', e => { e.target.blur(); saveLook(); });
  $('#lookDelete').addEventListener('click', e => { e.target.blur(); deleteLook(); });
  fillLooks();
  fetch('/api/looks').then(r => r.json()).then(r => { st.looks = r.looks; fillLooks(); })
    .catch(() => app.status('could not load looks', 3000));

  // --- tone curve ----------------------------------------------------------------

  // Drawn in a 200-unit box, y up. Points are [x, y] in 0..100.
  const curveSvg = $('#curve');
  const CURVE_COLOR = { rgb: '#ddd', r: '#f06060', g: '#5cc85c', b: '#6a9cff' };
  const MAX_CURVE_POINTS = 16;
  st.curveCh = 'rgb';
  st.curvePt = -1;
  const curvePts = ch => st.params.curve?.[ch] || IDENTITY_CURVE;
  const toBox = ([x, y]) => [x * 2, 200 - y * 2];

  function paintCurve() {
    let h = '';
    for (const v of [50, 100, 150]) h += `<line class="grid" x1="${v}" y1="0" x2="${v}" y2="200"/><line class="grid" x1="0" y1="${v}" x2="200" y2="${v}"/>`;
    h += '<line class="base" x1="0" y1="200" x2="200" y2="0"/>';
    const path = ch => {
      const f = curveFn(curvePts(ch));
      let d = '';
      for (let i = 0; i <= 100; i++) d += `${i ? 'L' : 'M'}${i * 2},${(200 - f(i / 100) * 200).toFixed(1)}`;
      return d;
    };
    for (const ch of CURVE_CHANNELS) {
      if (ch !== st.curveCh && st.params.curve?.[ch]) h += `<path class="ghost" stroke="${CURVE_COLOR[ch]}" d="${path(ch)}"/>`;
    }
    const c = CURVE_COLOR[st.curveCh];
    h += `<path class="line" stroke="${c}" d="${path(st.curveCh)}"/>`;
    curvePts(st.curveCh).forEach((q, i) => {
      const [x, y] = toBox(q);
      h += `<circle class="pt${i === st.curvePt ? ' active' : ''}" data-i="${i}" cx="${x}" cy="${y}" r="3.5" stroke="${c}" style="color:${c}"/>`;
    });
    curveSvg.innerHTML = h;
    for (const b of document.querySelectorAll('.curve-ch [data-ch]')) {
      b.setAttribute('aria-pressed', b.dataset.ch === st.curveCh);
      b.classList.toggle('bent', !!st.params.curve?.[b.dataset.ch]);
    }
  }

  function setCurvePts(pts) {
    if (st.compare !== 'yours') showCompare('yours');
    st.params.curve = cleanCurve({ ...(st.params.curve || {}), [st.curveCh]: pts });
    paintCurve();
    draw();
    scheduleSave();
  }

  // Pointer position in curve units (0..100), clamped.
  function curvePos(e) {
    const r = curveSvg.getBoundingClientRect();
    const bx = (e.clientX - r.left) / r.width * 208 - 4, by = (e.clientY - r.top) / r.height * 208 - 4;
    const clamp = v => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
    return [clamp(bx / 2), clamp((200 - by) / 2)];
  }

  let cdrag = null;
  curveSvg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pts = curvePts(st.curveCh).map(q => [...q]);
    let i = e.target.dataset?.i !== undefined ? +e.target.dataset.i : -1;
    if (i < 0) {
      if (pts.length >= MAX_CURVE_POINTS) return app.status(`a curve holds at most ${MAX_CURVE_POINTS} points`);
      const [x, y] = curvePos(e);
      i = pts.findIndex(q => q[0] > x);
      if (i <= 0) return;   // outside the end points: drag those instead
      if (x - pts[i - 1][0] < 1 || pts[i][0] - x < 1) return;
      pts.splice(i, 0, [x, y]);
      setCurvePts(pts);
    }
    st.curvePt = i;
    cdrag = { i };
    try { curveSvg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    paintCurve();
  });
  curveSvg.addEventListener('pointermove', e => {
    if (!cdrag) return;
    const pts = curvePts(st.curveCh).map(q => [...q]), i = cdrag.i;
    let [x, y] = curvePos(e);
    // A point stays between its neighbours, so the curve never folds back.
    const lo = i > 0 ? pts[i - 1][0] + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 100;
    x = Math.min(hi, Math.max(lo, x));
    pts[i] = [x, y];
    cdrag.moved = true;
    setCurvePts(pts);
  });
  const curveEnd = () => { if (cdrag) { cdrag = null; commit(); } };
  curveSvg.addEventListener('pointerup', curveEnd);
  curveSvg.addEventListener('pointercancel', curveEnd);
  curveSvg.addEventListener('dblclick', e => {
    const i = e.target.dataset?.i !== undefined ? +e.target.dataset.i : -1;
    const pts = curvePts(st.curveCh);
    if (i <= 0 || i >= pts.length - 1) return;   // the end points stay
    setCurvePts(pts.filter((_, j) => j !== i));
    st.curvePt = -1;
    paintCurve();
    commit();
  });
  for (const b of document.querySelectorAll('.curve-ch [data-ch]')) {
    b.addEventListener('click', () => { b.blur(); st.curveCh = b.dataset.ch; st.curvePt = -1; paintCurve(); });
  }
  $('#curveReset').addEventListener('click', e => {
    e.target.blur();
    st.curvePt = -1;
    setCurvePts(IDENTITY_CURVE);
    commit();
  });

  function paintSliders() {
    paintSource();
    paintCurve();
    paintLook();
    paintLens();
    paintMasks();
    for (const { input, out, row, spec } of Object.values(inputs)) {
      const v = st.params[spec.k];
      input.value = v;
      if (document.activeElement !== out) out.value = (spec.fmt || signed)(v);
      row.classList.toggle('changed', v !== (spec.neutral ?? 0));
    }
  }

  function set(k, v) {
    if (st.compare !== 'yours') showCompare('yours');
    st.params[k] = v;
    // Refit from the crop the drag started with, so easing a slider back
    // gives the frame back rather than leaving it shrunk.
    if (WARPS.includes(k)) st.params.crop = fitCrop(st.baseCrop || st.params.crop, st.params, st.W, st.H);
    const { out, row, spec } = inputs[k];
    if (document.activeElement !== out) out.value = (spec.fmt || signed)(v);
    row.classList.toggle('changed', v !== (spec.neutral ?? 0));
    if (inputs[k].input.value != v) inputs[k].input.value = v;
    draw();
    scheduleSave();
  }

  // --- history and saving ----------------------------------------------------

  function commit() {
    const now = JSON.stringify(st.params);
    if (now === st.committed) return;
    if (st.committed) st.undo.push(st.committed);
    st.redo = [];
    st.committed = now;
    scheduleSave();
  }

  function restore(json) {
    st.params = normalize(JSON.parse(json));
    syncSize();
    st.committed = json;
    paintSliders();
    draw();
    scheduleSave();
    showSource();   // an undo or redo across a switch of source
  }

  function scheduleSave() {
    clearTimeout(st.saveT);
    st.saveT = setTimeout(save, 400);
  }

  // Each save names the revision it builds on. If the recipe changed
  // elsewhere meanwhile (another window, or an edit to the file), the server
  // refuses and sends the newer version, which is taken up with ours on the
  // undo stack.
  async function save() {
    clearTimeout(st.saveT);
    st.saveT = null;
    if (!st.key) return;
    const f = app.frame(st.key);
    if (!f) return;
    st.saving = true;
    try {
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shoot: f.shoot, key: f.key, params: st.params, base: st.rev }),
      });
      const res = await r.json().catch(() => ({}));
      if (r.status === 409) {
        if (f.id === st.key) adopt(f, res.params, res.rev, 'changed in another window: loaded that version');
        return;
      }
      if (!r.ok) throw new Error(res.error || r.status);
      if (f.id === st.key) st.rev = res.rev;
      noteSaved(f, res.params);
      app.status('saved');
    } catch (e) {
      app.status(`save failed: ${e.message}`, 0);
    } finally {
      st.saving = false;
    }
  }

  function noteSaved(f, params) {
    f.edited = params !== null;
    f.params = params;
    app.thumbs.apply(f);
    paintStrip();
  }

  // Take up a version of the open frame's recipe from elsewhere, in place.
  // What was showing goes on the undo stack, so ⌘Z brings it back.
  function adopt(f, params, rev, note) {
    st.rev = rev;
    noteSaved(f, params);
    const next = normalize(params);
    next.source = params?.source || st.params.source;
    const json = JSON.stringify(next);
    if (json === JSON.stringify(st.params)) return;
    st.undo.push(JSON.stringify(st.params));
    st.redo = [];
    st.params = next;
    st.committed = json;
    syncSize();
    paintSliders();
    draw();
    showSource();
    app.status(`${note} (⌘Z to undo)`, 5000);
  }

  // The event stream says the open frame's recipe changed on disk. Our own
  // saves echo back here too; those match st.rev and are skipped. While a
  // change of ours is pending, leave it: its save will meet the conflict.
  async function remoteChanged(rev) {
    if (rev === st.rev || st.saveT || st.saving || st.opening || !st.key) return;
    const f = app.frame(st.key);
    if (!f) return;
    const key = st.key;
    const edit = await fetch(`/api/edit?shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`).then(r => r.json());
    if (key !== st.key || edit.rev === st.rev || st.saveT || st.saving) return;
    adopt(f, edit.params, edit.rev, 'updated from elsewhere');
  }

  async function flush() { if (st.saveT) await save(); }

  // --- rendering ---------------------------------------------------------------

  function draw() {
    if (st.rafPending) return;
    st.rafPending = true;
    requestAnimationFrame(() => {
      st.rafPending = false;
      if (!renderer || !st.W) return;
      const stage = $('#stage');
      const maxSize = Math.max(stage.clientWidth, stage.clientHeight) * (devicePixelRatio || 1);
      const showMask = (st.showMask || st.handleDrag || st.brush.on) && !st.cropMode ? st.maskSel : -1;
      if (st.before || st.compare === 'original') renderer.render(normalize(), { maxSize });
      else if (st.compare === 'proposed' && st.proposal) renderer.render(st.proposal.params, { maxSize });
      else if (st.cropMode) renderer.render(st.params, { crop: FULL_CROP, maxSize });
      else renderer.render(st.params, { maxSize, showMask, masksOff: st.masksOff });
      const visibleParams = st.before || st.compare === 'original' ? null
        : st.compare === 'proposed' && st.proposal ? st.proposal.params : st.params;
      const warning = lutWarning(visibleParams);
      $('#lutStatus').textContent = warning;
      $('#lutStatus').hidden = !warning;
      paintLook();
      fit();
      paintCropBox();
      paintGuides();
      paintCrosshair();
      paintHandles();
      paintArea();
      histogram();
      paintClip();
      paintReadout();
    });
  }

  function fit() {
    const stage = $('#stage');
    const availW = stage.clientWidth - 32, availH = stage.clientHeight - 32;
    const s = Math.min(availW / view.width, availH / view.height);
    view.style.width = Math.floor(view.width * s) + 'px';
    view.style.height = Math.floor(view.height * s) + 'px';
  }
  new ResizeObserver(() => st.key && draw()).observe($('#stage'));

  const histCanvas = document.createElement('canvas');
  histCanvas.width = 160; histCanvas.height = 100;
  function histogram() {
    const hctx = histCanvas.getContext('2d', { willReadFrequently: true });
    hctx.drawImage(view, 0, 0, histCanvas.width, histCanvas.height);
    const px = hctx.getImageData(0, 0, histCanvas.width, histCanvas.height).data;
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < px.length; i += 4) { bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++; }
    const out = $('#hist'), ctx = out.getContext('2d');
    const W = out.width, H = out.height;
    ctx.clearRect(0, 0, W, H);
    // Ignore the end bins when scaling, so a clipped sun does not flatten the rest.
    let peak = 1;
    for (const b of bins) for (let i = 2; i < 254; i++) peak = Math.max(peak, b[i]);
    ctx.globalCompositeOperation = 'lighter';
    ['rgba(230,70,70,.75)', 'rgba(70,200,90,.75)', 'rgba(80,120,240,.75)'].forEach((c, ch) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i * W / 255, H - Math.min(1, Math.sqrt(bins[ch][i] / peak)) * H);
      ctx.lineTo(W, H);
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
    // Lightroom-style corner triangles: lit when a channel piles up at an end.
    const n = histCanvas.width * histCanvas.height, lim = n * 0.0005;
    const lo = bins.some(b => b[0] > lim), hi = bins.some(b => b[255] > lim);
    const tri = (x, dir, on, colour) => {
      ctx.fillStyle = on ? colour : 'rgba(255,255,255,.18)';
      ctx.beginPath();
      ctx.moveTo(x, 3); ctx.lineTo(x + dir * 12, 3); ctx.lineTo(x, 15);
      ctx.fill();
    };
    tri(3, 1, lo, '#5aa9ff');
    tri(W - 3, -1, hi, '#ff4a4a');
  }

  // --- clipping and colour readout ---------------------------------------------

  // Clipping paints blown highlights red and crushed shadows blue on a layer
  // over the photo (a channel clipped on its own in a paler shade), so the
  // photo itself and the readout stay true. The readout follows the pointer
  // and updates as sliders move, for tuning a colour while watching it.
  st.clip = (() => { try { return localStorage.getItem('studio.clip') === '1'; } catch { return false; } })();
  st.hover = null;   // pointer over the photo, 0..1 of the view
  const clipView = $('#clipView'), clipSrc = document.createElement('canvas');

  function toggleClip() {
    st.clip = !st.clip;
    try { localStorage.setItem('studio.clip', st.clip ? '1' : '0'); } catch { /* fine */ }
    draw();
  }

  function paintClip() {
    $('#clipBtn').setAttribute('aria-pressed', st.clip);
    const on = st.clip && !st.cropMode;
    clipView.hidden = !on;
    if (!on) { st.clipped = null; return; }
    // Worked out at up to 1600px on the long side: plenty for spotting areas.
    const k = Math.min(1, 1600 / Math.max(view.width, view.height));
    const w = Math.max(1, Math.round(view.width * k)), h = Math.max(1, Math.round(view.height * k));
    for (const c of [clipSrc, clipView]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const sctx = clipSrc.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(view, 0, 0, w, h);
    const src = sctx.getImageData(0, 0, w, h).data;
    const octx = clipView.getContext('2d'), out = octx.createImageData(w, h), o = out.data;
    let blown = 0, crushed = 0;
    for (let i = 0; i < src.length; i += 4) {
      const r = src[i], g = src[i + 1], b = src[i + 2];
      const hiN = (r >= 254) + (g >= 254) + (b >= 254), loN = (r <= 1) + (g <= 1) + (b <= 1);
      if (hiN === 3) { o[i] = 255; o[i + 1] = 40; o[i + 2] = 40; o[i + 3] = 255; blown++; }
      else if (loN === 3) { o[i] = 40; o[i + 1] = 110; o[i + 2] = 255; o[i + 3] = 255; crushed++; }
      else if (hiN) { o[i] = 255; o[i + 1] = 150; o[i + 2] = 150; o[i + 3] = 170; }
      else if (loN) { o[i] = 150; o[i + 1] = 190; o[i + 2] = 255; o[i + 3] = 170; }
    }
    octx.putImageData(out, 0, 0);
    const n = w * h;
    st.clipped = { blown: blown / n, crushed: crushed / n };
  }

  const pct = v => (v >= 0.1 || !v ? Math.round(v * 100) : (v * 100).toFixed(1)) + '%';

  function paintReadout() {
    const el = $('#readout');
    if (!st.hover || !renderer || !view.width) {
      el.innerHTML = st.clipped
        ? `<span><b>${pct(st.clipped.blown)}</b> blown</span> <span><b>${pct(st.clipped.crushed)}</b> crushed</span>`
        : 'Point at the photo to read its colour';
      return;
    }
    // A 3x3 average, read straight off the drawing (row 0 is the bottom).
    const gl = renderer.gl, box = 3;
    const x = Math.max(0, Math.min(view.width - box, Math.round(st.hover[0] * view.width - 1)));
    const y = Math.max(0, Math.min(view.height - box, Math.round((1 - st.hover[1]) * view.height - 2)));
    const px = new Uint8Array(box * box * 4);
    gl.readPixels(x, y, box, box, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const c = [0, 1, 2].map(k => { let t = 0; for (let i = k; i < px.length; i += 4) t += px[i]; return Math.round(t / (box * box)); });
    const [r, g, b] = c;
    // Lightness as L* (0..100, perceptual); hue and saturation as HSL.
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const L = Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : Y * 24389 / 27;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0;
    if (d) hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const l = (mx + mn) / 510, sat = d ? d / 255 / (1 - Math.abs(2 * l - 1)) : 0;
    // Groups wrap as wholes when the panel is narrow.
    const parts = [
      `<i class="sw" style="background:rgb(${r},${g},${b})"></i>R <b>${r}</b> G <b>${g}</b> B <b>${b}</b>`,
      `L <b>${Math.round(L)}</b>`,
      d ? `hue <b>${Math.round(hue * 60)}°</b> sat <b>${Math.round(sat * 100)}%</b>` : 'neutral',
    ];
    if (mx >= 254) parts.push('<b style="color:#ff6a6a">clipped</b>');
    else if (mx <= 1) parts.push('<b style="color:#6aa9ff">crushed</b>');
    el.innerHTML = parts.map(t => `<span>${t}</span>`).join(' ');
  }

  $('#wrap').addEventListener('pointermove', e => {
    const r = view.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    st.hover = fx >= 0 && fy >= 0 && fx <= 1 && fy <= 1 ? [fx, fy] : null;
    paintReadout();
  });
  $('#wrap').addEventListener('pointerleave', () => { st.hover = null; paintReadout(); });
  $('#clipBtn').addEventListener('click', e => { e.target.blur(); toggleClip(); });
  $('#hist').addEventListener('click', toggleClip);

  // --- crop ------------------------------------------------------------------

  const cropbox = $('#cropbox');

  function paintCropBox() {
    cropbox.hidden = !st.cropMode || st.before;
    if (cropbox.hidden) return;
    const c = st.params.crop;
    Object.assign(cropbox.style, {
      left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%',
    });
  }

  function aspect() {
    const v = $('#aspect').value;
    return v === 'free' ? null : v === 'orig' ? st.W / st.H : parseFloat(v);
  }

  function setCropMode(on) {
    st.cropMode = on;
    $('#cropBtn').setAttribute('aria-pressed', on);
    $('#cropBtn').textContent = on ? 'Done' : 'Crop';
    if (!on) commit();
    draw();
  }

  function applyAspect() {
    const r = aspect();
    let c = { ...st.params.crop };
    if (r) {
      const cur = (c.w * st.W) / (c.h * st.H);
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      if (cur > r) c.w = (c.h * st.H * r) / st.W; else c.h = (c.w * st.W) / (r * st.H);
      c.x = Math.min(Math.max(0, cx - c.w / 2), 1 - c.w);
      c.y = Math.min(Math.max(0, cy - c.h / 2), 1 - c.h);
    }
    st.params.crop = fitCrop(c, st.params, st.W, st.H);
    commit();
    draw();
  }

  let drag = null;
  cropbox.addEventListener('pointerdown', e => {
    e.preventDefault();
    cropbox.setPointerCapture(e.pointerId);
    drag = { handle: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, crop: { ...st.params.crop } };
  });
  cropbox.addEventListener('pointermove', e => {
    if (!drag) return;
    const rect = view.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / rect.width, dy = (e.clientY - drag.y) / rect.height;
    const c0 = drag.crop;
    let next;
    if (drag.handle === 'move') {
      const moved = { ...c0, x: Math.min(Math.max(0, c0.x + dx), 1 - c0.w), y: Math.min(Math.max(0, c0.y + dy), 1 - c0.h) };
      // Slide along an edge instead of sticking when one axis runs out of image.
      next = [moved, { ...c0, x: moved.x }, { ...c0, y: moved.y }]
        .find(c => cropValid(c, st.params, st.W, st.H));
    } else {
      const west = drag.handle.includes('w'), north = drag.handle.includes('n');
      const ax = west ? c0.x + c0.w : c0.x, ay = north ? c0.y + c0.h : c0.y;   // anchor corner
      let w = Math.max(0.03, west ? c0.w - dx : c0.w + dx);
      let h = Math.max(0.03, north ? c0.h - dy : c0.h + dy);
      const r = aspect();
      if (r) h = (w * st.W) / (r * st.H);
      next = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
      if (!cropValid(next, st.params, st.W, st.H)) next = null;
    }
    if (next) { st.params.crop = next; paintCropBox(); }
  });
  const endDrag = () => { if (drag) { drag = null; commit(); } };
  cropbox.addEventListener('pointerup', endDrag);
  cropbox.addEventListener('pointercancel', endDrag);

  $('#cropBtn').addEventListener('click', e => { e.target.blur(); setCropMode(!st.cropMode); });
  $('#cropReset').addEventListener('click', e => {
    e.target.blur();
    for (const k of WARPS) st.params[k] = SLIDERS.find(x => x.k === k)?.neutral ?? 0;
    st.params.groundArea = null;
    st.areaEdit = false;
    st.params.crop = { ...FULL_CROP };
    $('#aspect').value = 'free';
    paintSliders();
    commit();
    draw();
  });
  $('#aspect').addEventListener('change', e => { e.target.blur(); applyAspect(); });

  // --- proposals ---------------------------------------------------------------

  // A suggested edit sits beside yours until accepted or discarded. The bar
  // flips the view between the untouched original, your edit and the
  // proposal; the sliders always stay on your edit.
  st.proposal = null;
  st.compare = 'yours';

  function showCompare(which) {
    st.compare = which;
    paintProposal();
    draw();
  }

  function paintProposal() {
    const bar = $('#proposal');
    bar.hidden = !st.proposal;
    if (!st.proposal) return;
    $('#proposalNote').textContent = st.proposal.note || 'A suggested edit for this photo.';
    for (const b of bar.querySelectorAll('[data-compare]')) {
      b.setAttribute('aria-pressed', b.dataset.compare === st.compare);
    }
  }

  async function settleProposal(accept) {
    const f = app.frame(st.key);
    if (!f || !st.proposal) return;
    if (accept) {
      // Compared on the image already loaded, so accepted onto it too.
      st.params = normalize({ ...st.proposal.params, source: st.params.source });
      paintSliders();
      commit();                      // ⌘Z goes back to your edit
    }
    await app.post('/api/proposal', { shoot: f.shoot, key: f.key, params: null });
    f.proposed = false;
    st.proposal = null;
    showCompare('yours');
    await flush();
    app.status(accept ? 'proposal accepted (⌘Z to undo)' : 'proposal discarded');
  }

  // A proposal was made, changed or settled elsewhere (or by our own Accept
  // or Discard, which then finds nothing new). A new one opens on the
  // proposed view, as it would on opening the frame.
  async function proposalChanged() {
    const f = app.frame(st.key);
    if (!f || st.opening) return;
    const key = st.key;
    const prop = await fetch(`/api/proposal?shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`).then(r => r.json());
    if (key !== st.key) return;
    const next = prop.proposal ? { ...prop.proposal, params: normalize(prop.proposal.params) } : null;
    if (JSON.stringify(next) === JSON.stringify(st.proposal)) return;
    st.proposal = next;
    f.proposed = !!next;
    app.thumbs.apply(f);
    showCompare(next ? 'proposed' : st.compare === 'proposed' ? 'yours' : st.compare);
    if (next) app.status('new proposed edit: 1 / 2 / 3 to compare', 5000);
  }

  for (const b of document.querySelectorAll('#proposal [data-compare]')) {
    b.addEventListener('click', () => { b.blur(); showCompare(b.dataset.compare); });
  }
  $('#proposalAccept').addEventListener('click', e => { e.target.blur(); settleProposal(true); });
  $('#proposalDiscard').addEventListener('click', e => { e.target.blur(); settleProposal(false); });

  // --- white balance picker ---------------------------------------------------

  // Click something that should be neutral grey; Temp and Tint are solved so
  // it comes out neutral. Solved against the untoned render, since tone and
  // saturation change channel ratios.
  function setPicking(on) {
    st.picking = on;
    $('#wbPick').setAttribute('aria-pressed', on);
    view.style.cursor = on ? 'crosshair' : '';
    if (on && st.cropMode) setCropMode(false);
  }

  function pickNeutral(e) {
    const rect = view.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    renderer.render(st.params, { tone: false, maxSize: Math.max(view.width, view.height) });
    const gl = renderer.gl, box = 9;
    const x = Math.max(0, Math.min(view.width - box, Math.round(fx * view.width - box / 2)));
    const y = Math.max(0, Math.min(view.height - box, Math.round((1 - fy) * view.height - box / 2)));
    const px = new Uint8Array(box * box * 4);
    gl.readPixels(x, y, box, box, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += lin(px[i + c]);
    const [r, g, b] = sum.map(v => Math.log(Math.max(v, 1e-6)));
    const clamp = (v, lim = 100) => Math.round(Math.max(-lim, Math.min(lim, v)));
    // The shader's gains are exp(0.35 t) on red, exp(-0.3 u) on green, exp(-0.35 t) on blue.
    st.params.temp = clamp(((b - r) / 0.7) * 100, 300);
    st.params.tint = clamp(((g - (r + b) / 2) / 0.3) * 100, 300);
    setPicking(false);
    paintSliders();
    commit();
    draw();
    app.status(`white balance set: temp ${signed(st.params.temp)}, tint ${signed(st.params.tint)}`);
  }

  view.addEventListener('click', e => { if (st.picking && renderer) pickNeutral(e); });
  $('#wbPick').addEventListener('click', e => { e.target.blur(); setPicking(!st.picking); });

  // --- frames ------------------------------------------------------------------

  // The frames worth flipping between: the target collection in its order,
  // else the picks, else everything. The open frame always stays in the strip.
  function stripFrames() {
    if (app.target && app.frames.some(f => f.selected)) {
      const set = app.frames.filter(f => f.selected).sort((a, b) => a.selected - b.selected);
      const cur = app.frame(st.key);
      return cur && !cur.selected ? [...set, cur] : set;
    }
    const picks = app.frames.filter(f => f.picked || f.id === st.key);
    return picks.some(f => f.picked) ? picks : app.frames;
  }

  function paintStrip() {
    const strip = $('#strip');
    const frames = stripFrames();
    const have = [...strip.children].map(b => b.dataset.id).join();
    if (have !== frames.map(f => f.id).join()) {
      strip.innerHTML = '';
      for (const f of frames) {
        const b = document.createElement('button');
        b.dataset.id = f.id;
        // The strip is the collection's order when it shows one: drag to reorder.
        b.draggable = !!app.target && !!f.selected;
        b.title = f.id;
        b.innerHTML = `<img loading="lazy" draggable="false" alt="${f.key}" data-thumb="${f.id}" src="${app.src('thumb', f)}">
          <span class="pk"></span><span class="src"></span><span class="dot"></span>`;
        b.addEventListener('click', () => { b.blur(); open(f.id); });
        strip.appendChild(b);
        if (f.params) app.thumbs.apply(f);
      }
    }
    for (const b of strip.children) {
      const f = app.frame(b.dataset.id);
      b.classList.toggle('current', f.id === st.key);
      b.querySelector('.pk').textContent = f.selected ? `#${f.selected}` : f.picked ? '★' : '';
      b.querySelector('.dot').hidden = !f.edited;
      paintSourceTag(b.querySelector('.src'), f, f.id === st.key ? st.params.source : sourceOf(f, f.params));
    }
    strip.querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function open(id) {
    const f = app.frame(id);
    if (!f) return;
    if (id === st.key && renderer) { paintStrip(); draw(); return; }
    await flush();
    const token = ++st.loadToken;
    app.focusKey = id;
    app.syncUrl();
    st.key = id;
    // Until the image is in, the panel still holds the last frame's edit:
    // no source badge, and no switching.
    st.opening = true;
    st.shownSource = null;
    paintBadge(f, null);
    paintSource();
    $('#devName').textContent = app.isCollection() ? `${app.shootDate(f.shoot)} · ${f.key}` : f.key;
    paintStrip();
    const q = `shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`;
    const [edit, prop] = await Promise.all([
      fetch(`/api/edit?${q}`).then(r => r.json()),
      fetch(`/api/proposal?${q}`).then(r => r.json()),
    ]);
    if (token !== st.loadToken) return;
    const source = sourceOf(f, edit.params);
    paintBadge(f, source);
    let lens;
    try {
      [, lens] = await Promise.all([
        showImage(f, source, () => token !== st.loadToken),
        fetch(`/api/lens?${q}&source=${source}`).then(r => r.json()),
      ]);
    } catch (e) {
      if (token !== st.loadToken) return;
      app.status(`couldn't open ${f.key} from the ${SOURCE_LABEL[source]}: ${e.message}`, 0);
      st.key = null;   // the sliders still hold the last frame: never save them onto this one
      st.opening = false;
      return;
    }
    if (token !== st.loadToken) return;
    st.opening = false;
    const frames = stripFrames();
    prefetch(app, frames, frames.findIndex(g => g.id === id), () => st.key);
    st.lens = lens.lens;
    st.proposal = prop.proposal ? { ...prop.proposal, params: normalize(prop.proposal.params) } : null;
    st.compare = st.proposal ? 'proposed' : 'yours';
    paintProposal();
    st.params = normalize(edit.params);
    st.rev = edit.rev;
    app.watchEdit?.(f.shoot, f.key);
    // Carried explicitly from here on, so a pre-raw edit, once touched, is
    // saved as a JPEG edit rather than flipping to the raw.
    st.params.source = source;
    st.legacy = !!edit.params && !edit.params.source && source === 'jpeg' && !!f.raw;
    syncSize();
    st.maskSel = -1;
    st.brush.on = false;
    st.committed = JSON.stringify(st.params);
    st.undo = []; st.redo = [];
    $('#aspect').value = 'free';
    setCropMode(false);
    paintSliders();
    $('#devEmpty').hidden = true;
    $('#wrap').hidden = false;
    draw();
  }

  // --- source ------------------------------------------------------------------

  // Put the frame's RAW or JPEG into the renderer. Throws if it can't be
  // loaded; resolves false if stale() says a newer load has taken over.
  async function showImage(f, source, stale) {
    const img = await loadSource(app, f, source, { stale });
    if (!img || stale()) { release(img); return false; }
    if (!renderer) { renderer = new Renderer(view); renderer.onLutLoad = draw; }
    renderer.setImage(img);
    st.bw = img.width; st.bh = img.height;
    st.shownSource = source;
    st.dngLens = !!img.warp;   // the DNG corrects its own lens: Lensfun stays out
    release(img);
    return true;
  }

  // Load the image the params' source names, if it isn't the one shown: after
  // a switch, or an undo or redo across one. The rest of the edit carries over.
  async function showSource() {
    const f = app.frame(st.key), source = st.params.source;
    if (!f || !source || st.opening || source === st.shownSource) return;
    const opened = st.loadToken, mine = ++st.srcToken;
    const stale = () => opened !== st.loadToken || mine !== st.srcToken;
    const q = `shoot=${encodeURIComponent(f.shoot)}&key=${f.key}&source=${source}`;
    try {
      const [shown, lens] = await Promise.all([
        showImage(f, source, stale),
        fetch(`/api/lens?${q}`).then(r => r.json()),
      ]);
      if (!shown || stale()) return;
      st.lens = lens.lens;
      syncSize();
      paintSliders();
      draw();
      app.status(`developing from the ${SOURCE_LABEL[source]}`);
    } catch (e) {
      if (stale()) return;
      // Never label the photo with a source it isn't showing: go back.
      app.status(`couldn't load the ${SOURCE_LABEL[source]}: ${e.message}`, 0);
      st.params.source = st.shownSource;
      commit();
      paintSliders();
    }
  }

  function setSource(source) {
    const f = app.frame(st.key);
    if (!f || !st.params.source || st.opening || source === st.params.source) return;
    if (!(source === 'raw' ? f.raw : f.jpeg)) return;
    if (st.compare !== 'yours') showCompare('yours');
    st.params.source = source;
    commit();
    paintSource();
    paintStrip();
    showSource();
  }

  // The badge names the source being developed; it is dimmed while that
  // image is still loading, since the photo on screen is not from it yet.
  function paintBadge(f, source) {
    const badge = $('#devSource');
    badge.textContent = source ? SOURCE_LABEL[source] : '';
    badge.classList.toggle('jpeg', source === 'jpeg');
    badge.classList.toggle('redo', source === 'jpeg' && !!f.raw);
    badge.classList.toggle('loading', !!source && source !== st.shownSource);
    badge.title = source !== st.shownSource ? `Loading the ${SOURCE_LABEL[source]}…`
      : source === 'raw' ? 'Developing from the raw file' : 'Developing from the camera JPEG';
  }

  function paintSource() {
    const f = app.frame(st.key), source = st.opening ? null : st.params.source;
    if (!f) return;
    if (source) paintBadge(f, source);
    const why = [];
    for (const b of document.querySelectorAll('#sourceSeg [data-source]')) {
      const s = b.dataset.source, have = s === 'raw' ? f.raw : f.jpeg;
      b.setAttribute('aria-pressed', s === source);
      b.disabled = !have || !source;
      b.title = have ? `Develop from the ${s === 'raw' ? 'raw file' : 'camera JPEG'}`
        : s === 'raw' ? 'No raw file for this frame: it was shot JPEG only' : 'No camera JPEG for this frame: it was shot raw only';
      if (!have) why.push(b.title);
    }
    // A disabled button shows no tooltip in some browsers: say it on the row too.
    $('#sourceRow').title = why.join('');
    $('#sourceNote').hidden = !(st.legacy && source === 'jpeg');
  }

  for (const b of document.querySelectorAll('#sourceSeg [data-source]')) {
    b.addEventListener('click', () => { b.blur(); setSource(b.dataset.source); });
  }

  function step(dir) {
    const frames = stripFrames();
    const i = frames.findIndex(f => f.id === st.key);
    const next = frames[Math.max(0, Math.min(frames.length - 1, i + dir))];
    if (next) open(next.id);
  }

  // --- copy, paste, reset, export ------------------------------------------------

  function copy() {
    st.clipboard = { ...st.params };
    app.status('settings copied');
  }

  function paste() {
    if (!st.clipboard) return app.status('nothing copied yet');
    for (const [k, v] of Object.entries(st.clipboard)) if (!GEOMETRY.includes(k)) st.params[k] = v;
    paintSliders();
    commit();
    draw();
    app.status('settings pasted (crop kept)');
  }

  function resetAll() {
    // Settings go back to neutral; the source is a separate choice and stays.
    st.params = normalize({ source: st.params.source });
    syncSize();
    $('#aspect').value = 'free';
    paintSliders();
    commit();
    draw();
  }

  // Export each frame to its day's export/ folder. Resolves true if all went.
  async function exportFrames(ids) {
    await flush();
    const buttons = [$('#exportBtn'), $('#dSend')];
    buttons.forEach(b => (b.disabled = true));
    try {
      for (const [i, id] of ids.entries()) {
        const f = app.frame(id);
        const q = `shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`;
        app.status(`exporting ${f.key} (${i + 1}/${ids.length})…`, 0);
        const params = id === st.key ? st.params
          : (await fetch(`/api/edit?${q}`).then(r => r.json())).params;
        const source = id === st.key ? st.params.source : sourceOf(f, params);
        const img = await loadSource(app, f, source, { full: true });
        app.status(`exporting ${f.key} (${i + 1}/${ids.length})…`, 0);
        const blob = await renderJpeg(img, params);
        release(img);
        const res = await app.post(`/api/export?${q}`, blob);
        f.exported = true;
        if (ids.length === 1) app.status(`exported ${res.path}`, 4000);
      }
      if (ids.length > 1) app.status(`exported ${ids.length} frames, each to its day's export/ folder`, 4000);
      return true;
    } catch (e) {
      app.status(`export failed: ${e.message}`, 0);
      return false;
    } finally {
      buttons.forEach(b => (b.disabled = false));
    }
  }

  app.sortable($('#strip'), 'button', ids => app.reorderPost(ids));

  $('#copyBtn').addEventListener('click', e => { e.target.blur(); copy(); });
  $('#pasteBtn').addEventListener('click', e => { e.target.blur(); paste(); });
  $('#resetBtn').addEventListener('click', e => { e.target.blur(); resetAll(); });
  // Export and Send both act on what the scope picker says: the open photo,
  // or every edited one in the strip.
  async function scoped() {
    if ($('#exportScope').value === 'one') return st.key ? [st.key] : [];
    await flush();
    const keys = stripFrames().filter(f => f.edited).map(f => f.id);
    if (!keys.length) app.status('nothing edited in this strip yet');
    return keys;
  }
  $('#exportScope').addEventListener('change', e => e.target.blur());
  $('#exportBtn').addEventListener('click', async e => {
    e.target.blur();
    const ids = await scoped();
    if (ids.length) exportFrames(ids);
  });

  // Send: export, then Taildrop those exports to one of your devices.
  $('#dSend').addEventListener('click', async e => {
    e.target.blur();
    const ids = await scoped();
    const device = $('#dDevice').value;
    if (!ids.length || !(await exportFrames(ids))) return;
    try {
      app.status(device === '__reveal__' ? 'opening file manager…' : `sending to ${device}…`, 0);
      const frames = ids.map(id => app.frame(id)).map(f => ({ shoot: f.shoot, key: f.key }));
      const res = await app.post('/api/send', { frames, device });
      const what = res.sent.length === 1 ? res.sent[0] : `${res.sent.length} photos`;
      app.status(res.provider === 'reveal' ? `opened ${what} in the file manager` : `sent ${what} to ${device}: accept in Tailscale on the device`, 6000);
    } catch (err) {
      app.status(`couldn't send: ${err.message}`, 0);
    }
  });
  app.bindDevices($('#dDevice'), $('#dSendRow'));

  // --- keys --------------------------------------------------------------------

  addEventListener('keyup', e => {
    if (e.key === '\\' && st.before) { st.before = false; $('#badge').hidden = true; draw(); }
  });

  function onKey(e) {
    const k = e.key.toLowerCase();
    if (e.metaKey || e.ctrlKey) {
      if (k === 'z') {
        e.preventDefault();
        const from = e.shiftKey ? st.redo : st.undo, to = e.shiftKey ? st.undo : st.redo;
        if (!from.length) return;
        to.push(st.committed);
        restore(from.pop());
      } else if (k === ']' || k === '[') { e.preventDefault(); turn(k === ']' ? 'cw' : 'ccw'); }
      else if (k === 'c' && !getSelection().toString()) { e.preventDefault(); copy(); }
      else if (k === 'v') { e.preventDefault(); paste(); }
      return;
    }
    if (k === '\\') {
      if (!e.repeat) { st.before = true; $('#badge').hidden = false; draw(); }
    } else if ((k === 'arrowup' || k === 'arrowdown') && st.active) { e.preventDefault(); nudgeActive(k === 'arrowup' ? 1 : -1, e); }
    else if (k === 'arrowright' || k === 'j') { e.preventDefault(); step(1); }
    else if (k === 'arrowleft' || k === 'k') { e.preventDefault(); step(-1); }
    else if (k === 'r') setCropMode(!st.cropMode);
    else if (k === 'w') setPicking(!st.picking);
    else if (st.proposal && ['1', '2', '3'].includes(k)) showCompare(['original', 'yours', 'proposed'][+k - 1]);
    else if (k === 'o') cycleGrid();
    else if (k === 'x') toggleCrosshair();
    else if (k === 'c') toggleClip();
    else if (k === 'm' && e.shiftKey) toggleAllMasks();
    else if (k === 'm') { st.showMask = !st.showMask; paintMasks(); draw(); }
    else if (k === 'b' && mask()?.type === 'subject') setBrush(!st.brush.on);
    else if ((k === '[' || k === ']') && st.brush.on) setBrushSize(st.brush.size * (k === ']' ? 1.25 : 0.8));
    else if (k === 'escape' && st.brush.on) setBrush(false);
    else if (k === 'escape' && st.picking) setPicking(false);
    else if ((k === 'enter' || k === 'escape') && st.cropMode) setCropMode(false);
    else if (k === 'escape' && st.active) activate(null);
    else if (k === ' ' || k === 'p') { e.preventDefault(); if (st.key) app.togglePick(st.key); }
  }

  return {
    remoteChanged,
    proposalChanged,
    show(key) {
      const target = key || stripFrames()[0]?.id;
      if (!target) {
        $('#devEmpty').hidden = false;
        $('#wrap').hidden = true;
        return;
      }
      open(target);
    },
    reset() {
      st.key = null;
      st.W = 0;
      st.shownSource = null;
      $('#strip').innerHTML = '';
    },
    paintStrip() { if (st.key) paintStrip(); },
    stripIds: () => stripFrames().map(f => f.id),
    current: () => st.key,
    open: id => open(id),
    flush,
    onKey,
  };
}
