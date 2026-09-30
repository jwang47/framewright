// Shell and Library tab. Develop lives in develop.js and gets this app object.
//
// A view is one shoot or one collection. Frames are named "<shoot>/<key>"
// throughout, so a collection can hold frames from any days.
//
// The target collection is where S adds photos. Numbers on thumbnails are a
// photo's place in the target, and the "in order" view and drag-to-reorder
// work on the target. Opening a collection makes it the target.
import { createDevelop } from './develop.js';
import { createPost } from './post.js';
import { createFullscreen } from './fullscreen.js';
import { createSync } from './sync.js';
import { Renderer, loadBitmap, lutsReady } from './render.js';
import { sourceOf, loadSource, prefetch, release, paintSourceTag, SOURCE_LABEL } from './source.js';

const $ = s => document.querySelector(s);

function stored(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window: fine */ }
}

function shootDate(shoot) {
  return shoot.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}
function dayLabel(shoot) {
  if (!shootDate(shoot)) return shoot;
  const [y, m, d] = shootDate(shoot).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export const app = {
  shootDate,
  view: null,          // {kind: 'shoot'|'collection', id, name, days}
  frames: [],          // [{id, shoot, key, time, picked, edited, exported, selected}]
  collections: [],     // [{name, slug, days, shoots, items}] from /api/shoots
  target: null,        // slug of the target collection, or null
  focusKey: null,      // a frame id
  chosen: new Set(),   // frame ids ⌘/⇧-clicked in the library, for Sync; the focus is one of them
  tab: 'library',

  frame(id) { return this.frames.find(f => f.id === id); },
  src(kind, f) { return `/${kind}/${encodeURIComponent(f.shoot)}/${f.key}.jpg`; },
  isCollection() { return this.view?.kind === 'collection'; },
  targetName() { return this.collections.find(c => c.slug === this.target)?.name || ''; },

  status(msg, ms = 1500) {
    $('#status').textContent = msg;
    clearTimeout(this._statusT);
    if (ms) this._statusT = setTimeout(() => ($('#status').textContent = ''), ms);
  },

  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': body instanceof Blob ? 'image/jpeg' : 'application/json' },
      body: body instanceof Blob ? body : JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  },

  syncUrl() {
    const q = new URLSearchParams({ tab: this.tab });
    if (this.view) q.set('view', `${this.view.kind}:${this.view.id}`);
    if (this.focusKey) q.set('frame', this.focusKey);
    history.replaceState(null, '', '?' + q);
  },

  updateCounts() {
    $('#count').textContent = this.frames.filter(f => f.picked).length;
    $('#total').textContent = this.frames.length;
    const n = this.frames.filter(f => f.selected).length;
    $('#postCount').hidden = !this.target;
    $('#postN').textContent = n;
    $('#postName').textContent = this.targetName();
  },

  setTab(tab) {
    this.tab = tab;
    for (const b of document.querySelectorAll('.tabs button')) {
      b.setAttribute('aria-selected', b.dataset.tab === tab);
    }
    $('#library').hidden = tab !== 'library';
    $('#develop').hidden = tab !== 'develop';
    $('#post').hidden = tab !== 'post';
    if (tab === 'post') {
      post.show();
    } else if (tab === 'library') {
      library.render();
      // After layout, so the selected thumbnail is scrolled into view.
      requestAnimationFrame(() => library.setFocus(this.focusKey));
    } else {
      develop.show(this.focusKey);
    }
    this.syncUrl();
  },

  async togglePick(id) {
    const f = this.frame(id);
    f.picked = !f.picked;
    library.paint(id);
    develop.paintStrip();
    this.updateCounts();
    try {
      await this.post('/api/pick', { shoot: f.shoot, key: f.key, picked: f.picked });
      this.status(f.picked ? `picked ${f.key}` : `unpicked ${f.key}`);
    } catch (e) {
      f.picked = !f.picked;
      library.paint(id);
      this.updateCounts();
      this.status('save failed — is the server running?', 0);
    }
  },

  // Add to or take out of the target collection. New photos go last.
  async toggleSelect(id) {
    if (!this.target) return this.status('make a collection first: New collection', 3000);
    const f = this.frame(id), name = this.targetName();
    try {
      const res = await this.post('/api/select', {
        collection: this.target, shoot: f.shoot, key: f.key, selected: !f.selected,
      });
      this.applySelects(res.selects);
      this.status(f.selected ? `added ${f.key} to ${name} as #${f.selected}` : `removed ${f.key} from ${name}`);
    } catch (e) {
      this.status(`save failed: ${e.message}`, 0);
    }
  },

  // Number every frame by its place in the post set (0 = not in it).
  applySelects(selects) {
    const order = new Map(selects.map((ref, i) => [ref, i + 1]));
    for (const g of this.frames) {
      const was = g.selected;
      g.selected = order.get(g.id) || 0;
      if (g.selected !== was) library.paint(g.id);
    }
    this.updateCounts();
    develop.paintStrip();
    if (library.filter() === 'post') {
      library.render();
      library.setFocus(this.focusKey, false);
    }
  },

  // New carousel order, from a drag or a nudge. Shown at once, then saved.
  async reorderPost(ids) {
    const before = this.frames.filter(f => f.selected).sort((a, b) => a.selected - b.selected).map(f => f.id);
    if (ids.join() === before.join()) return;
    this.applySelects(ids);
    try {
      await this.post('/api/reorder', { collection: this.target, selects: ids });
      this.status('post order saved');
    } catch (e) {
      this.applySelects(before);
      this.status(`reorder failed: ${e.message}`, 0);
    }
  },

  // Drag-to-reorder for any container of [data-id] items that are draggable.
  sortable(container, itemSelector, onOrder) {
    let dragId = null;
    const clear = () => container.querySelectorAll('.drop-before, .drop-after, .dragging')
      .forEach(el => el.classList.remove('drop-before', 'drop-after', 'dragging'));
    container.addEventListener('dragstart', e => {
      const item = e.target.closest?.(itemSelector);
      if (!item?.draggable) return;
      dragId = item.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      item.classList.add('dragging');
    });
    container.addEventListener('dragover', e => {
      if (!dragId) return;
      e.preventDefault();
      const item = e.target.closest?.(itemSelector);
      container.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
      if (!item?.draggable || item.dataset.id === dragId) return;
      const r = item.getBoundingClientRect();
      item.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    });
    container.addEventListener('drop', e => {
      if (!dragId) return;
      e.preventDefault();
      const target = container.querySelector('.drop-before, .drop-after');
      if (target) {
        const ids = [...container.querySelectorAll(itemSelector)].filter(el => el.draggable).map(el => el.dataset.id);
        ids.splice(ids.indexOf(dragId), 1);
        const at = ids.indexOf(target.dataset.id) + (target.classList.contains('drop-after') ? 1 : 0);
        ids.splice(at, 0, dragId);
        onOrder(ids);
      }
      dragId = null;
      clear();
    });
    container.addEventListener('dragend', () => { dragId = null; clear(); });
  },
};

