// Subject masks: brush roughly over a subject and the mask snaps to its
// edges. GrabCut, with brush strokes in place of a box: colour models for
// subject and background, a graph cut that prefers to cut along edges, then
// a guided filter that lets the hard cut soften where the photo does (hair,
// out-of-focus edges). Plain functions on pixels, no DOM, so it runs in a
// worker (segment-worker.js) and in node for testing.

const BAND = 2;          // the subject may reach this many brush radii from a stroke's path
const PRIOR_IN = 0.7;    // chance a pixel under the brush is subject, before colour
const PRIOR_BAND = 0.3;  // the same, just outside the brush
const GAMMA = 50;        // how strongly the cut prefers edges
const K = 5;             // Gaussians per colour model
const WORK_PX = 160000;  // the cut runs at no more than this many pixels
const ITERS = 4;
const HARD = 1e6;

// img: {w, h, data: RGBA bytes}, the corrected frame. strokes: [{pts: [[x, y]]
// in frame 0..1, r: brush radius as a fraction of the long side, sub: true to
// mark background}]. Returns the mask as w*h bytes, 0..255.
export function segmentSubject(img, strokes) {
  const { w, h } = img;
  const out = new Uint8Array(w * h);
  const L = Math.max(w, h);
  const adds = strokes.filter(s => !s.sub && s.pts.length);
  if (!adds.length) return out;

  // Distance from each stroke's path in its own radii (min over strokes), and
  // what the subtract strokes cover, over the region the add strokes can reach.
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const s of adds) {
    const R = s.r * L * (BAND + 1);
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x * w - R); y0 = Math.min(y0, y * h - R);
      x1 = Math.max(x1, x * w + R); y1 = Math.max(y1, y * h + R);
    }
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) return out;
  const dist = new Float32Array(rw * rh).fill(Infinity);
  const sub = new Uint8Array(rw * rh);
  for (const s of strokes) {
    const r = Math.max(s.r * L, 0.5);
    const reach = s.sub ? 1 : BAND;
    paintPath(s.pts.map(([x, y]) => [x * w - x0, y * h - y0]), r, reach, rw, rh, (i, d) => {
      if (s.sub) sub[i] = 1;
      else if (d < dist[i]) dist[i] = d;
    });
  }

  // Work on a coarser grid when the region is big.
  const f = Math.max(1, Math.ceil(Math.sqrt(rw * rh / WORK_PX)));
  const gw = Math.ceil(rw / f), gh = Math.ceil(rh / f), n = gw * gh;
  const col = new Float32Array(3 * n), gd = new Float32Array(n), gsub = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx;
      let r = 0, gg = 0, b = 0, c = 0, d = Infinity, sb = 0;
      for (let y = gy * f; y < Math.min(rh, gy * f + f); y++) {
        for (let x = gx * f; x < Math.min(rw, gx * f + f); x++) {
          const o = 4 * ((y + y0) * w + x + x0), i = y * rw + x;
          r += img.data[o]; gg += img.data[o + 1]; b += img.data[o + 2]; c++;
          d = Math.min(d, dist[i]);
          sb |= sub[i];
        }
      }
      col[3 * g] = r / c; col[3 * g + 1] = gg / c; col[3 * g + 2] = b / c;
      gd[g] = d; gsub[g] = sb;
    }
  }

  const label = cut(col, gd, gsub, gw, gh);
  if (!label) return out;
  keepTouching(label, gd, gw, gh);

  // Back to full size, softened along the photo's own edges.
  const p = new Float32Array(rw * rh), guide = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / f - 0.5)), ya = Math.floor(fy), yb = Math.min(gh - 1, ya + 1), ty = fy - ya;
    for (let x = 0; x < rw; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / f - 0.5)), xa = Math.floor(fx), xb = Math.min(gw - 1, xa + 1), tx = fx - xa;
      const top = label[ya * gw + xa] * (1 - tx) + label[ya * gw + xb] * tx;
      const bot = label[yb * gw + xa] * (1 - tx) + label[yb * gw + xb] * tx;
      const o = 4 * ((y + y0) * w + x + x0);
      p[y * rw + x] = top * (1 - ty) + bot * ty;
      guide[y * rw + x] = (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) / 255;
    }
  }
  const a = guidedFilter(guide, p, rw, rh, Math.max(2, Math.round(1.5 * f)), 1e-3);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      let v = sub[i] || dist[i] > BAND ? 0 : a[i];
      if (v < 0.02) v = 0; else if (v > 0.98) v = 1;
      out[(y + y0) * w + x + x0] = Math.round(v * 255);
    }
  }
  return out;
}

