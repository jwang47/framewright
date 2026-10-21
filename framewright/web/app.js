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
import { createVideos } from './videos.js';
import { createCut } from './cut.js';
import { Renderer, loadBitmap, lutsReady, normalize, orientedSize } from './render.js';
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
  const year = y === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year });
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function plural(n, word) { return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`; }

// "4 photos · 38 clips" for a run of items.
function mediaCount(items) {
  const clips = items.filter(x => x.video).length, photos = items.length - clips;
  return [photos && plural(photos, 'photo'), clips && plural(clips, 'clip')].filter(Boolean).join(' · ') || 'empty';
}

// The Mac app (macos/) listens for these to show notifications, badge the
// Dock and keep the Mac awake during an import; in a browser they do nothing.
function native(message) {
  try { window.webkit?.messageHandlers?.framewright?.postMessage(message); } catch { /* browser */ }
}

function notify(title, body) {
  if (window.webkit?.messageHandlers?.framewright) return native({ type: 'notify', title, body });
  if (document.hasFocus() || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}

// In the Mac app, empty parts of the header move the window like a title bar.
if (window.webkit?.messageHandlers?.framewright) {
  const top = document.querySelector('header.top');
  const empty = e => e.target === top || e.target.matches?.('.counts, .counts *, .status');
  top.addEventListener('mousedown', e => { if (e.button === 0 && e.detail === 1 && empty(e)) native({ type: 'drag' }); });
  top.addEventListener('dblclick', e => { if (empty(e)) native({ type: 'zoom' }); });
}

// A thin sweep along the top while any request takes longer than a blink.
(function loadingBar() {
  const bar = document.getElementById('busy');
  const plain = window.fetch.bind(window);
  let pending = 0, timer = null;
  const done = () => { if (--pending <= 0) { pending = 0; clearTimeout(timer); timer = null; bar.classList.remove('on'); } };
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    // Polls run constantly in the background; they shouldn't flicker the bar.
    if (/\/api\/(card|import|offload|events)(\?|$)/.test(url) && !(init?.method === 'POST')) return plain(input, init);
    pending++;
    timer ??= setTimeout(() => bar.classList.add('on'), 150);
    return plain(input, init).finally(done);
  };
})();

export const app = {
  shootDate,
  dayLabel,
  clipCounts: {},
  storeName: 'external drive',
  storeMounted: false,
  // A small "SSD" / "Mac" tag saying where a photo or clip's file lives.
  whereTag(item) {
    if (!item.where) return '';
    const drive = item.where === 'store';
    const title = drive ? `On ${this.storeName}${this.storeMounted ? '' : ' (not plugged in)'}` : 'On this Mac, in the library';
    return `<span class="where ${drive ? 'drive' : 'mac'}${drive && !this.storeMounted ? ' gone' : ''}" title="${title}">${drive ? 'SSD' : 'Mac'}</span>`;
  },
  whereText(item) {
    return !item.where ? '' : item.where === 'store' ? `on ${this.storeName}` : 'on this Mac';
  },
  view: null,          // {kind: 'shoot'|'collection', id, name, days}
  frames: [],          // [{id, shoot, key, time, picked, edited, exported, selected}]
  collections: [],     // [{name, slug, days, shoots, items}] from /api/shoots
  target: null,        // slug of the target collection, or null
  focusKey: null,      // a frame id
  chosen: new Set(),   // frame ids ⌘/⇧-clicked in the library, for Sync; the focus is one of them
  tab: 'library',

  clips: [],           // the day's video clips, ids 'clip:shoot/key'; only the Library and Videos show them
  frame(id) { return this.frames.find(f => f.id === id); },
  clip(id) { return this.clips.find(c => c.id === id); },
  isClip(id) { return typeof id === 'string' && id.startsWith('clip:'); },
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
    $('#count').textContent = this.frames.filter(f => f.picked).length + this.clips.filter(c => c.picked).length;
    $('#total').textContent = this.frames.length + this.clips.length;
    const n = this.frames.filter(f => f.selected).length + this.clips.filter(c => c.selected).length;
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
    $('#videos').hidden = tab !== 'videos';
    $('#collections').hidden = tab !== 'collections';
    if (tab !== 'videos') videos.hide();
    paintNav();
    if (tab === 'post') {
      post.show();
    } else if (tab === 'collections') {
      renderCollections();
    } else if (tab === 'videos') {
      videos.show(this.clip(this.focusKey));
      cut.show();
    } else if (tab === 'library') {
      library.render();
      // After layout, so the selected thumbnail is scrolled into view.
      requestAnimationFrame(() => library.setFocus(this.focusKey));
    } else {
      develop.show(this.isClip(this.focusKey) ? (this.frames[0]?.id ?? null) : this.focusKey);
    }
    this.syncUrl();
  },

  async togglePick(id) {
    if (this.isClip(id)) return this.toggleClipPick(id);
    const f = this.frame(id);
    f.picked = !f.picked;
    if (f.picked) f.rejected = false;
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

  // Mark for deletion, or unmark. Marked items dim; the Marked filter's
  // Move to Trash clears them out when space is needed.
  async toggleReject(id) {
    const x = this.frame(id) || this.clip(id);
    if (!x) return;
    const before = { picked: x.picked, rejected: x.rejected };
    x.rejected = !x.rejected;
    if (x.rejected) x.picked = false;
    library.paint(id);
    develop.paintStrip();
    this.updateCounts();
    try {
      await this.post('/api/pick', { shoot: x.shoot, key: x.key, rejected: x.rejected });
      this.status(x.rejected ? `marked ${x.key} for deletion` : `unmarked ${x.key}`);
      if (library.filter() === 'rejects' && !x.rejected) library.render();
    } catch {
      Object.assign(x, before);
      library.paint(id);
      this.updateCounts();
      this.status('save failed — is the server running?', 0);
    }
  },

  async trashMarked() {
    const marked = library.merged().filter(x => x.rejected);
    if (!marked.length) return;
    const where = marked.some(x => x.where === 'store') ? ` (${this.storeName} files go to its Trash)` : '';
    if (!confirm(`Move ${marked.length} marked item${marked.length > 1 ? 's' : ''} to the Trash?${where}\nYou can put them back from the Trash in Finder.`)) return;
    try {
      const res = await this.post('/api/trash', { refs: marked.map(x => x.video ? x.id.slice(5) : x.id) });
      const gone = new Set(marked.map(x => x.id));
      this.frames = this.frames.filter(f => !gone.has(f.id));
      this.clips = this.clips.filter(c => !gone.has(c.id));
      if (gone.has(this.focusKey)) this.focusKey = library.merged()[0]?.id ?? null;
      this.status(`moved ${res.trashed.length} to the Trash`, 4000);
      await refreshMenus(`${this.view.kind}:${this.view.id}`);
      library.render();
      library.setFocus(this.focusKey, false);
    } catch (e) {
      this.status(`couldn't move to the Trash: ${e.message}`, 0);
    }
  },

  async toggleClipPick(id) {
    const c = this.clip(id);
    c.picked = !c.picked;
    if (c.picked) c.rejected = false;
    library.paint(id);
    this.updateCounts();
    try {
      await this.post('/api/pick', { shoot: c.shoot, key: c.key, picked: c.picked });
      this.status(c.picked ? `picked ${c.key}` : `unpicked ${c.key}`);
    } catch {
      c.picked = !c.picked;
      library.paint(id);
      this.updateCounts();
      this.status('save failed — is the server running?', 0);
    }
  },

  // Add to or take out of the target collection. New photos go last.
  async toggleSelect(id) {
    if (!this.target) return this.status('make a collection first: New collection', 3000);
    const f = this.frame(id) || this.clip(id), name = this.targetName();
    try {
      const res = await this.post('/api/select', {
        collection: this.target, shoot: f.shoot, key: f.key, selected: !f.selected,
      });
      this.applySelects(res.selects);
      updateCollectionCount(this.target, res.selects.length);
      this.status(f.selected ? `added ${f.key} to ${name} as #${f.selected}` : `removed ${f.key} from ${name}`);
    } catch (e) {
      this.status(`save failed: ${e.message}`, 0);
    }
  },

  // Every picked photo and clip shown here that isn't in the target collection yet.
  addPicks() { return this.addItems(library.merged().filter(x => x.picked), 'pick'); },

  async addItems(items, what = 'item') {
    if (!this.target) return this.status('choose a collection first (Collection menu in the toolbar)', 3000);
    const refs = items.filter(x => !x.selected).map(x => x.video ? x.id.slice(5) : x.id);
    if (!refs.length) return this.status(`all of these are already in ${this.targetName()}`, 2500);
    try {
      const res = await this.post('/api/select', { collection: this.target, refs });
      this.applySelects(res.selects);
      updateCollectionCount(this.target, res.selects.length);
      this.status(`added ${plural(refs.length, what)} to ${this.targetName()}`, 3000);
    } catch (e) {
      this.status(`save failed: ${e.message}`, 0);
    }
  },

  // Number every frame by its place in the post set (0 = not in it).
  applySelects(selects) {
    const order = new Map(selects.map((ref, i) => [ref, i + 1]));
    for (const g of [...this.frames, ...this.clips]) {
      const was = g.selected;
      g.selected = order.get(g.video ? g.id.slice(5) : g.id) || 0;
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
    if (f === 'post') return [...app.frames, ...app.clips].filter(x => x.selected).sort((a, b) => a.selected - b.selected);
    if (f === 'photos') return app.frames;
    if (f === 'videos') return app.clips;
    const all = this.merged();
    return f === 'picks' ? all.filter(x => x.picked) : f === 'rejects' ? all.filter(x => x.rejected) : all;
  },

  // Photos and clips in shooting order: by day, then time of day.
  // The whole Library runs newest day first, each day in shooting order.
  merged() {
    const lib = app.view?.kind === 'library';
    if (!app.clips.length && !lib) return app.frames;
    const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    return [...app.frames, ...app.clips].map((x, i) => [shootDate(x.shoot), x.shoot, x.time, i, x])
      .sort((a, b) => (lib ? cmp(b[0], a[0]) : cmp(a[0], b[0])) || cmp(a[1], b[1]) || cmp(a[2], b[2]) || a[3] - b[3])
      .map(e => e[4]);
  },

  zoomLevel: stored('studio.zoomLevel', 'days'),

  setZoomLevel(level, anchor) {
    this.zoomLevel = level;
    store('studio.zoomLevel', level);
    for (const b of document.querySelectorAll('#zoomLevel button')) b.setAttribute('aria-pressed', b.dataset.zoom === level);
    this.render();
    if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
    else if (level === 'days' || level === 'all') requestAnimationFrame(() => this.setFocus(app.focusKey));
  },

  coverOf(items) {
    const best = [...items.filter(x => x.picked), ...items.filter(x => !x.picked && !x.video), ...items.filter(x => x.video)];
    return best.slice(0, 3).map(x => x.video ? `/clipposter/${encodeURIComponent(x.shoot)}/${x.key}.jpg` : app.src('thumb', x));
  },

  // Months and Years: one card per month (or year), its best three as a cover.
  renderCards(items) {
    const list = $('#list');
    const years = this.zoomLevel === 'years';
    const groups = new Map();
    for (const x of items) {
      const date = shootDate(x.shoot) || '0000-00-00';
      const k = years ? date.slice(0, 4) : date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    let year = null, grid = null;
    for (const [k, group] of groups) {
      if (!years && k.slice(0, 4) !== year) {
        year = k.slice(0, 4);
        const all = items.filter(x => shootDate(x.shoot).startsWith(year));
        const h = document.createElement('h2');
        h.className = 'month';
        h.id = `y-${year}`;
        h.innerHTML = `${year} <span>${mediaCount(all)}</span>`;
        list.appendChild(h);
        grid = null;
      }
      if (!grid) { grid = document.createElement('div'); grid.className = 'cards'; list.appendChild(grid); }
      const days = new Set(group.map(x => shootDate(x.shoot))).size;
      const cover = this.coverOf(group);
      const name = years ? k : monthLabel(k).replace(/\s\d{4}$/, '');
      const clips = group.filter(x => x.video).length;
      const a = document.createElement('button');
      a.className = 'mcard';
      a.innerHTML = `<span class="mosaic n${cover.length}">${cover.map(u => `<img loading="lazy" alt="" src="${u}">`).join('')}
          ${clips ? `<span class="chip">▶ ${clips}</span>` : ''}</span>
        <span class="mcard-meta"><strong>${name}</strong><span>${plural(days, 'day')} · ${mediaCount(group)}</span></span>`;
      a.addEventListener('click', () => years ? this.setZoomLevel('months', `y-${k}`) : this.setZoomLevel('days', `m-${k}`));
      grid.appendChild(a);
    }
    if (!items.length) list.innerHTML = '<p class="empty">Nothing here yet.</p>';
  },

  clipFigure(c) {
    const fig = document.createElement('figure');
    fig.id = 'f-' + c.id;
    fig.dataset.id = c.id;
    fig.className = 'is-clip';
    fig.innerHTML = `
      <div class="frame clip">
        <img loading="lazy" decoding="async" draggable="false" alt="${c.key}" src="/clipposter/${encodeURIComponent(c.shoot)}/${c.key}.jpg">
        <button class="star" aria-label="Pick ${c.key}"></button>
        <span class="sel"></span>
        <span class="play" aria-hidden="true">▶</span>
        <span class="dur">${videos.clock(c.duration)}</span>
        ${c.captureFps || c.fps > 61 ? `<span class="hfr">${Math.round(c.captureFps || c.fps)}p</span>` : ''}
        ${c.online ? '' : '<span class="off" title="On a drive that is not plugged in">offline</span>'}
        ${app.whereTag(c)}
      </div>
      <figcaption><span class="name">${c.key}</span><span>${c.time}</span></figcaption>`;
    fig.querySelector('.frame').addEventListener('click', e => this.click(c.id, e));
    fig.querySelector('.frame').addEventListener('dblclick', () => { this.setFocus(c.id, false); app.setTab('videos'); });
    fig.querySelector('.star').addEventListener('click', e => { e.stopPropagation(); this.setFocus(c.id, false); app.togglePick(c.id); });
    return fig;
  },

  render() {
    const list = $('#list');
    list.innerHTML = '';
    this.observer?.disconnect();
    // Edited thumbnails render through the shader only once they scroll into view.
    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) {
        this.observer.unobserve(e.target);
        const f = app.frame(e.target.dataset.id);
        if (f?.params) thumbs.apply(f);
      }
    }, { rootMargin: '400px' });
    const frames = this.shown();
    const lib = app.view?.kind === 'library';
    $('#zoomLevel').hidden = !lib;
    const cards = lib && (this.zoomLevel === 'months' || this.zoomLevel === 'years') && this.filter() !== 'post';
    list.classList.toggle('timeline', cards);
    $('#library .lib').classList.toggle('cards-mode', cards);   // cards get the full width
    if (cards) { this.renderCards(frames); app.updateCounts(); return; }
    const timeline = lib && this.zoomLevel !== 'all';
    const byDay = timeline || (app.isCollection() && !!app.view.days && this.filter() !== 'post');
    const dayOf = x => timeline ? shootDate(x.shoot) : x.shoot;
    const perDay = new Map(), perMonth = new Map();
    for (const x of frames) {
      const d = dayOf(x), m = shootDate(x.shoot).slice(0, 7);
      if (!perDay.has(d)) perDay.set(d, []);
      perDay.get(d).push(x);
      if (!perMonth.has(m)) perMonth.set(m, []);
      perMonth.get(m).push(x);
    }
    let day = null, month = null;
    for (const f of frames) {
      if (timeline && shootDate(f.shoot).slice(0, 7) !== month) {
        month = shootDate(f.shoot).slice(0, 7);
        const items = perMonth.get(month);
        const h = document.createElement('h2');
        h.className = 'month';
        h.id = `m-${month}`;
        h.innerHTML = `${monthLabel(month)} <span>${plural(new Set(items.map(x => shootDate(x.shoot))).size, 'day')} · ${mediaCount(items)}</span>`;
        list.appendChild(h);
      }
      if (byDay && dayOf(f) !== day) {
        day = dayOf(f);
        const items = perDay.get(day);
        const cameras = [...new Set(items.map(x => x.camera || x.shoot.replace(/^\d{4}-\d{2}-\d{2}_?/, '').replace(/-/g, ' ')))].filter(Boolean);
        const h = document.createElement('div');
        h.className = 'day';
        h.id = `d-${day}`;
        h.innerHTML = `<h3>${dayLabel(f.shoot)}</h3><span class="meta">${mediaCount(items)}${cameras.length ? ' · ' + cameras.join(', ') : ''}</span>
          <span class="day-actions"><button data-act="select">Select</button><button data-act="add">Add to collection</button></span>`;
        h.querySelector('[data-act=select]').addEventListener('click', e => {
          e.currentTarget.blur();
          const ids = items.filter(x => !x.video).map(x => x.id);
          this.choose(ids);
          if (ids.length) this.setFocus(ids[0], false);
        });
        h.querySelector('[data-act=add]').addEventListener('click', e => { e.currentTarget.blur(); app.addItems(items); });
        list.appendChild(h);
      }
      if (f.video) {
        list.appendChild(this.clipFigure(f));
        this.paint(f.id);
        continue;
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
          ${app.whereTag(f)}
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
      if (f.params) this.observer.observe(fig);
    }
    if (!frames.length) {
      const clips = app.view?.kind === 'shoot' && app.clipCounts[app.view.id];
      const msg = { picks: 'Nothing picked yet.', post: 'Nothing in the post yet — press S on a photo to add it.',
        videos: 'No videos on this day.', photos: clips ? 'No photos on this day.' : '',
        rejects: 'Nothing marked for deletion. Press ⌫ (or Z) on a photo or video to mark it.' };
      list.innerHTML = `<p class="empty">${msg[this.filter()] || (clips
        ? `No photos on this day, but ${clips} video${clips > 1 ? 's' : ''}. <button id="toVideos">Open Videos <kbd>T</kbd></button>`
        : 'No frames.')}</p>`;
      $('#toVideos')?.addEventListener('click', () => app.setTab('videos'));
    }
    // Only frames on screen stay chosen, so Sync never reaches a hidden one.
    const shown = new Set(frames.map(f => f.id));
    for (const x of app.chosen) if (!shown.has(x)) app.chosen.delete(x);
    this.paintChosen();
    app.updateCounts();
    const marked = frames.filter(x => x.rejected).length;
    $('#trashMarked').hidden = this.filter() !== 'rejects' || !marked;
    $('#trashMarked').textContent = `Move ${marked} to Trash…`;
  },

  paintClip(id) {
    const c = app.clip(id), fig = document.getElementById('f-' + id);
    if (!c) return;
    if (fig) {
      fig.classList.toggle('picked', c.picked);
      fig.classList.toggle('rejected', !!c.rejected);
      fig.classList.toggle('focus', id === app.focusKey);
      fig.querySelector('.star').textContent = c.picked ? '★' : '☆';
      const sel = fig.querySelector('.sel');
      sel.hidden = !c.selected;
      sel.textContent = c.selected || '';
    }
    if (id === app.focusKey) {
      $('#loupeName').textContent = c.key;
      $('#loupeTime').textContent = c.time;
      const fps = c.captureFps ? `${Math.round(c.captureFps)}p slow motion` : c.fps ? `${c.fps}p` : '';
      $('#loupeTag').textContent = [videos.clock(c.duration), c.size, fps, videos.pretty(c.gamma),
        app.whereText(c), c.online ? '' : 'offline', c.rejected ? 'marked for deletion' : ''].filter(Boolean).join(' · ');
      $('#loupePick').textContent = c.picked ? '★ Picked' : '☆ Pick';
      $('#loupePick').setAttribute('aria-pressed', c.picked);
      $('#loupeDev').hidden = true;
      $('#loupeSel').hidden = !app.target;
      $('#loupeSel').textContent = c.selected ? `In collection #${c.selected}` : 'Add to collection';
      $('#loupeSel').setAttribute('aria-pressed', !!c.selected);
      $('#loupeOpen').hidden = false;
      $('#loupeOpen').disabled = !c.online;
    }
  },

  paint(id) {
    if (app.isClip(id)) return this.paintClip(id);
    const f = app.frame(id);
    if (!f) return;
    const fig = document.getElementById('f-' + id);
    if (fig) {
      fig.classList.toggle('picked', f.picked);
      fig.classList.toggle('rejected', !!f.rejected);
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
        f.edited && !f.raw && 'edited', f.exported && 'exported', f.proposed && 'proposal waiting', app.whereText(f),
        f.rejected && '<span class="rej-tag">marked for deletion</span>',
      ].filter(Boolean).join(' · ');
      $('#loupePick').textContent = f.picked ? '★ Picked' : '☆ Pick';
      $('#loupePick').setAttribute('aria-pressed', f.picked);
      $('#loupeSel').hidden = !app.target;
      $('#loupeDev').hidden = false;
      $('#loupeOpen').hidden = true;
      $('#loupeSel').textContent = f.selected ? `In collection #${f.selected}` : 'Add to collection';
      $('#loupeSel').title = `${f.selected ? 'Remove from' : 'Add to'} ${app.targetName()} (S)`;
      $('#loupeSel').setAttribute('aria-pressed', !!f.selected);
    }
  },

  visible() { return [...document.querySelectorAll('#list figure')].map(el => el.dataset.id); },

  // Plain click: just this frame, or, inside a choice of several, make it the
  // focus without losing the others. ⌘/ctrl-click: add or drop a frame.
  // ⇧-click: add every frame from the focus to it. The focus is Sync's source,
  // so adding frames leaves it where it is.
  click(id, e) {
    // Clips aren't chosen for Sync; clicking one just shows it.
    if (app.isClip(id) || app.isClip(app.focusKey) && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      this.choose([]);
      this.setFocus(id, false);
      return this.paintChosen();
    }
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
      for (const x of vis) if (app.isClip(x)) app.chosen.delete(x);
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
    const clip = app.clip(id);
    $('#loupeStage').hidden = !!clip;
    $('#loupeClip').hidden = !clip;
    if (clip) videos.lend($('#loupeClip'), clip);
    else { videos.pause(); loupe.show(id); }
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
  renderer: null, params: null, source: null, frame: null, token: 0, timer: null,
  zoom: 1, panX: 0, panY: 0, fitW: 0, fitH: 0, fullRequested: false,
  fullReady: false, pixels: false, edges: false, edgeRaf: 0,

  show(id) {
    // Holding an arrow key flies through frames; only load where it settles.
    this.token++;
    if (id !== this.frame?.id) {
      this.zoom = 1;
      this.panX = this.panY = 0;
      this.pixels = this.fullReady = false;
      this.frame = null;
      $('#loupeView').hidden = true;
      $('#loupeEdges').hidden = true;
      $('#loupeMinimap').hidden = true;
      $('#loupeZoomStatus').textContent = 'Loading preview…';
      $('#loupeZoomStatus').hidden = false;
      this.draw();
      this.paintControls();
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(id), 60);
  },

  async load(id) {
    const f = app.frame(id);
    if ($('#loupe').hidden || !f) return;
    const token = ++this.token, stale = () => token !== this.token;
    let quickReady = false, rawReady = false, rawFailed = false;
    try {
      const edit = await fetch(`/api/edit?shoot=${encodeURIComponent(f.shoot)}&key=${f.key}`).then(r => r.json());
      if (stale()) return;
      // From the file Develop would open, so the preview matches it.
      const source = sourceOf(f, edit.params);
      if (source === 'raw') {
        $('#loupeZoomStatus').textContent = 'Decoding RAW…';
        // The server's preview is the camera JPEG (or the RAW's embedded
        // JPEG). It gives immediate context while LibRaw does its work.
        loadBitmap(app.src('preview', f)).then(quick => {
          if (stale() || rawReady) return release(quick);
          if (!this.renderer) this.renderer = new Renderer($('#loupeView'));
          this.renderer.setImage(quick);
          release(quick);
          this.params = null;
          quickReady = true;
          $('#loupeView').hidden = false;
          this.draw();
          $('#loupeZoomStatus').textContent = rawFailed
            ? 'RAW unavailable · JPEG preview' : 'JPEG preview · decoding RAW…';
        }).catch(() => {});
      }
      const img = await loadSource(app, f, source, { stale, quiet: source === 'raw', background: false });
      if (!img || stale()) return release(img);
      rawReady = true;
      if (!this.renderer) this.renderer = new Renderer($('#loupeView'));
      this.renderer.setImage(img);
      release(img);
      this.params = edit.params;
      this.source = source;
      this.frame = f;
      this.fullRequested = false;
      this.fullReady = false;
      $('#loupeView').hidden = false;
      this.draw();
      $('#loupeZoomStatus').hidden = true;
      if (this.zoom > 1 || this.edges) this.loadFull();
      const ids = library.visible();
      prefetch(app, ids.map(i => app.frame(i)), ids.indexOf(id), () => app.focusKey);
    } catch (e) {
      rawFailed = true;
      if (!stale()) {
        $('#loupeZoomStatus').textContent = quickReady
          ? 'RAW unavailable · JPEG preview' : 'Preview unavailable';
        $('#loupeZoomStatus').hidden = false;
      }
      app.status(`preview failed: ${e.message}`, 0);
    }
  },

  draw() {
    if (!this.renderer || !this.renderer.w) return;
    const stage = $('#loupeStage');
    if (!stage.clientWidth || !stage.clientHeight) return;
    const view = $('#loupeView');
    if (this.pixels && this.fullReady) {
      const p = normalize(this.params);
      const [fw, fh] = orientedSize(p, this.renderer.w, this.renderer.h);
      const fullW = p.crop.w * fw, fullH = p.crop.h * fh;
      const s = Math.min((stage.clientWidth - 32) / fullW, (stage.clientHeight - 32) / fullH);
      const old = this.zoom;
      this.fitW = fullW * s;
      this.fitH = fullH * s;
      this.zoom = 1 / s;
      this.panX *= this.zoom / old;
      this.panY *= this.zoom / old;
      this.clampPan();
      this.renderPixels();
      this.paintControls();
      this.paintMap();
      return;
    }
    this.renderer.render(this.params, {
      maxSize: Math.max(stage.clientWidth, stage.clientHeight) * (devicePixelRatio || 1) * this.zoom,
    });
    const s = Math.min((stage.clientWidth - 32) / view.width, (stage.clientHeight - 32) / view.height);
    this.fitW = view.width * s;
    this.fitH = view.height * s;
    view.style.width = Math.floor(this.fitW * this.zoom) + 'px';
    view.style.height = Math.floor(this.fitH * this.zoom) + 'px';
    this.clampPan();
    this.applyPan();
    this.paintControls();
    this.paintMap();
    this.queueEdges();
  },

  renderPixels() {
    if (!this.pixels || !this.fullReady) return;
    const stage = $('#loupeStage'), view = $('#loupeView');
    const fullW = this.fitW * this.zoom, fullH = this.fitH * this.zoom;
    const w = Math.min(1, stage.clientWidth / fullW);
    const h = Math.min(1, stage.clientHeight / fullH);
    const x = Math.max(0, Math.min(1 - w, 0.5 - this.panX / fullW - w / 2));
    const y = Math.max(0, Math.min(1 - h, 0.5 - this.panY / fullH - h / 2));
    this.renderer.render(this.params, { viewport: { x, y, w, h } });
    view.style.width = view.width + 'px';
    view.style.height = view.height + 'px';
    view.style.marginLeft = view.style.marginTop = '0px';
    this.paintMapBox();
    this.queueEdges();
  },

  clampPan() {
    const stage = $('#loupeStage');
    const x = Math.max(0, (this.fitW * this.zoom - stage.clientWidth) / 2);
    const y = Math.max(0, (this.fitH * this.zoom - stage.clientHeight) / 2);
    this.panX = Math.max(-x, Math.min(x, this.panX));
    this.panY = Math.max(-y, Math.min(y, this.panY));
  },

  applyPan() {
    if (this.pixels && this.fullReady) {
      if (!this.panRaf) this.panRaf = requestAnimationFrame(() => {
        this.panRaf = 0;
        this.renderPixels();
      });
      this.paintMapBox();
      return;
    }
    const view = $('#loupeView');
    view.style.marginLeft = this.panX + 'px';
    view.style.marginTop = this.panY + 'px';
    this.paintMapBox();
  },

  paintControls() {
    $('#loupeZoomLevel').textContent = this.pixels ? '100%' : this.zoom === 1 ? 'Fit' : `${this.zoom}×`;
    $('#loupeOut').disabled = !this.frame || (!this.pixels && this.zoom === 1);
    $('#loupeIn').disabled = !this.frame || this.pixels || this.zoom === 4;
    $('#loupeFit').disabled = !this.frame || (!this.pixels && this.zoom === 1);
    $('#loupePixels').disabled = !this.frame;
    $('#loupePixels').setAttribute('aria-pressed', this.pixels);
    $('#loupeEdgeToggle').disabled = !this.frame;
    $('#loupeEdgeToggle').setAttribute('aria-pressed', this.edges);
    $('#loupeView').classList.toggle('zoomed', this.zoom > 1);
    $('#loupeMinimap').hidden = this.zoom === 1 || !this.frame || !this.renderer?.w;
  },

  setZoom(next, point = null) {
    if (!this.frame) return;
    const old = this.zoom;
    const wasPixels = this.pixels;
    this.pixels = false;
    next = Math.max(1, Math.min(4, next));
    if (next === old && !wasPixels) return;
    if (point && this.fitW && this.fitH) {
      const rect = $('#loupeStage').getBoundingClientRect();
      const dx = point.clientX - rect.left - rect.width / 2;
      const dy = point.clientY - rect.top - rect.height / 2;
      this.panX = -(dx - this.panX) * next / old;
      this.panY = -(dy - this.panY) * next / old;
    } else {
      this.panX *= next / old;
      this.panY *= next / old;
    }
    this.zoom = next;
    if (next === 1) this.panX = this.panY = 0;
    this.draw();
    if (next > 1) this.loadFull();
  },

  setPixels() {
    if (!this.frame) return;
    if (this.pixels) return this.setZoom(1);
    this.captureMap();
    this.pixels = true;
    if (this.fullReady) this.draw();
    else {
      this.paintControls();
      this.loadFull();
    }
  },

  async loadFull() {
    if (this.fullRequested || !this.frame || (this.zoom === 1 && !this.pixels && !this.edges)) return;
    this.fullRequested = true;
    const token = this.token, f = this.frame;
    const status = $('#loupeZoomStatus');
    status.textContent = 'Loading full detail…';
    status.hidden = false;
    try {
      const img = await loadSource(app, f, this.source,
        { full: true, quiet: true, background: true, keep: false, stale: () => token !== this.token });
      if (!img || token !== this.token) return release(img);
      if (this.pixels) this.captureMap();
      this.renderer.setImage(img);
      release(img);
      this.fullReady = true;
      this.draw();
      status.hidden = true;
    } catch {
      if (token === this.token) status.textContent = 'Full detail unavailable';
    }
  },

  paintMap() {
    const map = $('#loupeMinimap'), canvas = $('#loupeMap');
    if (this.zoom === 1 || !this.fitW || !this.fitH) return;
    if (this.pixels) {
      map.hidden = false;
      this.paintMapBox();
      return;
    }
    const scale = Math.min(160 / this.fitW, 120 / this.fitH);
    const w = Math.max(1, Math.round(this.fitW * scale));
    const h = Math.max(1, Math.round(this.fitH * scale));
    const dpr = Math.min(devicePixelRatio || 1, 3);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.getContext('2d').drawImage($('#loupeView'), 0, 0, canvas.width, canvas.height);
    map.hidden = false;
    this.paintMapBox();
  },

  captureMap() {
    const view = $('#loupeView');
    if (!view.width || !view.height) return;
    const canvas = $('#loupeMap');
    const s = Math.min(160 / view.width, 120 / view.height);
    canvas.width = Math.max(1, Math.round(view.width * s));
    canvas.height = Math.max(1, Math.round(view.height * s));
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.getContext('2d').drawImage(view, 0, 0, canvas.width, canvas.height);
  },

  setEdges() {
    if (!this.frame) return;
    this.edges = !this.edges;
    $('#loupeEdgeToggle').setAttribute('aria-pressed', this.edges);
    $('#loupeEdges').hidden = !this.edges || !this.fullReady;
    if (this.edges) {
      if (!this.fullReady) this.loadFull();
      else this.queueEdges();
    }
  },

  queueEdges() {
    if (!this.edges || !this.fullReady || $('#loupeView').hidden) return;
    cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = requestAnimationFrame(() => this.paintEdges());
  },

  paintEdges() {
    const stage = $('#loupeStage'), view = $('#loupeView'), overlay = $('#loupeEdges');
    if (!this.edges || !this.fullReady || view.hidden) return;
    const w = Math.round(stage.clientWidth), h = Math.round(stage.clientHeight);
    if (!w || !h) return;
    if (!this.edgeInput) this.edgeInput = document.createElement('canvas');
    const input = this.edgeInput;
    input.width = overlay.width = w;
    input.height = overlay.height = h;
    const rect = view.getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
    const ctx = input.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(view, rect.left - stageRect.left, rect.top - stageRect.top, rect.width, rect.height);
    const src = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4)
      gray[i] = src[j + 3] ? 0.2126 * src[j] + 0.7152 * src[j + 1] + 0.0722 * src[j + 2] : 0;
    const out = overlay.getContext('2d').createImageData(w, h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, j = i * 4;
      if (!src[j + 3]) continue;
      const l = gray[i - 1], r = gray[i + 1], u = gray[i - w], d = gray[i + w];
      if (Math.abs(4 * gray[i] - l - r - u - d) < 18 || Math.abs(l - r) + Math.abs(u - d) < 16) continue;
      out.data[j] = 30; out.data[j + 1] = 235; out.data[j + 2] = 255; out.data[j + 3] = 200;
    }
    overlay.getContext('2d').putImageData(out, 0, 0);
    overlay.hidden = false;
  },

  paintMapBox() {
    if (this.zoom === 1) return;
    const stage = $('#loupeStage'), map = $('#loupeMap'), box = $('#loupeMapBox');
    const imageW = this.fitW * this.zoom, imageH = this.fitH * this.zoom;
    if (!map.clientWidth || !imageW || !imageH) return;
    const w = Math.min(1, stage.clientWidth / imageW);
    const h = Math.min(1, stage.clientHeight / imageH);
    const cx = 0.5 - this.panX / imageW, cy = 0.5 - this.panY / imageH;
    box.style.width = w * map.clientWidth + 'px';
    box.style.height = h * map.clientHeight + 'px';
    box.style.left = Math.max(0, Math.min(1 - w, cx - w / 2)) * map.clientWidth + 'px';
    box.style.top = Math.max(0, Math.min(1 - h, cy - h / 2)) * map.clientHeight + 'px';
  },

  panFromMap(e) {
    const rect = $('#loupeMap').getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    this.panX = (0.5 - u) * this.fitW * this.zoom;
    this.panY = (0.5 - v) * this.fitH * this.zoom;
    this.clampPan();
    this.applyPan();
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
  paintNav();
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
$('#trashMarked').addEventListener('click', e => { e.currentTarget.blur(); app.trashMarked(); });
$('#addPicks').addEventListener('click', e => { e.currentTarget.blur(); app.addPicks(); });
$('#loupeOpen').addEventListener('click', e => {
  e.target.blur();
  const c = app.clip(app.focusKey);
  if (c) { videos.pause(); app.post('/api/clip/open', { shoot: c.shoot, key: c.key }).catch(err => app.status(err.message, 4000)); }
});
$('#loupeSel').addEventListener('click', e => { e.target.blur(); if (app.focusKey) app.toggleSelect(app.focusKey); });
$('#loupeSync').addEventListener('click', e => { e.target.blur(); sync.open(); });
$('#loupeDev').addEventListener('click', e => { e.target.blur(); if (app.focusKey) app.setTab('develop'); });
$('#loupeView').addEventListener('click', e => {
  if (loupe.dragged) { loupe.dragged = false; return; }
  if (app.focusKey) loupe.setZoom(loupe.zoom === 1 ? 2 : loupe.zoom + 1, e);
});
$('#loupeView').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    loupe.setZoom(loupe.zoom === 1 ? 2 : loupe.zoom + 1);
  } else if (e.key === 'Escape' && loupe.zoom > 1) {
    e.preventDefault(); e.stopPropagation(); loupe.setZoom(1);
  }
});
$('#loupeView').addEventListener('pointerdown', e => {
  if (loupe.zoom === 1) return;
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  loupe.drag = { x: e.clientX, y: e.clientY };
  loupe.dragged = false;
  e.currentTarget.classList.add('panning');
});
$('#loupeView').addEventListener('pointermove', e => {
  if (!loupe.drag) return;
  const dx = e.clientX - loupe.drag.x, dy = e.clientY - loupe.drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) loupe.dragged = true;
  loupe.panX += dx; loupe.panY += dy;
  loupe.drag.x = e.clientX; loupe.drag.y = e.clientY;
  loupe.clampPan(); loupe.applyPan();
});
for (const type of ['pointerup', 'pointercancel']) $('#loupeView').addEventListener(type, e => {
  loupe.drag = null;
  e.currentTarget.classList.remove('panning');
});
$('#loupeIn').addEventListener('click', e => { e.currentTarget.blur(); loupe.setZoom(loupe.zoom + 1); });
$('#loupeOut').addEventListener('click', e => { e.currentTarget.blur(); loupe.setZoom(loupe.pixels ? 4 : loupe.zoom - 1); });
$('#loupeFit').addEventListener('click', e => { e.currentTarget.blur(); loupe.setZoom(1); });
$('#loupePixels').addEventListener('click', e => { e.currentTarget.blur(); loupe.setPixels(); });
$('#loupeEdgeToggle').addEventListener('click', e => { e.currentTarget.blur(); loupe.setEdges(); });
$('#loupeStage').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault(); loupe.setZoom(loupe.zoom + (e.deltaY < 0 ? 1 : -1), e);
}, { passive: false });
$('#loupeMinimap').addEventListener('pointerdown', e => {
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  loupe.mapDrag = true;
  loupe.panFromMap(e);
});
$('#loupeMinimap').addEventListener('pointermove', e => { if (loupe.mapDrag) loupe.panFromMap(e); });
for (const type of ['pointerup', 'pointercancel']) $('#loupeMinimap').addEventListener(type, () => { loupe.mapDrag = false; });
$('#loupeMinimap').addEventListener('keydown', e => {
  const step = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] }[e.key];
  if (!step) return;
  e.preventDefault(); e.stopPropagation();
  loupe.panX -= step[0]; loupe.panY -= step[1];
  loupe.clampPan(); loupe.applyPan();
});

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
const videos = createVideos(app);
const cut = createCut(app, videos);
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
  if (app.tab === 'library' && app.isClip(app.focusKey)) {
    videos.fullscreen();
  } else if (app.tab === 'library' && app.focusKey) {
    fullscreen.open(library.visible().filter(id => !app.isClip(id)), app.focusKey, id => library.setFocus(id));
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
  const help = document.querySelector('.shortcut-help[open]');
  if (e.key === 'Escape' && help) {
    help.open = false;
    help.querySelector('summary').focus();
    e.preventDefault();
    return;
  }
  if (e.target.closest?.('.shortcut-help')) return;
  if (fullscreen.isOpen) return fullscreen.onKey(e);
  if (e.target.matches?.('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (e.key.toLowerCase() === 'f' && e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return openFullscreen(); }
  if (app.tab === 'videos' && cut.onKey(e)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if (app.tab === 'develop') develop.onKey(e);
    else if (app.tab === 'library' && !e.altKey) libraryShortcut(e);
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'g' && app.tab !== 'library') return app.setTab('library');
  // P picks (one-handed, right hand on the keyboard); ⇧P opens Post.
  if (k === 'p' && e.shiftKey) { e.preventDefault(); return app.setTab('post'); }
  if (k === 't') { e.preventDefault(); return app.setTab('videos'); }
  if (app.tab === 'videos') {
    if (k === 'd') return app.focusKey && app.setTab('develop');
    return videos.onKey(e);
  }
  if (app.tab === 'library' && app.isClip(app.focusKey)) {
    // Space plays a video; P (or X) picks it, like everything else.
    if (k === ' ') { e.preventDefault(); return videos.toggle(); }
    if (k === 'enter' || k === 'd') { e.preventDefault(); return app.setTab('videos'); }
    if (k === ',' || k === '.') { e.preventDefault(); return videos.step(k === '.' ? 1 : -1); }
  }
  if (k === 'd' || (k === 'enter' && app.tab === 'library')) {
    if (app.focusKey) app.setTab('develop');
    return;
  }
  if (k === 's' && e.shiftKey && app.tab === 'library') { e.preventDefault(); return app.addPicks(); }
  if (k === 's' && app.focusKey && app.tab !== 'post') return app.toggleSelect(app.focusKey);
  if (app.tab === 'develop') return develop.onKey(e);
  if (app.tab === 'post') return post.onKey(e);

  if (k === 'arrowright' || k === 'l') { e.preventDefault(); library.move(1); }
  else if (k === 'arrowleft' || k === 'h') { e.preventDefault(); library.move(-1); }
  else if (k === 'arrowdown' || k === 'j') { e.preventDefault(); library.move(library.columns()); }
  else if (k === 'arrowup' || k === 'k') { e.preventDefault(); library.move(-library.columns()); }
  else if (k === 'p' || k === 'x') { e.preventDefault(); if (app.focusKey) app.togglePick(app.focusKey); }
  else if (k === 'backspace' || k === 'delete' || k === 'z') { e.preventDefault(); if (app.focusKey) app.toggleReject(app.focusKey); }
  else if (k === 'f') setFilter(library.filter() === 'picks' ? 'all' : 'picks');
  else if ((k === '[' || k === ']') && library.filter() === 'post') nudgePost(k === ']' ? 1 : -1);
  else if (k === 'o') {
    const filters = [...$('#filter').options].filter(o => !o.hidden).map(o => o.value);
    setFilter(filters[(filters.indexOf(library.filter()) + 1) % filters.length]);
  }
  else if (k === 'e') $('#loupeBtn').click();
  else if (k === 'i') { e.preventDefault(); loupe.setPixels(); }
  else if (k === 'v') { e.preventDefault(); loupe.setEdges(); }
  else if (k === 'escape' && app.chosen.size) library.choose([]);
  else if (k === '=' || k === '+') library.zoom(+$('#zoom').value + 30);
  else if (k === '-' || k === '_') library.zoom(+$('#zoom').value - 30);
});

// ⌘A chooses every frame shown, ⌘⇧S syncs settings to them, ⌘Z undoes a sync.
function libraryShortcut(e) {
  const k = e.key.toLowerCase();
  if (k === 'backspace') {
    e.preventDefault();
    if (app.focusKey) app.toggleReject(app.focusKey);
  } else if (k === 'a') {
    e.preventDefault();
    const photos = library.visible().filter(id => !app.isClip(id));
    library.choose(photos);
    if (!app.chosen.has(app.focusKey)) library.setFocus(photos[0], false);
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
function updateCollectionCount(slug, count) {
  const collection = app.collections.find(c => c.slug === slug);
  if (!collection) return;
  collection.items = count;
  if (collection.days) return; // Day collections show their number of days.
  const option = [...$('#shoot').options].find(o => o.value === `collection:${slug}`);
  if (option) option.textContent = `${collection.name} (${count})`;
}

async function loadTarget() {
  if (!app.target) return app.applySelects([]);
  const res = await fetch(`/api/collection?slug=${encodeURIComponent(app.target)}`);
  const items = res.ok ? (await res.json()).items : [];
  app.applySelects(items);
  if (res.ok) updateCollectionCount(app.target, items.length);
}

function setTarget(slug) {
  app.target = app.collections.some(c => c.slug === slug) ? slug : null;
  store('studio.target', app.target || '');
  $('#target').value = app.target || '';
  const post = $('#filter').querySelector('[value=post]');
  post.hidden = !app.target;
  post.textContent = app.target ? `In ${app.targetName()}, in order (O)` : '';
  if (!app.target && $('#filter').value === 'post') $('#filter').value = 'all';
  $('#renameCol').disabled = $('#deleteCol').disabled = $('#addPicks').disabled = !app.target;
  document.querySelector('.tabs [data-tab=post]').hidden = !app.target;
}

async function loadView(value, tab, frame) {
  let [kind, id] = value.split(/:(.*)/s);
  if (kind === 'trip') kind = 'collection';          // links from before collections
  const q = kind === 'collection' ? `collection=${encodeURIComponent(id)}`
    : kind === 'library' ? 'all=1' : `shoot=${encodeURIComponent(id)}`;
  const [data, clipData] = await Promise.all([
    fetch('/api/frames?' + q).then(r => r.json()),
    kind === 'shoot' ? fetch('/api/clips?' + q).then(r => r.ok ? r.json() : { days: [] })
      : kind === 'library' ? fetch('/api/clips').then(r => r.ok ? r.json() : { days: [] }) : null,
  ]);
  app.view = { kind, id, name: data.name || id, days: data.days || null };
  app.frames = data.frames.map(f => ({ ...f, id: `${f.shoot}/${f.key}`, selected: 0 }));
  app.clips = (clipData ? clipData.days.flatMap(d => d.clips) : data.clips || [])
    .map(c => ({ ...c, id: `clip:${c.shoot}/${c.key}`, video: true, selected: c.selected || 0 }));
  app.chosen = new Set();
  app.focusKey = app.frame(frame) || app.clip(frame) ? frame : (library.merged()[0] || {}).id || null;
  if (kind === 'collection') setTarget(id);
  $('#viewTitle').textContent = kind === 'library' ? 'Library' : kind === 'collection' ? app.view.name : dayLabel(id);
  $('#viewBack').hidden = kind === 'library';
  $('#shoot').value = value;
  // A collection with days is where day picks get narrowed down: start on them.
  const start = kind === 'collection' && app.view.days && app.frames.some(f => f.picked) ? 'picks' : 'all';
  $('#filter').value = start;
  if (!frame && start === 'picks') app.focusKey = app.frames.find(f => f.picked)?.id ?? app.focusKey;
  develop.reset();
  app.updateCounts();
  app.setTab(['develop', 'post', 'videos'].includes(tab) ? tab : 'library');
  await loadTarget();
}

// Rebuild the view menu and the target menu from the server.
async function refreshMenus(keepView) {
  const { shoots, shootCounts = {}, clipCounts = {}, store, storeMounted, storeFree, collections } = await (await fetch('/api/shoots')).json();
  app.collections = collections;
  app.clipCounts = clipCounts;
  app.storeName = store || 'external drive';
  app.storeMounted = storeMounted;
  const sel = $('#shoot');
  const colOpts = collections.map(c => {
    // Two cameras on one day are two shoot folders, so count dates, not folders.
    const days = new Set(c.shoots.map(shootDate)).size;
    const what = c.days ? `${days} days` : c.items;
    return `<option value="collection:${c.slug}">${c.name} (${what})</option>`;
  }).join('');
  const shootOpts = shoots.map(s => {
    const n = shootCounts[s], v = clipCounts[s];
    const parts = [n ? `${n}` : '', v ? `${v} video${v > 1 ? 's' : ''}` : ''].filter(Boolean);
    const count = parts.length ? ` (${parts.join(' · ')})` : '';
    return `<option value="shoot:${s}">${s}${count}</option>`;
  }).join('');
  sel.innerHTML = '<option value="library:all">Library</option>' +
    (collections.length ? `<optgroup label="Collections">${colOpts}</optgroup>` : '') +
    `<optgroup label="Days">${shootOpts}</optgroup>`;
  const total = Object.values(shootCounts).reduce((a, b) => a + b, 0) + Object.values(clipCounts).reduce((a, b) => a + b, 0);
  $('#navLibraryN').textContent = total.toLocaleString();
  $('#navCollectionsN').textContent = collections.length || '';
  $('#recentCols').innerHTML = collections.slice(0, 5).map(c => `
    <button class="side-col" data-slug="${c.slug}">
      <span class="swatch">${c.cover[0] ? `<img alt="" src="${c.cover[0]}">` : ''}</span>
      <span class="nm">${c.name}</span><span class="n">${shortDate(c.date)}</span>
    </button>`).join('');
  for (const b of document.querySelectorAll('#recentCols .side-col')) {
    b.addEventListener('click', () => { b.blur(); loadView(`collection:${b.dataset.slug}`, 'library'); });
  }
  $('#driveRow').hidden = !store;
  $('#driveName').textContent = store || '';
  $('#driveFree').textContent = !storeMounted ? 'not plugged in' : storeFree != null ? `${bytes(storeFree)} free` : '';
  if (app.tab === 'collections') renderCollections();
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
      await loadView('library:all', 'library');
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
    const id = `${r.shoot}/${r.key}`;
    if (app.view?.kind === 'library' && app.frame(id)) {
      if (app.tab !== 'develop') { app.setTab('library'); library.setFocus(id); }
      else { app.focusKey = id; app.setTab('develop'); }
    } else {
      await loadView('library:all', app.tab === 'develop' ? 'develop' : 'library', id);
    }
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
// how many frames and clips on it are new. One click starts copying them with
// the same verified copy as import_photos.py; the button fills as a progress
// bar with speed and time left, and the dialog (click again) shows detail and
// options. Optionally imports as soon as a card appears and ejects it after.
(function cardImport() {
  const btn = $('#importBtn'), dlg = $('#importDlg'), go = $('#importGo'), bar = $('#busy');
  let card = null, groups = [], running = false, deleteInitialized = false, error = null, dest = null, many = false;
  const auto = $('#importAuto'), autoEject = $('#importAutoEject');
  auto.checked = stored('studio.autoImport', '0') === '1';
  autoEject.checked = stored('studio.autoEject', '0') === '1';
  auto.addEventListener('change', () => store('studio.autoImport', auto.checked ? '1' : '0'));
  autoEject.addEventListener('change', () => store('studio.autoEject', autoEject.checked ? '1' : '0'));

  const frames = gs => gs.reduce((n, g) => n + g.frames, 0);
  const mb = x => x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${Math.round(x)} MB`;
  const what = gs => {
    const photos = frames(gs.filter(g => g.kind !== 'video')), clips = frames(gs.filter(g => g.kind === 'video'));
    return [photos && `${photos} photo${photos > 1 ? 's' : ''}`, clips && `${clips} clip${clips > 1 ? 's' : ''}`]
      .filter(Boolean).join(' + ') || 'nothing';
  };
  const eta = s => !Number.isFinite(s) || s <= 0 ? '' : s < 60 ? `${Math.ceil(s)}s left`
    : s < 3600 ? `${Math.round(s / 60)} min left` : `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min left`;

  function label() {
    btn.classList.remove('importing');
    btn.textContent = groups.length ? `Import ${what(groups)}${dest ? ` → ${dest}` : ''}` : 'Card: nothing new';
    btn.title = groups.length ? `${card}: copy everything new in one click (click again for details)` : `${card}: everything is already imported`;
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
    error = res.error || null;
    dest = res.store;
    many = (res.cards || []).length > 1;
    $('#importCard').textContent = card;
    $('#importEject').hidden = !res.eject;
    $('#importFormat').hidden = !res.eject || !!res.error || (res.groups || []).length > 0 || (res.cards || []).length !== 1;
    const total = groups.reduce((t, g) => t + g.mb, 0);
    $('#importPlan').innerHTML = res.error ? `<p class="none">${res.error}</p>`
      : !groups.length ? '<p class="none">Everything on this card is already in the library.</p>'
      : `<table>${groups.map(g => `<tr>${many ? `<td>${g.card}</td>` : ''}<td>${g.shoot}${g.kind === 'video' ? ' · video' : ''}</td>
          <td>${g.frames} ${g.kind === 'video' ? 'clips' : 'frames'}</td><td>${mb(g.mb)}</td></tr>`).join('')}</table>
        <p class="none">${what(groups)}, ${mb(total)} in all. Images go to ${res.to}.</p>`;
    go.disabled = running || !groups.length;
    go.textContent = groups.length ? `Import ${what(groups)}` : 'Import';
    if (!running) label();
    return true;
  }

  // Cheap presence check; the plan is only read when a card appears.
  async function poll() {
    if (running) return;
    try { await check(); } catch { /* server restarting; try again next tick */ }
  }

  async function check() {
    const res = await (await fetch('/api/card')).json().catch(() => ({}));
    if (res.card === card) return;
    card = res.card || null;
    btn.hidden = !card;
    $('#cardBox').hidden = !card;
    $('#cardName').textContent = card || '';
    if (!card) { if (dlg.open) dlg.close(); return; }
    await loadPlan();
    if (auto.checked && groups.length && !error) {
      app.status(`${card} connected: importing ${what(groups)}`, 4000);
      run();
    }
  }

  async function watch() {
    let st;
    const samples = [];
    do {
      await new Promise(r => setTimeout(r, 500));
      st = await (await fetch('/api/import')).json();
      const pct = st.bytes_total ? st.bytes / st.bytes_total : 0;
      // Speed over the last ~10 seconds, so one big clip doesn't swing it.
      samples.push([performance.now(), st.bytes || 0]);
      while (samples.length > 20) samples.shift();
      const [t0, b0] = samples[0], [t1, b1] = samples.at(-1);
      const rate = t1 > t0 ? (b1 - b0) / ((t1 - t0) / 1000) : 0;
      const left = rate > 0 ? (st.bytes_total - st.bytes) / rate : NaN;
      const speed = rate > 0 ? `${Math.round(rate / 2 ** 20)} MB/s` : '';
      $('#importBar').value = pct;
      $('#importNow').textContent = st.current
        ? [`${st.copied}/${st.total}`, st.current, speed, eta(left)].filter(Boolean).join(' · ') : '';
      const p = `${(pct * 100).toFixed(1)}%`;
      btn.style.setProperty('--pct', p);
      bar.style.setProperty('--pct', p);
      $('#cardBar').hidden = false;
      $('#cardBar').style.setProperty('--pct', p);
      btn.textContent = `Importing ${Math.round(pct * 100)}%${eta(left) ? ' · ' + eta(left) : ''}`;
      document.title = `${Math.round(pct * 100)}% · Framewright`;
      native({ type: 'import', running: true, progress: pct });
    } while (st.running);
    return st;
  }

  async function run() {
    if (running) return;
    running = true;
    go.disabled = $('#importJpeg').disabled = $('#importDelete').disabled = true;
    $('#importProgress').hidden = false;
    btn.classList.add('importing');
    bar.classList.add('on', 'determinate');
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    try {
      await app.post('/api/import', { jpegOnly: $('#importJpeg').checked, deleteFromCard: $('#importDelete').checked });
      const st = await watch();
      if (st.error) throw new Error(st.error);
      $('#importNow').textContent = `imported ${st.copied} files, verified${st.deleted ? ` · ${st.deleted} source files deleted` : ''}`;
      app.status(`imported ${what(st.groups)} from ${st.card}`, 5000);
      notify('Import finished', `${what(st.groups)} from ${st.card}, verified.`);
      // Open the newest day that got anything; a day of only clips opens in Videos.
      const shoots = await refreshMenus(`${app.view?.kind}:${app.view?.id}`);
      if (shoots.length) {
        await loadView('library:all', 'library');
        library.setZoomLevel('days');
      }
      if (autoEject.checked) $('#importEject').click();
    } catch (e) {
      $('#importNow').textContent = `import stopped: ${e.message}`;
      app.status(`import failed: ${e.message}`, 0);
      notify('Import stopped', e.message);
    } finally {
      running = false;
      document.title = 'Framewright';
      bar.classList.remove('on', 'determinate');
      $('#cardBar').hidden = true;
      native({ type: 'import', running: false, progress: 0 });
      $('#importJpeg').disabled = $('#importDelete').disabled = false;
      await loadPlan().catch(() => {});
    }
  }

  // One click imports; while importing (or with nothing new) it shows details.
  btn.addEventListener('click', async () => {
    btn.blur();
    if (!running && groups.length && !error) return run();
    $('#importProgress').hidden = !running;
    dlg.showModal();
    if (!running) await loadPlan();
  });
  btn.addEventListener('contextmenu', e => { e.preventDefault(); dlg.showModal(); if (!running) loadPlan(); });
  $('#importJpeg').addEventListener('change', loadPlan);
  go.addEventListener('click', run);
  $('#importClose').addEventListener('click', () => dlg.close());
  $('#importEject').addEventListener('click', async () => {
    try {
      const res = await app.post('/api/eject', {});
      dlg.close();
      card = null;
      btn.hidden = $('#cardBox').hidden = true;
      app.status(`ejected ${res.ejected}; safe to pull the card`, 5000);
    } catch (e) {
      app.status(`couldn't eject: ${e.message}`, 0);
    }
  });
  // Format: offered once everything on the card is in the library. The server
  // re-checks every file by hash before erasing, and wants the name typed.
  $('#importFormat').addEventListener('click', async () => {
    const name = (card || '').split(', ')[0];
    const typed = prompt(`Erase everything on "${name}"? Framewright first checks that every photo and clip on it is safely in the library, then formats it (keeping its name). Files Framewright doesn't import are erased too.\n\nType the card's name to confirm:`);
    if (typed === null) return;
    try {
      await app.post('/api/card/format', { card: name, confirm: typed.trim() });
      let st;
      do {
        await new Promise(r => setTimeout(r, 700));
        st = await (await fetch('/api/card/format')).json();
        $('#importNow').textContent = st.phase === 'erasing' ? `formatting ${name}…` : `checking every file on ${name} against the library…`;
        $('#importProgress').hidden = false;
      } while (st.running);
      if (st.error) throw new Error(st.error);
      $('#importNow').textContent = `${name} formatted; it's empty and ready for the camera`;
      app.status(`formatted ${name}`, 5000);
      notify('Card formatted', `${name} is empty and ready for the camera.`);
    } catch (e) {
      $('#importNow').textContent = `not formatted: ${e.message}`;
      app.status(`not formatted: ${e.message}`, 0);
    }
    await loadPlan().catch(() => {});
  });

  // The Mac app's File ▸ Import menu item (⌘I) lands here.
  window.framewrightImport = () => (card && groups.length && !running ? run() : btn.hidden ? app.status('no camera card connected', 3000) : btn.click());
  poll();
  setInterval(poll, 2000);
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

function shortDate(date) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric', year: y === new Date().getFullYear() ? undefined : 'numeric' };
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

function bytes(n) {
  return n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TB` : n >= 2 ** 30 ? `${Math.round(n / 2 ** 30)} GB` : `${Math.round(n / 2 ** 20)} MB`;
}

// --- sidebar ---------------------------------------------------------------------

function paintNav() {
  const lib = app.view?.kind === 'library';
  const on = (id, yes) => $(id).classList.toggle('on', !!yes);
  on('#navCollections', app.tab === 'collections' || (app.view?.kind === 'collection' && app.tab !== 'collections'));
  on('#navPicks', app.tab !== 'collections' && lib && library.filter() === 'picks');
  on('#navLibrary', app.tab !== 'collections' && lib && library.filter() !== 'picks');
  for (const b of document.querySelectorAll('#recentCols .side-col')) {
    b.classList.toggle('on', app.tab !== 'collections' && app.view?.kind === 'collection' && app.view.id === b.dataset.slug);
  }
}

async function openLibrary(filter = 'all') {
  if (app.view?.kind !== 'library') await loadView('library:all', 'library');
  else app.setTab('library');
  setFilter(filter);
  paintNav();
}

$('#navLibrary').addEventListener('click', e => { e.currentTarget.blur(); openLibrary('all'); });
$('#navPicks').addEventListener('click', e => { e.currentTarget.blur(); openLibrary('picks'); });
$('#navCollections').addEventListener('click', e => { e.currentTarget.blur(); app.setTab('collections'); });
$('#viewBack').addEventListener('click', e => { e.currentTarget.blur(); openLibrary('all'); });
for (const b of document.querySelectorAll('#zoomLevel button')) {
  b.setAttribute('aria-pressed', b.dataset.zoom === library.zoomLevel);
  b.addEventListener('click', () => { b.blur(); library.setZoomLevel(b.dataset.zoom); });
}

// --- collections workspace -----------------------------------------------------------
//
// Every collection as a card with a cover from its items (or its days' picks),
// grouped by month of its date. Clicking one opens it in the Library.

let colKind = '';
for (const b of document.querySelectorAll('#colKind button')) {
  b.addEventListener('click', () => {
    b.blur();
    colKind = b.dataset.kind;
    for (const x of document.querySelectorAll('#colKind button')) x.setAttribute('aria-pressed', x === b);
    renderCollections();
  });
}

function renderCollections() {
  const grid = $('#colGrid');
  const shown = app.collections.filter(c => !colKind || c.kind === colKind);
  const KIND = { trip: 'Trip', post: 'Post', set: 'Set' };
  let month = null, html = '';
  for (const c of shown) {
    const m = c.date ? c.date.slice(0, 7) : '';
    if (m !== month) {
      if (month !== null) html += '</div>';
      month = m;
      html += `<h2 class="col-month">${m ? monthLabel(m) : 'Undated'}</h2><div class="col-cards">`;
    }
    const counts = [c.photos && plural(c.photos, 'photo'), c.clips && plural(c.clips, 'clip')].filter(Boolean).join(' · ') || 'empty';
    const range = c.days ? ` · ${shortDate(c.days.from)}–${shortDate(c.days.to)}` : '';
    html += `<article class="col-card" data-slug="${c.slug}">
      <button class="col-open" aria-label="Open ${c.name}">
        <span class="mosaic n${c.cover.length}">${c.cover.map(u => `<img loading="lazy" alt="" src="${u}">`).join('')}
          <span class="chip kind">${KIND[c.kind] || ''}</span></span>
      </button>
      <div class="col-meta">
        <div class="col-title"><strong>${c.name}</strong><span class="col-date" title="${c.dateSet ? 'Date you set' : 'Latest day it covers'}">${shortDate(c.date)}</span></div>
        <div class="hint">${counts}${range}</div>
        <div class="col-actions">
          <button data-act="date">Set date</button><button data-act="rename">Rename</button><button data-act="delete">Delete</button>
        </div>
      </div>
    </article>`;
  }
  if (month !== null) html += '</div>';
  grid.innerHTML = html || '<p class="empty">No collections yet. Make one, then press S on photos and clips to add them.</p>';
  for (const card of grid.querySelectorAll('.col-card')) {
    const slug = card.dataset.slug, c = app.collections.find(x => x.slug === slug);
    card.querySelector('.col-open').addEventListener('click', () => loadView(`collection:${slug}`, 'library'));
    card.querySelector('[data-act=date]').addEventListener('click', async () => {
      const date = prompt(`Date for ${c.name} (YYYY-MM-DD), or leave empty to use the latest day it covers:`, c.dateSet ? c.date : '');
      if (date === null) return;
      try {
        await app.post('/api/collections/date', { collection: slug, date: date.trim() });
        await refreshMenus(`${app.view?.kind}:${app.view?.id}`);
      } catch (e) { app.status(`couldn't set the date: ${e.message}`, 0); }
    });
    card.querySelector('[data-act=rename]').addEventListener('click', () => { setTarget(slug); renameCollection(); });
    card.querySelector('[data-act=delete]').addEventListener('click', () => { setTarget(slug); deleteCollection(); });
  }
}

$('#newCol2').addEventListener('click', e => { e.currentTarget.blur(); newCollection(); });

async function start() {
  const q = new URLSearchParams(location.search);
  let want = q.get('view') || (q.get('shoot') ? `shoot:${q.get('shoot')}` : 'library:all');
  if (want?.startsWith('trip:')) want = 'collection:' + want.slice(5);
  const shoots = await refreshMenus(want);
  const sel = $('#shoot');
  setTarget(stored('studio.target', ''));
  sel.addEventListener('change', () => { sel.blur(); loadView(sel.value, app.tab); });
  if (sel.value && (shoots.length || sel.value !== 'library:all')) loadView(sel.value, q.get('tab'), q.get('frame'));
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