// --- library: zoomable grid plus a large preview of the selected frame ---------

const library = {
  // 'all', 'picks', or 'post' (the target collection's photos here, in its order)
  filter: () => $('#filter').value,

  shown() {
    const f = this.filter();
    if (f === 'picks') return app.frames.filter(x => x.picked);
    if (f === 'post') return app.frames.filter(x => x.selected).sort((a, b) => a.selected - b.selected);
    return app.frames;
  },

  render() {
    const list = $('#list');
    list.innerHTML = '';
    const frames = this.shown();
    const byDay = app.isCollection() && !!app.view.days && this.filter() !== 'post';
    let day = null;
    for (const f of frames) {
      if (byDay && f.shoot !== day) {
        day = f.shoot;
        const n = frames.filter(x => x.shoot === day).length;
        const h = document.createElement('h2');
        h.className = 'day';
        h.innerHTML = `${dayLabel(day)} <span>${day} · ${n}</span>`;
        list.appendChild(h);
      }
      const fig = document.createElement('figure');
      fig.id = 'f-' + f.id;
      fig.dataset.id = f.id;
      fig.draggable = this.filter() === 'post';
      fig.innerHTML = `
        <div class="frame">
          <img loading="lazy" decoding="async" draggable="false" alt="${f.key}" data-thumb="${f.id}" src="${app.src('thumb', f)}">
          <button class="star" aria-label="Pick ${f.key}"></button>
          <span class="sel"></span>
          <span class="src"></span>
          <span class="prop" title="A proposed edit is waiting: open in Develop to compare">proposal</span>
          <span class="dot"></span>
        </div>
        <figcaption><span class="name">${f.key}</span><span>${f.time}</span></figcaption>`;
      fig.querySelector('.frame').addEventListener('click', e => this.click(f.id, e));
      fig.querySelector('.frame').addEventListener('dblclick', () => {
        app.focusKey = f.id;
        app.setTab('develop');
      });
      fig.querySelector('.star').addEventListener('click', e => {
        e.stopPropagation();
        this.setFocus(f.id, false);
        app.togglePick(f.id);
      });
      list.appendChild(fig);
      this.paint(f.id);
      if (f.params) thumbs.apply(f);
    }
    if (!frames.length) {
      const msg = { picks: 'Nothing picked yet.', post: 'Nothing in the post yet — press S on a photo to add it.' };
      list.innerHTML = `<p class="empty">${msg[this.filter()] || 'No frames.'}</p>`;
    }
    // Only frames on screen stay chosen, so Sync never reaches a hidden one.
    const shown = new Set(frames.map(f => f.id));
    for (const x of app.chosen) if (!shown.has(x)) app.chosen.delete(x);
    this.paintChosen();
    app.updateCounts();
  },

  paint(id) {
    const f = app.frame(id);
    if (!f) return;
    const fig = document.getElementById('f-' + id);
    if (fig) {
      fig.classList.toggle('picked', f.picked);
      fig.classList.toggle('focus', id === app.focusKey);
      fig.classList.toggle('chosen', app.chosen.has(id));
      fig.querySelector('.star').textContent = f.picked ? '★' : '☆';
      fig.querySelector('.dot').hidden = !f.edited;
      fig.querySelector('.prop').hidden = !f.proposed;
      const sel = fig.querySelector('.sel');
      sel.hidden = !f.selected;
      sel.textContent = f.selected || '';
      paintSourceTag(fig.querySelector('.src'), f, sourceOf(f, f.params));
    }
    if (id === app.focusKey) {
      $('#loupeName').textContent = f.key;
      $('#loupeTime').textContent = app.isCollection() ? `${dayLabel(f.shoot)} ${f.time}` : f.time;
      const source = sourceOf(f, f.params);
      $('#loupeTag').innerHTML = [
        f.raw && `<span class="src-tag ${source}">${f.edited ? 'edited from' : 'from'} ${SOURCE_LABEL[source]}</span>`,
        f.edited && !f.raw && 'edited', f.exported && 'exported', f.proposed && 'proposal waiting',
      ].filter(Boolean).join(' · ');
      $('#loupePick').textContent = f.picked ? '★ Picked' : '☆ Pick';
      $('#loupePick').setAttribute('aria-pressed', f.picked);
      $('#loupeSel').hidden = !app.target;
      $('#loupeSel').textContent = f.selected ? `In ${app.targetName()} #${f.selected}` : `Add to ${app.targetName()}`;
      $('#loupeSel').setAttribute('aria-pressed', !!f.selected);
    }
  },

  visible() { return [...document.querySelectorAll('#list figure')].map(el => el.dataset.id); },

  // Plain click: just this frame, or, inside a choice of several, make it the
  // focus without losing the others. ⌘/ctrl-click: add or drop a frame.
  // ⇧-click: add every frame from the focus to it. The focus is Sync's source,
  // so adding frames leaves it where it is.
  click(id, e) {
    if (e.metaKey || e.ctrlKey) {
      if (!app.chosen.size && app.focusKey) app.chosen.add(app.focusKey);
      if (app.chosen.has(id)) app.chosen.delete(id); else app.chosen.add(id);
      this.paint(id);
      if (id === app.focusKey && !app.chosen.has(id)) this.setFocus([...app.chosen].at(-1) || id, false);
    } else if (app.chosen.size > 1 && app.chosen.has(id)) {
      this.setFocus(id, false);
    } else if (e.shiftKey && app.focusKey) {
      const vis = this.visible(), a = vis.indexOf(app.focusKey), b = vis.indexOf(id);
      if (a >= 0 && b >= 0) for (const x of vis.slice(Math.min(a, b), Math.max(a, b) + 1)) app.chosen.add(x);
      vis.forEach(x => app.chosen.has(x) && this.paint(x));
    } else {
      this.choose([]);
      this.setFocus(id, false);
    }
    this.paintChosen();
  },

  choose(ids) {
    const old = [...app.chosen];
    app.chosen = new Set(ids);
    for (const x of old) this.paint(x);
    for (const x of ids) this.paint(x);
    this.paintChosen();
  },

  paintChosen() {
    const n = app.chosen.size, b = $('#loupeSync');
    b.hidden = n < 2;
    b.textContent = `Sync settings to ${n}…`;
    $('#chosenN').hidden = n < 2;
    $('#chosenN').textContent = `${n} chosen · Esc to clear`;
  },

  setFocus(id, scroll = true) {
    const prev = app.focusKey;
    app.focusKey = id;
    if (prev) this.paint(prev);
    if (!id) return;
    this.paint(id);
    const fig = document.getElementById('f-' + id);
    if (fig && scroll) fig.scrollIntoView({ block: 'nearest' });
    loupe.show(id);
    app.syncUrl();
  },

  // Frames per grid row, so up/down move by a whole row.
  columns() {
    const list = $('#list'), fig = list.querySelector('figure');
    if (!fig) return 1;
    const cs = getComputedStyle(list);
    const inner = list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    return Math.max(1, Math.round((inner + gap) / (fig.offsetWidth + gap)));
  },

  move(dir) {
    if (app.chosen.size) this.choose([]);
    const vis = this.visible();
    if (!vis.length) return;
    let i = vis.indexOf(app.focusKey);
    i = i < 0 ? 0 : Math.max(0, Math.min(vis.length - 1, i + dir));
    this.setFocus(vis[i]);
  },

  zoom(px) {
    const z = $('#zoom');
    px = Math.max(+z.min, Math.min(+z.max, px));
    z.value = px;
    $('#list').style.setProperty('--thumb', px + 'px');
    $('#list').classList.toggle('small', px < 110);
    store('studio.thumb', px);
    if (app.focusKey) document.getElementById('f-' + app.focusKey)?.scrollIntoView({ block: 'nearest' });
  },
};

