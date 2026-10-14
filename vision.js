// vision.js — 影像處理同 AI 模型（全部喺瀏覽器本地運行，相片唔會上傳）
// 座標慣例：所有 quad / spine 都用 0–1 正規化座標（相對於已轉正嘅相片）。
// quad = [x0,y0, x1,y1, x2,y2, x3,y3] 次序：左上、右上、右下、左下
// spine = [xTop,yTop, xBottom,yBottom]

const ORT_VER = '1.23.2';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const MODEL_BASE = new URL('./models/', import.meta.url).href;
const MODEL_CACHE = 'bookscan-models-v1';
const DEFAULT_MANIFEST = { corner: 'doccornernet_lean.onnx', uvdoc: 'uvdoc.onnx' };
let manifestP = null;
/** models/manifest.json 話我知用邊個模型檔（微調之後換檔名就得，唔會用舊快取） */
function manifest() {
  if (!manifestP) manifestP = (async () => {
    let m = null;
    try { const r = await fetch(MODEL_BASE + 'manifest.json', { cache: 'no-cache' }); if (r.ok) m = await r.json(); } catch (e) { }
    m = Object.assign({}, DEFAULT_MANIFEST, m || {});
    // 清走唔再用嘅舊模型快取
    try {
      const c = await caches.open(MODEL_CACHE), keep = [MODEL_BASE + m.corner, MODEL_BASE + m.uvdoc];
      for (const req of await c.keys()) if (!keep.includes(req.url)) await c.delete(req);
    } catch (e) { }
    return m;
  })();
  return manifestP;
}

export const ANALYSIS_SIDE = 512;   // 偵測用嘅細圖
export const MID_SIDE = 1800;       // 縮圖 / 細修用

// ---------------------------------------------------------------- 基本工具
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/** 由 ImageBitmap 整出已旋轉、已縮細嘅 canvas。rot = 0/90/180/270 */
export function orientedCanvas(bitmap, rot = 0, maxSide = 0) {
  const sw = bitmap.width, sh = bitmap.height;
  const rotated = rot === 90 || rot === 270;
  let ow = rotated ? sh : sw, oh = rotated ? sw : sh;
  let s = 1;
  if (maxSide && Math.max(ow, oh) > maxSide) s = maxSide / Math.max(ow, oh);
  const W = Math.max(1, Math.round(ow * s)), H = Math.max(1, Math.round(oh * s));
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2, H / 2);
  ctx.rotate(rot * Math.PI / 180);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
  return c;
}

export function canvasToImg(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: d.data };
}

export function scaleCanvas(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const W = Math.max(1, Math.round(src.width * s)), H = Math.max(1, Math.round(src.height * s));
  // 分幾步縮細，質素好啲
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 > W && ch / 2 > H) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const t = makeCanvas(nw, nh); const tc = t.getContext('2d');
    tc.imageSmoothingQuality = 'high'; tc.drawImage(cur, 0, 0, nw, nh);
    cur = t; cw = nw; ch = nh;
  }
  const c = makeCanvas(W, H); const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cur, 0, 0, W, H);
  return c;
}

