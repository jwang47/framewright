// Fullscreen: one photo at a time on black, with its edit, filling the screen.
// Browses whatever list it is opened with (the Library grid as filtered, or
// the Develop filmstrip); arrows move, space picks, S adds to the collection,
// Esc or ⇧F leaves. The preview shows at once and is replaced by a render
// from the full-size original once the frame settles.
//
// It can also show anything drawn onto a canvas (Post's slides): openDrawn()
// takes how many there are and a function that draws one at a given size.
import { Renderer } from './render.js';
import { sourceOf, loadSource, prefetch, release, REDO } from './source.js';

const $ = s => document.querySelector(s);

export function createFullscreen(app) {
  const layer = $('#fs'), view = $('#fsView'), drawn = $('#fsDrawn');
  const st = { list: [], at: 0, open: false, token: 0, renderer: null, params: null, hiT: null, capT: null, onClose: null, drawn: null };
  const count = () => (st.drawn ? st.drawn.count : st.list.length);

  const frame = () => app.frame(st.list[st.at]);
  // Render for the screen it will fill (the window can report 0 while hidden).
  const maxSize = () => Math.max(screen.width, screen.height, innerWidth, innerHeight) * (devicePixelRatio || 1);

  function fit() {
    const c = st.drawn ? drawn : view;
    if (!c.width || (!st.drawn && !st.renderer?.w)) return;
    const s = Math.min((innerWidth || screen.width) / c.width, (innerHeight || screen.height) / c.height);
    c.style.width = Math.floor(c.width * s) + 'px';
    c.style.height = Math.floor(c.height * s) + 'px';
  }

  function caption() {
    if (st.drawn) {
      const { name, meta } = st.drawn.caption(st.at);
      $('#fsName').textContent = name;
      $('#fsMeta').textContent = meta;
    } else {
      const f = frame();
      if (!f) return;
      $('#fsName').textContent = f.key;
      $('#fsMeta').textContent = `${app.shootDate(f.shoot)} · ${f.time}` +
        (f.picked ? ' · ★' : '') + (f.selected ? ` · #${f.selected} in ${app.targetName()}` : '');
    }
    $('#fsCount').textContent = `${st.at + 1} / ${count()}`;
    $('#fsHint').textContent = st.drawn ? 'H/L or ←/→ slides · Esc exit' : 'H/L or ←/→ photos · Space pick · S add · Esc exit';
    // The caption shows on arrival and fades; moving the mouse brings it back.
    layer.classList.add('show-ui');
    clearTimeout(st.capT);
    st.capT = setTimeout(() => layer.classList.remove('show-ui'), 1800);
  }

  async function showDrawn() {
    const token = ++st.token;
    caption();
    const c = await st.drawn.draw(st.at, maxSize());
    if (token !== st.token) return;
    drawn.width = c.width;
    drawn.height = c.height;
    drawn.getContext('2d').drawImage(c, 0, 0);
    fit();
  }

  async function show() {
    if (st.drawn) return showDrawn();
    const f = frame();
    if (!f) return;
    const token = ++st.token;
    caption();
    app.focusKey = f.id;
    const q = `shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`;
    const edit = await fetch(`/api/edit?${q}`).then(r => r.json());
    // The same file the edit was made on: the raw or the camera JPEG.
    const source = sourceOf(f, edit.params);
    const bmp = await loadSource(app, f, source, { stale: () => token !== st.token });
    if (!bmp || token !== st.token) return release(bmp);
    if (!st.renderer) st.renderer = new Renderer(view);
    st.params = edit.params;
    st.renderer.setImage(bmp);
    release(bmp);
    st.renderer.render(st.params, { maxSize: maxSize() });
    fit();
    // Settled on this frame: decode its neighbours, and redo it from the
    // original at screen resolution unless the half-size raw already covers
    // the screen (a 24MP+ raw usually does, and a full decode takes seconds).
    clearTimeout(st.hiT);
    st.hiT = setTimeout(async () => {
      const current = () => (st.open && !st.drawn ? st.list[st.at] : null);
      prefetch(app, st.list.map(id => app.frame(id)), st.at, current);
      const crop = st.params?.crop || { w: 1, h: 1 };
      if (bmp.linear && Math.max(bmp.width, bmp.height) * Math.min(crop.w, crop.h) >= maxSize()) return;
      const big = await loadSource(app, f, source, { full: true, quiet: true, priority: REDO, stale: () => token !== st.token })
        .catch(() => null);
      if (!big || token !== st.token) return release(big);
      st.renderer.setImage(big);
      release(big);
      st.renderer.render(st.params, { maxSize: maxSize() });
      fit();
    }, 350);
  }

  function step(dir) {
    const at = Math.max(0, Math.min(count() - 1, st.at + dir));
    if (at !== st.at) { st.at = at; show(); }
  }

  async function enter() {
    st.open = true;
    layer.hidden = false;
    view.hidden = !!st.drawn;
    drawn.hidden = !st.drawn;
    try { await document.documentElement.requestFullscreen?.(); } catch { /* the overlay still fills the window */ }
    show();
  }

  function open(list, id, onClose) {
    if (!list.length) return;
    Object.assign(st, { drawn: null, list, at: Math.max(0, list.indexOf(id)), onClose });
    return enter();
  }

  // opts: { count, at, draw(i, maxSize) -> canvas, caption(i) -> {name, meta}, onClose(i) }
  function openDrawn(opts) {
    if (!opts.count) return;
    Object.assign(st, { drawn: opts, list: [], at: Math.max(0, Math.min(opts.count - 1, opts.at || 0)), onClose: opts.onClose });
    return enter();
  }

  function close() {
    if (!st.open) return;
    st.open = false;
    st.token++;
    clearTimeout(st.hiT);
    layer.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    st.onClose?.(st.drawn ? st.at : st.list[st.at]);
  }

  // Leaving the browser's fullscreen (Esc) closes the view too.
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) close(); });
  addEventListener('resize', () => {
    if (!st.open) return;
    if (st.drawn) return fit();
    if (st.renderer?.w) { st.renderer.render(st.params, { maxSize: maxSize() }); fit(); }
  });
  layer.addEventListener('mousemove', () => caption());
  layer.addEventListener('click', e => {
    // Click the left or right third to go back or forward.
    const x = e.clientX / innerWidth;
    if (x < 1 / 3) step(-1); else if (x > 2 / 3) step(1);
  });

  return {
    get isOpen() { return st.open; },
    open,
    openDrawn,
    close,
    onKey(e) {
      const k = e.key.toLowerCase();
      if (k === 'escape' || (k === 'f' && e.shiftKey)) { e.preventDefault(); close(); }
      else if (k === 'arrowright' || k === 'arrowdown' || k === 'j' || k === 'l') { e.preventDefault(); step(1); }
      else if (k === 'arrowleft' || k === 'arrowup' || k === 'k' || k === 'h') { e.preventDefault(); step(-1); }
      else if (k === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); close(); app.setTab('post'); }
      else if (st.drawn) return;
      else if (k === ' ') { e.preventDefault(); app.togglePick(st.list[st.at]).then(caption); }
      else if (k === 's') { e.preventDefault(); app.toggleSelect(st.list[st.at]).then(caption); }
    },
  };
}