// Thumbnails of edited frames are rendered here through the develop shader, so
// the grid and the filmstrip show the edit, not the camera JPEG. One offscreen
// renderer works through a queue; results are cached per frame and edit, and a
// frame is redrawn whenever its edit is saved.
const thumbs = {
  renderer: null, canvas: null, done: new Map(), queue: [], busy: false,

  key(f) { return JSON.stringify(f.params); },

  show(f, url) {
    for (const img of document.querySelectorAll('img[data-thumb]')) {
      if (img.dataset.thumb === f.id) img.src = url;
    }
  },

  apply(f) {
    if (!f.params) {
      const old = this.done.get(f.id);
      if (old) { URL.revokeObjectURL(old.url); this.done.delete(f.id); }
      return this.show(f, app.src('thumb', f));
    }
    const hit = this.done.get(f.id);
    if (hit && hit.key === this.key(f)) return this.show(f, hit.url);
    if (!this.queue.includes(f)) this.queue.push(f);
    this.pump();
  },

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const f = this.queue.shift(), key = this.key(f);
      try {
        const url = await this.render(f);
        const old = this.done.get(f.id);
        if (old) URL.revokeObjectURL(old.url);
        this.done.set(f.id, { key, url });
        this.show(f, url);
      } catch { /* keep the camera thumbnail */ }
      await new Promise(r => setTimeout(r));   // let the page breathe between frames
    }
    this.busy = false;
  },

  async render(f) {
    if (!this.renderer) {
      this.canvas = document.createElement('canvas');
      this.renderer = new Renderer(this.canvas);
    }
    // An edit on the raw is drawn from a half-size decode; this queue already
    // takes one frame at a time, which is all a decode should have.
    const img = sourceOf(f, f.params) === 'raw' ? await loadSource(app, f, 'raw', { quiet: true, keep: false })
      : await loadBitmap(app.src('thumb', f));
    this.renderer.setImage(img);
    release(img);
    await lutsReady(f.params);
    this.renderer.render(f.params, { maxSize: 480 });
    const blob = await new Promise(r => this.canvas.toBlob(r, 'image/jpeg', 0.85));
    return URL.createObjectURL(blob);
  },
};
app.thumbs = thumbs;