function toGray(img) {
  const n = img.w * img.h, g = new Float32Array(n), d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return g;
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const denorm = (q, w, h) => q.map((v, i) => v * (i % 2 ? h : w));
export const normq = (q, w, h) => q.map((v, i) => v / (i % 2 ? h : w));

// ---------------------------------------------------------------- 透視變換
/** 由單位正方形 (u,v)∈[0,1]² 映射去四邊形 q（像素）嘅 homography，返回 [a,b,c,d,e,f,g,h] */
export function unitHomography(q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}
export function applyH(H, u, v) {
  const w = H[6] * u + H[7] * v + 1;
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

function sampleGray(g, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return -1;
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** 長闊比估計（Zhang 2002 白板掃描方法，考慮透視），失敗就用邊長平均 */
export function estimateAspect(q, imgW, imgH) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const naive = (dist(x0, y0, x1, y1) + dist(x3, y3, x2, y2)) / (dist(x0, y0, x3, y3) + dist(x1, y1, x2, y2));
  const u0 = imgW / 2, v0 = imgH / 2;
  const m1 = [x0, y0, 1], m2 = [x1, y1, 1], m3 = [x3, y3, 1], m4 = [x2, y2, 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
  if (Math.abs(k2 - 1) < 0.04 && Math.abs(k3 - 1) < 0.04) return naive; // 透視好弱，Zhang 方法唔穩定
  if (Math.abs(n2[2] * n3[2]) < 1e-9) return naive;
  const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
    (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
  if (!(f2 > 0)) return naive;
  const f = Math.sqrt(f2), M = Math.max(imgW, imgH);
  if (f < 0.4 * M || f > 6 * M) return naive;
  const a2 = [(n2[0] - u0 * n2[2]) / f, (n2[1] - v0 * n2[2]) / f, n2[2]];
  const a3 = [(n3[0] - u0 * n3[2]) / f, (n3[1] - v0 * n3[2]) / f, n3[2]];
  const r = Math.sqrt(dot(a2, a2) / dot(a3, a3));
  if (!isFinite(r) || r / naive < 0.8 || r / naive > 1.25) return naive;
  return r;
}

// ---------------------------------------------------------------- 遮罩（分割）
function otsu(vals, n, lo, hi) {
  const B = 256, hist = new Float64Array(B), sc = (B - 1) / (hi - lo || 1);
  for (let i = 0; i < n; i++) { let b = Math.round((vals[i] - lo) * sc); if (b < 0) b = 0; else if (b >= B) b = B - 1; hist[b]++; }
  let sum = 0; for (let i = 0; i < B; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = -1, bt = 0;
  let mean = sum / n, tot = 0; for (let i = 0; i < B; i++) tot += hist[i] * (i - mean) ** 2;
  for (let t = 0; t < B; t++) {
    wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bt = t; }
  }
  return { t: lo + bt / sc, sep: tot > 0 ? best / n / tot : 0 };
}

function boxAny(m, w, h, r) { // 二值膨脹（方形）
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let cnt = 0; const row = y * w;
    for (let x = -r; x < w; x++) {
      const a = x + r; if (a < w && m[row + a]) cnt++;
      const b = x - r - 1; if (b >= 0 && m[row + b]) cnt--;
      if (x >= 0) t[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = -r; y < h; y++) {
      const a = y + r; if (a < h && t[a * w + x]) cnt++;
      const b = y - r - 1; if (b >= 0 && t[b * w + x]) cnt--;
      if (y >= 0) o[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return o;
}
function invert(m) { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; }
const dilate = boxAny;
const erode = (m, w, h, r) => invert(boxAny(invert(m), w, h, r));

function fillHoles(m, w, h) {
  const seen = new Uint8Array(w * h), q = new Int32Array(w * h); let qh = 0, qt = 0;
  const push = (i) => { if (!m[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = m[i] || !seen[i] ? 1 : 0;
  return o;
}

function largestComponent(m, w, h) {
  const lab = new Int32Array(w * h), q = new Int32Array(w * h);
  let best = 0, bestSize = 0, cur = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s]) continue;
    cur++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = cur; let size = 0;
    while (qh < qt) {
      const i = q[qh++]; size++; const x = i % w, y = (i / w) | 0;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; q[qt++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; q[qt++] = i + 1; }
      if (y > 0 && m[i - w] && !lab[i - w]) { lab[i - w] = cur; q[qt++] = i - w; }
      if (y < h - 1 && m[i + w] && !lab[i + w]) { lab[i + w] = cur; q[qt++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  const o = new Uint8Array(w * h); let border = 0;
  for (let i = 0; i < w * h; i++) if (lab[i] === best && best) {
    o[i] = 1; const x = i % w, y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
  }
  return { mask: o, area: bestSize / (w * h), border: border / (2 * (w + h)) };
}

function cleanMask(raw, w, h) {
  const r = Math.max(2, Math.round(Math.max(w, h) / 160));
  let m = erode(dilate(raw, w, h, r), w, h, r);      // 閉運算：填返啲字
  m = dilate(erode(m, w, h, 1), w, h, 1);             // 開運算：去雜點
  m = fillHoles(m, w, h);
  return largestComponent(m, w, h);
}

/** 「似紙」遮罩：光、低飽和 */
function paperMask(img) {
  const n = img.w * img.h, p = new Float32Array(n), d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    p[i] = (r + g + b) / 765 - 1.3 * (mx - mn) / (mx + 1);
  }
  const { t, sep } = otsu(p, n, -1.3, 1);
  const raw = new Uint8Array(n); for (let i = 0; i < n; i++) raw[i] = p[i] > t ? 1 : 0;
  const c = cleanMask(raw, img.w, img.h); c.sep = sep; c.kind = 'paper';
  return c;
}

/** 「唔似背景」遮罩：用相片四邊嘅顏色做背景模型 */
function backgroundMask(img) {
  const { w, h, data: d } = img, n = w * h;
  const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const samples = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x < bw || y < bw || x >= w - bw || y >= h - bw) { const j = (y * w + x) * 4; samples.push([d[j], d[j + 1], d[j + 2]]); }
  }
  // k-means（k=5）
  const K = 5; let C = [];
  for (let k = 0; k < K; k++) C.push(samples[Math.floor((k + 0.5) * samples.length / K)].slice());
  for (let it = 0; it < 8; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let bi = 0, bd = 1e18;
      for (let k = 0; k < K; k++) { const dd = (s[0] - C[k][0]) ** 2 + (s[1] - C[k][1]) ** 2 + (s[2] - C[k][2]) ** 2; if (dd < bd) { bd = dd; bi = k; } }
      const a = acc[bi]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++;
    }
    C = C.map((c, k) => acc[k][3] ? [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]] : c);
  }
  const dv = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let bd = 1e18;
    for (let k = 0; k < K; k++) { const dd = (d[j] - C[k][0]) ** 2 + (d[j + 1] - C[k][1]) ** 2 + (d[j + 2] - C[k][2]) ** 2; if (dd < bd) bd = dd; }
    dv[i] = Math.sqrt(bd);
  }
  const { t, sep } = otsu(dv, n, 0, 260);
  const thr = Math.max(t, 28);
  const raw = new Uint8Array(n); for (let i = 0; i < n; i++) raw[i] = dv[i] > thr ? 1 : 0;
  const c = cleanMask(raw, w, h); c.sep = sep; c.kind = 'bg';
  return c;
}

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up);
}
function simplifyClosed(h, eps) { // 簡化閉合多邊形
  let pts = h.slice(), changed = true;
  while (changed && pts.length > 4) {
    changed = false; let bi = -1, bd = 1e18;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const L = dist(a[0], a[1], c[0], c[1]) || 1;
      const dd = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L;
      if (dd < bd) { bd = dd; bi = i; }
    }
    if (bd < eps) { pts.splice(bi, 1); changed = true; }
  }
  return pts;
}
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; }

export function orderQuad(pts) { // → TL,TR,BR,BL 平面陣列
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0, bv = 1e18; s.forEach((p, i) => { if (p[0] + p[1] < bv) { bv = p[0] + p[1]; k = i; } });
  const o = []; for (let i = 0; i < 4; i++) { const p = s[(k + i) % 4]; o.push(p[0], p[1]); }
  return o;
}

function maskToQuad(mk, w, h) {
  const m = mk.mask, pts = [];
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1; const row = y * w;
    for (let x = 0; x < w; x++) if (m[row + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); pts.push([r + 1, y]); }
  }
  if (pts.length < 8) return null;
  let hull = convexHull(pts);
  let eps = Math.max(w, h) * 0.006;
  let s = simplifyClosed(hull, eps);
  while (s.length > 22) { eps *= 1.4; s = simplifyClosed(hull, eps); }
  if (s.length < 4) return null;
  const n = s.length; let best = null, ba = -1;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const ar = polyArea([s[a], s[b], s[c], s[d]]); if (ar > ba) { ba = ar; best = [s[a], s[b], s[c], s[d]]; }
  }
  return orderQuad(best);
}

