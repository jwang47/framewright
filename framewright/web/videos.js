// Videos tab: every clip of the day (or the whole library) as a grid of
// posters, grouped by day, beside a player. Picks share the day's picks file
// with its photos. Log clips play through a small shader that approximates a
// display conversion, so S-Log footage is watchable before it's graded; the
// curve matches clips.py's poster frames.

const $ = s => document.querySelector(s);

const VERT = `attribute vec2 p; varying vec2 uv;
void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
const FRAG = `precision highp float; varying vec2 uv; uniform sampler2D tex; uniform float logView;
vec3 decode(vec3 v) {
  vec3 code = v * 1023.;
  vec3 hi = pow(vec3(10.), (code - 420.) / 261.5) * .19 - .01;
  vec3 lo = (code - 95.) * .01125 / (171.2102946929 - 95.);
  return mix(lo, hi, step(171.2102946929, code));
}
void main() {
  vec3 c = texture2D(tex, uv).rgb;
  if (logView > .5) {
    vec3 x = max(decode(c), 0.) * 1.4;
    c = pow(clamp(x * (1. + x / 36.) / (1. + x), 0., 1.), vec3(1. / 2.2));
    float l = dot(c, vec3(.2126, .7152, .0722));
    c = clamp(mix(vec3(l), c, 1.25), 0., 1.);
  }
  gl_FragColor = vec4(c, 1.);
}`;

function stored(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
}

const clock = s => {
  if (!Number.isFinite(s)) return '–';
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
};
const size = b => !b ? '' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`;
const pretty = s => (s || '').replace(/-/g, ' ').replace(/\b(s )?log(\d)/i, (m, a, n) => `S-Log${n}`)
  .replace(/s gamut(\d)/i, 'S-Gamut$1').replace(/\bcine\b/i, 'Cine');