// The preview renders through the develop shader, so it shows each frame's edit.
const loupe = {
  renderer: null, params: null, token: 0, timer: null,

  show(id) {
    // Holding an arrow key flies through frames; only load where it settles.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(id), 60);
  },

  async load(id) {
    const f = app.frame(id);
    if ($('#loupe').hidden || !f) return;
    const token = ++this.token, stale = () => token !== this.token;
    try {
      const edit = await fetch(`/api/edit?shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`).then(r => r.json());
      if (stale()) return;
      // From the file Develop would open, so the preview matches it.
      const img = await loadSource(app, f, sourceOf(f, edit.params), { stale });
      if (!img || stale()) return release(img);
      if (!this.renderer) this.renderer = new Renderer($('#loupeView'));
      this.renderer.setImage(img);
      release(img);
      this.params = edit.params;
      this.draw();
      const ids = library.visible();
      prefetch(app, ids.map(i => app.frame(i)), ids.indexOf(id), () => app.focusKey);
    } catch (e) {
      app.status(`preview failed: ${e.message}`, 0);
    }
  },

  draw() {
    if (!this.renderer || !this.renderer.w) return;
    const stage = $('#loupeStage');
    const view = $('#loupeView');
    this.renderer.render(this.params, {
      maxSize: Math.max(stage.clientWidth, stage.clientHeight) * (devicePixelRatio || 1),
    });
    const s = Math.min((stage.clientWidth - 32) / view.width, (stage.clientHeight - 32) / view.height);
    view.style.width = Math.floor(view.width * s) + 'px';
    view.style.height = Math.floor(view.height * s) + 'px';
  },
};
new ResizeObserver(() => loupe.draw()).observe($('#loupeStage'));

function setLoupe(on) {
  $('#loupeBtn').setAttribute('aria-pressed', on);
  $('#loupe').hidden = !on;
  $('.lib').classList.toggle('with-loupe', on);
  store('studio.loupe', on ? '1' : '0');
  if (on && app.focusKey) loupe.load(app.focusKey);
  if (app.focusKey) document.getElementById('f-' + app.focusKey)?.scrollIntoView({ block: 'nearest' });
}

function setFilter(value) {
  const sel = $('#filter');
  sel.value = [...sel.options].some(o => o.value === value && !o.hidden) ? value : 'all';
  library.render();
  const vis = library.visible();
  library.setFocus(vis.includes(app.focusKey) ? app.focusKey : vis[0] || null);
}

app.sortable($('#list'), 'figure', ids => app.reorderPost(ids));

// Keyboard reorder in the post view: [ and ] move the selected photo.
function nudgePost(dir) {
  const ids = app.frames.filter(f => f.selected).sort((a, b) => a.selected - b.selected).map(f => f.id);
  const i = ids.indexOf(app.focusKey), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  app.reorderPost(ids);
}

$('#filter').addEventListener('change', e => { e.target.blur(); setFilter(e.target.value); });
$('#zoom').addEventListener('input', e => library.zoom(+e.target.value));
$('#zoom').addEventListener('change', e => e.target.blur());
$('#loupeBtn').addEventListener('click', e => {
  e.currentTarget.blur();
  setLoupe($('#loupeBtn').getAttribute('aria-pressed') !== 'true');
});
$('#loupePick').addEventListener('click', e => { e.target.blur(); if (app.focusKey) app.togglePick(app.focusKey); });
$('#loupeSel').addEventListener('click', e => { e.target.blur(); if (app.focusKey) app.toggleSelect(app.focusKey); });
$('#loupeSync').addEventListener('click', e => { e.target.blur(); sync.open(); });
$('#loupeDev').addEventListener('click', e => { e.target.blur(); if (app.focusKey) app.setTab('develop'); });
$('#loupeView').addEventListener('click', () => app.focusKey && app.setTab('develop'));

library.zoom(+stored('studio.thumb', 120));
setLoupe(stored('studio.loupe', '1') === '1');

// --- shell -------------------------------------------------------------------

// Taildrop devices, shared by Develop and Post: one list, one remembered
// choice, and picking a device in either tab picks it in both.
const deviceSelects = [];
let devicesLoaded = null;
app.bindDevices = async (select, row) => {
  deviceSelects.push(select);
  devicesLoaded ||= fetch('/api/devices').then(r => r.json()).catch(() => ({ devices: [] }));
  const devices = [...((await devicesLoaded).devices || []), { name: '__reveal__', label: 'File manager' }];
  row.hidden = false;
  const saved = stored('studio.device', '');
  const phone = devices.find(d => /iphone|pixel|android|phone/i.test(d.name));
  select.replaceChildren(...devices.map(d => new Option(d.label || d.name, d.name)));
  select.value = devices.some(d => d.name === saved) ? saved : (phone || devices[0]).name;
  select.addEventListener('change', () => {
    select.blur();
    store('studio.device', select.value);
    for (const s of deviceSelects) s.value = select.value;
  });
};

const develop = createDevelop(app);
const post = createPost(app);
const fullscreen = createFullscreen(app);
const sync = createSync(app, {
  onSaved(f, params) {
    f.edited = params !== null;
    f.params = params;
    thumbs.apply(f);
    library.paint(f.id);
  },
});
app.fullscreen = fullscreen;

// Fullscreen browses what you were browsing: the Library grid as filtered, or
// the Develop filmstrip; closing lands you on the last photo shown.
function openFullscreen() {
  if (app.tab === 'library' && app.focusKey) {
    fullscreen.open(library.visible(), app.focusKey, id => library.setFocus(id));
  } else if (app.tab === 'develop' && develop.current()) {
    fullscreen.open(develop.stripIds(), develop.current(), id => develop.open(id));
  } else if (app.tab === 'post') {
    post.fullscreen();
  }
}
$('#loupeFs').addEventListener('click', e => { e.currentTarget.blur(); openFullscreen(); });
$('#devFs').addEventListener('click', e => { e.currentTarget.blur(); openFullscreen(); });

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { b.blur(); app.setTab(b.dataset.tab); });
}