function quadMaskIoU(q, mk, w, h) {
  // 用掃描線計 quad 同 mask 嘅 IoU（喺細圖度做，夠快）
  const m = mk.mask; let inter = 0, qa = 0, ma = 0;
  const P = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
  for (let y = 0; y < h; y += 2) {
    const yy = y + 0.5, xs = [];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) xs.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((a, b) => a - b);
    const x0 = xs.length >= 2 ? xs[0] : 1e9, x1 = xs.length >= 2 ? xs[xs.length - 1] : -1e9;
    for (let x = 0; x < w; x += 2) {
      const inQ = x + 0.5 >= x0 && x + 0.5 <= x1, inM = m[y * w + x] === 1;
      if (inQ) qa++; if (inM) ma++; if (inQ && inM) inter++;
    }
  }
  return inter / Math.max(1, qa + ma - inter);
}

// ---------------------------------------------------------------- 邊緣支持度（評分同微調）
function edgeSupport(g, w, h, ax, ay, bx, by, cx, cy, t0 = 0.06, t1 = 0.94, N = 40) {
  const L = dist(ax, ay, bx, by); if (L < 4) return { frac: 0, cont: 0 };
  let nx = -(by - ay) / L, ny = (bx - ax) / L;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // 法線指向外
  let hit = 0, cont = 0, cnt = 0;
  const off = Math.max(1.5, Math.max(w, h) / 400);
  for (let k = 0; k < N; k++) {
    const t = t0 + (t1 - t0) * k / (N - 1), px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
    let best = 0;
    for (let o = -2; o <= 2; o++) {
      const qx = px + nx * o, qy = py + ny * o;
      const out = sampleGray(g, w, h, qx + nx * off, qy + ny * off), inn = sampleGray(g, w, h, qx - nx * off, qy - ny * off);
      if (out < 0 || inn < 0) continue;
      const v = Math.abs(out - inn); if (v > best) best = v;
    }
    cnt++; if (best > 14) hit++; cont += Math.min(best, 60) / 60;
  }
  return { frac: hit / cnt, cont: cont / cnt };
}
function quadScore(g, w, h, q) {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  let sum = 0, mn = 1;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, e = edgeSupport(g, w, h, q[2 * i], q[2 * i + 1], q[2 * j], q[2 * j + 1], cx, cy);
    const s = 0.5 * e.frac + 0.5 * e.cont; sum += s; mn = Math.min(mn, s);
  }
  return 0.75 * sum / 4 + 0.25 * mn;
}
function cornerObjective(g, w, h, q, i) {
  // 角點目標：兩條相鄰邊喺角附近要有清楚邊緣，而延長線出去角外面就唔應該有
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const X = q[2 * i], Y = q[2 * i + 1];
  let s = 0;
  for (const j of [(i + 3) % 4, (i + 1) % 4]) {
    const OX = q[2 * j], OY = q[2 * j + 1]; // 由角點出發，t=0 喺角點
    const L = Math.max(8, dist(X, Y, OX, OY)), D = Math.hypot(w, h);
    const nearT = Math.min(0.3, 0.035 * D / L), extT = Math.min(0.12, 0.022 * D / L), t0 = Math.min(0.02, 1.5 / L);
    const near = edgeSupport(g, w, h, X, Y, OX, OY, cx, cy, t0, nearT, 24);
    const whole = edgeSupport(g, w, h, X, Y, OX, OY, cx, cy, nearT, 0.95, 24);
    const ext = edgeSupport(g, w, h, X, Y, OX, OY, cx, cy, -extT, -t0, 14);
    s += near.cont + 0.5 * near.frac + 0.5 * whole.cont - 0.9 * ext.cont - 0.4 * ext.frac;
  }
  return s;
}
function refineQuad(g, w, h, q, R, iters = 2) {
  q = q.slice();
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < 4; i++) {
      const ox = q[2 * i], oy = q[2 * i + 1];
      let best = cornerObjective(g, w, h, q, i), bx = ox, by = oy;
      const step = Math.max(1, Math.round(R / 4));
      for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
        q[2 * i] = ox + dx; q[2 * i + 1] = oy + dy;
        const v = cornerObjective(g, w, h, q, i); if (v > best + 1e-6) { best = v; bx = q[2 * i]; by = q[2 * i + 1]; }
      }
      // 再細步
      const cx0 = bx, cy0 = by;
      for (let dy = -step; dy <= step; dy++) for (let dx = -step; dx <= step; dx++) {
        q[2 * i] = cx0 + dx; q[2 * i + 1] = cy0 + dy;
        const v = cornerObjective(g, w, h, q, i); if (v > best + 1e-6) { best = v; bx = q[2 * i]; by = q[2 * i + 1]; }
      }
      q[2 * i] = bx; q[2 * i + 1] = by;
    }
  }
  return q;
}