export function createVideos(app) {
  const video = $('#vidPlayer'), canvas = $('#vidGL');
  let days = [], clips = [], focus = null, loaded = null, gl = null, tex = null, uLog = null;
  let scope = stored('studio.videoScope', 'day'), logView = stored('studio.logView', '1') === '1';
  let token = 0, current = null;
  // The player can be lent to the Library's preview pane; this is where it lives.
  const home = $('#vidStage').parentElement, homeBefore = $('#vidStage').nextElementSibling?.nextElementSibling;

  const id = c => `${c.shoot}/${c.key}`;
  const find = x => clips.find(c => id(c) === x);
  const filter = () => $('#vidFilter').value;
  const shown = () => filter() === 'picks' ? clips.filter(c => c.picked) : clips;
  const day = () => app.view?.kind === 'shoot' ? app.view.id : null;

  async function load() {
    const mine = ++token;
    const shoot = scope === 'day' && day();
    const q = shoot ? `?shoot=${encodeURIComponent(shoot)}` : '';
    const res = await fetch('/api/clips' + q);
    if (mine !== token) return;
    days = res.ok ? (await res.json()).days : [];
    clips = days.flatMap(d => d.clips);
    if (!find(focus)) focus = clips[0] ? id(clips[0]) : null;
    render();
  }

  function render() {
    $('#vidScope').value = scope;
    $('#vidScope').querySelector('[value=day]').disabled = !day();
    const list = $('#vidList');
    list.innerHTML = '';
    const items = shown();
    const total = items.reduce((t, c) => t + (c.duration || 0), 0);
    $('#vidCount').textContent = items.length
      ? `${items.length} clip${items.length > 1 ? 's' : ''} · ${clock(total)} · ${items.filter(c => c.picked).length} picked` : '';
    let current = null;
    for (const c of items) {
      if (c.shoot !== current) {
        current = c.shoot;
        const n = items.filter(x => x.shoot === current).length;
        const h = document.createElement('h2');
        h.className = 'day';
        h.innerHTML = `${app.dayLabel(current)} <span>${current} · ${n}</span>`;
        list.appendChild(h);
      }
      const fig = document.createElement('figure');
      fig.id = 'v-' + id(c);
      fig.dataset.id = id(c);
      fig.innerHTML = `
        <div class="frame clip">
          <img loading="lazy" decoding="async" draggable="false" alt="${c.key}"
            src="/clipposter/${encodeURIComponent(c.shoot)}/${c.key}.jpg">
          <button class="star" aria-label="Pick ${c.key}"></button>
          <span class="dur">${clock(c.duration)}</span>
          ${c.captureFps || c.fps > 61 ? `<span class="hfr">${Math.round(c.captureFps || c.fps)}p</span>` : ''}
          ${c.online ? '' : '<span class="off" title="On a drive that is not plugged in">offline</span>'}
          ${app.whereTag(c)}
        </div>
        <figcaption><span class="name">${c.key}</span><span>${c.time.slice(0, 5)}</span></figcaption>`;
      fig.querySelector('.frame').addEventListener('click', () => setFocus(id(c), false));
      fig.querySelector('.frame').addEventListener('dblclick', () => { setFocus(id(c), false); toggle(); });
      fig.querySelector('.star').addEventListener('click', e => { e.stopPropagation(); togglePick(id(c)); });
      list.appendChild(fig);
      paint(id(c));
    }
    if (!items.length) {
      const msg = filter() === 'picks' ? 'No clips picked yet.'
        : scope === 'day' && day() ? 'No videos on this day. Switch to All days to see every clip.'
        : 'No videos yet. Connect a camera card and press Import.';
      list.innerHTML = `<p class="empty">${msg}</p>`;
    }
    if (focus && !items.some(c => id(c) === focus)) focus = items[0] ? id(items[0]) : null;
    setFocus(focus);
  }

  function paint(x) {
    const c = find(x), fig = document.getElementById('v-' + x);
    if (!c || !fig) return;
    fig.classList.toggle('picked', c.picked);
    fig.classList.toggle('rejected', !!c.rejected);
    fig.classList.toggle('focus', x === focus);
    fig.querySelector('.star').textContent = c.picked ? '★' : '☆';
    if (x === focus) {
      $('#vidPick').textContent = c.picked ? '★ Picked' : '☆ Pick';
      $('#vidPick').setAttribute('aria-pressed', c.picked);
    }
  }

  function setFocus(x, scroll = true) {
    const prev = focus;
    focus = x;
    if (prev && prev !== x) paint(prev);
    const c = find(x);
    $('#vidEmpty').hidden = !!c;
    $('#vidStage').hidden = $('#vidBar').hidden = !c;
    if (!c) { unload(); return; }
    paint(x);
    if (scroll) document.getElementById('v-' + x)?.scrollIntoView({ block: 'nearest' });
    if (loaded !== x) open(c);
    meta(c);
  }

  function meta(c) {
    $('#vidName').textContent = c.name;
    $('#vidTime').textContent = `${app.dayLabel(c.shoot)} ${c.time}`;
    const fps = c.captureFps ? `${c.captureFps}p shot, plays at ${c.fps}p` : c.fps ? `${c.fps}p` : '';
    $('#vidMeta').innerHTML = [
      clock(c.duration), [c.size, fps].filter(Boolean).join(' · '), c.codec,
      [pretty(c.gamma), pretty(c.gamut)].filter(Boolean).join(' / '), c.lens, size(c.bytes), app.whereText(c),
      c.online ? '' : '<span class="off">offline: plug in the drive to play</span>',
    ].filter(Boolean).map(s => `<span>${s}</span>`).join('');
    $('#vidLog').hidden = !c.log;
    $('#vidLog').setAttribute('aria-pressed', logView);
    $('#vidReveal').disabled = $('#vidOpen').disabled = !c.online;
  }

  function unload() {
    loaded = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function attach(host) {
    for (const el of [$('#vidStage'), $('#vidBar')]) if (el.parentElement !== host || host === home) {
      if (host === home) home.insertBefore(el, homeBefore); else host.appendChild(el);
    }
    $('#vidStage').hidden = $('#vidBar').hidden = false;
    requestAnimationFrame(draw);
  }

  function open(c) {
    current = c;
    loaded = id(c);
    video.pause();
    if (!c.online) { unload(); loaded = id(c); canvas.hidden = true; return; }
    video.src = `/clip/${encodeURIComponent(c.shoot)}/${c.key}`;
    video.poster = `/clipposter/${encodeURIComponent(c.shoot)}/${c.key}.jpg`;
    useGL(c);
    paintControls();
  }

  // --- log view shader ----------------------------------------------------------

  function initGL() {
    if (gl) return true;
    gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return false;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    uLog = gl.getUniformLocation(prog, 'logView');
    return true;
  }

  function useGL(c) {
    const on = c.log && logView && initGL();
    canvas.hidden = !on;
    // The poster (already converted) shows until the shader has a frame to draw.
    video.classList.remove('under-gl');
    canvas.style.visibility = 'hidden';
    if (on) draw();
  }

  function fit() {
    // The canvas covers just the picture inside the letterboxed video element.
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return false;
    const box = video.getBoundingClientRect(), scale = Math.min(box.width / w, box.height / h);
    const cw = Math.round(w * scale), ch = Math.round(h * scale), dpr = devicePixelRatio || 1;
    Object.assign(canvas.style, { width: cw + 'px', height: ch + 'px',
      left: (video.offsetLeft + (box.width - cw) / 2) + 'px', top: (video.offsetTop + (box.height - ch) / 2) + 'px' });
    const pw = Math.min(w, Math.round(cw * dpr)), ph = Math.min(h, Math.round(ch * dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    return true;
  }

  function draw() {
    if (canvas.hidden || !gl || video.readyState < 2 || !fit()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    } catch { return; }
    gl.uniform1f(uLog, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    video.classList.add('under-gl');
    canvas.style.visibility = '';
  }

  function loop() {
    draw();
    if (video.paused || video.ended) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  }

  // --- transport --------------------------------------------------------------

  function toggle() {
    if (!video.src) return;
    if (video.paused) video.play().catch(e => app.status(`can't play: ${e.message}`, 4000));
    else video.pause();
  }

  function step(frames) {
    const c = current;
    video.pause();
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + frames / (c?.fps || 30)));
  }

  function paintControls() {
    $('#vidPlay').textContent = video.paused ? '▶' : '❚❚';
    $('#vidPlay').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    const d = video.duration;
    $('#vidSeek').max = Number.isFinite(d) ? d : 0;
    if (!seeking) $('#vidSeek').value = video.currentTime;
    $('#vidClock').textContent = `${clock(video.currentTime)} / ${clock(d)}`;
    $('#vidMute').textContent = video.muted ? '🔇' : '🔊';
  }

  let seeking = false;
  video.addEventListener('play', () => { paintControls(); loop(); });
  for (const ev of ['pause', 'timeupdate', 'durationchange', 'volumechange', 'ended']) video.addEventListener(ev, paintControls);
  for (const ev of ['loadeddata', 'seeked', 'resize']) video.addEventListener(ev, draw);
  video.addEventListener('click', toggle);
  canvas.addEventListener('click', toggle);
  video.addEventListener('error', () => {
    const c = current;
    if (c?.online) app.status(`this browser can't decode ${c.codec || 'this'} video; use Open to play it in QuickTime`, 6000);
  });
  new ResizeObserver(draw).observe($('#vidStage'));
  $('#vidPlay').addEventListener('click', e => { e.currentTarget.blur(); toggle(); });
  $('#vidSeek').addEventListener('input', e => { seeking = true; video.currentTime = +e.target.value; });
  $('#vidSeek').addEventListener('change', e => { seeking = false; e.target.blur(); });
  $('#vidRate').addEventListener('change', e => { video.playbackRate = +e.target.value; e.target.blur(); });
  $('#vidMute').addEventListener('click', e => { e.currentTarget.blur(); video.muted = !video.muted; });
  $('#vidFs').addEventListener('click', e => {
    e.currentTarget.blur();
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#vidStage').requestFullscreen?.().catch(() => {});
  });
  $('#vidLog').addEventListener('click', e => {
    e.currentTarget.blur();
    logView = !logView;
    store('studio.logView', logView ? '1' : '0');
    if (current) { useGL(current); if (find(id(current))) meta(current); }
  });

  // --- managing ---------------------------------------------------------------

  async function togglePick(x) {
    const c = find(x);
    if (!c) return;
    c.picked = !c.picked;
    if (c.picked) c.rejected = false;
    paint(x);
    try {
      await app.post('/api/pick', { shoot: c.shoot, key: c.key, picked: c.picked });
      app.status(c.picked ? `picked ${c.key}` : `unpicked ${c.key}`);
      if (filter() === 'picks') render();
      else $('#vidCount').textContent = $('#vidCount').textContent.replace(/\d+ picked$/, `${clips.filter(c => c.picked).length} picked`);
    } catch {
      c.picked = !c.picked;
      paint(x);
      app.status('save failed — is the server running?', 0);
    }
  }

  async function toggleReject(x) {
    const c = find(x);
    if (!c) return;
    const before = { picked: c.picked, rejected: c.rejected };
    c.rejected = !c.rejected;
    if (c.rejected) c.picked = false;
    paint(x);
    try {
      await app.post('/api/pick', { shoot: c.shoot, key: c.key, rejected: c.rejected });
      app.status(c.rejected ? `marked ${c.key} for deletion` : `unmarked ${c.key}`);
    } catch {
      Object.assign(c, before);
      paint(x);
      app.status('save failed — is the server running?', 0);
    }
  }

  async function action(kind) {
    const c = find(focus);
    if (!c) return;
    try {
      await app.post(`/api/clip/${kind}`, { shoot: c.shoot, key: c.key });
    } catch (e) {
      app.status(e.message, 4000);
    }
  }

  $('#vidPick').addEventListener('click', e => { e.currentTarget.blur(); if (focus) togglePick(focus); });
  $('#vidOpen').addEventListener('click', e => { e.currentTarget.blur(); video.pause(); action('open'); });
  $('#vidReveal').addEventListener('click', e => { e.currentTarget.blur(); action('reveal'); });
  $('#vidFilter').addEventListener('change', e => { e.target.blur(); render(); });
  $('#vidScope').addEventListener('change', e => {
    e.target.blur();
    scope = e.target.value;
    store('studio.videoScope', scope);
    load();
  });

  function columns() {
    const list = $('#vidList'), fig = list.querySelector('figure');
    if (!fig) return 1;
    const cs = getComputedStyle(list);
    const inner = list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    return Math.max(1, Math.round((inner + gap) / (fig.offsetWidth + gap)));
  }

  function move(dir) {
    const ids = shown().map(id);
    if (!ids.length) return;
    let i = ids.indexOf(focus);
    i = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + dir));
    setFocus(ids[i]);
  }

  return {
    show() { attach(home); loaded = null; load(); },
    // Library: play one clip in the preview pane.
    lend(host, c) { attach(host); if (loaded !== id(c)) open(c); },
    toggle,
    step,
    pause() { video.pause(); },
    fullscreen() { $('#vidFs').click(); },
    log() { return logView; },
    pretty, clock,
    hide() { video.pause(); },
    reload() { if (app.tab === 'videos') load(); },
    onKey(e) {
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 'l') { e.preventDefault(); move(1); }
      else if (k === 'arrowleft' || k === 'h') { e.preventDefault(); move(-1); }
      else if (k === 'arrowdown' || k === 'j') { e.preventDefault(); move(columns()); }
      else if (k === 'arrowup' || k === 'k') { e.preventDefault(); move(-columns()); }
      else if (k === ' ' || k === 'enter') { e.preventDefault(); toggle(); }
      else if (k === 'p' || k === 'x') { e.preventDefault(); if (focus) togglePick(focus); }
      else if (k === 'backspace' || k === 'delete' || k === 'z') { e.preventDefault(); if (focus) toggleReject(focus); }
      else if (k === ',' || k === '.') { e.preventDefault(); step(k === '.' ? 1 : -1); }
      else if (k === 'f') { $('#vidFilter').value = filter() === 'picks' ? 'all' : 'picks'; render(); }
      else if (k === 'o') action('open');
      else if (k === 'r') action('reveal');
    },
  };
}