addEventListener('keydown', e => {
  if (fullscreen.isOpen) return fullscreen.onKey(e);
  if (e.target.matches?.('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (e.key.toLowerCase() === 'f' && e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return openFullscreen(); }
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if (app.tab === 'develop') develop.onKey(e);
    else if (app.tab === 'library' && !e.altKey) libraryShortcut(e);
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'g' && app.tab !== 'library') return app.setTab('library');
  if ((k === 'd' || k === 'enter') && app.tab === 'library') {
    if (app.focusKey) app.setTab('develop');
    return;
  }
  if (k === 's' && app.focusKey && app.tab !== 'post') return app.toggleSelect(app.focusKey);
  if (app.tab === 'develop') return develop.onKey(e);
  if (app.tab === 'post') return post.onKey(e);

  if (k === 'arrowright' || k === 'j') { e.preventDefault(); library.move(1); }
  else if (k === 'arrowleft' || k === 'k') { e.preventDefault(); library.move(-1); }
  else if (k === 'arrowdown') { e.preventDefault(); library.move(library.columns()); }
  else if (k === 'arrowup') { e.preventDefault(); library.move(-library.columns()); }
  else if (k === ' ' || k === 'p') { e.preventDefault(); if (app.focusKey) app.togglePick(app.focusKey); }
  else if (k === 'f') setFilter(library.filter() === 'picks' ? 'all' : 'picks');
  else if ((k === '[' || k === ']') && library.filter() === 'post') nudgePost(k === ']' ? 1 : -1);
  else if (k === 'o' && app.target) setFilter(library.filter() === 'post' ? 'picks' : 'post');
  else if (k === 'e') $('#loupeBtn').click();
  else if (k === 'escape' && app.chosen.size) library.choose([]);
  else if (k === '=' || k === '+') library.zoom(+$('#zoom').value + 30);
  else if (k === '-' || k === '_') library.zoom(+$('#zoom').value - 30);
});

// ⌘A chooses every frame shown, ⌘⇧S syncs settings to them, ⌘Z undoes a sync.
function libraryShortcut(e) {
  const k = e.key.toLowerCase();
  if (k === 'a') {
    e.preventDefault();
    library.choose(library.visible());
    if (!app.chosen.has(app.focusKey)) library.setFocus(library.visible()[0], false);
  } else if (k === 's' && e.shiftKey) {
    e.preventDefault();
    sync.open();
  } else if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    sync.undoLast().then(did => did || app.status('nothing to undo here', 1500));
  }
}

// Pinch or ctrl-scroll over the grid zooms the thumbnails instead of the page.
$('#list').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  library.zoom(+$('#zoom').value - e.deltaY);
}, { passive: false });

// Number every frame here by its place in the target collection.
async function loadTarget() {
  if (!app.target) return app.applySelects([]);
  const res = await fetch(`/api/collection?slug=${encodeURIComponent(app.target)}`);
  app.applySelects(res.ok ? (await res.json()).items : []);
}

function setTarget(slug) {
  app.target = app.collections.some(c => c.slug === slug) ? slug : null;
  store('studio.target', app.target || '');
  $('#target').value = app.target || '';
  const post = $('#filter').querySelector('[value=post]');
  post.hidden = !app.target;
  post.textContent = app.target ? `In ${app.targetName()}, in order (O)` : '';
  if (!app.target && $('#filter').value === 'post') $('#filter').value = 'all';
  $('#renameCol').disabled = $('#deleteCol').disabled = !app.target;
}

async function loadView(value, tab, frame) {
  let [kind, id] = value.split(/:(.*)/s);
  if (kind === 'trip') kind = 'collection';          // links from before collections
  const q = kind === 'collection' ? `collection=${encodeURIComponent(id)}` : `shoot=${encodeURIComponent(id)}`;
  const data = await (await fetch('/api/frames?' + q)).json();
  app.view = { kind, id, name: data.name || id, days: data.days || null };
  app.frames = data.frames.map(f => ({ ...f, id: `${f.shoot}/${f.key}`, selected: 0 }));
  app.chosen = new Set();
  app.focusKey = app.frame(frame) ? frame : (app.frames[0] || {}).id || null;
  if (kind === 'collection') setTarget(id);
  // A collection with days is where day picks get narrowed down: start on them.
  const start = kind === 'collection' && app.view.days && app.frames.some(f => f.picked) ? 'picks' : 'all';
  $('#filter').value = start;
  if (!frame && start === 'picks') app.focusKey = app.frames.find(f => f.picked)?.id ?? app.focusKey;
  develop.reset();
  app.updateCounts();
  app.setTab(['develop', 'post'].includes(tab) ? tab : 'library');
  await loadTarget();
}

// Rebuild the view menu and the target menu from the server.
async function refreshMenus(keepView) {
  const { shoots, collections } = await (await fetch('/api/shoots')).json();
  app.collections = collections;
  const sel = $('#shoot');
  const colOpts = collections.map(c => {
    // Two cameras on one day are two shoot folders, so count dates, not folders.
    const days = new Set(c.shoots.map(shootDate)).size;
    const what = c.days ? `${days} days` : `${c.items} photos`;
    return `<option value="collection:${c.slug}">${c.name} (${what})</option>`;
  }).join('');
  const shootOpts = shoots.map(s => `<option value="shoot:${s}">${s}</option>`).join('');
  sel.innerHTML = (collections.length ? `<optgroup label="Collections">${colOpts}</optgroup>` : '') +
    `<optgroup label="Days">${shootOpts}</optgroup>`;
  if (keepView && [...sel.options].some(o => o.value === keepView)) sel.value = keepView;
  $('#target').innerHTML = '<option value="">No collection</option>' +
    collections.map(c => `<option value="${c.slug}">${c.name}</option>`).join('');
  return shoots;
}