// Calls fn(i, d) for every pixel within reach radii of the path, d in radii.
function paintPath(pts, r, reach, rw, rh, fn) {
  const R = r * reach;
  const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((q, k) => [pts[k], q]);
  for (const [[ax, ay], [bx, by]] of segs) {
    const xa = Math.max(0, Math.floor(Math.min(ax, bx) - R)), xb = Math.min(rw - 1, Math.ceil(Math.max(ax, bx) + R));
    const ya = Math.max(0, Math.floor(Math.min(ay, by) - R)), yb = Math.min(rh - 1, Math.ceil(Math.max(ay, by) + R));
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        const t = l2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / l2)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d <= R) fn(y * rw + x, d / r);
      }
    }
  }
}

// The graph cut, iterated with the colour models it refines. Returns 1 for
// subject and 0 for background per grid cell, or null when nothing is found.
function cut(col, gd, gsub, gw, gh) {
  const n = gw * gh;
  const hardBg = i => gsub[i] || gd[i] > BAND;
  let label = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = !hardBg(i) && gd[i] <= 1 ? 1 : 0;
  const bgIdx = [], fgIdx = [];
  for (let i = 0; i < n; i++) (label[i] ? fgIdx : bgIdx).push(i);
  if (fgIdx.length < 4) return null;

  // Edge weights: strong where neighbours look alike, so cuts follow edges.
  const nb = [[1, 0], [0, 1], [1, 1], [-1, 1]];
  let sum = 0, cnt = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      for (const [dx, dy] of nb) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || X >= gw || Y >= gh) continue;
        sum += diff2(col, y * gw + x, Y * gw + X); cnt++;
      }
    }
  }
  const beta = 1 / (2 * Math.max(sum / Math.max(cnt, 1), 1e-6));
  const g = new Graph(n, 8);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      for (const [dx, dy] of nb) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        const wgt = GAMMA / Math.hypot(dx, dy) * Math.exp(-beta * diff2(col, i, j));
        g.addEdge(i, j, wgt);
      }
    }
  }

  let fg = fitGmm(col, fgIdx), bg = fitGmm(col, bgIdx);
  for (let it = 0; it < ITERS; it++) {
    const cap = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (hardBg(i)) { cap[i] = -HARD; continue; }
      const prior = gd[i] <= 1 ? PRIOR_IN : PRIOR_BAND;
      const dFg = -gmmLogP(fg, col, i) - Math.log(prior);
      const dBg = -gmmLogP(bg, col, i) - Math.log(1 - prior);
      cap[i] = dBg - dFg;   // > 0 leans subject, < 0 background
    }
    const next = g.maxflow(cap);
    let changed = 0;
    const f2 = [], b2 = [];
    for (let i = 0; i < n; i++) {
      if (next[i] !== label[i]) changed++;
      (next[i] ? f2 : b2).push(i);
    }
    label = next;
    if (f2.length < 4) return null;
    if (!changed || it === ITERS - 1) break;
    fg = fitGmm(col, f2, fg); bg = fitGmm(col, b2, bg);
  }
  return label;
}

function diff2(col, i, j) {
  const a = col[3 * i] - col[3 * j], b = col[3 * i + 1] - col[3 * j + 1], c = col[3 * i + 2] - col[3 * j + 2];
  return a * a + b * b + c * c;
}

