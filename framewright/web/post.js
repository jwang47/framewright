// Post tab: lay a collection out as an Instagram carousel. Each slide is a
// layout (one photo, or a collage of up to four) whose cells hold photos,
// rendered with their edits and positioned by pan and zoom. The layout is
// saved on the collection; export writes numbered 1080-wide JPEGs.
import { Renderer, lutsReady } from './render.js';
import { sourceOf, loadSource, release } from './source.js';

const $ = s => document.querySelector(s);

const ASPECTS = { '4:5': 1350 / 1080, '1:1': 1, '1.91:1': 566 / 1080, '9:16': 1920 / 1080 };
// A story's top and bottom, in pixels of its 1920, sit under Instagram's own
// profile row and reply bar: shaded on screen so nothing important goes there.
const STORY_SAFE = { top: 250, bottom: 340 };
const WIDTH = 1080;

// Cells as [x, y, w, h] in the unit square.
// Layouts: cells as [x, y, w, h] in 0..1. Most have one main divider that
// can be dragged on the slide: `split` says along which axis ('x' or 'y') and
// where it starts, and cells(s) lays the cells out for the divider at s.
const rows = (x, y, w, h, n) => Array.from({ length: n }, (_, i) => [x, y + i * h / n, w, h / n]);
const cols = (x, y, w, h, n) => Array.from({ length: n }, (_, i) => [x + i * w / n, y, w / n, h]);
const LAYOUTS = {
  single: { label: 'Single', cells: () => [[0, 0, 1, 1]] },
  '2h': { label: 'Side by side', split: ['x', .5], cells: s => [[0, 0, s, 1], [s, 0, 1 - s, 1]] },
  '2v': { label: 'Stacked', split: ['y', .5], cells: s => [[0, 0, 1, s], [0, s, 1, 1 - s]] },
  '1+2': { label: 'Big + 2 below', split: ['y', .6], cells: s => [[0, 0, 1, s], ...cols(0, s, 1, 1 - s, 2)] },
  '1+3b': { label: 'Big + 3 below', split: ['y', .65], cells: s => [[0, 0, 1, s], ...cols(0, s, 1, 1 - s, 3)] },
  '2+1': { label: 'Big + 2 beside', split: ['x', .6], cells: s => [[0, 0, s, 1], ...rows(s, 0, 1 - s, 1, 2)] },
  '1+3': { label: 'Tall + 3 beside', split: ['x', .55], cells: s => [[0, 0, s, 1], ...rows(s, 0, 1 - s, 1, 3)] },
  '1+4': { label: 'Tall + 4 beside', split: ['x', .5], cells: s => [[0, 0, s, 1], ...rows(s, 0, 1 - s, 1, 4)] },
  '3+1': { label: '3 beside + tall', split: ['x', .45], cells: s => [...rows(0, 0, s, 1, 3), [s, 0, 1 - s, 1]] },
  '2x2': { label: 'Grid of 4', cells: () => [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
  '3h': { label: 'Three columns', cells: () => cols(0, 0, 1, 1, 3) },
  '3v': { label: 'Three rows', cells: () => rows(0, 0, 1, 1, 3) },
  '2x3': { label: 'Grid of 6', cells: () => [...cols(0, 0, 1, 1 / 3, 2), ...cols(0, 1 / 3, 1, 1 / 3, 2), ...cols(0, 2 / 3, 1, 1 / 3, 2)] },
};
const SPLIT_MIN = 0.15, SPLIT_MAX = 0.85;
const splitOf = slide => slide.split ?? LAYOUTS[slide.layout].split?.[1];
const layoutCells = slide => LAYOUTS[slide.layout].cells(splitOf(slide));

const cellOf = ref => ({ ref, x: 0, y: 0, zoom: 1, fit: 'cover' });

export function createPost(app) {
  const st = {
    col: null, name: '', items: [], post: null, sel: 0, cell: 0, dropOn: null,
    rev: null, saving: false,   // the collection's revision on the server; a save in flight
    saveT: null, photos: new Map(), params: new Map(), renderer: null, canvas: null,
  };
  const view = $('#slideView');

  // --- photos ------------------------------------------------------------------

  // {params, source}: the frame's edit and the file it develops from.
  async function editFor(ref) {
    if (!st.params.has(ref)) {
      const [shoot, key] = ref.split('/');
      const res = await fetch(`/api/edit?shoot=${encodeURIComponent(shoot)}&key=${key}`);
      const edit = res.ok ? await res.json() : { params: null };
      st.params.set(ref, { params: edit.params, source: sourceOf(edit, edit.params) });
    }
    return st.params.get(ref);
  }

  // A photo with its edit applied, as an ImageBitmap, cached per size. size is
  // the long side to render at; by default a working size (4000px for export).
  async function photo(ref, full = false, size = null) {
    const { params, source } = await editFor(ref);
    const max = size || (full ? 4000 : 1600);
    const k = `${ref}|${full}|${max}|${source}|${JSON.stringify(params)}`;
    if (!st.photos.has(k)) {
      st.photos.set(k, (async () => {
        if (!st.renderer) {
          st.canvas = document.createElement('canvas');
          st.renderer = new Renderer(st.canvas);
        }
        const [shoot, key] = ref.split('/');
        const img = await loadSource(app, { shoot, key }, source, { full });
        st.renderer.setImage(img);
        release(img);
        await lutsReady(params);
        st.renderer.render(params, { maxSize: max });
        return createImageBitmap(st.canvas);
      })());
      // Exact-size renders follow the window size; keep only the latest few.
      if (size) {
        const sized = [...st.photos.keys()].filter(key => !key.includes(`|${full ? 4000 : 1600}|`));
        // Dropped, not closed: a slide still being drawn may hold one.
        for (const old of sized.slice(0, Math.max(0, sized.length - 30))) st.photos.delete(old);
      }
    }
    return st.photos.get(k);
  }

  // --- geometry ----------------------------------------------------------------

  function slideSize(width = WIDTH) {
    return [width, Math.round(width * ASPECTS[st.post.aspect])];
  }

  // Cell rectangles in pixels: an outer margin when bordered, and a gap
  // between cells (half on each side that touches another cell).
  function cellRects(slide, W, H) {
    const scale = W / WIDTH, gap = st.post.gap * scale;
    const m = st.post.border ? gap : 0;
    const AW = W - 2 * m, AH = H - 2 * m;
    return layoutCells(slide).map(([x, y, w, h]) => {
      let rx = m + x * AW, ry = m + y * AH, rw = w * AW, rh = h * AH;
      if (x > 0) { rx += gap / 2; rw -= gap / 2; }
      if (x + w < 1) rw -= gap / 2;
      if (y > 0) { ry += gap / 2; rh -= gap / 2; }
      if (y + h < 1) rh -= gap / 2;
      return [rx, ry, rw, rh];
    });
  }

  // The area a photo fills in its cell: the whole cell, or for "square" the
  // largest centred square, with background around it (a square shot inside
  // a taller 4:5 post keeps the size it would have in a 1:1 post).
  function frameOf(cell, [cx, cy, cw, ch]) {
    if (cell.fit !== 'square') return [cx, cy, cw, ch];
    const s = Math.min(cw, ch);
    return [cx + (cw - s) / 2, cy + (ch - s) / 2, s, s];
  }

  // Where a photo lands in its frame: fill (cover, also used for square) or
  // whole (contain), zoomed, and panned from -1 (left/top edge) to 1.
  function placement(img, cell, rect) {
    const [cx, cy, cw, ch] = frameOf(cell, rect);
    const base = cell.fit === 'contain' ? Math.min(cw / img.width, ch / img.height) : Math.max(cw / img.width, ch / img.height);
    const s = base * cell.zoom, w = img.width * s, h = img.height * s;
    return [cx + (cw - w) * (cell.x + 1) / 2, cy + (ch - h) * (cell.y + 1) / 2, w, h];
  }

  async function drawSlide(ctx, slide, W, H, full = false) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = st.post.bg;
    ctx.fillRect(0, 0, W, H);
    const rects = cellRects(slide, W, H);
    for (const [i, rect] of rects.entries()) {
      const cell = slide.cells[i];
      if (!cell?.ref) {
        ctx.fillStyle = 'rgba(128,128,128,.25)';
        ctx.fillRect(...rect);
        continue;
      }
      const img = await photo(cell.ref, full);
      ctx.save();
      ctx.beginPath();
      ctx.rect(...frameOf(cell, rect));
      ctx.clip();
      // Rendered again at exactly the size it lands on the slide: the shader
      // averages every source pixel an output pixel covers, where shrinking a
      // big render on a canvas skips some and breaks thin lines into dashes.
      const at = placement(img, cell, rect);
      const size = Math.round(Math.max(img.width, img.height) * at[2] / img.width);
      ctx.drawImage(size < Math.max(img.width, img.height) ? await photo(cell.ref, full, size) : img, ...at);
      ctx.restore();
    }
    return rects;
  }

  // --- drawing -----------------------------------------------------------------

  let drawing = 0;
  async function draw() {
    if (!st.post) return;
    const token = ++drawing;
    const slide = st.post.slides[st.sel];
    const stage = $('#pstage');
    const [W, H] = slideSize();
    const fit = Math.min((stage.clientWidth - 40) / W, (stage.clientHeight - 40) / H);
    const dpr = devicePixelRatio || 1;
    view.width = Math.round(W * fit * dpr);
    view.height = Math.round(H * fit * dpr);
    view.style.width = Math.round(W * fit) + 'px';
    view.style.height = Math.round(H * fit) + 'px';
    if (!slide) return;
    const off = document.createElement('canvas');
    off.width = view.width; off.height = view.height;
    const rects = await drawSlide(off.getContext('2d'), slide, off.width, off.height);
    if (token !== drawing) return;
    const ctx = view.getContext('2d');
    ctx.drawImage(off, 0, 0);
    drawGuides(ctx, rects.map((r, i) => (slide.cells[i] ? frameOf(slide.cells[i], r) : r)), dpr);
    if (st.post.aspect === '9:16') drawStorySafe(ctx, view.width, view.height, dpr);
    // Outline the selected cell, and the one a dragged photo would land on.
    const r = rects[st.cell];
    if (r && rects.length > 1 && st.dropOn == null) {
      ctx.strokeStyle = '#ff5a8a';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeRect(r[0] + 1.5 * dpr, r[1] + 1.5 * dpr, r[2] - 3 * dpr, r[3] - 3 * dpr);
    }
    const t = st.dropOn != null && rects[st.dropOn];
    if (t) {
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(...t);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3 * dpr;
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.strokeRect(t[0] + 1.5 * dpr, t[1] + 1.5 * dpr, t[2] - 3 * dpr, t[3] - 3 * dpr);
      ctx.setLineDash([]);
    }
    st.rects = rects.map(([x, y, w, h]) => [x / dpr, y / dpr, w / dpr, h / dpr]);
  }

  // Shade the parts of a story Instagram covers (screen only, never exported).
  function drawStorySafe(ctx, W, H, dpr) {
    const top = H * STORY_SAFE.top / 1920, bottom = H * STORY_SAFE.bottom / 1920;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(0, 0, W, top);
    ctx.fillRect(0, H - bottom, W, bottom);
    ctx.strokeStyle = 'rgba(255,255,255,.6)';
    ctx.lineWidth = dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    for (const y of [top, H - bottom]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }

  // Grid and crosshair inside each tile (screen only, never exported). They
  // share Develop's settings: O cycles the grid, X toggles the crosshair.
  const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  function drawGuides(ctx, rects, dpr) {
    const grid = pref('studio.grid', 'off'), cross = pref('studio.crosshair', '0') === '1';
    if (grid === 'off' && !cross) return;
    ctx.save();
    for (const [x, y, w, h] of rects) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      const line = (x1, y1, x2, y2, alpha) => {
        for (const [c, off] of [[`rgba(0,0,0,${alpha * 0.5})`, dpr], [`rgba(255,255,255,${alpha})`, 0]]) {
          ctx.strokeStyle = c; ctx.lineWidth = dpr;
          ctx.beginPath(); ctx.moveTo(x1 + off, y1 + off); ctx.lineTo(x2 + off, y2 + off); ctx.stroke();
        }
      };
      const n = grid === 'fine' ? 12 : grid === 'thirds' ? 3 : 0;
      for (let i = 1; i < n; i++) {
        line(x + w * i / n, y, x + w * i / n, y + h, 0.45);
        line(x, y + h * i / n, x + w, y + h * i / n, 0.45);
      }
      if (cross) { line(x + w / 2, y, x + w / 2, y + h, 0.9); line(x, y + h / 2, x + w, y + h / 2, 0.9); }
      ctx.restore();
    }
    ctx.restore();
  }
  function cyclePref(k, values) {
    const cur = pref(k, values[0]);
    try { localStorage.setItem(k, values[(values.indexOf(cur) + 1) % values.length]); } catch { /* fine */ }
    paintGuideButtons();
    draw();
  }
  function paintGuideButtons() {
    const grid = pref('studio.grid', 'off');
    $('#pGrid').textContent = `Grid: ${grid}`;
    $('#pGrid').setAttribute('aria-pressed', grid !== 'off');
    $('#pCross').setAttribute('aria-pressed', pref('studio.crosshair', '0') === '1');
  }

  // Drawn offscreen and copied in only if no newer draw of the same slide
  // started meanwhile: overlapping draws used to leave a mix of old and new.
  const thumbDraws = new Map();
  async function drawThumb(i) {
    const c = document.querySelector(`#slides [data-id="${i}"] canvas`);
    if (!c) return;
    const token = (thumbDraws.get(c) || 0) + 1;
    thumbDraws.set(c, token);
    const [W, H] = slideSize(150);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    await drawSlide(off.getContext('2d'), st.post.slides[i], W, H);
    if (thumbDraws.get(c) !== token) return;
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(off, 0, 0);
  }

  function paintSlides() {
    const list = $('#slides');
    list.innerHTML = '';
    st.post.slides.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'slide' + (i === st.sel ? ' current' : '');
      b.dataset.id = String(i);
      b.draggable = true;
      b.innerHTML = `<span class="n">${i + 1}</span><canvas></canvas>`;
      b.addEventListener('click', () => { b.blur(); select(i); });
      list.appendChild(b);
      drawThumb(i);
    });
    const unused = st.items.filter(ref => !st.post.slides.some(s => s.cells.some(c => c.ref === ref)));
    $('#unused').hidden = !unused.length;
    $('#unusedList').innerHTML = unused.map(ref => `<button data-ref="${ref}" draggable="true" title="Click to add as a new slide, or drag onto a tile">${ref.split('/')[1]}</button>`).join('');
    $('#slideCount').textContent = `${st.post.slides.length} slide${st.post.slides.length === 1 ? '' : 's'}`;
  }

  function paintPanel() {
    const p = st.post, slide = p.slides[st.sel];
    $('#pAspect').value = p.aspect;
    $('#pGap').value = p.gap;
    $('#pGapOut').value = Math.round(p.gap);
    $('#pBorder').checked = p.border;
    $('#pBg').value = p.bg;
    $('#slideTitle').textContent = slide ? `Slide ${st.sel + 1}` : 'No slides';
    for (const b of document.querySelectorAll('#layouts button')) {
      b.setAttribute('aria-pressed', slide?.layout === b.dataset.layout);
    }
    const cells = $('#cells');
    cells.innerHTML = '';
    if (!slide) return;
    const options = st.items.map((ref, i) => `<option value="${ref}">${i + 1} · ${ref.split('/')[1]}</option>`).join('');
    slide.cells.forEach((cell, i) => {
      const row = document.createElement('div');
      row.className = 'cell-row' + (i === st.cell ? ' active' : '');
      row.innerHTML = `
        <span class="cn">${slide.cells.length > 1 ? i + 1 : ''}</span>
        <select aria-label="Photo in cell ${i + 1}"><option value="">(empty)</option>${options}</select>
        <button class="fit" title="Fill the tile, a square in the tile, or the whole photo">${{ cover: 'Fill', square: 'Square', contain: 'Whole' }[cell.fit] || 'Fill'}</button>
        <input type="range" min="1" max="4" step="0.01" value="${cell.zoom}" aria-label="Zoom">`;
      const sel = row.querySelector('select');
      sel.value = cell.ref || '';
      sel.addEventListener('change', () => {
        cell.ref = sel.value || null;
        Object.assign(cell, { x: 0, y: 0, zoom: 1 });
        sel.blur();
        paintSlides();               // the photo taken out (or put in) moves in or out of the unused list
        changed();
      });
      sel.addEventListener('focus', () => { st.cell = i; });
      row.querySelector('.fit').addEventListener('click', e => {
        e.target.blur();
        cell.fit = { cover: 'square', square: 'contain', contain: 'cover' }[cell.fit] || 'cover';
        Object.assign(cell, { x: 0, y: 0, zoom: 1 });
        changed();
      });
      const zoom = row.querySelector('input');
      zoom.addEventListener('input', () => { st.cell = i; cell.zoom = +zoom.value; changed(false); });
      zoom.addEventListener('change', () => { zoom.blur(); changed(); });
      row.addEventListener('pointerdown', () => { if (st.cell !== i) selectCell(i); });
      cells.appendChild(row);
    });
  }

  function paint() {
    paintSlides();
    paintPanel();
    draw();
  }

  // --- editing -------------------------------------------------------------------

  function selectCell(i) {
    st.cell = i;
    paintPanel();
    draw();
  }

  function select(i) {
    st.sel = Math.max(0, Math.min(st.post.slides.length - 1, i));
    st.cell = 0;
    paint();
  }

  function changed(repaintPanel = true) {
    if (repaintPanel) paintPanel();
    draw();
    drawThumb(st.sel);
    clearTimeout(st.saveT);
    st.saveT = setTimeout(save, 500);
  }

  // Each save names the revision it builds on. If the post or the
  // collection's photos changed elsewhere meanwhile, the server refuses and
  // sends the newer version, which is loaded in place.
  async function save() {
    clearTimeout(st.saveT);
    st.saveT = null;
    if (!st.col) return;
    const col = st.col;
    st.saving = true;
    try {
      const r = await fetch('/api/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: col, post: st.post, base: st.rev }),
      });
      const res = await r.json().catch(() => ({}));
      if (col !== st.col) return;
      if (r.status === 409) {
        adopt(res, 'post changed in another window: loaded that version');
        return;
      }
      if (!r.ok) throw new Error(res.error || r.status);
      st.rev = res.rev;
      app.status('post saved');
    } catch (e) {
      app.status(`couldn't save the post: ${e.message}`, 0);
    } finally {
      st.saving = false;
    }
  }
  async function flush() { if (st.saveT) await save(); }

  // Take up the collection's photos and post from the server, keeping the
  // selected slide where it can.
  function applyCollection(c) {
    st.items = c.items;
    st.rev = c.rev;
    st.post = c.post || {
      aspect: '4:5', gap: 12, border: false, bg: '#ffffff',
      slides: c.items.map(ref => ({ layout: 'single', cells: [cellOf(ref)] })),
    };
    // Photos taken out of the collection leave their cells empty.
    for (const s of st.post.slides) for (const cell of s.cells) if (cell.ref && !c.items.includes(cell.ref)) cell.ref = null;
  }

  function adopt(c, note) {
    applyCollection(c);
    st.sel = Math.max(0, Math.min(st.sel, st.post.slides.length - 1));
    const cells = st.post.slides[st.sel]?.cells.length || 0;
    if (st.cell >= cells) st.cell = cells ? 0 : -1;
    paint();
    app.status(note, 5000);
  }

  // The event stream says the collection changed on disk: another window, a
  // photo added to or taken out of it, or an edit to the file. Our own saves
  // echo back with st.rev and are skipped; a change of ours still pending
  // will meet the conflict when it saves.
  async function remoteChanged(rev) {
    if (!st.col || rev === st.rev || st.saveT || st.saving) return;
    const col = st.col;
    const res = await fetch(`/api/collection?slug=${encodeURIComponent(col)}`);
    if (!res.ok || col !== st.col) return;
    const c = await res.json();
    if (c.rev === st.rev || st.saveT || st.saving) return;
    adopt(c, 'post updated from elsewhere');
  }

  function setLayout(layout) {
    const slide = st.post.slides[st.sel];
    if (!slide) return;
    const n = LAYOUTS[layout].cells(LAYOUTS[layout].split?.[1]).length;
    const cells = slide.cells.filter(c => c.ref);
    // Photos that no longer fit move to their own slides right after, so none is lost.
    const spill = cells.slice(n).map(c => ({ layout: 'single', cells: [c] }));
    slide.layout = layout;
    delete slide.split;              // each layout starts from its own proportions
    slide.cells = [...cells.slice(0, n)];
    // Fill new cells with the photos from the following single slides.
    while (slide.cells.length < n) {
      const next = st.post.slides[st.sel + 1];
      if (next && next.layout === 'single' && next.cells[0]?.ref && !spill.length) {
        slide.cells.push({ ...next.cells[0], x: 0, y: 0, zoom: 1 });
        st.post.slides.splice(st.sel + 1, 1);
      } else {
        slide.cells.push(cellOf(null));
      }
    }
    st.post.slides.splice(st.sel + 1, 0, ...spill);
    st.cell = 0;
    paintSlides();
    changed();
  }

  function splitSlide() {
    const slide = st.post.slides[st.sel];
    if (!slide || slide.cells.length < 2) return;
    const singles = slide.cells.filter(c => c.ref).map(c => ({ layout: 'single', cells: [{ ...c, x: 0, y: 0, zoom: 1 }] }));
    st.post.slides.splice(st.sel, 1, ...(singles.length ? singles : [{ layout: 'single', cells: [cellOf(null)] }]));
    paintSlides();
    changed();
  }

  function addSlide(ref = null) {
    if (st.post.slides.length >= 20) return app.status('Instagram allows at most 20 slides');
    const at = ref ? st.post.slides.length : st.sel + 1;
    st.post.slides.splice(at, 0, { layout: 'single', cells: [cellOf(ref)] });
    st.sel = at;
    st.cell = 0;
    paintSlides();
    changed();
  }

  function deleteSlide() {
    if (!st.post.slides.length) return;
    st.post.slides.splice(st.sel, 1);
    st.sel = Math.max(0, Math.min(st.sel, st.post.slides.length - 1));
    paintSlides();
    changed();
  }

  // The main divider of the slide's layout, in view pixels: {axis, at, lo, hi}
  // with lo..hi the range it can be dragged over, or null for fixed layouts.
  function divider(slide) {
    const split = LAYOUTS[slide.layout].split;
    if (!split) return null;
    const r = view.getBoundingClientRect(), axis = split[0];
    const size = axis === 'x' ? r.width : r.height;
    const m = st.post.border ? st.post.gap * r.width / WIDTH : 0;
    const span = size - 2 * m;
    return { axis, m, span, at: m + splitOf(slide) * span, lo: m + SPLIT_MIN * span, hi: m + SPLIT_MAX * span };
  }
  function nearDivider(slide, x, y) {
    const d = divider(slide);
    if (!d) return null;
    const grab = Math.max(6, st.post.gap * view.getBoundingClientRect().width / WIDTH / 2 + 4);
    return Math.abs((d.axis === 'x' ? x : y) - d.at) <= grab ? d : null;
  }
  const cellAt = (x, y) => (st.rects || []).findIndex(([cx, cy, cw, ch]) => x >= cx && x <= cx + cw && y >= cy && y <= cy + ch);

  // Drag inside a cell pans its photo; drag it out onto another tile and let
  // go to swap the two. Drag the layout's main divider to resize. Ctrl or
  // pinch-wheel zooms.
  let pan = null, resize = null;
  view.addEventListener('pointerdown', async e => {
    const slide = st.post?.slides[st.sel];
    if (!slide || !st.rects) return;
    const r = view.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const d = nearDivider(slide, x, y);
    if (d) {
      try { view.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      resize = { slide, d };
      return;
    }
    const i = cellAt(x, y);
    if (i < 0) { selectCell(-1); return; }          // the gap or border: nothing selected
    const wasSelected = i === st.cell;
    if (!wasSelected) selectCell(i);
    const cell = slide.cells[i];
    // Take the press now, so a quick click is never missed; how far the
    // photo can pan is filled in once it is loaded.
    try { view.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const press = pan = { x: e.clientX, y: e.clientY, from: i, cell, x0: cell?.x, y0: cell?.y, spanX: 0, spanY: 0, wasSelected, moved: false };
    if (!cell?.ref) return;
    const img = await photo(cell.ref);
    const frame = frameOf(cell, st.rects[i]);
    const [, , w, h] = placement(img, cell, st.rects[i]);
    Object.assign(press, { spanX: frame[2] - w, spanY: frame[3] - h });
  });
  view.addEventListener('pointermove', e => {
    const r = view.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const slide = st.post?.slides[st.sel];
    if (resize) {
      const { d } = resize;
      const at = Math.max(d.lo, Math.min(d.hi, d.axis === 'x' ? x : y));
      resize.slide.split = Math.round((at - d.m) / d.span * 1000) / 1000;
      draw();
      return;
    }
    if (!pan) {
      const d = slide && nearDivider(slide, x, y);
      view.style.cursor = d ? (d.axis === 'x' ? 'col-resize' : 'row-resize') : '';
      return;
    }
    const { cell } = pan;
    if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 3) pan.moved = true;
    if (!cell?.ref) return;
    // Over another tile: this is a move, not a pan. The photo goes back to
    // where it was and the tile it would swap with is outlined.
    const over = cellAt(x, y);
    const target = over >= 0 && over !== pan.from ? over : null;
    if (target !== st.dropOn) {
      st.dropOn = target;
      view.style.cursor = target === null ? '' : 'grabbing';
    }
    if (target !== null) {
      cell.x = pan.x0; cell.y = pan.y0;
      draw();
      return;
    }
    // Moving the pointer right moves the photo right: pan runs over the slack between cell and photo.
    if (Math.abs(pan.spanX) > 1) cell.x = Math.max(-1, Math.min(1, pan.x0 + 2 * (e.clientX - pan.x) / pan.spanX));
    if (Math.abs(pan.spanY) > 1) cell.y = Math.max(-1, Math.min(1, pan.y0 + 2 * (e.clientY - pan.y) / pan.spanY));
    draw();
  });
  const endPan = () => {
    if (resize) {
      resize = null;
      changed(false);
      return;
    }
    if (!pan) return;
    const { moved, wasSelected, from } = pan;
    pan = null;
    const to = st.dropOn;
    st.dropOn = null;
    view.style.cursor = '';
    if (to !== null && to !== undefined) {
      swapCells(from, to);
      return;
    }
    if (moved) changed(false);
    else if (wasSelected) selectCell(-1);           // clicking the selected tile again lets go of it
  };

  // Swap two tiles' photos, each keeping its own pan, zoom and fit.
  function swapCells(a, b) {
    const cells = st.post.slides[st.sel].cells;
    [cells[a], cells[b]] = [cells[b], cells[a]];
    st.cell = b;
    changed();
  }

  // Photos not in the post can be dragged straight onto a tile.
  $('#unusedList').addEventListener('dragstart', e => {
    const ref = e.target.dataset?.ref;
    if (ref) e.dataTransfer.setData('text/x-studio-ref', ref);
  });
  view.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-studio-ref')) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const i = cellAt(e.clientX - r.left, e.clientY - r.top);
    if ((i >= 0 ? i : null) !== st.dropOn) { st.dropOn = i >= 0 ? i : null; draw(); }
  });
  view.addEventListener('dragleave', () => { if (st.dropOn !== null) { st.dropOn = null; draw(); } });
  view.addEventListener('drop', e => {
    const ref = e.dataTransfer.getData('text/x-studio-ref');
    const i = st.dropOn;
    st.dropOn = null;
    if (!ref || i === null || i === undefined) return draw();
    e.preventDefault();
    const cell = st.post.slides[st.sel].cells[i];
    Object.assign(cell, { ref, x: 0, y: 0, zoom: 1 });
    st.cell = i;
    paintSlides();
    changed();
  });
  view.addEventListener('pointerup', endPan);
  view.addEventListener('pointercancel', endPan);
  view.addEventListener('wheel', e => {
    const cell = st.post?.slides[st.sel]?.cells[st.cell];
    if (!e.ctrlKey || !cell?.ref) return;
    e.preventDefault();
    cell.zoom = Math.max(1, Math.min(4, cell.zoom * Math.exp(-e.deltaY / 200)));
    changed(false);
  }, { passive: false });

  // --- export --------------------------------------------------------------------

  // Every slide, or with `only` just that one (0-based); a single slide
  // replaces its own file and leaves the rest of the export alone.
  async function exportSlides(only = null) {
    if (!st.post.slides.length) return false;
    await (st.saveT && save());
    const buttons = [$('#pExport'), $('#pSend')];
    buttons.forEach(b => (b.disabled = true));
    const [W, H] = slideSize();
    const n = st.post.slides.length;
    const which = only === null ? st.post.slides.map((_, i) => i) : [only];
    try {
      for (const i of which) {
        app.status(only === null ? `exporting slide ${i + 1}/${n}…` : `exporting slide ${i + 1}…`, 0);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        await drawSlide(c.getContext('2d'), st.post.slides[i], W, H, true);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
        const single = only === null ? '' : '&single=1';
        await app.post(`/api/post-export?collection=${encodeURIComponent(st.col)}&n=${i + 1}&of=${n}${single}`, blob);
      }
      app.status(only === null ? `exported ${n} slides to shoots/posts/${st.col}/`
        : `exported slide ${only + 1} to shoots/posts/${st.col}/${String(only + 1).padStart(2, '0')}.jpg`, 5000);
      return true;
    } catch (e) {
      app.status(`export failed: ${e.message}`, 0);
      return false;
    } finally {
      buttons.forEach(b => (b.disabled = false));
      // Full-size photos are big; keep only the screen-size ones cached.
      for (const k of [...st.photos.keys()]) if (k.includes('|true|')) st.photos.delete(k);
    }
  }

  // --- background swatches from the photos -----------------------------------------

  // Quiet background tones taken from the collection itself: the light
  // neutral surfaces (concrete, stone, walls) at three lightnesses, a dark tone
  // from the shadows, plus plain white and black.
  function srgbToLab([r, g, b]) {
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B),
      Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  }
  function labToHex([L, a, b]) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
    const [X, Y, Z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
    const rgb = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z]
      .map(v => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))));
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const median = xs => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };

  async function makeSwatches() {
    const light = [], dark = [];
    const c = document.createElement('canvas'); c.width = c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const ref of st.items) {
      ctx.drawImage(await photo(ref), 0, 0, 48, 48);
      const d = ctx.getImageData(0, 0, 48, 48).data;
      for (let i = 0; i < d.length; i += 4) {
        const lab = srgbToLab([d[i], d[i + 1], d[i + 2]]), chroma = Math.hypot(lab[1], lab[2]);
        if (chroma < 14 && lab[0] > 55) light.push(lab);
        else if (chroma < 14 && lab[0] > 6 && lab[0] < 28) dark.push(lab);
      }
    }
    const tone = (set, L, k) => labToHex([L, median(set.map(p => p[1])) * k, median(set.map(p => p[2])) * k]);
    // Light tones keep the photos' hue but gentler, so they read as off-white, not beige.
    return [
      light.length && { name: 'Paper', hex: tone(light, 96, 0.45) },
      light.length && { name: 'Concrete', hex: tone(light, 91, 0.6) },
      light.length && { name: 'Stone', hex: tone(light, 84, 0.75) },
      dark.length && { name: 'Charcoal', hex: tone(dark, 14, 0.8) },
      { name: 'White', hex: '#ffffff' },
      { name: 'Black', hex: '#000000' },
    ].filter(Boolean);
  }

  function paintSwatches(list) {
    const box = $('#swatches');
    box.innerHTML = list.map(s => `<button data-hex="${s.hex}" title="${s.name} ${s.hex}" aria-label="${s.name} background"
      aria-pressed="${s.hex === st.post.bg}"><span style="background:${s.hex}"></span>${s.name}</button>`).join('');
  }
  $('#swatches').addEventListener('click', e => {
    const b = e.target.closest('button[data-hex]');
    if (!b) return;
    b.blur();
    st.post.bg = b.dataset.hex;
    for (const x of document.querySelectorAll('#swatches button')) x.setAttribute('aria-pressed', x === b);
    paintSlides();
    changed();
  });

  // --- wiring --------------------------------------------------------------------

  $('#layouts').innerHTML = Object.entries(LAYOUTS).map(([k, l]) => {
    const rects = l.cells(l.split?.[1]).map(([x, y, w, h]) =>
      `<rect x="${x * 24 + 1}" y="${y * 30 + 1}" width="${w * 24 - 2}" height="${h * 30 - 2}" rx="1"/>`).join('');
    return `<button data-layout="${k}" title="${l.label}" aria-label="${l.label}"><svg viewBox="0 0 24 30" width="20" height="25">${rects}</svg></button>`;
  }).join('');
  for (const b of document.querySelectorAll('#layouts button')) {
    b.addEventListener('click', () => { b.blur(); setLayout(b.dataset.layout); });
  }
  $('#pAspect').addEventListener('change', e => { e.target.blur(); st.post.aspect = e.target.value; paintSlides(); changed(); });
  $('#pGap').addEventListener('input', e => { st.post.gap = +e.target.value; $('#pGapOut').value = Math.round(st.post.gap); paintSlides(); changed(false); });
  $('#pGap').addEventListener('change', e => e.target.blur());
  $('#pBorder').addEventListener('change', e => { e.target.blur(); st.post.border = e.target.checked; paintSlides(); changed(); });
  $('#pBg').addEventListener('input', e => {
    st.post.bg = e.target.value;
    for (const x of document.querySelectorAll('#swatches button')) x.setAttribute('aria-pressed', x.dataset.hex === st.post.bg);
    paintSlides();
    changed(false);
  });
  $('#pAdd').addEventListener('click', e => { e.target.blur(); addSlide(); });
  $('#pDelete').addEventListener('click', e => { e.target.blur(); deleteSlide(); });
  $('#pSplit').addEventListener('click', e => { e.target.blur(); splitSlide(); });
  // Export and Send both act on what the scope picker says: every slide, or
  // just the selected one.
  const scoped = () => ($('#pScope').value === 'one' ? st.sel : null);
  $('#pScope').addEventListener('change', e => e.target.blur());
  $('#pExport').addEventListener('click', e => { e.target.blur(); exportSlides(scoped()); });

  // Taildrop: export, then send the numbered slides to one of your devices.
  async function send(only = null) {
    const device = $('#pDevice').value;
    try {
      if (!(await exportSlides(only))) return;
      app.status(device === '__reveal__' ? 'opening file manager…' : `sending to ${device}…`, 0);
      const body = { collection: st.col, device, ...(only === null ? {} : { slide: only + 1 }) };
      const res = await app.post('/api/send', body);
      const what = only === null ? `${res.sent.length} slides` : `slide ${only + 1}`;
      app.status(res.provider === 'reveal' ? `opened ${what} in the file manager` : `sent ${what} to ${device}: accept in Tailscale on the device`, 6000);
    } catch (err) {
      app.status(`couldn't send: ${err.message}`, 0);
    }
  }
  $('#pSend').addEventListener('click', e => { e.target.blur(); send(scoped()); });
  app.bindDevices($('#pDevice'), $('#sendRow'));
  $('#pGrid').addEventListener('click', e => { e.target.blur(); cyclePref('studio.grid', ['off', 'thirds', 'fine']); });
  $('#pCross').addEventListener('click', e => { e.target.blur(); cyclePref('studio.crosshair', ['0', '1']); });
  paintGuideButtons();
  $('#pReset').addEventListener('click', e => {
    e.target.blur();
    if (!confirm('Go back to one photo per slide, in collection order? Your layouts will be lost.')) return;
    st.post = { ...st.post, slides: st.items.map(ref => ({ layout: 'single', cells: [cellOf(ref)] })) };
    select(0);
    changed();
  });
  $('#unusedList').addEventListener('click', e => {
    const ref = e.target.dataset?.ref;
    if (ref) { e.target.blur(); addSlide(ref); }
  });
  app.sortable($('#slides'), '.slide', ids => {
    const order = ids.map(Number);
    const current = st.post.slides[st.sel];
    st.post.slides = order.map(i => st.post.slides[i]);
    st.sel = st.post.slides.indexOf(current);
    paintSlides();
    changed();
  });
  new ResizeObserver(() => st.post && draw()).observe($('#pstage'));

  // Fullscreen: the slides as they'll look, at screen size.
  function fullscreen() {
    if (!st.post?.slides.length) return;
    app.fullscreen.openDrawn({
      count: st.post.slides.length,
      at: st.sel,
      draw: async (i, max) => {
        const aspect = ASPECTS[st.post.aspect];
        const W = Math.round(Math.min(max, max / aspect)), H = Math.round(W * aspect);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        await drawSlide(c.getContext('2d'), st.post.slides[i], W, H);
        return c;
      },
      caption: i => ({
        name: `Slide ${i + 1}`,
        meta: `${st.name} · ${LAYOUTS[st.post.slides[i].layout].label}`,
      }),
      onClose: i => select(i),
    });
  }
  $('#postFs').addEventListener('click', e => { e.currentTarget.blur(); fullscreen(); });

  return {
    fullscreen,
    flush,
    remoteChanged,
    async show() {
      const empty = $('#postEmpty');
      if (!app.target) {
        empty.hidden = false;
        empty.textContent = 'Pick a collection in "Add to" (or open one) to lay out its post.';
        $('#postBody').hidden = true;
        return;
      }
      const res = await fetch(`/api/collection?slug=${encodeURIComponent(app.target)}`);
      if (!res.ok) return;
      const c = await res.json();
      await flush();       // a pending save of the last collection goes to that one
      if (st.col !== app.target) { st.sel = 0; st.cell = 0; }
      st.col = app.target;
      st.name = c.name;
      st.params.clear();   // edits may have changed since last time
      applyCollection(c);
      app.watchPost?.(st.col);
      $('#postName').textContent = c.name;
      empty.hidden = !!c.items.length;
      empty.textContent = 'This collection is empty: add photos to it with S in the Library.';
      $('#postBody').hidden = !c.items.length;
      if (c.items.length) select(Math.min(st.sel, st.post.slides.length - 1));
      if (c.items.length) {
        const col = st.col;
        makeSwatches().then(list => { if (st.col === col) paintSwatches(list); });
      }
    },
    onKey(e) {
      const k = e.key.toLowerCase();
      if (k === 'escape') return selectCell(-1);
      if (k === 'o') return cyclePref('studio.grid', ['off', 'thirds', 'fine']);
      if (k === 'x') return cyclePref('studio.crosshair', ['0', '1']);
      if (k === 'arrowdown' || k === 'arrowright' || k === 'j') { e.preventDefault(); select(st.sel + 1); }
      else if (k === 'arrowup' || k === 'arrowleft' || k === 'k') { e.preventDefault(); select(st.sel - 1); }
    },
  };
}