async function newCollection() {
  const name = prompt('Name for the new collection:');
  if (!name) return;
  const range = prompt('Include whole days too? Enter a date range like 2026-09-21..2026-09-25, or leave empty for a hand-picked collection.', '');
  const body = { name };
  if (range && range.trim()) {
    const [from, to] = range.split(/\s*(?:\.\.|to|–|-(?=\d{4}))\s*/).map(x => x.trim());
    Object.assign(body, { from, to: to || from });
  }
  try {
    const res = await app.post('/api/collections/create', body);
    await refreshMenus(`${app.view.kind}:${app.view.id}`);
    setTarget(res.slug);
    await loadTarget();
    app.status(`made ${name}; S adds photos to it`, 3000);
  } catch (e) {
    app.status(`couldn't make it: ${e.message}`, 0);
  }
}

async function renameCollection() {
  if (!app.target) return;
  const name = prompt('New name:', app.targetName());
  if (!name || name === app.targetName()) return;
  try {
    const res = await app.post('/api/collections/rename', { collection: app.target, name });
    const viewing = app.isCollection() && app.view.id === app.target;
    if (viewing) app.view = { ...app.view, id: res.slug, name };
    await refreshMenus(`${app.view.kind}:${app.view.id}`);
    setTarget(res.slug);
    app.syncUrl();
    app.updateCounts();
  } catch (e) {
    app.status(`couldn't rename: ${e.message}`, 0);
  }
}

async function deleteCollection() {
  if (!app.target) return;
  const name = app.targetName();
  if (!confirm(`Delete the collection "${name}"? The photos and their edits stay; only the collection goes.`)) return;
  try {
    await app.post('/api/collections/delete', { collection: app.target });
    const viewing = app.isCollection() && app.view.id === app.target;
    const shoots = await refreshMenus(`${app.view.kind}:${app.view.id}`);
    setTarget(null);
    if (viewing) {
      $('#shoot').value = `shoot:${shoots[0]}`;
      await loadView($('#shoot').value, app.tab);
    } else {
      await loadTarget();
    }
    app.status(`deleted ${name}`);
  } catch (e) {
    app.status(`couldn't delete: ${e.message}`, 0);
  }
}

$('#target').addEventListener('change', e => { e.target.blur(); setTarget(e.target.value); loadTarget(); });
$('#newCol').addEventListener('click', e => { e.currentTarget.blur(); newCollection(); });
$('#renameCol').addEventListener('click', e => { e.currentTarget.blur(); renameCollection(); });
$('#deleteCol').addEventListener('click', e => { e.currentTarget.blur(); deleteCollection(); });

// --- find a photo --------------------------------------------------------------
//
// Any part of a file name or a day ("322", "L1030322", "09-22"); picking a
// result opens that photo in its day, in Library (or Develop if that is open).
(function search() {
  const input = $('#search'), box = $('#searchResults');
  let results = [], hl = 0, timer = null, token = 0;

  function paint() {
    box.hidden = !input.value.trim() || document.activeElement !== input;
    if (box.hidden) return;
    if (!results.length) { box.innerHTML = '<div class="none">No photos match.</div>'; return; }
    box.innerHTML = results.map((r, i) => `
      <button role="option" class="${i === hl ? 'hl' : ''}" data-i="${i}">
        <img loading="lazy" alt="" src="/thumb/${encodeURIComponent(r.shoot)}/${r.key}.jpg">
        <span><span class="k">${r.key}</span><br><span class="d">${r.shoot}</span></span>
        <span class="e">${r.edited ? 'edited' : ''}</span>
      </button>`).join('');
    box.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    const q = input.value.trim(), mine = ++token;
    if (!q) { results = []; return paint(); }
    const res = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
    if (mine !== token) return;
    results = res.results;
    hl = 0;
    paint();
  }

  async function pick(r) {
    if (!r) return;
    input.blur();
    box.hidden = true;
    const view = `shoot:${r.shoot}`;
    $('#shoot').value = view;
    await loadView(view, app.tab === 'develop' ? 'develop' : 'library', `${r.shoot}/${r.key}`);
    app.status(`${r.key} · ${r.shoot}`);
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', () => setTimeout(paint, 150));   // let a click on a result land first
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hl = Math.max(0, Math.min(results.length - 1, hl + (e.key === 'ArrowDown' ? 1 : -1)));
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[hl]);
    } else if (e.key === 'Escape') {
      input.blur();
    }
  });
  box.addEventListener('mousedown', e => {
    const b = e.target.closest('button[data-i]');
    if (b) { e.preventDefault(); pick(results[+b.dataset.i]); }
  });
  addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.matches?.('input, select, textarea')) { e.preventDefault(); input.focus(); input.select(); }
  });
})();

