// Cut: assemble clips into an edit. The clip bin and player are the Videos
// grid (videos.js); this adds the cut itself — a timeline of trimmed clips
// saved as <library>/cuts/<slug>.cut.json — program playback across clips,
// and export through ffmpeg (cuts.py).
//
// Source mode: the player shows the bin's clip; I and O mark in and out, E
// appends that range. Program mode: clicking the timeline plays the cut; B
// splits at the playhead, ⌫ ripple-deletes the selected clip, ⌘Z undoes.

const $ = s => document.querySelector(s);

export function createCut(app, videos) {
  const video = $('#vidPlayer'), track = $('#cutTrack');
  let cut = null, slug = null, list = [], meta = new Map();
  let mode = 'source', playhead = 0, selected = -1, playing = false, at = -1;
  let marks = { in: null, out: null }, history = [], future = [], saveTimer = null;

  const ref = c => `${c.shoot}/${c.key}`;
  const len = c => c.out - c.in;
  const total = () => (cut?.clips || []).reduce((t, c) => t + len(c), 0);
  const clock = videos.clock;

  // --- loading and saving -------------------------------------------------------

  async function refreshList(keep) {
    list = (await (await fetch('/api/cuts')).json()).cuts;
    const sel = $('#cutPick');
    sel.innerHTML = list.map(c => `<option value="${c.slug}">${c.name}</option>`).join('') +
      '<option value="">+ New cut…</option>';
    sel.value = keep ?? slug ?? '';
  }

  async function clipMeta(shoot) {
    if (meta.has(shoot)) return;
    const res = await fetch(`/api/clips?shoot=${encodeURIComponent(shoot)}`);
    const days = res.ok ? (await res.json()).days : [];
    meta.set(shoot, new Map(days.flatMap(d => d.clips).map(c => [c.key, c])));
  }
  const info = c => meta.get(c.shoot)?.get(c.key);

  async function open(which) {
    if (!which) return;
    const res = await fetch(`/api/cut?slug=${encodeURIComponent(which)}`);
    if (!res.ok) return app.status('that cut is gone', 3000);
    cut = (await res.json()).cut;
    slug = which;
    await Promise.all([...new Set(cut.clips.map(c => c.shoot))].map(clipMeta));
    history = []; future = []; playhead = 0; selected = -1;
    $('#cutPick').value = slug;
    try { localStorage.setItem('studio.cut', slug); } catch { /* private window */ }
    paint();
  }

  async function create() {
    const name = prompt('Name for the new cut:', `Cut ${new Date().toISOString().slice(0, 10)}`);
    if (!name) { $('#cutPick').value = slug ?? ''; return; }
    try {
      const res = await app.post('/api/cut/save', { cut: { name, clips: [], log709: true } });
      await refreshList(res.slug);
      await open(res.slug);
    } catch (e) {
      app.status(`couldn't make it: ${e.message}`, 0);
      $('#cutPick').value = slug ?? '';
    }
  }

  function change(fn) {
    if (!cut) return app.status('make a cut first: + New cut', 3000);
    history.push(JSON.stringify(cut.clips));
    future = [];
    fn(cut.clips);
    paint();
    save();
  }

  function save() {
    clearTimeout(saveTimer);
    $('#cutState').textContent = 'saving…';
    saveTimer = setTimeout(async () => {
      try {
        const res = await app.post('/api/cut/save', { slug, cut: { name: cut.name, clips: cut.clips, log709: cut.log709 } });
        if (res.slug !== slug) { slug = res.slug; await refreshList(slug); }
        $('#cutState').textContent = 'saved';
      } catch (e) {
        $('#cutState').textContent = `not saved: ${e.message}`;
      }
    }, 500);
  }

  function undo(redo = false) {
    const from = redo ? future : history, to = redo ? history : future;
    if (!cut || !from.length) return;
    to.push(JSON.stringify(cut.clips));
    cut.clips = JSON.parse(from.pop());
    paint();
    save();
  }

  // --- editing --------------------------------------------------------------------

  function append() {
    const src = videos.current();
    if (!src) return app.status('choose a clip in the bin first', 2500);
    if (!src.online) return app.status(`${src.key} is on a drive that is not plugged in`, 3000);
    const dur = src.duration || video.duration || 0;
    const start = marks.in ?? 0, end = marks.out ?? dur;
    if (!(end > start)) return app.status('out must come after in', 2500);
    if (!meta.has(src.shoot)) meta.set(src.shoot, new Map());
    meta.get(src.shoot).set(src.key, src);
    change(cs => cs.push({ shoot: src.shoot, key: src.key, in: +start.toFixed(3), out: +end.toFixed(3) }));
    marks = { in: null, out: null };
    paintMarks();
    app.status(`added ${src.key} (${clock(end - start)})`);
  }

  function locate(t) {
    let acc = 0;
    for (let i = 0; i < cut.clips.length; i++) {
      const l = len(cut.clips[i]);
      if (t < acc + l || i === cut.clips.length - 1) return { i, offset: Math.max(0, Math.min(l, t - acc)), start: acc };
      acc += l;
    }
    return null;
  }

  function split() {
    const hit = cut && locate(playhead);
    if (!hit || hit.offset < 0.05 || len(cut.clips[hit.i]) - hit.offset < 0.05) return app.status('move the playhead inside a clip to split it', 2500);
    change(cs => {
      const c = cs[hit.i], cutAt = +(c.in + hit.offset).toFixed(3);
      cs.splice(hit.i, 1, { ...c, out: cutAt }, { ...c, in: cutAt });
    });
    selected = hit.i + 1;
    paint();
  }

  function remove() {
    if (selected < 0 || !cut?.clips[selected]) return;
    const i = selected;
    change(cs => cs.splice(i, 1));
    selected = Math.min(i, cut.clips.length - 1);
    playhead = Math.min(playhead, total());
    paint();
  }

  // --- program playback: hand off from clip to clip ---------------------------------

  function load(i, offset, play) {
    const c = cut.clips[i], m = info(c);
    if (!m) return app.status(`${c.key} isn't in the library`, 3000);
    if (!m.online) { stop(); return app.status(`${c.key} is on a drive that is not plugged in`, 3000); }
    at = i;
    videos.openClip(m);
    const go = () => {
      video.currentTime = c.in + offset;
      if (play) video.play().catch(() => {});
    };
    if (video.readyState >= 1 && video.src.endsWith(`/${c.key}`)) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
  }

  function seek(t, play = playing) {
    if (!cut?.clips.length) return;
    playhead = Math.max(0, Math.min(total(), t));
    const hit = locate(playhead);
    load(hit.i, hit.offset, play);
    paintHead();
  }

  function play() {
    if (!cut?.clips.length) return;
    mode = 'program';
    playing = true;
    if (playhead >= total() - 0.05) playhead = 0;
    seek(playhead, true);
    paintMode();
  }

  function stop() {
    playing = false;
    video.pause();
    paintMode();
  }

  function tick() {
    if (mode !== 'program' || at < 0 || !cut?.clips[at]) return;
    const c = cut.clips[at];
    const start = cut.clips.slice(0, at).reduce((t, x) => t + len(x), 0);
    playhead = start + Math.max(0, Math.min(len(c), video.currentTime - c.in));
    if (playing && video.currentTime >= c.out - 0.02) {
      if (at + 1 < cut.clips.length) load(at + 1, 0, true);
      else { playhead = total(); stop(); }
    }
    paintHead();
  }
  video.addEventListener('timeupdate', tick);
  (function frame() { if (playing) tick(); requestAnimationFrame(frame); })();
  video.addEventListener('pause', () => { if (mode === 'program' && playing && video.currentTime < (cut?.clips[at]?.out ?? 0) - 0.05) { playing = false; paintMode(); } });

  // --- drawing ----------------------------------------------------------------------

  const pps = () => {
    const width = track.clientWidth - 24;
    return Math.max(4, width / Math.max(total(), 10));
  };

  function paint() {
    $('#cutName').textContent = cut ? cut.name : 'No cut yet';
    $('#cutStats').textContent = cut ? `${cut.clips.length} clip${cut.clips.length === 1 ? '' : 's'} · ${clock(total())}` : '';
    $('#cutLog').setAttribute('aria-pressed', !!cut?.log709);
    $('#cutLog').disabled = $('#cutExport').disabled = !cut;
    const scale = pps();
    const ruler = $('#cutRuler'), step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * scale >= 70) || 600;
    let ticks = '';
    for (let t = 0; t <= Math.max(total(), 10); t += step) ticks += `<span style="left:${t * scale}px">${clock(t)}</span>`;
    ruler.innerHTML = ticks;
    const blocks = $('#cutBlocks');
    blocks.innerHTML = '';
    if (!cut?.clips.length) {
      blocks.innerHTML = `<p class="cut-empty">${cut ? 'Choose a clip above, mark in (I) and out (O), then press E to add it here.' : 'Make a cut with + New cut, then add clips with E.'}</p>`;
    }
    (cut?.clips || []).forEach((c, i) => {
      const b = document.createElement('div');
      b.className = 'cut-clip' + (i === selected ? ' sel' : '');
      b.style.width = `${Math.max(6, len(c) * scale - 2)}px`;
      b.draggable = true;
      b.dataset.i = i;
      b.style.backgroundImage = `url("/clipposter/${encodeURIComponent(c.shoot)}/${c.key}.jpg")`;
      b.innerHTML = `<span class="nm">${c.key}</span><span class="du">${len(c).toFixed(1)}s</span>
        <i class="trim l" title="Drag to trim the start"></i><i class="trim r" title="Drag to trim the end"></i>`;
      b.addEventListener('click', e => {
        if (e.target.classList.contains('trim')) return;
        selected = i;
        mode = 'program';
        const start = cut.clips.slice(0, i).reduce((t, x) => t + len(x), 0);
        const x = e.offsetX / scale;
        seek(start + Math.min(len(c), Math.max(0, x)), false);
        paint();
      });
      b.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); b.classList.add('dragging'); });
      b.addEventListener('dragend', () => b.classList.remove('dragging'));
      b.addEventListener('dragover', e => e.preventDefault());
      b.addEventListener('drop', e => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        if (Number.isNaN(from) || from === i) return;
        change(cs => { const [m] = cs.splice(from, 1); cs.splice(i, 0, m); });
        selected = i;
        paint();
      });
      for (const side of ['l', 'r']) b.querySelector(`.trim.${side}`).addEventListener('mousedown', e => trimDrag(e, i, side, scale));
      blocks.appendChild(b);
    });
    paintHead();
    paintMode();
  }

  function trimDrag(e, i, side, scale) {
    e.preventDefault();
    e.stopPropagation();
    const c = cut.clips[i], m = info(c), max = m?.duration ?? c.out + 600, x0 = e.clientX;
    const before = JSON.stringify(cut.clips), orig = { ...c };
    const move = ev => {
      const dt = (ev.clientX - x0) / scale;
      if (side === 'l') c.in = +Math.max(0, Math.min(orig.out - 0.1, orig.in + dt)).toFixed(3);
      else c.out = +Math.min(max, Math.max(orig.in + 0.1, orig.out + dt)).toFixed(3);
      paint();
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      if (JSON.stringify(cut.clips) !== before) { history.push(before); future = []; save(); }
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }

  function paintHead() {
    $('#cutHead').style.left = `${playhead * pps()}px`;
    $('#cutTime').textContent = `${clock(playhead)} / ${clock(total())}`;
  }

  function paintMode() {
    $('#cutMode').textContent = mode === 'program' ? 'Timeline' : 'Source';
    $('#cutMode').className = `cut-mode ${mode}`;
    $('#cutPlay').textContent = playing ? '❚❚' : '▶';
  }

  function paintMarks() {
    const src = videos.current();
    $('#cutMarks').textContent = src
      ? `${src.key} · in ${marks.in == null ? '—' : clock(marks.in)} · out ${marks.out == null ? '—' : clock(marks.out)} · E adds it`
      : 'Choose a clip to add';
  }

  // --- export -------------------------------------------------------------------------

  async function exportCut() {
    if (!cut?.clips.length) return app.status('add clips before exporting', 2500);
    const dlg = $('#cutExportDlg');
    $('#cutExportName').textContent = cut.name;
    $('#cutExportNow').textContent = '';
    $('#cutExportBar').value = 0;
    $('#cutExportReveal').hidden = true;
    $('#cutExportGo').disabled = false;
    dlg.showModal();
  }

  $('#cutExportGo').addEventListener('click', async () => {
    $('#cutExportGo').disabled = true;
    try {
      clearTimeout(saveTimer);
      await app.post('/api/cut/save', { slug, cut: { name: cut.name, clips: cut.clips, log709: cut.log709 } });
      await app.post('/api/cut/export', { slug, size: $('#cutExportSize').value, codec: $('#cutExportCodec').value });
      let st;
      do {
        await new Promise(r => setTimeout(r, 500));
        st = await (await fetch('/api/cut/export')).json();
        $('#cutExportBar').value = st.progress || 0;
        $('#cutExportNow').textContent = `rendering ${Math.round((st.progress || 0) * 100)}%`;
      } while (st.running);
      if (st.error) throw new Error(st.error);
      $('#cutExportNow').textContent = `exported ${st.name}`;
      $('#cutExportReveal').hidden = false;
      app.status(`exported ${cut.name}`, 4000);
    } catch (e) {
      $('#cutExportNow').textContent = `export failed: ${e.message}`;
    } finally {
      $('#cutExportGo').disabled = false;
    }
  });
  $('#cutExportReveal').addEventListener('click', () => app.post('/api/cut/reveal', {}).catch(e => app.status(e.message, 3000)));
  $('#cutExportClose').addEventListener('click', () => $('#cutExportDlg').close());

  // --- controls -------------------------------------------------------------------------

  $('#cutPick').addEventListener('change', e => { e.target.blur(); e.target.value ? open(e.target.value) : create(); });
  $('#cutRename').addEventListener('click', e => {
    e.currentTarget.blur();
    if (!cut) return;
    const name = prompt('Rename the cut:', cut.name);
    if (!name || name === cut.name) return;
    cut.name = name;
    paint();
    save();
  });
  $('#cutLog').addEventListener('click', e => { e.currentTarget.blur(); if (cut) { cut.log709 = !cut.log709; paint(); save(); } });
  $('#cutExport').addEventListener('click', e => { e.currentTarget.blur(); exportCut(); });
  $('#cutPlay').addEventListener('click', e => { e.currentTarget.blur(); playing ? stop() : play(); });
  $('#cutTrackArea').addEventListener('click', e => {
    if (e.target.closest('.cut-clip') || !cut?.clips.length) return;
    mode = 'program';
    selected = -1;
    seek((e.clientX - $('#cutBlocks').getBoundingClientRect().left) / pps(), false);
    paint();
  });
  new ResizeObserver(() => paint()).observe(track);
  videos.onFocus(() => { if (mode === 'program') stop(); mode = 'source'; marks = { in: null, out: null }; paintMarks(); paintMode(); });

  return {
    async show() {
      await refreshList();
      let want = slug;
      try { want = want || localStorage.getItem('studio.cut'); } catch { /* private window */ }
      if (want && list.some(c => c.slug === want)) { if (want !== slug) await open(want); else paint(); }
      else if (list[0]) await open(list[0].slug);
      else paint();
      paintMarks();
    },
    // Keys the Cut workspace takes before the bin's own (videos.js).
    onKey(e) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(e.shiftKey); return true; }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (k === ' ') { e.preventDefault(); if (mode === 'program') { playing ? stop() : play(); } else videos.toggle(); return true; }
      if (k === 'i' || k === 'o') {
        e.preventDefault();
        if (mode !== 'source' || !videos.current()) return true;
        marks[k === 'i' ? 'in' : 'out'] = video.currentTime;
        paintMarks();
        return true;
      }
      if (k === 'e') { e.preventDefault(); append(); return true; }
      if (k === 'b') { e.preventDefault(); split(); return true; }
      if ((k === 'backspace' || k === 'delete') && mode === 'program') { e.preventDefault(); remove(); return true; }
      if (mode === 'program' && (k === 'arrowleft' || k === 'arrowright')) {
        e.preventDefault();
        seek(playhead + (k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 1 : 1 / 24), false);
        return true;
      }
      return false;
    },
  };
}