// Drop stray patches that don't connect to where the brush went.
function keepTouching(label, gd, gw, gh) {
  const seen = new Uint8Array(label.length), stack = [];
  for (let i = 0; i < label.length; i++) if (label[i] && gd[i] <= 1) { seen[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % gw, y = (i - x) / gw;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        if (label[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
  }
  for (let i = 0; i < label.length; i++) label[i] = seen[i];
}

// --- colour models ------------------------------------------------------------

// A mixture of K Gaussians over the given cells' colours. Starts from k-means,
// or from the previous model's components when there is one.
function fitGmm(col, idx, prev) {
  const step = Math.max(1, Math.floor(idx.length / 20000));
  const s = [];
  for (let k = 0; k < idx.length; k += step) s.push(idx[k]);
  const assign = new Int32Array(s.length);
  if (prev) {
    for (let k = 0; k < s.length; k++) assign[k] = bestComp(prev, col, s[k]);
  } else {
    // k-means from luminance quantiles: deterministic, and spread out.
    const byLum = s.map((i, k) => [col[3 * i] * 0.3 + col[3 * i + 1] * 0.59 + col[3 * i + 2] * 0.11, k]).sort((a, b) => a[0] - b[0]);
    const cent = [];
    for (let c = 0; c < K; c++) {
      const i = s[byLum[Math.min(s.length - 1, Math.floor((c + 0.5) / K * s.length))][1]];
      cent.push([col[3 * i], col[3 * i + 1], col[3 * i + 2]]);
    }
    for (let iter = 0; iter < 8; iter++) {
      const acc = cent.map(() => [0, 0, 0, 0]);
      for (let k = 0; k < s.length; k++) {
        const i = s[k];
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) {
          const a = col[3 * i] - cent[c][0], b = col[3 * i + 1] - cent[c][1], d = col[3 * i + 2] - cent[c][2];
          const dd = a * a + b * b + d * d;
          if (dd < bd) { bd = dd; best = c; }
        }
        assign[k] = best;
        acc[best][0] += col[3 * i]; acc[best][1] += col[3 * i + 1]; acc[best][2] += col[3 * i + 2]; acc[best][3]++;
      }
      for (let c = 0; c < K; c++) if (acc[c][3]) cent[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    }
  }
  const comps = [];
  for (let c = 0; c < K; c++) {
    let m = [0, 0, 0], cnt = 0;
    for (let k = 0; k < s.length; k++) if (assign[k] === c) { const i = s[k]; m[0] += col[3 * i]; m[1] += col[3 * i + 1]; m[2] += col[3 * i + 2]; cnt++; }
    if (!cnt) continue;
    m = m.map(v => v / cnt);
    const cv = new Float64Array(9);
    for (let k = 0; k < s.length; k++) {
      if (assign[k] !== c) continue;
      const i = s[k], d = [col[3 * i] - m[0], col[3 * i + 1] - m[1], col[3 * i + 2] - m[2]];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cv[3 * a + b] += d[a] * d[b];
    }
    for (let a = 0; a < 9; a++) cv[a] /= cnt;
    for (let a = 0; a < 3; a++) cv[4 * a] += 4;   // keep flat patches from collapsing
    const det = cv[0] * (cv[4] * cv[8] - cv[5] * cv[7]) - cv[1] * (cv[3] * cv[8] - cv[5] * cv[6]) + cv[2] * (cv[3] * cv[7] - cv[4] * cv[6]);
    const inv = [
      (cv[4] * cv[8] - cv[5] * cv[7]) / det, (cv[2] * cv[7] - cv[1] * cv[8]) / det, (cv[1] * cv[5] - cv[2] * cv[4]) / det,
      (cv[5] * cv[6] - cv[3] * cv[8]) / det, (cv[0] * cv[8] - cv[2] * cv[6]) / det, (cv[2] * cv[3] - cv[0] * cv[5]) / det,
      (cv[3] * cv[7] - cv[4] * cv[6]) / det, (cv[1] * cv[6] - cv[0] * cv[7]) / det, (cv[0] * cv[4] - cv[1] * cv[3]) / det,
    ];
    comps.push({ w: cnt / s.length, m, inv, logNorm: Math.log(cnt / s.length) - 0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI) });
  }
  return comps;
}

function compLog(c, col, i) {
  const a = col[3 * i] - c.m[0], b = col[3 * i + 1] - c.m[1], d = col[3 * i + 2] - c.m[2], v = c.inv;
  const q = a * (v[0] * a + v[1] * b + v[2] * d) + b * (v[3] * a + v[4] * b + v[5] * d) + d * (v[6] * a + v[7] * b + v[8] * d);
  return c.logNorm - 0.5 * q;
}

function bestComp(g, col, i) {
  let best = 0, bl = -Infinity;
  g.forEach((c, k) => { const l = compLog(c, col, i); if (l > bl) { bl = l; best = k; } });
  return best;
}

function gmmLogP(g, col, i) {
  let mx = -Infinity;
  const ls = g.map(c => { const l = compLog(c, col, i); if (l > mx) mx = l; return l; });
  let s = 0;
  for (const l of ls) s += Math.exp(l - mx);
  return Math.max(mx + Math.log(s), -1e3);
}

// --- guided filter --------------------------------------------------------------

// He et al.: the output follows p but takes its edges from the guide I.
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

function boxMean(src, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const s = S[yb * (w + 1) + xb] - S[ya * (w + 1) + xb] - S[yb * (w + 1) + xa] + S[ya * (w + 1) + xa];
      out[y * w + x] = s / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}

// --- max flow -------------------------------------------------------------------

// Boykov-Kolmogorov max flow, for the cut. Nodes link to the source (subject)
// or sink (background) by a signed terminal capacity; edges are undirected.
const NONE = -1, TERMINAL = -2, ORPHAN = -3;

export class Graph {
  constructor(n, degree) {
    this.n = n;
    this.first = new Int32Array(n).fill(-1);   // each node's arcs, as a linked list
    this.nextArc = new Int32Array(n * degree);
    this.head = new Int32Array(n * degree);
    this.cap0 = new Float64Array(n * degree);
    this.m = 0;
  }

  addEdge(i, j, c) {
    if (this.m + 2 > this.head.length) this.grow();
    for (const [a, b] of [[i, j], [j, i]]) {
      const k = this.m++;
      this.head[k] = b; this.cap0[k] = c;
      this.nextArc[k] = this.first[a]; this.first[a] = k;
    }
  }

  grow() {
    const g = (A, T) => { const B = new T(A.length * 2); B.set(A); return B; };
    this.nextArc = g(this.nextArc, Int32Array); this.head = g(this.head, Int32Array); this.cap0 = g(this.cap0, Float64Array);
  }

  // tr: per node, > 0 capacity from the source, < 0 to the sink. Returns 1 for
  // nodes on the source side of the minimum cut.
  maxflow(tr) {
    const { n, first, nextArc, head } = this;
    const sis = a => a ^ 1;
    const cap = this.cap0.slice(0, this.m);
    tr = Float64Array.from(tr);
    const parent = new Int32Array(n).fill(NONE), sink = new Uint8Array(n);
    const ts = new Int32Array(n), dist = new Int32Array(n);
    const inQ = new Uint8Array(n);
    let q = new Int32Array(Math.max(16, n)), qh = 0, qt = 0, qn = 0;
    const activate = i => {
      if (inQ[i]) return;
      inQ[i] = 1;
      if (qn === q.length) { const b = new Int32Array(q.length * 2); for (let k = 0; k < qn; k++) b[k] = q[(qh + k) % q.length]; q = b; qh = 0; qt = qn; }
      q[qt] = i; qt = (qt + 1) % q.length; qn++;
    };
    const nextActive = () => {
      while (qn) {
        const i = q[qh]; qh = (qh + 1) % q.length; qn--; inQ[i] = 0;
        if (parent[i] !== NONE) return i;
      }
      return -1;
    };
    for (let i = 0; i < n; i++) {
      if (tr[i] > 0) { parent[i] = TERMINAL; sink[i] = 0; dist[i] = 1; activate(i); }
      else if (tr[i] < 0) { parent[i] = TERMINAL; sink[i] = 1; dist[i] = 1; activate(i); }
    }
    const orphans = [];
    let time = 0, current = -1;

    for (;;) {
      let i = current;
      if (i >= 0 && parent[i] === NONE) i = -1;
      if (i < 0) i = nextActive();
      if (i < 0) break;
      current = -1;
      // Grow the tree i is in until it touches the other.
      let bridge = -1;
      if (!sink[i]) {
        for (let a = first[i]; a >= 0; a = nextArc[a]) {
          if (cap[a] <= 0) continue;
          const j = head[a];
          if (parent[j] === NONE) { sink[j] = 0; parent[j] = sis(a); ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j); }
          else if (sink[j]) { bridge = a; break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = sis(a); ts[j] = ts[i]; dist[j] = dist[i] + 1; }
        }
      } else {
        for (let a = first[i]; a >= 0; a = nextArc[a]) {
          if (cap[sis(a)] <= 0) continue;
          const j = head[a];
          if (parent[j] === NONE) { sink[j] = 1; parent[j] = sis(a); ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j); }
          else if (!sink[j]) { bridge = sis(a); break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = sis(a); ts[j] = ts[i]; dist[j] = dist[i] + 1; }
        }
      }
      time++;
      if (bridge < 0) continue;
      current = i;

      // Augment along source root -> ... -> bridge -> ... -> sink root.
      let b = cap[bridge];
      let s = head[sis(bridge)];
      for (;;) { const a = parent[s]; if (a === TERMINAL) break; b = Math.min(b, cap[sis(a)]); s = head[a]; }
      b = Math.min(b, tr[s]);
      let t = head[bridge];
      for (;;) { const a = parent[t]; if (a === TERMINAL) break; b = Math.min(b, cap[a]); t = head[a]; }
      b = Math.min(b, -tr[t]);
      cap[sis(bridge)] += b; cap[bridge] -= b;
      s = head[sis(bridge)];
      for (;;) {
        const a = parent[s];
        if (a === TERMINAL) break;
        cap[a] += b; cap[sis(a)] -= b;
        if (cap[sis(a)] <= 0) { parent[s] = ORPHAN; orphans.push(s); }
        s = head[a];
      }
      tr[s] -= b;
      if (tr[s] <= 0) { parent[s] = ORPHAN; orphans.push(s); }
      t = head[bridge];
      for (;;) {
        const a = parent[t];
        if (a === TERMINAL) break;
        cap[sis(a)] += b; cap[a] -= b;
        if (cap[a] <= 0) { parent[t] = ORPHAN; orphans.push(t); }
        t = head[a];
      }
      tr[t] += b;
      if (tr[t] >= 0) { parent[t] = ORPHAN; orphans.push(t); }

      // Adopt the orphans, or free them.
      while (orphans.length) {
        const o = orphans.pop(), isSink = sink[o];
        let dMin = Infinity, aMin = -1;
        for (let a0 = first[o]; a0 >= 0; a0 = nextArc[a0]) {
          if ((isSink ? cap[a0] : cap[sis(a0)]) <= 0) continue;
          const j = head[a0];
          if (sink[j] !== isSink || parent[j] === NONE) continue;
          // Does j still lead back to its terminal?
          let d = 0, k = j;
          for (;;) {
            if (ts[k] === time) { d += dist[k]; break; }
            const a = parent[k];
            d++;
            if (a === TERMINAL) { ts[k] = time; dist[k] = 1; break; }
            if (a === ORPHAN) { d = Infinity; break; }
            k = head[a];
          }
          if (d < Infinity) {
            if (d < dMin) { aMin = a0; dMin = d; }
            for (k = j; ts[k] !== time; k = head[parent[k]]) { ts[k] = time; dist[k] = d--; }
          }
        }
        if (aMin >= 0) { parent[o] = aMin; ts[o] = time; dist[o] = dMin + 1; continue; }
        for (let a0 = first[o]; a0 >= 0; a0 = nextArc[a0]) {
          const j = head[a0];
          if (sink[j] !== isSink) continue;
          const a = parent[j];
          if (a === NONE) continue;
          if ((isSink ? cap[a0] : cap[sis(a0)]) > 0) activate(j);
          if (a !== TERMINAL && a !== ORPHAN && head[a] === o) { parent[j] = ORPHAN; orphans.push(j); }
        }
        parent[o] = NONE;
      }
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parent[i] !== NONE && !sink[i] ? 1 : 0;
    return out;
  }
}