// --- import from a camera card -------------------------------------------------
//
// The header grows an Import button while a card is plugged in, labelled with
// how many frames on it are new. The dialog shows where they will land, copies
// them with the same verified copy as import_photos.py, then opens the day.
(function cardImport() {
  const btn = $('#importBtn'), dlg = $('#importDlg'), go = $('#importGo');
  let card = null, groups = [], running = false, deleteInitialized = false;

  const frames = gs => gs.reduce((n, g) => n + g.frames, 0);
  const mb = x => x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${Math.round(x)} MB`;

  function label() {
    const n = frames(groups);
    btn.textContent = n ? `Import ${n} new` : 'Card: nothing new';
    btn.title = `${card}: import new photos`;
  }

  async function loadPlan() {
    const jpeg = $('#importJpeg').checked ? '&jpeg=1' : '';
    const res = await (await fetch('/api/card?plan=1' + jpeg)).json();
    if (!res.card) return false;
    card = res.card;
    if (!deleteInitialized) {
      $('#importDelete').checked = res.deleteFromCard === true;
      deleteInitialized = true;
    }
    groups = res.groups || [];
    $('#importCard').textContent = card;
    $('#importEject').hidden = !res.eject;
    $('#importPlan').innerHTML = res.error ? `<p class="none">${res.error}</p>`
      : !groups.length ? '<p class="none">Everything on this card is already in the library.</p>'
      : `<table>${groups.map(g => `<tr><td>${g.shoot}${g.kind === 'video' ? ' · video' : ''}</td>
          <td>${g.frames} ${g.kind === 'video' ? 'clips' : 'frames'}</td><td>${mb(g.mb)}</td></tr>`).join('')}</table>
        <p class="none">Images go to ${res.to}.</p>`;
    go.disabled = running || !groups.length;
    go.textContent = groups.length ? `Import ${frames(groups)}` : 'Import';
    if (!running) label();
    return true;
  }

  // Cheap presence check; the plan is only read when a card appears.
  async function poll() {
    if (document.hidden || running) return;
    const res = await (await fetch('/api/card')).json().catch(() => ({}));
    if (res.card === card) return;
    card = res.card || null;
    btn.hidden = !card;
    if (card) await loadPlan();
    else if (dlg.open) dlg.close();
  }

  async function watch() {
    let st;
    do {
      await new Promise(r => setTimeout(r, 400));
      st = await (await fetch('/api/import')).json();
      const pct = st.bytes_total ? st.bytes / st.bytes_total : 0;
      $('#importBar').value = pct;
      $('#importNow').textContent = st.current ? `${st.copied}/${st.total} · ${st.current}` : '';
      btn.textContent = `Importing ${Math.round(pct * 100)}%`;
    } while (st.running);
    return st;
  }

  async function run() {
    running = true;
    go.disabled = $('#importJpeg').disabled = $('#importDelete').disabled = true;
    $('#importProgress').hidden = false;
    try {
      await app.post('/api/import', { jpegOnly: $('#importJpeg').checked, deleteFromCard: $('#importDelete').checked });
      const st = await watch();
      if (st.error) throw new Error(st.error);
      $('#importNow').textContent = `imported ${st.copied} files, verified${st.deleted ? ` · ${st.deleted} source files deleted` : ''}`;
      app.status(`imported ${frames(st.groups)} from ${st.card}`, 5000);
      // Open the newest day that got stills, so the new frames are on screen.
      const shoots = await refreshMenus(`${app.view?.kind}:${app.view?.id}`);
      const day = st.groups.filter(g => g.kind === 'raw').map(g => g.shoot).sort((a, b) => shootDate(a).localeCompare(shootDate(b)) || a.localeCompare(b)).pop();
      if (day && shoots.includes(day)) {
        $('#shoot').value = `shoot:${day}`;
        await loadView(`shoot:${day}`, 'library');
      }
    } catch (e) {
      $('#importNow').textContent = `import stopped: ${e.message}`;
      app.status(`import failed: ${e.message}`, 0);
    } finally {
      running = false;
      $('#importJpeg').disabled = $('#importDelete').disabled = false;
      await loadPlan().catch(() => {});
    }
  }

  btn.addEventListener('click', async () => {
    btn.blur();
    $('#importProgress').hidden = !running;
    dlg.showModal();
    if (!running) await loadPlan();
  });
  $('#importJpeg').addEventListener('change', loadPlan);
  go.addEventListener('click', run);
  $('#importClose').addEventListener('click', () => dlg.close());
  $('#importEject').addEventListener('click', async () => {
    try {
      const res = await app.post('/api/eject', {});
      dlg.close();
      card = null;
      btn.hidden = true;
      app.status(`ejected ${res.ejected}; safe to pull the card`, 5000);
    } catch (e) {
      app.status(`couldn't eject: ${e.message}`, 0);
    }
  });
  poll();
  setInterval(poll, 3000);
  document.addEventListener('visibilitychange', poll);
})();

