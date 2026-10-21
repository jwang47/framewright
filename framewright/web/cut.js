// Cut: assemble clips into an edit. The clip bin and player are the Videos
// grid (videos.js); this adds the cut itself — clips on a timeline, saved as
// <library>/cuts/<slug>.cut.json (cuts.py documents the format) — gapless
// program playback, and export through ffmpeg.
//
// Source mode: the player shows the bin's clip; I and O mark in and out, E
// appends that range. Program mode (click the timeline): Space plays the cut,
// handing off between two players so cuts don't stall; transitions blend the
// two through the player's shader. B splits, ⌫ deletes, C adds or changes a
// transition, M toggles slow motion on 120p clips, T adds a title, ⌘Z undoes.

const $ = s => document.querySelector(s);
const db = g => Math.min(1, Math.pow(10, (g || 0) / 20));

export function createCut(app, videos) {
  const music = $('#cutMusic'), overlay = $('#cutTitle'), track = $('#cutTrack');
  let cut = null, slug = null, list = [], meta = new Map();
  let mode = 'source', playhead = 0, playing = false, at = -1;
  let sel = { kind: null, i: -1 };
  let marks = { in: null, out: null }, history = [], future = [], saveTimer = null;

  const clock = videos.clock;
  const clips = () => cut?.clips || [];
  const speedOf = c => c.speed || 1;
  const len = c => (c.out - c.in) / speedOf(c);
  const starts = () => {
    const out = [];
    let t = 0;
    clips().forEach((c, i) => { if (i) t -= c.trans?.dur || 0; out.push(t); t += len(c); });
    return out;
  };
  const total = () => { const s = starts(), cs = clips(); return cs.length ? s.at(-1) + len(cs.at(-1)) : 0; };
  const info = c => meta.get(c.shoot)?.get(c.key);
  const fpsOut = () => info(clips()[0] || {})?.fps || 23.976;

  // --- loading and saving -------------------------------------------------------

  async function refreshList(keep) {
    list = (await (await fetch('/api/cuts')).json()).cuts;
    $('#cutPick').innerHTML = list.map(c => `<option value="${c.slug}">${c.name}</option>`).join('') +
      '<option value="">+ New cut…</option>';
    $('#cutPick').value = keep ?? slug ?? '';
  }

  async function clipMeta(shoot) {
    if (meta.has(shoot)) return;
    const res = await fetch(`/api/clips?shoot=${encodeURIComponent(shoot)}`);
    const days = res.ok ? (await res.json()).days : [];
    meta.set(shoot, new Map(days.flatMap(d => d.clips).map(c => [c.key, c])));
  }

  async function open(which) {
    if (!which) return;
    const res = await fetch(`/api/cut?slug=${encodeURIComponent(which)}`);
    if (!res.ok) return app.status('that cut is gone', 3000);
    stop();
    cut = (await res.json()).cut;
    cut.titles ||= [];
    slug = which;
    $('#cutPick').value = slug;
    await Promise.all([...new Set(cut.clips.map(c => c.shoot))].map(clipMeta));
    history = []; future = []; playhead = 0; sel = { kind: null, i: -1 };
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

  const snapshot = () => JSON.stringify({ clips: cut.clips, titles: cut.titles, music: cut.music, clipGain: cut.clipGain });
  const restore = text => Object.assign(cut, JSON.parse(text));

  function change(fn) {
    if (!cut) return app.status('make a cut first: + New cut', 3000);
    history.push(snapshot());
    future = [];
    fn(cut);
    paint();
    save();
  }

  function body() {
    const out = { name: cut.name, clips: cut.clips, log709: cut.log709, titles: cut.titles };
    if (cut.music) out.music = cut.music;
    if (cut.clipGain) out.clipGain = cut.clipGain;
    return out;
  }

  function save() {
    clearTimeout(saveTimer);
    $('#cutState').textContent = 'saving…';
    saveTimer = setTimeout(async () => {
      try {
        const res = await app.post('/api/cut/save', { slug, cut: body() });
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
    to.push(snapshot());
    restore(from.pop());
    paint();
    save();
  }

  // --- editing --------------------------------------------------------------------

  function append() {
    const src = videos.current();
    if (!src) return app.status('choose a clip in the bin first', 2500);
    if (!src.online) return app.status(`${src.key} is on a drive that is not plugged in`, 3000);
    const dur = src.duration || videos.active().duration || 0;
    const start = marks.in ?? 0, end = marks.out ?? dur;
    if (!(end > start)) return app.status('out must come after in', 2500);
    if (!meta.has(src.shoot)) meta.set(src.shoot, new Map());
    meta.get(src.shoot).set(src.key, src);
    change(k => k.clips.push({ shoot: src.shoot, key: src.key, in: +start.toFixed(3), out: +end.toFixed(3) }));
    marks = { in: null, out: null };
    paintMarks();
    app.status(`added ${src.key} (${clock(end - start)})`);
  }

  function locate(t) {
    const s = starts(), cs = clips();
    for (let i = cs.length - 1; i >= 0; i--) if (t >= s[i] || i === 0) return { i, offset: Math.max(0, Math.min(len(cs[i]), t - s[i])) };
    return null;
  }

  function split() {
    const hit = cut && locate(playhead);
    if (!hit || hit.offset < 0.05 || len(clips()[hit.i]) - hit.offset < 0.05) return app.status('move the playhead inside a clip to split it', 2500);
    change(k => {
      const c = k.clips[hit.i], cutAt = +(c.in + hit.offset * speedOf(c)).toFixed(3);
      const { trans, ...rest } = c;
      k.clips.splice(hit.i, 1, { ...c, out: cutAt }, { ...rest, in: cutAt });
    });
    sel = { kind: 'clip', i: hit.i + 1 };
    paint();
  }

  function remove() {
    if (sel.kind === 'title' && cut?.titles[sel.i]) {
      const i = sel.i;
      change(k => k.titles.splice(i, 1));
    } else if (sel.kind === 'clip' && cut?.clips[sel.i]) {
      const i = sel.i;
      change(k => { k.clips.splice(i, 1); if (k.clips[0]) delete k.clips[0].trans; });
      sel.i = Math.min(i, clips().length - 1);
      playhead = Math.min(playhead, total());
    } else return;
    paint();
  }

  // None → crossfade → dip to black → none, on the transition into a clip.
  function cycleTransition(i, longer = false) {
    if (!cut?.clips[i] || i === 0) return app.status('select a clip after the first to add a transition into it', 3000);
    change(k => {
      const c = k.clips[i], room = Math.min(len(c), len(k.clips[i - 1])) / 2;
      if (longer && c.trans) {
        const steps = [0.25, 0.5, 1, 2], next = steps.find(s => s > c.trans.dur + 0.01) ?? steps[0];
        c.trans.dur = Math.min(next, room);
      } else if (!c.trans) c.trans = { type: 'cross', dur: Math.min(0.5, room) };
      else if (c.trans.type === 'cross') c.trans.type = 'dip';
      else delete c.trans;
    });
    const t = clips()[i].trans;
    app.status(t ? `${t.type === 'dip' ? 'dip to black' : 'crossfade'}, ${t.dur}s` : 'cut');
  }

  // Speed of one clip: a preset, the 120p → 24p conform, or a typed percent.
  function setSpeed(i, value) {
    const c = cut?.clips[i];
    if (!c) return app.status('select a clip on the timeline', 2500);
    let speed;
    if (value === 'slow') {
      const m = info(c), fps = m?.captureFps || m?.fps || 0;
      if (!(fps > fpsOut() * 1.5)) return app.status(`${c.key} isn't high frame rate; pick a percent instead`, 3000);
      speed = +(fpsOut() / fps).toFixed(4);
    } else if (value === 'custom') {
      const typed = prompt('Speed in percent (5–400):', Math.round(speedOf(c) * 100));
      if (typed === null) return paintSpeed();
      speed = +typed / 100;
      if (!(speed >= 0.05 && speed <= 4)) { paintSpeed(); return app.status('speed runs from 5% to 400%', 3000); }
    } else speed = +value;
    change(k => { if (speed === 1) delete k.clips[i].speed; else k.clips[i].speed = speed; });
    app.status(speed === 1 ? 'normal speed' : `${Math.round(speed * 100)}% speed${speed !== 1 ? ' (silent)' : ''}`);
  }

  function paintSpeed() {
    const c = sel.kind === 'clip' ? cut?.clips[sel.i] : null, menu = $('#cutSpeed');
    menu.disabled = !c;
    if (!c) { menu.value = '1'; return; }
    const s = speedOf(c), preset = [...menu.options].find(o => +o.value === s);
    let custom = menu.querySelector('option[data-current]');
    if (preset) { custom?.remove(); menu.value = preset.value; return; }
    if (!custom) { custom = document.createElement('option'); custom.dataset.current = '1'; menu.insertBefore(custom, menu.lastElementChild); }
    custom.value = String(s);
    custom.textContent = `${Math.round(s * 1000) / 10}%`;
    menu.value = custom.value;
  }

  // A 120p clip plays as slow motion in a 24p cut: speed = cut fps / clip fps.
  function toggleSlow(i) {
    const c = cut?.clips[i];
    if (!c) return app.status('select a clip on the timeline', 2500);
    const m = info(c), fps = m?.captureFps || m?.fps || 0;
    change(k => {
      const x = k.clips[i];
      if (x.speed && x.speed !== 1) delete x.speed;
      else x.speed = fps > fpsOut() * 1.5 ? +(fpsOut() / fps).toFixed(4) : 0.5;
    });
    const s = clips()[i].speed;
    app.status(s ? `slow motion ×${(1 / s).toFixed(1)} (silent)` : 'normal speed');
  }

  function addTitle() {
    if (!cut) return app.status('make a cut first: + New cut', 3000);
    const text = prompt('Title text:');
    if (!text?.trim()) return;
    const lower = confirm('Show it as a lower third? (Cancel centres it.)');
    change(k => k.titles.push({ text: text.trim(), at: +playhead.toFixed(2), dur: 3, style: lower ? 'lower' : 'center' }));
    sel = { kind: 'title', i: cut.titles.length - 1 };
    paint();
  }

  // --- program playback: two players, handed off at each edit ----------------------

  function startAt(t, play) {
    const cs = clips();
    if (!cs.length) return;
    mode = 'program';
    videos.program(true);
    playhead = Math.max(0, Math.min(total(), t));
    const hit = locate(playhead), c = cs[hit.i], m = info(c);
    if (!m?.online) { stop(); return app.status(`${c.key} is on a drive that is not plugged in`, 3000); }
    at = hit.i;
    videos.openClip(m);
    const el = videos.active();
    const go = () => {
      el.currentTime = c.in + hit.offset * speedOf(c);
      setRate(el, c);
      el.volume = db(cut.clipGain);
      if (play) el.play().catch(() => {});
      primeNext();
    };
    if (el.readyState >= 1 && videos.holds(el, c)) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
    if (play) startMusic();
    paintHead();
    paintMarks();
  }

  function setRate(el, c) {
    el.playbackRate = speedOf(c);
    el.muted = speedOf(c) !== 1;
  }

  function primeNext() {
    const next = clips()[at + 1];
    if (!next) return;
    const m = info(next);
    if (m?.online) videos.prime(m, next.in);
  }

  function play() {
    if (!clips().length) return;
    if (playhead >= total() - 0.05) playhead = 0;
    playing = true;
    startAt(playhead, true);
    paintMode();
  }

  function stop() {
    playing = false;
    for (const el of [videos.active(), videos.primed()?.el]) el?.pause();
    music.pause();
    videos.setMix(null);
    paintMode();
  }

  function seek(t) { startAt(t, false); paintTitle(); }

  function tick() {
    requestAnimationFrame(tick);
    if (!playing || mode !== 'program' || at < 0) return;
    const cs = clips(), s = starts(), c = cs[at];
    if (!c) return stop();
    const el = videos.active();
    playhead = s[at] + (el.currentTime - c.in) / speedOf(c);
    const next = cs[at + 1], primed = videos.primed();
    if (next && primed && next.trans && playhead >= s[at + 1]) {
      // Inside a transition: both play, blended by the shader.
      const amt = Math.min(1, (playhead - s[at + 1]) / next.trans.dur);
      if (primed.el.paused) { setRate(primed.el, next); primed.el.play().catch(() => {}); }
      const g = db(cut.clipGain);
      el.volume = g * (1 - amt);
      primed.el.volume = g * amt;
      videos.setMix(primed.el, amt, next.trans.type === 'dip', info(next)?.log);
    }
    if (el.currentTime >= c.out - 0.03 || el.ended) {
      if (next && primed && primed.el.readyState >= 2) {
        if (primed.el.paused) { setRate(primed.el, next); primed.el.play().catch(() => {}); }
        primed.el.volume = db(cut.clipGain);
        videos.swap();
        at += 1;
        primeNext();
      } else if (next) {
        startAt(s[at + 1], true);         // not ready in time: load it directly
      } else {
        playhead = total();
        stop();
      }
    }
    paintHead();
    paintTitle();
    musicLevel();
  }
  requestAnimationFrame(tick);

  function startMusic() {
    const m = cut?.music;
    if (!m) { music.pause(); return; }
    const src = `/music/${encodeURIComponent(m.file)}`;
    if (!music.src.endsWith(src)) music.src = src;
    const go = () => { music.currentTime = m.start + playhead; musicLevel(); music.play().catch(() => {}); };
    if (music.readyState >= 1) go(); else music.addEventListener('loadedmetadata', go, { once: true });
  }

  function musicLevel() {
    const m = cut?.music;
    if (!m) return;
    const fade = Math.max(0.01, Math.min(m.fade, total() / 2));
    const env = Math.max(0, Math.min(1, playhead / fade, (total() - playhead) / fade));
    music.volume = db(m.gain) * env;
  }

  function paintTitle() {
    const t = (cut?.titles || []).find(x => playhead >= x.at && playhead <= x.at + x.dur);
    overlay.hidden = !t || mode !== 'program';
    if (!t) return;
    const fade = Math.min(0.3, t.dur / 3);
    overlay.className = `cut-overlay ${t.style}`;
    overlay.innerHTML = t.style === 'lower' ? '<span></span>' : '';
    (overlay.querySelector('span') || overlay).textContent = t.text;
    overlay.style.opacity = Math.max(0, Math.min(1, (playhead - t.at) / fade, (t.at + t.dur - playhead) / fade));
  }

  // --- drawing ----------------------------------------------------------------------

  let zoom = 1;
  const pps = () => Math.max(4, (track.clientWidth - 24) / Math.max(total(), 10)) * zoom;

  function paint() {
    $('#cutName').textContent = cut ? cut.name : 'No cut yet';
    $('#cutStats').textContent = cut ? `${clips().length} clip${clips().length === 1 ? '' : 's'} · ${clock(total())}` : '';
    $('#cutLog').setAttribute('aria-pressed', !!cut?.log709);
    for (const b of ['#cutLog', '#cutExport', '#cutTitleBtn', '#cutMusicBtn', '#cutRename']) $(b).disabled = !cut;
    const scale = pps(), s = starts(), width = Math.max(total(), 10) * scale + 40;
    $('#cutLanes').style.width = `${width}px`;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find(x => x * scale >= 70) || 600;
    let ticks = '';
    for (let t = 0; t <= Math.max(total(), 10); t += step) ticks += `<span style="left:${t * scale}px">${clock(t)}</span>`;
    $('#cutRuler').innerHTML = ticks;

    const lane = $('#cutBlocks');
    lane.innerHTML = clips().length ? '' : `<p class="cut-empty">${cut ? 'Choose a clip above, mark in (I) and out (O), then press E to add it here.' : 'Make a cut with + New cut, then add clips with E.'}</p>`;
    clips().forEach((c, i) => {
      const b = document.createElement('div');
      b.className = 'cut-clip' + (sel.kind === 'clip' && sel.i === i ? ' sel' : '') + (c.speed ? ' slow' : '');
      Object.assign(b.style, { left: `${s[i] * scale}px`, width: `${Math.max(6, len(c) * scale - 2)}px`,
        backgroundImage: `url("/clipposter/${encodeURIComponent(c.shoot)}/${c.key}.jpg")` });
      b.draggable = true;
      b.innerHTML = `<span class="nm">${c.key}${c.speed ? ` · ${Math.round(c.speed * 1000) / 10}%` : ''}</span>
        <span class="du">${len(c).toFixed(1)}s</span><i class="trim l"></i><i class="trim r"></i>`;
      b.addEventListener('click', e => {
        if (e.target.classList.contains('trim')) return;
        sel = { kind: 'clip', i };
        seek(s[i] + Math.max(0, Math.min(len(c), e.offsetX / scale)));
        paint();
      });
      b.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); b.classList.add('dragging'); });
      b.addEventListener('dragend', () => b.classList.remove('dragging'));
      b.addEventListener('dragover', e => e.preventDefault());
      b.addEventListener('drop', e => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        if (Number.isNaN(from) || from === i) return;
        change(k => { const [m] = k.clips.splice(from, 1); k.clips.splice(i, 0, m); if (k.clips[0]) delete k.clips[0].trans; });
        sel = { kind: 'clip', i };
        paint();
      });
      for (const side of ['l', 'r']) b.querySelector(`.trim.${side}`).addEventListener('mousedown', e => trimDrag(e, i, side, scale));
      lane.appendChild(b);
      if (i > 0) {
        const t = document.createElement('button');
        t.className = 'cut-join' + (c.trans ? ` ${c.trans.type}` : '');
        t.title = c.trans ? `${c.trans.type === 'dip' ? 'Dip to black' : 'Crossfade'} ${c.trans.dur}s · click to change, ⇧-click for longer` : 'Cut · click for a crossfade';
        t.textContent = c.trans ? (c.trans.type === 'dip' ? '▼' : '⨯') : '+';
        const w = c.trans ? c.trans.dur * scale : 0;
        t.style.left = `${s[i] * scale + w / 2 - 9}px`;
        t.addEventListener('click', e => { e.stopPropagation(); cycleTransition(i, e.shiftKey); });
        lane.appendChild(t);
      }
    });

    const titles = $('#cutTitles');
    titles.innerHTML = '';
    (cut?.titles || []).forEach((t, i) => {
      const b = document.createElement('div');
      b.className = 'cut-tblock' + (sel.kind === 'title' && sel.i === i ? ' sel' : '');
      Object.assign(b.style, { left: `${t.at * scale}px`, width: `${Math.max(16, t.dur * scale - 2)}px` });
      b.innerHTML = `<span></span><i class="trim r"></i>`;
      b.querySelector('span').textContent = `${t.style === 'lower' ? '▁ ' : 'T '}${t.text}`;
      b.title = 'Drag to move · double-click to edit · ⌫ deletes';
      b.addEventListener('mousedown', e => titleDrag(e, i, scale, e.target.classList.contains('trim')));
      b.addEventListener('dblclick', () => {
        const text = prompt('Title text (empty removes it):', t.text);
        if (text === null) return;
        change(k => { if (text.trim()) k.titles[i].text = text.trim(); else k.titles.splice(i, 1); });
      });
      titles.appendChild(b);
    });

    const m = cut?.music;
    $('#cutMusicLane').innerHTML = m ? `<div class="cut-mblock" style="width:${total() * scale}px"></div>` : '';
    if (m) $('#cutMusicLane .cut-mblock').textContent = `♪ ${m.file} · ${m.gain} dB`;
    paintHead();
    paintMode();
    paintSpeed();
  }

  function trimDrag(e, i, side, scale) {
    e.preventDefault();
    e.stopPropagation();
    const c = cut.clips[i], m = info(c), max = m?.duration ?? c.out + 600, x0 = e.clientX;
    const before = snapshot(), orig = { ...c }, sp = speedOf(c);
    const move = ev => {
      const dt = (ev.clientX - x0) / scale * sp;
      if (side === 'l') c.in = +Math.max(0, Math.min(orig.out - 0.1, orig.in + dt)).toFixed(3);
      else c.out = +Math.min(max, Math.max(orig.in + 0.1, orig.out + dt)).toFixed(3);
      paint();
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      if (snapshot() !== before) { history.push(before); future = []; save(); }
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }

  function titleDrag(e, i, scale, resize) {
    e.preventDefault();
    sel = { kind: 'title', i };
    const t = cut.titles[i], x0 = e.clientX, orig = { ...t }, before = snapshot();
    const move = ev => {
      const dt = (ev.clientX - x0) / scale;
      if (resize) t.dur = +Math.max(0.5, orig.dur + dt).toFixed(2);
      else t.at = +Math.max(0, Math.min(Math.max(0, total() - 0.5), orig.at + dt)).toFixed(2);
      paint();
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      if (snapshot() !== before) { history.push(before); future = []; save(); }
      else { seek(t.at); paint(); }
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
    if (mode !== 'program') overlay.hidden = true;
  }

  function paintMarks() {
    const src = videos.current();
    $('#cutMarks').textContent = src && mode === 'source'
      ? `${src.key} · in ${marks.in == null ? '—' : clock(marks.in)} · out ${marks.out == null ? '—' : clock(marks.out)} · E adds it`
      : mode === 'program' ? 'B split · C transition · M slow motion · T title · ⌫ delete' : 'Choose a clip to add';
  }

  // --- music ------------------------------------------------------------------------

  async function musicDialog() {
    if (!cut) return;
    const files = (await (await fetch('/api/music')).json()).music;
    const m = cut.music || { file: '', start: 0, gain: -12, fade: 1.5 };
    $('#musicFile').innerHTML = '<option value="">No music</option>' + files.map(f => `<option>${f}</option>`).join('');
    $('#musicFile').value = m.file;
    $('#musicStart').value = m.start;
    $('#musicGain').value = m.gain;
    $('#musicFade').value = m.fade;
    $('#clipGain').value = cut.clipGain || 0;
    $('#musicNow').textContent = '';
    paintLevels();
    $('#cutMusicDlg').showModal();
  }
  function paintLevels() {
    $('#musicGainV').textContent = `${$('#musicGain').value} dB`;
    $('#clipGainV').textContent = `${$('#clipGain').value} dB`;
  }
  for (const id of ['#musicGain', '#clipGain']) $(id).addEventListener('input', paintLevels);
  $('#musicUpload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('#musicNow').textContent = `uploading ${file.name}…`;
    try {
      const r = await fetch(`/api/music/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || r.status);
      $('#musicFile').innerHTML = '<option value="">No music</option>' + res.music.map(f => `<option>${f}</option>`).join('');
      $('#musicFile').value = res.file;
      $('#musicNow').textContent = `added ${res.file}`;
    } catch (err) {
      $('#musicNow').textContent = `upload failed: ${err.message}`;
    }
  });
  $('#musicSave').addEventListener('click', () => {
    const file = $('#musicFile').value;
    change(k => {
      if (file) k.music = { file, start: Math.max(0, +$('#musicStart').value || 0), gain: +$('#musicGain').value, fade: Math.max(0, +$('#musicFade').value || 0) };
      else delete k.music;
      const g = +$('#clipGain').value;
      if (g) k.clipGain = g; else delete k.clipGain;
    });
    $('#cutMusicDlg').close();
  });
  $('#musicClose').addEventListener('click', () => $('#cutMusicDlg').close());

  // --- export -------------------------------------------------------------------------

  function exportCut() {
    if (!clips().length) return app.status('add clips before exporting', 2500);
    $('#cutExportName').textContent = cut.name;
    $('#cutExportNow').textContent = '';
    $('#cutExportBar').value = 0;
    $('#cutExportReveal').hidden = true;
    $('#cutExportGo').disabled = false;
    $('#cutExportDlg').showModal();
  }

  $('#cutExportGo').addEventListener('click', async () => {
    $('#cutExportGo').disabled = true;
    try {
      clearTimeout(saveTimer);
      await app.post('/api/cut/save', { slug, cut: body() });
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
  $('#cutNew').addEventListener('click', e => { e.currentTarget.blur(); create(); });
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
  $('#cutTitleBtn').addEventListener('click', e => { e.currentTarget.blur(); addTitle(); });
  $('#cutMusicBtn').addEventListener('click', e => { e.currentTarget.blur(); musicDialog(); });
  $('#cutMusicLane').addEventListener('click', () => musicDialog());
  $('#cutPlay').addEventListener('click', e => { e.currentTarget.blur(); playing ? stop() : play(); });
  $('#cutZoomIn').addEventListener('click', e => { e.currentTarget.blur(); zoom = Math.min(16, zoom * 1.5); paint(); });
  $('#cutZoomOut').addEventListener('click', e => { e.currentTarget.blur(); zoom = Math.max(1, zoom / 1.5); paint(); });
  // Drag along the ruler or an empty part of the timeline to scrub.
  function scrub(t) {
    playhead = Math.max(0, Math.min(total(), t));
    const hit = locate(playhead), c = clips()[hit.i], el = videos.active();
    if (mode === 'program' && hit.i === at && videos.holds(el, c) && el.readyState >= 1) {
      videos.scrubTo(el, c.in + hit.offset * speedOf(c), true);
      paintHead();
      paintTitle();
    } else seek(playhead);
  }
  $('#cutTrackArea').addEventListener('mousedown', e => {
    if (e.target.closest('.cut-clip, .cut-tblock, .cut-join, .cut-mblock') || !clips().length || e.button) return;
    e.preventDefault();
    if (playing) stop();
    sel = { kind: null, i: -1 };
    const left = $('#cutLanes').getBoundingClientRect().left;
    scrub((e.clientX - left) / pps());
    paint();
    const move = ev => scrub((ev.clientX - left) / pps());
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); seek(playhead); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  $('#cutSpeed').addEventListener('change', e => { e.target.blur(); if (sel.kind === 'clip') setSpeed(sel.i, e.target.value); });
  new ResizeObserver(() => paint()).observe(track);
  videos.onFocus(() => {
    if (mode === 'program') { stop(); videos.program(false); }
    mode = 'source';
    marks = { in: null, out: null };
    paintMarks();
    paintMode();
  });

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
    hide() { stop(); },
    // Keys the Cut workspace takes before the bin's own (videos.js).
    onKey(e) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(e.shiftKey); return true; }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      const take = fn => { e.preventDefault(); fn(); return true; };
      if (k === ' ') return take(() => (mode === 'program' ? (playing ? stop() : play()) : videos.toggle()));
      if (k === 'i' || k === 'o') return take(() => {
        if (mode !== 'source' || !videos.current()) return;
        marks[k === 'i' ? 'in' : 'out'] = videos.active().currentTime;
        paintMarks();
      });
      if (k === 'e') return take(append);
      if (k === 't') return take(addTitle);
      if (mode !== 'program') return false;
      if (k === 'b') return take(split);
      if (k === 'c') return take(() => cycleTransition(sel.kind === 'clip' ? sel.i : locate(playhead)?.i, e.shiftKey));
      if (k === 'm') return take(() => toggleSlow(sel.kind === 'clip' ? sel.i : locate(playhead)?.i));
      if (k === 'backspace' || k === 'delete') return take(remove);
      if (k === 'arrowleft' || k === 'arrowright') return take(() => seek(playhead + (k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 1 : 1 / fpsOut())));
      return false;
    },
  };
}