function isGoodQuad(q, w, h) {
  const P = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4], c = P[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const s = Math.sign(cr); if (!s) return false; if (sign && s !== sign) return false; sign = s;
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9)))) * 180 / Math.PI;
    if (ang < 35 || ang > 145) return false;
  }
  const area = polyArea(P) / (w * h);
  return area > 0.04 && area < 1.02;
}
function quadDist(a, b, w, h) { let s = 0; for (let i = 0; i < 4; i++) s += dist(a[2 * i], a[2 * i + 1], b[2 * i], b[2 * i + 1]); return s / 4 / Math.hypot(w, h); }

// ---------------------------------------------------------------- 模型載入
let ortP = null;
export function getOrt() {
  if (!ortP) {
    ortP = import(ORT_BASE + 'ort.webgpu.min.mjs').then((ort) => {
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = (self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1);
      return ort;
    }).catch((e) => { ortP = null; throw new Error('載入 AI 運算庫失敗（需要上網一次）：' + e.message); });
  }
  return ortP;
}

export async function fetchModel(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* 非 https 環境 */ }
  if (cache) { const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載模型失敗 ${url}（HTTP ${res.status}）`);
  const total = +res.headers.get('content-length') || 0;
  let buf;
  if (res.body && res.body.getReader) {
    const rd = res.body.getReader(), chunks = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onProgress && onProgress(got, total); }
    buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else buf = new Uint8Array(await res.arrayBuffer());
  if (cache) { try { await cache.put(url, new Response(buf.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { } }
  return buf;
}

let cornerP = null, uvP = null;
export const runtimeInfo = { uvdocBackend: '', cornerBackend: '', error: '' };
export function getCornerSession(onProgress) {
  if (!cornerP) cornerP = (async () => {
    const ort = await getOrt();
    const bytes = await fetchModel(MODEL_BASE + (await manifest()).corner, onProgress);
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    runtimeInfo.cornerBackend = 'CPU';
    return s;
  })().catch((e) => { cornerP = null; runtimeInfo.error = e.message; throw e; });
  return cornerP;
}
export function getUvdocSession(onProgress) {
  if (!uvP) uvP = (async () => {
    const ort = await getOrt();
    const bytes = await fetchModel(MODEL_BASE + (await manifest()).uvdoc, onProgress);
    let adapter = null;
    try { adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (e) { adapter = null; }
    if (adapter) {
      try {
        const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
        runtimeInfo.uvdocBackend = 'GPU（WebGPU）';
        return s;
      } catch (e) { console.warn('WebGPU 唔用得，轉用 CPU', e); }
    }
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    runtimeInfo.uvdocBackend = 'CPU（WASM）';
    return s;
  })().catch((e) => { uvP = null; runtimeInfo.error = e.message; throw e; });
  return uvP;
}

// ---------------------------------------------------------------- 半精度
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
function toHalf(v) {
  _f[0] = v; const x = _u[0], sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
function tensorToF32(t) {
  const d = t.data;
  if (d instanceof Float32Array) return d;
  if (d instanceof Uint16Array) { const o = new Float32Array(d.length); for (let i = 0; i < d.length; i++) o[i] = fromHalf(d[i]); return o; }
  return Float32Array.from(d);
}

// ---------------------------------------------------------------- 角點模型
export async function detectCornersML(analysisCanvas) {
  const sess = await getCornerSession();
  const ort = await getOrt();
  const S = 224, c = makeCanvas(S, S), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(analysisCanvas, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data, x = new Float32Array(S * S * 3);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    x[j] = (d[i] / 255 - mean[0]) / std[0]; x[j + 1] = (d[i + 1] / 255 - mean[1]) / std[1]; x[j + 2] = (d[i + 2] / 255 - mean[2]) / std[2];
  }
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, S, S, 3]) });
  let coords = null, logit = 0;
  for (const k in out) { const v = out[k].data; if (v.length === 8) coords = Array.from(v); else if (v.length === 1) logit = v[0]; }
  return { quad: coords, score: 1 / (1 + Math.exp(-logit)) };
}

// ---------------------------------------------------------------- 書脊
function findSpine(g, w, h, q) {
  // 將跨頁拉正成細圖，搵中間最暗、最少字嘅直條
  const r = estimateAspect(q, w, h);
  const RH = 240, RW = Math.max(60, Math.round(RH * r));
  const H = unitHomography(q);
  const mean = new Float32Array(RW), sd = new Float32Array(RW);
  for (let x = 0; x < RW; x++) {
    let s = 0, s2 = 0, n = 0;
    for (let y = Math.round(RH * 0.08); y < RH * 0.92; y++) {
      const [px, py] = applyH(H, (x + 0.5) / RW, (y + 0.5) / RH);
      const v = sampleGray(g, w, h, px, py); if (v < 0) continue;
      s += v; s2 += v * v; n++;
    }
    mean[x] = n ? s / n : 0; sd[x] = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
  }
  const win = Math.max(2, Math.round(RW * 0.012));
  const sm = (a) => { const o = new Float32Array(RW); for (let x = 0; x < RW; x++) { let s = 0, n = 0; for (let k = -win; k <= win; k++) { const i = x + k; if (i >= 0 && i < RW) { s += a[i]; n++; } } o[x] = s / n; } return o; };
  const M = sm(mean), D = sm(sd);
  const med = Array.from(M.slice(Math.round(RW * 0.15), Math.round(RW * 0.85))).sort((a, b) => a - b);
  const median = med[med.length >> 1] || 0;
  let bx = Math.round(RW / 2), bs = -1e9;
  for (let x = Math.round(RW * 0.38); x <= Math.round(RW * 0.62); x++) {
    const s = (median - M[x]) - 0.6 * D[x] - 0.15 * Math.abs(x - RW / 2) / RW * 100;
    if (s > bs) { bs = s; bx = x; }
  }
  const depth = median - M[bx];
  return { u: (bx + 0.5) / RW, depth, aspect: r };
}

function refineSpineEnd(mk, w, h, H, u, fromV, toV) {
  if (!mk) return null;
  const steps = 80; let run = 0;
  for (let k = 0; k <= steps; k++) {
    const v = fromV + (toV - fromV) * k / steps;
    const [x, y] = applyH(H, u, v);
    const xi = Math.round(x), yi = Math.round(y);
    const on = xi >= 0 && yi >= 0 && xi < w && yi < h && mk.mask[yi * w + xi];
    if (on) { run++; if (run >= 3) { const vv = fromV + (toV - fromV) * (k - 2) / steps; return applyH(H, u, vv); } } else run = 0;
  }
  return null;
}

// ---------------------------------------------------------------- 主偵測
/**
 * 偵測書本位置、單頁 / 跨頁、書脊。
 * analysisCanvas：已轉正嘅細圖（長邊 ~512）。midCanvas：中等解像度（用嚟微調角點）。
 */
export async function detectBook(analysisCanvas, midCanvas, opts = {}) {
  const img = canvasToImg(analysisCanvas), { w, h } = img, g = toGray(img);
  const cands = [];
  let ml = null;
  try { ml = await detectCornersML(analysisCanvas); } catch (e) { console.warn('角點模型失敗', e); }
  if (ml && ml.quad) cands.push({ q: denorm(ml.quad, w, h), method: 'ai', prior: 0.12 * ml.score + 0.06 });
  const masks = [];
  for (const fn of [backgroundMask, paperMask]) {
    try {
      const mk = fn(img);
      const ok = mk.area > 0.05 && mk.area < 0.97 && mk.sep > 0.45 && mk.border < 0.5;
      if (ok) { masks.push(mk); const q = maskToQuad(mk, w, h); if (q) cands.push({ q, method: mk.kind === 'bg' ? 'mask-bg' : 'mask-paper', prior: 0 }); }
    } catch (e) { console.warn(e); }
  }
  for (const c of cands) {
    c.valid = isGoodQuad(c.q, w, h);
    c.edge = c.valid ? quadScore(g, w, h, c.q) : 0;
  }
  for (const c of cands) {
    c.agree = cands.filter((o) => o !== c && o.valid && quadDist(o.q, c.q, w, h) < 0.03).length;
    c.total = c.edge + c.prior + 0.08 * c.agree;
  }
  const valid = cands.filter((c) => c.valid).sort((a, b) => b.total - a.total);
  const debug = cands.map((c) => ({ m: c.method, edge: +c.edge.toFixed(3), total: +c.total.toFixed(3), valid: c.valid, q: c.q.map((v, i) => +(v / (i % 2 ? h : w)).toFixed(3)) }));
  let result;
  if (valid.length && valid[0].edge >= 0.28) {
    const best = valid[0];
    let q = refineQuad(g, w, h, best.q, Math.max(3, Math.round(Math.max(w, h) * 0.012)));
    if (quadScore(g, w, h, q) < best.edge) q = best.q;
    // 喺中解像度再微調一次
    let qn = normq(q, w, h);
    if (midCanvas) {
      const mi = canvasToImg(midCanvas), mg = toGray(mi);
      let mq = denorm(qn, mi.w, mi.h);
      const before = quadScore(mg, mi.w, mi.h, mq);
      const r = refineQuad(mg, mi.w, mi.h, mq, Math.max(2, Math.round(Math.max(mi.w, mi.h) * 0.004)), 1);
      if (quadScore(mg, mi.w, mi.h, r) >= before) qn = normq(r, mi.w, mi.h);
    }
    result = { quad: qn, method: best.method, confidence: Math.min(1, best.edge + 0.1 * best.agree), failed: false };
    // 本書塞滿成個畫面：大部分角都貼住相邊，而邊緣又唔清楚 → 用成幅相
    const nb = [0, 1, 2, 3].filter((i) => Math.min(qn[2 * i], qn[2 * i + 1], 1 - qn[2 * i], 1 - qn[2 * i + 1]) < 0.03).length;
    if (nb >= 3 && best.edge < 0.55) result = { quad: [0, 0, 1, 0, 1, 1, 0, 1], method: 'full-frame', confidence: best.edge, failed: false };
  } else {
    result = { quad: [0, 0, 1, 0, 1, 1, 0, 1], method: 'full', confidence: 0, failed: true };
  }
  // 單頁 / 跨頁
  const qpx = denorm(result.quad, w, h);
  const sp = findSpine(g, w, h, qpx);
  let mode = 'single';
  if (result.failed) mode = 'single'; // 搵唔到書就成幅相照出，唔好夾硬切開
  else if (sp.aspect > 1.18) mode = 'spread';
  else if (sp.aspect > 1.0 && sp.depth > 18) mode = 'spread';
  result.aspect = sp.aspect;
  result.mode = mode;
  // 書脊兩端
  const H = unitHomography(qpx);
  let top = applyH(H, sp.u, 0), bot = applyH(H, sp.u, 1);
  if (!result.failed && masks.length) {
    const mk = masks.map((m) => ({ m, iou: quadMaskIoU(qpx, m, w, h) })).sort((a, b) => b.iou - a.iou)[0];
    if (mk.iou > 0.75) {
      const t2 = refineSpineEnd(mk.m, w, h, H, sp.u, -0.08, 0.3); if (t2) top = t2;
      const b2 = refineSpineEnd(mk.m, w, h, H, sp.u, 1.08, 0.7); if (b2) bot = b2;
    }
  }
  result.spine = [top[0] / w, top[1] / h, bot[0] / w, bot[1] / h];
  result.debug = debug;
  return result;
}

/** 由 shot 嘅設定計出每一頁嘅四邊形（正規化），key: S / L / R */
export function pageQuads(quad, spine, mode) {
  if (mode !== 'spread') return { S: quad };
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad, [tx, ty, bx, by] = spine;
  return { L: [x0, y0, tx, ty, bx, by, x3, y3], R: [tx, ty, x1, y1, x2, y2, bx, by] };
}

// ---------------------------------------------------------------- UVDoc 曲頁拉直
const UV_W = 488, UV_H = 712, GW = 31, GH = 45, MARGIN = 0.04;

function expandedHomography(qpx, m) {
  const H = unitHomography(qpx);
  const e = [[-m, -m], [1 + m, -m], [1 + m, 1 + m], [-m, 1 + m]].flatMap(([u, v]) => applyH(H, u, v));
  return unitHomography(e);
}

/** 返回 Float32Array(2*45*31) 網格，或者 null（模型結果唔可信） */
export async function uvdocGrid(srcImg, quadN, onProgress) {
  const sess = await getUvdocSession(onProgress);
  const ort = await getOrt();
  const He = expandedHomography(denorm(quadN, srcImg.w, srcImg.h), MARGIN);
  const n = UV_W * UV_H, x = new Uint16Array(3 * n), d = srcImg.data, sw = srcImg.w, sh = srcImg.h;
  const LUT = new Uint16Array(256); for (let i = 0; i < 256; i++) LUT[i] = toHalf(i / 255);
  const WHITE = LUT[255];
  for (let yy = 0; yy < UV_H; yy++) for (let xx = 0; xx < UV_W; xx++) {
    const [px, py] = applyH(He, xx / (UV_W - 1), yy / (UV_H - 1));
    const o = yy * UV_W + xx;
    if (px < 0 || py < 0 || px > sw - 1 || py > sh - 1) { x[o] = x[o + n] = x[o + 2 * n] = WHITE; continue; }
    const x0 = px | 0, y0 = py | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1), fx = px - x0, fy = py - y0;
    for (let c = 0; c < 3; c++) {
      const a = d[(y0 * sw + x0) * 4 + c], b = d[(y0 * sw + x1) * 4 + c], cc = d[(y1 * sw + x0) * 4 + c], dd = d[(y1 * sw + x1) * 4 + c];
      const v = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
      x[o + c * n] = LUT[Math.max(0, Math.min(255, Math.round(v)))];
    }
  }
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float16', x, [1, 3, UV_H, UV_W]) });
  let gridT = null; for (const k in out) if (out[k].dims[1] === 2) gridT = out[k];
  if (!gridT) return null;
  const grid = Float32Array.from(tensorToF32(gridT));
  // 檢查結果：覆蓋範圍要夠、唔可以摺埋
  let minx = 9, maxx = -9, miny = 9, maxy = -9, bad = 0;
  const N = GW * GH;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const gx = grid[j * GW + i], gy = grid[N + j * GW + i];
    if (!isFinite(gx) || !isFinite(gy)) return null;
    minx = Math.min(minx, gx); maxx = Math.max(maxx, gx); miny = Math.min(miny, gy); maxy = Math.max(maxy, gy);
    if (i > 0 && gx <= grid[j * GW + i - 1]) bad++;
    if (j > 0 && gy <= grid[N + (j - 1) * GW + i]) bad++;
  }
  if (maxx - minx < 1.2 || maxy - miny < 1.2 || bad > N * 0.04) return null;
  return grid;
}

// ---------------------------------------------------------------- 輸出一頁
/** 由原圖（Img）同四邊形（＋可選網格）砌出平直嘅一頁，返回 ImageData */
export function renderPage(src, quadN, grid, outW, outH) {
  const sw = src.w, sh = src.h, d = src.data;
  const qpx = denorm(quadN, sw, sh);
  const H = grid ? expandedHomography(qpx, MARGIN) : unitHomography(qpx);
  const out = new ImageData(outW, outH), o = out.data;
  const N = GW * GH;
  // 預先計每一欄嘅網格插值參數
  const colI = new Int32Array(outW), colF = new Float32Array(outW);
  for (let x = 0; x < outW; x++) { const t = outW > 1 ? x / (outW - 1) * (GW - 1) : 0; colI[x] = Math.min(GW - 2, t | 0); colF[x] = t - colI[x]; }
  for (let y = 0; y < outH; y++) {
    let ri = 0, rf = 0;
    if (grid) { const t = outH > 1 ? y / (outH - 1) * (GH - 1) : 0; ri = Math.min(GH - 2, t | 0); rf = t - ri; }
    for (let x = 0; x < outW; x++) {
      let u, v;
      if (grid) {
        const i = colI[x], f = colF[x], a = ri * GW + i, b = a + GW;
        const gx = (grid[a] * (1 - f) + grid[a + 1] * f) * (1 - rf) + (grid[b] * (1 - f) + grid[b + 1] * f) * rf;
        const gy = (grid[N + a] * (1 - f) + grid[N + a + 1] * f) * (1 - rf) + (grid[N + b] * (1 - f) + grid[N + b + 1] * f) * rf;
        u = (gx + 1) / 2; v = (gy + 1) / 2;
      } else { u = (x + 0.5) / outW; v = (y + 0.5) / outH; }
      const w = H[6] * u + H[7] * v + 1;
      const px = (H[0] * u + H[1] * v + H[2]) / w, py = (H[3] * u + H[4] * v + H[5]) / w;
      const oi = (y * outW + x) * 4;
      if (px < 0 || py < 0 || px > sw - 1 || py > sh - 1) { o[oi] = o[oi + 1] = o[oi + 2] = o[oi + 3] = 255; continue; }
      const x0 = px | 0, y0 = py | 0, x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = px - x0, fy = py - y0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      o[oi] = d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11;
      o[oi + 1] = d[i00 + 1] * w00 + d[i01 + 1] * w01 + d[i10 + 1] * w10 + d[i11 + 1] * w11;
      o[oi + 2] = d[i00 + 2] * w00 + d[i01 + 2] * w01 + d[i10 + 2] * w10 + d[i11 + 2] * w11;
      o[oi + 3] = 255;
    }
  }
  return out;
}

/** 一頁嘅長闊比（闊 / 高） */
export function pageAspect(quadN, w, h) {
  return estimateAspect(denorm(quadN, w, h), w, h);
}