// --- offload to the external drive -----------------------------------------------
//
// While the drive (store.py) is plugged in, the header shows an Offload
// button. The dialog lists the shoots with photos still here, all ticked;
// the server moves them one verified file at a time, as --offload does.
(function driveOffload() {
  const btn = $('#offloadBtn'), dlg = $('#offloadDlg'), go = $('#offloadGo');
  let drive = null, shoots = [], running = false, busy = false;   // busy: this window's run
  const mb = x => x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${Math.round(x)} MB`;
  const ticked = () => [...dlg.querySelectorAll('#offloadPlan input:checked')].map(i => i.value);
  const here = () => (app.view?.kind === 'shoot' ? app.view.id : null);

  function paintTotal() {
    const pick = new Set(ticked());
    const chosen = shoots.filter(s => pick.has(s.shoot));
    const total = chosen.reduce((n, s) => n + s.mb, 0);
    const foot = $('#offloadTotal');
    if (foot) foot.textContent = `${chosen.reduce((n, s) => n + s.files, 0)} files · ${mb(total)}`;
    go.disabled = running || !chosen.length;
    go.textContent = chosen.length ? `Offload ${mb(total)}` : 'Offload';
  }

  async function loadPlan() {
    const res = await (await fetch('/api/offload?plan=1')).json();
    $('#offloadDrive').textContent = res.drive;
    shoots = res.shoots || [];
    $('#offloadPlan').innerHTML = !res.mounted ? `<p class="none">${res.drive} is not plugged in.</p>`
      : res.error ? `<p class="none">${res.error}</p>`
      : !shoots.length ? `<p class="none">Every shoot's photos are already on ${res.drive}.</p>`
      : `<table><tbody>${shoots.map(s => `<tr><td><label><input type="checkbox" value="${s.shoot}" checked> ${s.shoot}</label></td>
          <td>${s.files} files</td><td>${mb(s.mb)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td colspan="2" id="offloadTotal"></td></tr></tfoot></table>`;
    $('#offloadThis').hidden = running || !shoots.some(s => s.shoot === here());
    paintTotal();
  }

  function label(st) {
    const pct = st.bytes_total ? st.bytes / st.bytes_total : 0;
    btn.textContent = st.running ? `Offloading ${Math.round(pct * 100)}%` : `Offload to ${drive}`;
  }

  async function poll() {
    if (document.hidden || running || busy) return;
    const res = await (await fetch('/api/offload')).json().catch(() => ({}));
    drive = res.drive;
    btn.hidden = !res.configured || (!res.mounted && !res.state?.running);
    btn.title = `Move photos to ${drive}, keeping picks, edits and previews here`;
    if (res.state?.running) watch();   // one started in another window
    else label(res.state || {});
    if (!res.mounted && dlg.open && !running) loadPlan();
  }

  async function watch() {
    if (running) return null;
    running = true;
    let st;
    try {
      do {
        await new Promise(r => setTimeout(r, 400));
        st = (await (await fetch('/api/offload')).json()).state;
        $('#offloadBar').value = st.bytes_total ? st.bytes / st.bytes_total : 0;
        $('#offloadNow').textContent = !st.current ? ''
          : st.phase === 'previews' ? `making previews · ${st.current}`
          : `${st.moved}/${st.total} · ${st.current}`;
        label(st);
      } while (st.running);
    } finally {
      running = false;
    }
    return st;
  }

  async function run() {
    const chosen = ticked();
    busy = true;
    go.disabled = true;
    $('#offloadThis').hidden = true;
    for (const i of dlg.querySelectorAll('#offloadPlan input')) i.disabled = true;
    $('#offloadProgress').hidden = false;
    $('#offloadBar').value = 0;
    $('#offloadNow').textContent = 'starting…';
    try {
      await app.post('/api/offload', { shoots: chosen });
      const st = await watch();
      if (st?.error) throw new Error(st.error);
      $('#offloadNow').textContent = `moved ${st.moved} files to ${drive}, verified`;
      app.status(`offloaded ${chosen.length} shoot${chosen.length > 1 ? 's' : ''} to ${drive}`, 5000);
    } catch (e) {
      $('#offloadNow').textContent = `offload stopped: ${e.message}`;
      app.status(`offload failed: ${e.message}`, 0);
    } finally {
      busy = false;
      label({});
      await loadPlan().catch(() => {});
    }
  }

  btn.addEventListener('click', async () => {
    btn.blur();
    $('#offloadProgress').hidden = !running;
    dlg.showModal();
    if (!running) await loadPlan();
  });
  $('#offloadPlan').addEventListener('change', paintTotal);
  $('#offloadThis').addEventListener('click', () => {
    for (const i of dlg.querySelectorAll('#offloadPlan input')) i.checked = i.value === here();
    paintTotal();
  });
  go.addEventListener('click', run);
  $('#offloadClose').addEventListener('click', () => dlg.close());
  poll();
  setInterval(poll, 3000);
  document.addEventListener('visibilitychange', poll);
})();

async function start() {
  const q = new URLSearchParams(location.search);
  let want = q.get('view') || (q.get('shoot') ? `shoot:${q.get('shoot')}` : null);
  if (want?.startsWith('trip:')) want = 'collection:' + want.slice(5);
  const shoots = await refreshMenus(want);
  const sel = $('#shoot');
  setTarget(stored('studio.target', ''));
  sel.addEventListener('change', () => { sel.blur(); loadView(sel.value, app.tab); });
  if (sel.value) loadView(sel.value, q.get('tab'), q.get('frame'));
  else if (!shoots.length) {
    app.setTab('library');
    $('#list').innerHTML = '<p class="empty">Your library is empty. Connect a camera card to import photos, or add shoot folders to your library.</p>';
  }
}

// --- hot reload ----------------------------------------------------------------
//
// The server streams a hello with its boot id, then a change event when the
// page code changes, and edit and proposal events when the recipe or the
// proposal of the frame being developed changes on disk, and post events when
// the photos or layout of the collection whose post is open change (the
// stream reconnects to watch each new frame or collection). CSS is swapped in place; anything else reloads, after
// saving a pending edit. A new boot id means the server restarted with new
// code, so the page reloads to match it. The URL keeps the view and frame.
(function hotReload() {
  let boot = null, reloading = false, es = null, watch = '';
  const watching = { edit: '', post: '' };
  const reload = async () => {
    if (reloading) return;
    reloading = true;
    try { await Promise.all([develop.flush(), post.flush()]); } catch { /* reload anyway */ }
    location.reload();
  };
  function connect() {
    es?.close();
    es = new EventSource('/api/events' + (watch ? `?${watch}` : ''));
    es.addEventListener('hello', e => {
      if (boot && e.data !== boot) reload();
      boot = e.data;
    });
    es.addEventListener('change', e => {
      if (e.data !== 'css') return reload();
      for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
        const url = new URL(link.href);
        url.searchParams.set('v', Date.now());
        link.href = url;
      }
    });
    es.addEventListener('edit', e => develop.remoteChanged(e.data));
    es.addEventListener('proposal', () => develop.proposalChanged());
    es.addEventListener('post', e => post.remoteChanged(e.data));
  }
  function rewatch() {
    const q = [watching.edit, watching.post].filter(Boolean).join('&');
    if (q !== watch) { watch = q; connect(); }
  }
  app.watchEdit = (shoot, key) => {
    watching.edit = `shoot=${encodeURIComponent(shoot)}&key=${encodeURIComponent(key)}`;
    rewatch();
  };
  app.watchPost = slug => {
    watching.post = slug ? `collection=${encodeURIComponent(slug)}` : '';
    rewatch();
  };
  connect();
})();

start();
