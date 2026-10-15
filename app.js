// app.js — 書影 BookScan 主程式
// 所有相片只會存喺你部機嘅瀏覽器（IndexedDB），唔會上傳去任何伺服器。
import * as V from './vision.js';

const LIBS = {
  pdf: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  sortable: 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js',
  zip: 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js',
};
const RES_PRESETS = { small: 1600, std: 2400, high: 3200 };
const THUMB_H = 420;

// ================================================================ 小工具
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
let toastT = 0;
function toast(msg, ms = 2800) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const loaded = {};
function loadScript(url) {
  if (!loaded[url]) loaded[url] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = () => { delete loaded[url]; rej(new Error('載入失敗：' + url)); }; document.head.append(s); });
  return loaded[url];
}
function canvasToBlob(c, type = 'image/jpeg', q = 0.85) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise((r) => c.toBlob(r, type, q));
}
function imageDataToCanvas(id) { const c = V.makeCanvas(id.width, id.height); c.getContext('2d').putImageData(id, 0, 0); return c; }
const ICON = {
  cam: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="4"/></svg>',
  up: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4m-5 5 5-5 5 5M4 20h16"/></svg>',
  pdf: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12m-5-5 5 5 5-5M4 20h16"/></svg>',
  gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  redo: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9 13a3 3 0 1 0 3-3"/></svg>',
  del: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};
const iconBtn = (icon, text, attrs = {}, longText = '') => h('button', attrs, h('span', { class: 'ic', html: ICON[icon] }), h('span', { class: 'tx' }, text), longText ? h('span', { class: 'long' }, longText) : null);

// ================================================================ IndexedDB
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open('bookscan', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      const s = d.createObjectStore('shots', { keyPath: 'id' }); s.createIndex('bookId', 'bookId');
      d.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const st = t.objectStore(store); let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('儲存失敗（可能係空間唔夠）'));
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbGet = (s, k) => tx(s, 'readonly', (st) => reqP(st.get(k)));
const dbPut = (s, v, k) => tx(s, 'readwrite', (st) => { k === undefined ? st.put(v) : st.put(v, k); });
const dbDel = (s, k) => tx(s, 'readwrite', (st) => { st.delete(k); });
const dbAll = (s) => tx(s, 'readonly', (st) => reqP(st.getAll()));
const shotsOf = (bookId) => tx('shots', 'readonly', (st) => reqP(st.index('bookId').getAll(bookId)));
const delBlobsOf = (shotId) => tx('blobs', 'readwrite', (st) => { st.delete(IDBKeyRange.bound(shotId + '|', shotId + '|￿')); });

// ================================================================ 狀態
const S = { books: [], book: null, shots: [], sel: new Set(), view: 'library' };
const thumbURLs = new Map(); // key -> objectURL
function defaultSettings() { return { dewarp: true, heightCm: 21, res: 'std', jpegQ: 0.85, uniformAspect: true, guide: 'spread' }; }
const bookSettings = () => Object.assign(defaultSettings(), S.book?.settings || {});
const orderedShots = () => S.shots.slice().sort((a, b) => a.order - b.order);
function pageKeys(shot) {
  if (shot.mode !== 'spread') return ['S'];
  return S.book.dir === 'rtl' ? ['R', 'L'] : ['L', 'R'];
}
const included = (shot, k) => shot.include?.[k] !== false;

// ================================================================ 讀 EXIF 拍攝時間
async function exifTime(file) {
  try {
    if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
    const buf = await file.slice(0, 256 * 1024).arrayBuffer(), dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < dv.byteLength) {
      const marker = dv.getUint16(off), len = dv.getUint16(off + 2);
      if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) {
        const t = off + 10, le = dv.getUint16(t) === 0x4949;
        const u16 = (p) => dv.getUint16(t + p, le), u32 = (p) => dv.getUint32(t + p, le);
        const str = (p, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint8(t + p + i); if (!c) break; s += String.fromCharCode(c); } return s; };
        const readIFD = (p) => { const n = u16(p), o = {}; for (let i = 0; i < n; i++) { const e = p + 2 + i * 12, tag = u16(e), cnt = u32(e + 4); o[tag] = { cnt, val: cnt > 4 ? u32(e + 8) : e + 8, raw: e + 8 }; } return o; };
        const ifd0 = readIFD(u32(4)); let dt = null, sub = '';
        if (ifd0[0x8769]) {
          const ex = readIFD(u32(ifd0[0x8769].raw));
          if (ex[0x9003]) dt = str(ex[0x9003].val, 19);
          if (ex[0x9291]) sub = str(ex[0x9291].cnt > 4 ? ex[0x9291].val : ex[0x9291].raw, ex[0x9291].cnt);
        }
        if (!dt && ifd0[0x0132]) dt = str(ifd0[0x0132].val, 19);
        if (!dt) return null;
        const m = dt.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/); if (!m) return null;
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() + (sub ? +('0.' + sub.replace(/\D/g, '')) * 1000 : 0);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch (e) { /* 冇 EXIF */ }
  return null;
}
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// ================================================================ 處理隊列
const Q = { pending: [], running: false, paused: false, total: 0, done: 0, current: '' };
function enqueue(id, opts = {}) {
  const ex = Q.pending.find((p) => p.id === id);
  if (ex) Object.assign(ex.opts, opts); else { Q.pending.push({ id, opts }); Q.total++; }
  runQueue();
}
async function runQueue() {
  if (Q.running) return; Q.running = true;
  while (Q.pending.length) {
    if (Q.paused) { await sleep(300); continue; }
    const job = Q.pending.shift();
    updateStatus();
    try { await processShot(job.id, job.opts); } catch (e) { console.error(e); }
    Q.done++;
    updateStatus();
    await sleep(0);
  }
  Q.running = false; Q.total = 0; Q.done = 0; updateStatus();
}
let modelMsg = '';
function modelProgress(name) { return (got, total) => { modelMsg = `第一次使用：下載${name} ${fmtBytes(got)}${total ? ' / ' + fmtBytes(total) : ''}`; updateStatus(); }; }

async function loadBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) {
    // 後備：經 <img> 解碼
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return await createImageBitmap(img);
    } catch (e2) { throw new Error('讀唔到呢張相（可能係 HEIC 格式，請先轉做 JPG）'); }
    finally { URL.revokeObjectURL(url); }
  }
}
const quadKey = (q) => q.map((v) => v.toFixed(4)).join(',');

async function processShot(id, opts = {}) {
  let shot = await dbGet('shots', id); if (!shot) return;
  const blob = await dbGet('blobs', id + '|orig');
  if (!blob) { shot.status = 'error'; shot.error = '搵唔到原相'; await saveShot(shot); return; }
  const rev0 = shot.rev || 0;
  shot.status = 'working'; refreshCard(shot);
  let bmp;
  try { bmp = await loadBitmap(blob); }
  catch (e) { shot.status = 'error'; shot.error = e.message; await saveShot(shot); return; }
  try {
    const mid = V.orientedCanvas(bmp, shot.rot || 0, V.MID_SIDE);
    shot.w = mid.width; shot.h = mid.height;
    if (!shot.quad || opts.redetect) {
      const ana = V.scaleCanvas(mid, V.ANALYSIS_SIDE);
      V.getCornerSession(modelProgress('偵測模型')).catch(() => {});
      const det = await V.detectBook(ana, mid);
      modelMsg = '';
      shot.auto = { quad: det.quad, spine: det.spine, mode: det.mode };
      shot.detect = { method: det.method, confidence: det.confidence, failed: det.failed };
      const g = shot.guide;
      if (det.failed && g && !(shot.rot) && Math.abs(mid.width / mid.height - g.aspect) / g.aspect < 0.03) {
        // 自動偵測唔到：用影相時嘅對準框
        det.quad = g.quad; det.mode = g.mode; det.spine = centerSpine(g.quad);
        shot.auto = { quad: det.quad, spine: det.spine, mode: det.mode };
        shot.detect = { method: 'guide', confidence: 0, failed: false };
      }
      if (!shot.edited) {
        shot.quad = det.quad; shot.spine = det.spine; if (!shot.modeLocked) shot.mode = det.mode;
        // 睇唔到書邊時，AI 拉直會亂扭，預設關咗（可以喺「調整」再開）
        if (det.method === 'full' || det.method === 'full-frame') shot.dewarp = false;
      }
      shot.grids = {}; shot.gridKeys = {};
    }
    if (!shot.spine) shot.spine = centerSpine(shot.quad);
    const set = bookSettings();
    const pages = V.pageQuads(shot.quad, shot.spine, shot.mode);
    const midImg = V.canvasToImg(mid);
    shot.grids = shot.grids || {}; shot.gridKeys = shot.gridKeys || {}; shot.aspects = {};
    shot.spreadAspect = shot.mode === 'spread' ? V.estimateAspect(V.denorm(shot.quad, mid.width, mid.height), mid.width, mid.height) : null;
    for (const [k, q] of Object.entries(pages)) {
      shot.aspects[k] = shot.mode === 'spread' ? shot.spreadAspect / 2 : V.pageAspect(q, mid.width, mid.height);
      const want = set.dewarp && shot.dewarp !== false;
      if (want) {
        if (!shot.grids[k] || shot.gridKeys[k] !== quadKey(q)) {
          try { shot.grids[k] = await V.uvdocGrid(midImg, q, modelProgress('曲頁拉直模型')); shot.gridKeys[k] = quadKey(q); }
          catch (e) { console.warn(e); shot.grids[k] = null; shot.gridKeys[k] = ''; toast('曲頁拉直模型載入唔到，暫時用普通拉正'); }
          modelMsg = '';
        }
      }
      const grid = want ? shot.grids[k] : null;
      const th = THUMB_H, tw = Math.max(20, Math.round(th * shot.aspects[k]));
      const out = imageDataToCanvas(V.renderPage(midImg, q, grid, tw, th));
      await dbPut('blobs', await canvasToBlob(out, 'image/jpeg', 0.8), `${id}|thumb|${k}`);
      await sleep(0);
    }
    for (const k of ['S', 'L', 'R']) if (!pages[k]) { delete shot.grids[k]; delete shot.gridKeys[k]; }
    shot.status = 'ready'; shot.error = ''; shot.thumbV = (shot.thumbV || 0) + 1;
  } catch (e) {
    console.error(e); shot.status = 'error'; shot.error = '處理失敗：' + e.message;
  } finally { bmp.close?.(); }
  // 處理期間用戶可能刪咗或者重新排過次序
  const cur = await dbGet('shots', id);
  if (!cur) { await delBlobsOf(id); return; }
  if ((cur.rev || 0) !== rev0) return; // 處理期間用戶改過設定，等下一輪重新處理
  shot.order = cur.order;
  await saveShot(shot);
}
function centerSpine(q) {
  const H = V.unitHomography(q);
  const t = V.applyH(H, 0.5, 0), b = V.applyH(H, 0.5, 1);
  return [t[0], t[1], b[0], b[1]];
}
async function saveShot(shot) {
  await dbPut('shots', shot);
  const i = S.shots.findIndex((s) => s.id === shot.id);
  if (i >= 0) S.shots[i] = shot;
  if (S.book && shot.bookId === S.book.id) refreshCard(shot);
}

// ================================================================ 書架
async function loadBooks() { S.books = (await dbAll('books')).sort((a, b) => b.updated - a.updated); }
async function openLibrary() {
  S.view = 'library'; S.book = null; S.shots = []; S.sel.clear();
  history.replaceState(null, '', location.pathname);
  await loadBooks(); renderBar(); renderSelbar(); renderLibrary();
}
async function renderLibrary() {
  $('#toolbarArea').innerHTML = '';
  const main = $('#main'); main.innerHTML = '';
  main.append(h('div', { class: 'toolbar' },
    h('button', { class: 'primary', onclick: newBookDialog }, '＋ 新書'),
  ));
  if (!S.books.length) {
    main.append(h('div', { class: 'empty' },
      h('h2', {}, '將實體書變成 PDF'),
      h('p', {}, '撳「＋ 新書」開始。之後可以直接影相，或者一次過上載已經影好嘅相。'),
      h('ol', {},
        h('li', {}, '影每一版（左右兩頁一齊影都得）'),
        h('li', {}, '程式自動搵書邊、切開左右頁、拉直曲頁'),
        h('li', {}, '有需要就手動調整，然後匯出 PDF')),
      h('p', {}, '相片只會存喺你呢部機，唔會上傳。')));
  } else {
    const list = h('div', { class: 'books' });
    for (const b of S.books) {
      const shots = await shotsOf(b.id);
      const size = shots.reduce((s, x) => s + (x.size || 0), 0);
      const pages = shots.reduce((s, x) => s + (x.mode === 'spread' ? (x.include?.L !== false) + (x.include?.R !== false) : (x.include?.S !== false ? 1 : 0)), 0);
      const first = shots.sort((a, c) => a.order - c.order)[0];
      const cov = h('div', { class: 'cov' }, '📖');
      if (first) dbGet('blobs', `${first.id}|thumb|${first.mode === 'spread' ? (b.dir === 'rtl' ? 'R' : 'L') : 'S'}`).then((bl) => { if (bl) { cov.innerHTML = ''; cov.append(h('img', { src: URL.createObjectURL(bl), alt: '' })); } });
      list.append(h('div', { class: 'book' }, cov,
        h('div', { class: 'meta' },
          h('b', {}, b.title || '未命名'),
          h('small', {}, `${shots.length} 張相 · ${pages} 頁 · ${b.dir === 'rtl' ? '直排' : '橫排'}`),
          h('small', {}, `佔用 ${fmtBytes(size)} · ${new Date(b.updated).toLocaleDateString()}`),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => openBook(b.id) }, '打開'),
            h('button', { class: 'danger', onclick: () => deleteBook(b, size) }, '刪除')))));
    }
    main.append(list);
  }
  main.append(await storagePanel());
}
async function storagePanel() {
  const box = h('div', { class: 'storage' }, h('h3', {}, '儲存空間'));
  try {
    const est = await navigator.storage.estimate();
    const pct = est.quota ? Math.min(100, est.usage / est.quota * 100) : 0;
    box.append(h('p', {}, `呢個網站用咗 ${fmtBytes(est.usage || 0)}（瀏覽器俾嘅上限大約 ${fmtBytes(est.quota || 0)}）`),
      h('div', { class: 'meter' }, h('i', { style: `width:${pct.toFixed(1)}%` })));
  } catch (e) { box.append(h('p', {}, '呢個瀏覽器報唔到用量。')); }
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (e) { }
  box.append(
    h('p', {}, '相片存喺瀏覽器嘅「網站資料」入面，喺檔案管理或者相簿度係搵唔到嘅。要釋放空間，喺上面逐本書撳「刪除」就得；或者去瀏覽器設定 → 網站資料 → 刪除呢個網站嘅資料（會連所有書一齊刪）。'),
    h('p', {}, persisted ? '✓ 已設定為「長期保存」，瀏覽器唔會自動清走。' : '提示：瀏覽器有機會喺空間緊張時自動清走資料。匯出 PDF 之後先好刪相。'),
    h('div', { class: 'seg' },
      !persisted && h('button', { onclick: async () => { const ok = await navigator.storage.persist?.(); toast(ok ? '已設定長期保存' : '瀏覽器拒絕咗（可以加入書籤或者主畫面再試）'); renderLibrary(); } }, '要求長期保存'),
      h('button', { onclick: async () => { await caches.delete('bookscan-models-v1'); toast('已清除 AI 模型快取（下次用會重新下載）'); } }, '清除 AI 模型快取')));
  return box;
}
function newBookDialog() {
  let dir = 'ltr';
  const title = h('input', { type: 'text', placeholder: '例如：紅樓夢 第一冊', value: '' });
  const seg = h('div', { class: 'seg' });
  const draw = () => { seg.innerHTML = ''; seg.append(
    h('button', { class: dir === 'ltr' ? 'on' : '', onclick: () => { dir = 'ltr'; draw(); } }, '橫排（向左翻，西式）'),
    h('button', { class: dir === 'rtl' ? 'on' : '', onclick: () => { dir = 'rtl'; draw(); } }, '直排（向右翻，中式）')); };
  draw();
  openDialog('新書', [
    h('div', { class: 'field' }, h('label', {}, '書名'), title),
    h('div', { class: 'field' }, h('label', {}, '排版'), seg, h('div', { class: 'hint' }, '直排書會先排右頁、後排左頁，PDF 亦會設定成由右至左閱讀。之後可以喺設定改。')),
  ], [
    { text: '取消' },
    { text: '建立', primary: true, act: async () => {
      const b = { id: uid(), title: title.value.trim() || '未命名的書', dir, created: Date.now(), updated: Date.now(), settings: defaultSettings() };
      await dbPut('books', b); await openBook(b.id);
    } },
  ]);
  setTimeout(() => title.focus(), 50);
}
async function deleteBook(b, size) {
  if (!await confirmDlg(`刪除「${b.title}」？`, `會刪除呢本書所有相片同設定，釋放大約 ${fmtBytes(size)}。已經匯出咗嘅 PDF 唔受影響。`, '刪除')) return;
  const shots = await shotsOf(b.id);
  for (const s of shots) { await delBlobsOf(s.id); await dbDel('shots', s.id); }
  await dbDel('books', b.id);
  toast('已刪除'); openLibrary();
}

// ================================================================ 書本頁面
async function openBook(id) {
  S.book = await dbGet('books', id); if (!S.book) return openLibrary();
  S.view = 'book'; S.sel.clear();
  S.shots = await shotsOf(id);
  history.replaceState(null, '', '#book=' + id);
  renderBar(); renderBookView();
  for (const s of S.shots) if (s.status !== 'ready' && s.status !== 'error') enqueue(s.id);
}
function renderBar() {
  const bar = $('#bar'); bar.innerHTML = '';
  if (S.view === 'library' || !S.book) {
    bar.append(h('div', { class: 'brand' }, '📖 書影', h('small', {}, '影書 → PDF')));
  } else {
    const t = h('input', { class: 'title-input', value: S.book.title, 'aria-label': '書名' });
    t.addEventListener('change', async () => { S.book.title = t.value.trim() || '未命名'; await touchBook(); });
    bar.append(iconBtn('back', '書架', { class: 'ghost', onclick: openLibrary }), t);
  }
}
async function touchBook() { S.book.updated = Date.now(); await dbPut('books', S.book); }
function renderBookView() {
  const ta = $('#toolbarArea'); ta.innerHTML = '';
  ta.append(
    h('div', { class: 'toolbar' },
      iconBtn('cam', '影相', { class: 'primary', onclick: () => openCamera() }),
      iconBtn('up', '上載相片', { onclick: () => $('#fileInput').click() }),
      iconBtn('pdf', '匯出 PDF', { onclick: exportDialog }),
      iconBtn('gear', '設定', { onclick: settingsDialog }),
    ),
    h('div', { class: 'status', id: 'status' }));
  renderGrid(); updateStatus();
}
function renderGrid() {
  const main = $('#main'); main.innerHTML = '';
  const shots = orderedShots();
  if (!shots.length) {
    main.append(h('div', { class: 'empty' },
      h('h2', {}, '仲未有相'),
      h('p', {}, '撳「影相」用相機逐版影，或者「上載相片」一次過揀晒（電腦可以直接拖相入嚟）。'),
      h('p', {}, '上載嘅相會按拍攝時間排好次序；冇拍攝時間就按檔名。')));
    return;
  }
  const grid = h('div', { id: 'grid' });
  for (const s of shots) grid.append(cardFor(s));
  main.append(grid);
  renumber();
  loadScript(LIBS.sortable).then(() => {
    if (!window.Sortable || !document.body.contains(grid)) return;
    window.Sortable.create(grid, { handle: '.handle', animation: 150, delay: 0, onEnd: saveOrderFromDOM });
  }).catch(() => {});
}
function cardFor(s) {
  const card = h('div', { class: 'card' + (S.sel.has(s.id) ? ' sel' : ''), 'data-id': s.id });
  fillCard(card, s); return card;
}
function fillCard(card, s) {
  card.innerHTML = '';
  const cb = h('input', { type: 'checkbox', 'aria-label': '揀選' }); cb.checked = S.sel.has(s.id);
  cb.addEventListener('change', () => { cb.checked ? S.sel.add(s.id) : S.sel.delete(s.id); card.classList.toggle('sel', cb.checked); renderSelbar(); });
  const thumbs = h('div', { class: 'thumbs', onclick: () => s.status === 'ready' && openEditor(s.id), title: '撳一下調整' });
  if (s.status === 'error') thumbs.append(h('div', { class: 'err' }, s.error || '出錯'));
  else if (s.status !== 'ready') thumbs.append(h('div', { class: 'spin' }, s.status === 'working' ? '處理緊…' : '排緊隊…'));
  else {
    const keys = s.mode === 'spread' ? ['L', 'R'] : ['S']; // 跟相片入面嘅位置顯示（左頁喺左）
    for (const k of keys) {
      const img = h('img', { alt: '', class: included(s, k) ? '' : 'off' });
      thumbs.append(h('span', { class: 'tw' + (keys.length === 1 ? ' solo' : '') }, img, h('i', { class: 'pl', 'data-k': k })));
      const key = `${s.id}|thumb|${k}`, cacheKey = key + '|' + (s.thumbV || 0);
      if (thumbURLs.has(cacheKey)) img.src = thumbURLs.get(cacheKey);
      else dbGet('blobs', key).then((b) => { if (b) { const u = URL.createObjectURL(b); for (const [ck, cu] of thumbURLs) if (ck.startsWith(key + '|')) { URL.revokeObjectURL(cu); thumbURLs.delete(ck); } thumbURLs.set(cacheKey, u); img.src = u; } });
    }
  }
  const badges = h('div', { class: 'badges' },
    h('span', { class: 'badge' }, s.mode === 'spread' ? '跨頁' : '單頁'),
    s.detect?.failed && !s.edited ? h('span', { class: 'badge warn' }, '⚠ 搵唔到書邊，用咗成幅相') : null,
    s.detect?.method === 'guide' && !s.edited ? h('span', { class: 'badge warn' }, '用咗對準框') : null,
    s.detect?.method === 'full-frame' && !s.edited ? h('span', { class: 'badge' }, '書頁塞滿成幅相') : null,
    s.edited ? h('span', { class: 'badge ok' }, '✎ 已調整') : null,
    s.status === 'ready' && s.mode === 'spread' && (!included(s, 'L') || !included(s, 'R')) ? h('span', { class: 'badge' }, '只要一頁') : null);
  card.append(
    h('div', { class: 'card-top' }, h('span', { class: 'handle', title: '拖動排次序', 'aria-label': '拖動排次序' }, '⠿'), h('span', { class: 'num' }), h('span', { class: 'pn' }), cb),
    thumbs, badges,
    h('div', { class: 'card-actions' },
      iconBtn('edit', '調整', { onclick: () => s.status === 'ready' ? openEditor(s.id) : toast('仲處理緊，等陣先') }),
      iconBtn('redo', '重影', { onclick: () => retakeMenu(s.id) }),
      iconBtn('del', '刪除', { class: 'danger', onclick: () => deleteShots([s.id]) })));
}
function refreshCard(s) {
  const card = document.querySelector(`.card[data-id="${s.id}"]`);
  if (card) { fillCard(card, s); renumber(); }
}
function renumber() {
  let p = 1;
  orderedShots().forEach((s, i) => {
    const card = document.querySelector(`.card[data-id="${s.id}"]`);
    const n = pageKeys(s).filter((k) => included(s, k)).length;
    if (card) {
      let pp = p;
      for (const k of pageKeys(s)) {
        const lab = card.querySelector(`.pl[data-k="${k}"]`);
        const txt = included(s, k) ? `p.${pp++}` : '唔要';
        if (lab) lab.textContent = txt;
      }
      $('.num', card).textContent = '#' + (i + 1);
      $('.pn', card).textContent = n === 0 ? '（唔要）' : n === 1 ? `第 ${p} 頁` : `第 ${p}–${p + n - 1} 頁`;
    }
    p += n;
  });
}
async function saveOrderFromDOM() {
  const ids = [...document.querySelectorAll('#grid .card')].map((c) => c.dataset.id);
  for (let i = 0; i < ids.length; i++) {
    const s = S.shots.find((x) => x.id === ids[i]);
    if (s && s.order !== i) { s.order = i; await dbPut('shots', s); }
  }
  renumber(); touchBook();
}
function renderSelbar() {
  const bar = $('#selbar'); bar.innerHTML = '';
  if (!S.sel.size || S.view !== 'book') { bar.classList.remove('show'); return; }
  const ids = [...S.sel];
  bar.append(
    h('span', {}, `已揀 ${ids.length} 張`),
    h('button', { onclick: () => setModeMany(ids, 'single') }, '設為單頁'),
    h('button', { onclick: () => setModeMany(ids, 'spread') }, '設為跨頁'),
    h('button', { onclick: () => deleteShots(ids) }, '刪除'),
    h('button', { onclick: () => { S.sel.clear(); document.querySelectorAll('.card.sel').forEach((c) => { c.classList.remove('sel'); $('input', c).checked = false; }); renderSelbar(); } }, '取消'));
  bar.classList.add('show');
}
async function setModeMany(ids, mode) {
  for (const id of ids) {
    const s = S.shots.find((x) => x.id === id); if (!s || s.mode === mode) continue;
    s.mode = mode; s.modeLocked = true; if (mode === 'spread' && s.quad) s.spine = centerSpine(s.quad);
    s.include = {}; s.status = 'queued'; s.rev = (s.rev || 0) + 1; await saveShot(s); enqueue(s.id);
  }
  toast(mode === 'spread' ? '已設為跨頁（會切開左右）' : '已設為單頁（唔會切開）');
}
async function deleteShots(ids) {
  if (!await confirmDlg(`刪除 ${ids.length} 張相？`, '刪除咗就冇得還原。', '刪除')) return;
  for (const id of ids) {
    await delBlobsOf(id); await dbDel('shots', id);
    S.shots = S.shots.filter((s) => s.id !== id); S.sel.delete(id);
    Q.pending = Q.pending.filter((p) => p.id !== id);
  }
  await touchBook(); renderGrid(); renderSelbar();
}
function retakeMenu(id) {
  openDialog('重影呢一版', [h('p', {}, '新相會取代呢張相，位置唔變。')], [
    { text: '取消' },
    { text: '揀相檔', act: () => { const inp = $('#replaceInput'); inp.onchange = async () => { if (inp.files[0]) await replaceShot(id, inp.files[0]); inp.value = ''; }; inp.click(); } },
    { text: '用相機影', primary: true, act: () => openCamera(id) },
  ]);
}
async function replaceShot(id, blob, time = null, guide = null) {
  const s = S.shots.find((x) => x.id === id); if (!s) return;
  await delBlobsOf(id);
  await dbPut('blobs', blob, id + '|orig');
  Object.assign(s, { size: blob.size, name: blob.name || s.name, time: time ?? s.time, quad: null, spine: null, edited: false, modeLocked: false, rot: 0, include: {}, grids: {}, gridKeys: {}, status: 'queued', dewarp: true, guide, rev: (s.rev || 0) + 1 });
  await saveShot(s); enqueue(id); toast('已換相，重新處理緊');
}

let statusPct = 0;
function updateStatus() {
  const el = $('#status'); if (!el) return;
  el.innerHTML = '';
  const ready = S.shots.filter((s) => s.status === 'ready').length;
  const pages = S.shots.reduce((n, s) => n + (s.status === 'ready' ? pageKeys(s).filter((k) => included(s, k)).length : 0), 0);
  if (Q.running && Q.total) {
    statusPct = Q.done / Q.total * 100;
    el.append(h('span', {}, `處理緊 ${Math.min(Q.done + 1, Q.total)} / ${Q.total}`), h('div', { class: 'progress' }, h('i', { style: `width:${statusPct}%` })));
  } else if (S.shots.length) el.append(h('span', {}, `${S.shots.length} 張相 · ${pages} 頁`));
  if (modelMsg) el.append(h('span', {}, modelMsg));
  if (V.runtimeInfo.uvdocBackend) el.append(h('span', {}, '曲頁拉直用 ' + V.runtimeInfo.uvdocBackend));
  if (V.runtimeInfo.cornerModel) el.append(h('span', {}, '書角模型：' + (V.runtimeInfo.cornerModel === 'doccornernet_lean.onnx' ? '原裝' : V.runtimeInfo.cornerModel.replace('.onnx', ''))));
  if (ready < S.shots.length && !Q.running) { /* 有錯誤 */ }
}

// ================================================================ 加相
async function addFiles(files, { fromCamera = false } = {}) {
  if (!S.book) return;
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name));
  if (!files.length) { toast('冇揀到相片'); return; }
  try { if (!(await navigator.storage.persisted?.())) navigator.storage.persist?.(); } catch (e) { }
  const items = [];
  for (const f of files) items.push({ f, t: fromCamera ? Date.now() : await exifTime(f) });
  let how;
  if (!fromCamera) {
    if (items.every((i) => i.t != null)) { items.sort((a, b) => a.t - b.t || natural(a.f.name, b.f.name)); how = '已按拍攝時間排序'; }
    else { items.sort((a, b) => natural(a.f.name, b.f.name)); how = '部分相冇拍攝時間，已按檔名排序'; }
  }
  let order = S.shots.reduce((m, s) => Math.max(m, s.order), -1) + 1;
  for (const { f, t } of items) {
    const id = uid();
    try { await dbPut('blobs', f, id + '|orig'); }
    catch (e) { toast('儲存失敗：部機空間可能唔夠'); break; }
    const s = { id, bookId: S.book.id, order: order++, name: f.name || 'photo.jpg', time: t, added: Date.now(), size: f.size, rot: 0, status: 'queued', include: {}, dewarp: true, edited: false };
    await dbPut('shots', s); S.shots.push(s);
    enqueue(id);
  }
  await touchBook();
  renderGrid(); updateStatus();
  if (how && files.length > 1) toast(`加咗 ${files.length} 張相，${how}`);
}
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
document.addEventListener('dragover', (e) => { if (S.view === 'book' && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('drop-active'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop-active'); });
document.addEventListener('drop', (e) => { document.body.classList.remove('drop-active'); if (S.view === 'book' && e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

// ================================================================ 對話框
function openDialog(title, body, buttons) {
  const d = $('#dlg'); d.innerHTML = '';
  const foot = h('footer');
  const box = h('form', { class: 'dlg', method: 'dialog' }, h('header', {}, title), h('div', { class: 'body' }, body), foot);
  for (const b of buttons) foot.append(h('button', { type: 'button', class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: async () => { if (b.keepOpen) { await b.act?.(); return; } d.close(); await b.act?.(); } }, b.text));
  d.append(box); d.showModal(); return d;
}
function confirmDlg(title, msg, okText = '確定') {
  return new Promise((res) => {
    const d = openDialog(title, [h('p', {}, msg)], [{ text: '取消', act: () => res(false) }, { text: okText, danger: true, act: () => res(true) }]);
    d.addEventListener('cancel', () => res(false), { once: true });
  });
}

function settingsDialog() {
  const b = S.book, st = bookSettings();
  let dir = b.dir;
  const dirSeg = h('div', { class: 'seg' });
  const drawDir = () => { dirSeg.innerHTML = ''; dirSeg.append(
    h('button', { type: 'button', class: dir === 'ltr' ? 'on' : '', onclick: () => { dir = 'ltr'; drawDir(); } }, '橫排（向左翻）'),
    h('button', { type: 'button', class: dir === 'rtl' ? 'on' : '', onclick: () => { dir = 'rtl'; drawDir(); } }, '直排（向右翻）')); };
  drawDir();
  const dew = h('input', { type: 'checkbox' }); dew.checked = st.dewarp;
  const uni = h('input', { type: 'checkbox' }); uni.checked = st.uniformAspect;
  openDialog('設定', [
    h('div', { class: 'field' }, h('label', {}, '排版方向'), dirSeg),
    h('div', { class: 'field' }, h('label', { class: 'check' }, dew, h('span', {}, '用 AI 拉直曲頁', h('div', { class: 'hint' }, '每頁要多一兩秒。有 GPU（WebGPU）會快好多。個別頁可以喺「調整」度關。')))),
    h('div', { class: 'field' }, h('label', { class: 'check' }, uni, h('span', {}, '跨頁切出嚟嘅頁統一長闊比', h('div', { class: 'hint' }, '用全本書嘅中位數，令 PDF 每頁大細一致。封面同單頁照用自己嘅比例。')))),
    h('div', { class: 'field' }, h('label', {}, '排次序'), h('div', { class: 'seg' },
      h('button', { type: 'button', onclick: () => resort('time') }, '按拍攝時間'),
      h('button', { type: 'button', onclick: () => resort('name') }, '按檔名')), h('div', { class: 'hint' }, '亦可以喺頁面清單用 ⠿ 拖動。')),
    h('div', { class: 'field' }, h('label', {}, '重新偵測'), h('button', { type: 'button', onclick: async () => { $('#dlg').close(); for (const s of S.shots) if (!s.edited) { s.status = 'queued'; await saveShot(s); enqueue(s.id, { redetect: true }); } toast('重新偵測緊未手動調整嘅頁'); } }, '重新自動偵測（唔郁已調整嘅頁）')),
    h('div', { class: 'field' }, h('label', {}, '訓練資料'), h('button', { type: 'button', onclick: () => { $('#dlg').close(); exportTraining(); } }, '匯出訓練資料（zip）'), h('div', { class: 'hint' }, '包括相片（縮細）同你調整過嘅角點，用嚟喺電腦微調 AI 模型。')),
  ], [
    { text: '取消' },
    { text: '儲存', primary: true, act: async () => {
      const dirChanged = dir !== b.dir, dewChanged = dew.checked !== st.dewarp;
      b.dir = dir; b.settings = { ...st, dewarp: dew.checked, uniformAspect: uni.checked };
      await touchBook();
      if (dewChanged) for (const s of S.shots) { s.status = 'queued'; await saveShot(s); enqueue(s.id); }
      if (dirChanged) renderGrid();
      toast('已儲存設定');
    } },
  ]);
}
async function resort(by) {
  $('#dlg').close();
  const arr = S.shots.slice();
  if (by === 'time') arr.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || natural(a.name, b.name));
  else arr.sort((a, b) => natural(a.name, b.name));
  for (let i = 0; i < arr.length; i++) { arr[i].order = i; await dbPut('shots', arr[i]); }
  renderGrid(); toast(by === 'time' ? '已按拍攝時間排序（冇時間嘅排最尾）' : '已按檔名排序');
}

// ================================================================ 編輯器
const E = { shot: null, img: null, iw: 0, ih: 0, quad: null, spine: null, mode: 'single', include: {}, dewarp: true, rot: 0,
  scale: 1, ox: 0, oy: 0, dpr: 1, pointers: new Map(), drag: null, pan: null, pinch: null, bmp: null, dirty: false };
async function openEditor(id) {
  const s = S.shots.find((x) => x.id === id); if (!s) return;
  const blob = await dbGet('blobs', id + '|orig'); if (!blob) return;
  E.shot = s; E.rot = s.rot || 0; E.quad = s.quad.slice(); E.spine = (s.spine || centerSpine(s.quad)).slice();
  E.mode = s.mode; E.include = { ...(s.include || {}) }; E.dewarp = s.dewarp !== false; E.dirty = false; E.dewarpTouched = false;
  $('#edTitle').textContent = `#${orderedShots().indexOf(s) + 1} 調整`;
  $('#editor').classList.add('show'); document.body.style.overflow = 'hidden';
  E.bmp = await loadBitmap(blob);
  setEditorImage();
  renderEdTools(); fitView(); drawEditor();
}
function setEditorImage() {
  E.img = V.orientedCanvas(E.bmp, E.rot, 4096); E.iw = E.img.width; E.ih = E.img.height;
}
function closeEditor() {
  $('#editor').classList.remove('show'); document.body.style.overflow = '';
  E.bmp?.close?.(); E.bmp = null; E.img = null; E.shot = null; hideLoupe();
}
function renderEdTools() {
  const t = $('#edTools'); t.innerHTML = '';
  const btn = (txt, on, fn, title) => h('button', { class: on ? 'on' : '', onclick: fn, title }, txt);
  t.append(
    btn('單頁', E.mode === 'single', () => setEdMode('single'), '唔切開'),
    btn('跨頁', E.mode === 'spread', () => setEdMode('spread'), '切開左右兩頁'),
    h('span', { class: 'sep' }));
  if (E.mode === 'spread') {
    t.append(btn((E.include.L !== false ? '✓ ' : '✕ ') + '左頁', E.include.L !== false, () => { E.include.L = E.include.L === false; E.dirty = true; renderEdTools(); }),
      btn((E.include.R !== false ? '✓ ' : '✕ ') + '右頁', E.include.R !== false, () => { E.include.R = E.include.R === false; E.dirty = true; renderEdTools(); }),
      h('span', { class: 'sep' }));
  }
  t.append(
    btn((E.dewarp ? '✓ ' : '') + '曲頁拉直', E.dewarp, () => { E.dewarp = !E.dewarp; E.dewarpTouched = true; E.dirty = true; renderEdTools(); }),
    btn('↻ 轉 90°', false, async () => { E.rot = (E.rot + 90) % 360; setEditorImage(); await autoDetectEd(); fitView(); }),
    btn('成幅相', false, () => { E.quad = [0, 0, 1, 0, 1, 1, 0, 1]; E.spine = centerSpine(E.quad); E.dirty = true; drawEditor(); }),
    btn('自動偵測', false, autoDetectEd),
    btn('預覽', false, previewEd));
}
function setEdMode(m) {
  if (E.mode === m) return;
  E.mode = m; E.dirty = true;
  if (m === 'spread') E.spine = centerSpine(E.quad);
  renderEdTools(); drawEditor();
}
async function autoDetectEd() {
  $('#edHint').textContent = '偵測緊…';
  const mid = V.scaleCanvas(E.img, V.MID_SIDE), ana = V.scaleCanvas(mid, V.ANALYSIS_SIDE);
  const det = await V.detectBook(ana, mid);
  E.quad = det.quad; E.spine = det.spine; E.mode = det.mode; E.dirty = true;
  $('#edHint').textContent = det.failed ? '搵唔到書邊，用咗成幅相，請手動拉' : '已自動偵測，可以再微調';
  renderEdTools(); drawEditor();
}
async function previewEd() {
  const d = openDialog('預覽', [h('div', { class: 'preview-pages', id: 'pv' }, h('p', {}, '整緊預覽…'))], [{ text: '關閉' }]);
  const mid = V.scaleCanvas(E.img, V.MID_SIDE), midImg = V.canvasToImg(mid);
  const pages = V.pageQuads(E.quad, E.spine, E.mode);
  const keys = E.mode === 'spread' ? ['L', 'R'] : ['S']; // 跟實物位置：左頁喺左
  d.classList.add('wide');
  d.addEventListener('close', () => d.classList.remove('wide'), { once: true });
  const pv = $('#pv', d); pv.innerHTML = '';
  const spreadA = E.mode === 'spread' ? V.estimateAspect(V.denorm(E.quad, mid.width, mid.height), mid.width, mid.height) / 2 : 0;
  for (const k of keys) {
    const q = pages[k];
    let grid = null;
    if (E.dewarp && bookSettings().dewarp) { try { grid = await V.uvdocGrid(midImg, q, modelProgress('曲頁拉直模型')); } catch (e) { } }
    const a = spreadA || V.pageAspect(q, mid.width, mid.height);
    const hh = 900, c = imageDataToCanvas(V.renderPage(midImg, q, grid, Math.round(hh * a), hh));
    const url = URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.85));
    pv.append(h('figure', {}, h('img', { src: url, alt: '' }), h('figcaption', {}, { L: '左頁', R: '右頁', S: '單頁' }[k] + (E.mode === 'spread' ? ((k === 'R') === (S.book.dir === 'rtl') ? '（先）' : '（後）') : '') + (included({ include: E.include }, k) ? '' : '（唔要）') + (grid ? '' : E.dewarp ? '（拉直唔到，用咗普通拉正）' : ''))));
  }
}
async function saveEditor() {
  const s = E.shot; if (!s) return closeEditor();
  const changedGeom = quadKey(E.quad) !== quadKey(s.quad) || quadKey(E.spine) !== quadKey(s.spine || []) || E.mode !== s.mode || E.rot !== (s.rot || 0);
  if (changedGeom) {
    s.edited = true;
    // 原本搵唔到書邊（拉直預設關咗），而家手動拉好咗框 → 自動開返拉直
    if (!E.dewarpTouched && ['full', 'full-frame'].includes(s.detect?.method) && quadKey(E.quad) !== quadKey([0, 0, 1, 0, 1, 1, 0, 1])) E.dewarp = true;
  }
  if (E.mode !== s.mode) s.modeLocked = true;
  const rotChanged = E.rot !== (s.rot || 0);
  Object.assign(s, { quad: E.quad, spine: E.spine, mode: E.mode, include: E.include, dewarp: E.dewarp, rot: E.rot });
  if (rotChanged) { s.grids = {}; s.gridKeys = {}; }
  closeEditor();
  if (changedGeom || E.dirty) { s.status = 'queued'; s.rev = (s.rev || 0) + 1; await saveShot(s); enqueue(s.id); }
}
$('#edCancel').addEventListener('click', closeEditor);
$('#edDone').addEventListener('click', saveEditor);

// ---- 編輯器：畫面同手勢
const cv = $('#edCanvas');
function fitView() {
  const r = $('#edStage').getBoundingClientRect(); E.dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * E.dpr); cv.height = Math.round(r.height * E.dpr);
  const pad = 28;
  E.scale = Math.min((r.width - pad * 2) / E.iw, (r.height - pad * 2) / E.ih);
  E.ox = (r.width - E.iw * E.scale) / 2; E.oy = (r.height - E.ih * E.scale) / 2;
  drawEditor();
}
window.addEventListener('resize', () => { if (E.img) { const r = $('#edStage').getBoundingClientRect(); cv.width = Math.round(r.width * E.dpr); cv.height = Math.round(r.height * E.dpr); drawEditor(); } });
const toScreen = (x, y) => [x * E.scale + E.ox, y * E.scale + E.oy];
const toImg = (x, y) => [(x - E.ox) / E.scale, (y - E.oy) / E.scale];
function edPoints() { // 像素座標嘅控制點：0-3 外框角，4-5 書脊（跨頁）
  const q = E.quad, p = [];
  for (let i = 0; i < 4; i++) p.push([q[2 * i] * E.iw, q[2 * i + 1] * E.ih]);
  if (E.mode === 'spread') { p.push([E.spine[0] * E.iw, E.spine[1] * E.ih]); p.push([E.spine[2] * E.iw, E.spine[3] * E.ih]); }
  return p;
}
function setEdPoint(i, x, y) {
  x = Math.max(-0.02, Math.min(1.02, x / E.iw)); y = Math.max(-0.02, Math.min(1.02, y / E.ih));
  if (i < 4) { E.quad[2 * i] = x; E.quad[2 * i + 1] = y; } else { const j = i - 4; E.spine[2 * j] = x; E.spine[2 * j + 1] = y; }
}
function edEdges() {
  return E.mode === 'spread' ? [[0, 4], [4, 1], [1, 2], [2, 5], [5, 3], [3, 0], [4, 5]] : [[0, 1], [1, 2], [2, 3], [3, 0]];
}
function drawEditor() {
  if (!E.img) return;
  const ctx = cv.getContext('2d'), W = cv.width / E.dpr, H = cv.height / E.dpr;
  ctx.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = E.scale < 2;
  ctx.drawImage(E.img, E.ox, E.oy, E.iw * E.scale, E.ih * E.scale);
  const P = edPoints().map(([x, y]) => toScreen(x, y));
  // 框外變暗
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H);
  const outline = E.mode === 'spread' ? [0, 4, 1, 2, 5, 3] : [0, 1, 2, 3];
  outline.forEach((i, k) => k ? ctx.lineTo(...P[i]) : ctx.moveTo(...P[i])); ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fill('evenodd'); ctx.restore();
  // 邊
  ctx.lineWidth = 2; ctx.strokeStyle = '#ffb36b';
  for (const [a, b] of edEdges()) {
    ctx.save(); if (a === 4 && b === 5) { ctx.setLineDash([8, 6]); ctx.strokeStyle = '#7fe0c8'; }
    ctx.beginPath(); ctx.moveTo(...P[a]); ctx.lineTo(...P[b]); ctx.stroke(); ctx.restore();
  }
  // 邊中點把手
  for (const [a, b] of edEdges()) {
    const mx = (P[a][0] + P[b][0]) / 2, my = (P[a][1] + P[b][1]) / 2;
    ctx.beginPath(); ctx.arc(mx, my, 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); ctx.strokeStyle = a === 4 && b === 5 ? '#1f8f78' : '#e86a10'; ctx.lineWidth = 2; ctx.stroke();
  }
  // 角點
  P.forEach((p, i) => {
    const active = E.drag && ((E.drag.type === 'pt' && E.drag.i === i) || (E.drag.type === 'edge' && E.drag.e.includes(i)));
    ctx.beginPath(); ctx.arc(p[0], p[1], active ? 13 : 11, 0, Math.PI * 2);
    ctx.fillStyle = i >= 4 ? 'rgba(31,143,120,.35)' : 'rgba(255,122,26,.35)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = i >= 4 ? '#7fe0c8' : '#ff7a1a'; ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  });
}
function hitTest(sx, sy, touch) {
  const P = edPoints().map(([x, y]) => toScreen(x, y)), R = touch ? 30 : 16;
  let best = null, bd = R;
  P.forEach((p, i) => { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { type: 'pt', i }; } });
  if (best) return best;
  // 邊中點
  for (const e of edEdges()) {
    const mx = (P[e[0]][0] + P[e[1]][0]) / 2, my = (P[e[0]][1] + P[e[1]][1]) / 2, d = Math.hypot(mx - sx, my - sy);
    if (d < bd) { bd = d; best = { type: 'edge', e }; }
  }
  if (best) return best;
  // 邊線本身
  const LR = touch ? 18 : 9; bd = LR;
  for (const e of edEdges()) {
    const [a, b] = [P[e[0]], P[e[1]]], L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2; if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((sx - a[0]) * (b[0] - a[0]) + (sy - a[1]) * (b[1] - a[1])) / L2));
    if (t < 0.12 || t > 0.88) continue;
    const d = Math.hypot(a[0] + t * (b[0] - a[0]) - sx, a[1] + t * (b[1] - a[1]) - sy);
    if (d < bd) { bd = d; best = { type: 'edge', e }; }
  }
  return best;
}
function localXY(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const [x, y] = localXY(e); E.pointers.set(e.pointerId, { x, y });
  if (E.pointers.size === 1) {
    const hit = hitTest(x, y, e.pointerType !== 'mouse');
    if (hit) {
      const P = edPoints();
      E.drag = { ...hit, sx: x, sy: y, start: P.map((p) => p.slice()) };
      if (hit.type === 'pt') E.drag.focus = P[hit.i];
      else { const [a, b] = [P[hit.e[0]], P[hit.e[1]]]; E.drag.focus = toImg(x, y); E.drag.n = (() => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; })(); }
      showLoupe(x, y);
    } else E.pan = { sx: x, sy: y, ox: E.ox, oy: E.oy };
  } else if (E.pointers.size === 2) {
    if (E.drag) { E.drag.start.forEach((p, i) => setEdPoint(i, p[0], p[1])); E.drag = null; hideLoupe(); }
    E.pan = null;
    const [a, b] = [...E.pointers.values()];
    E.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: E.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ox: E.ox, oy: E.oy };
  }
  drawEditor();
});
cv.addEventListener('pointermove', (e) => {
  if (!E.pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse') { const [x, y] = localXY(e); const hit = hitTest(x, y, false); cv.style.cursor = hit ? (hit.type === 'pt' ? 'grab' : 'move') : 'crosshair'; }
    return;
  }
  const [x, y] = localXY(e); E.pointers.set(e.pointerId, { x, y });
  if (E.pinch && E.pointers.size >= 2) {
    const [a, b] = [...E.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ns = clampScale(E.pinch.scale * d / E.pinch.d);
    const ix = (E.pinch.mx - E.pinch.ox) / E.pinch.scale, iy = (E.pinch.my - E.pinch.oy) / E.pinch.scale;
    E.scale = ns; E.ox = mx - ix * ns; E.oy = my - iy * ns; drawEditor(); return;
  }
  if (E.drag) {
    const dx = (x - E.drag.sx) / E.scale, dy = (y - E.drag.sy) / E.scale, st = E.drag.start;
    if (E.drag.type === 'pt') { setEdPoint(E.drag.i, st[E.drag.i][0] + dx, st[E.drag.i][1] + dy); E.drag.focus = [st[E.drag.i][0] + dx, st[E.drag.i][1] + dy]; }
    else {
      const k = dx * E.drag.n[0] + dy * E.drag.n[1];
      for (const i of E.drag.e) setEdPoint(i, st[i][0] + E.drag.n[0] * k, st[i][1] + E.drag.n[1] * k);
      E.drag.focus = toImg(x, y);
    }
    E.dirty = true; drawEditor(); showLoupe(x, y); return;
  }
  if (E.pan) { E.ox = E.pan.ox + (x - E.pan.sx); E.oy = E.pan.oy + (y - E.pan.sy); drawEditor(); }
});
function endPointer(e) {
  E.pointers.delete(e.pointerId);
  if (E.pointers.size < 2) E.pinch = null;
  if (!E.pointers.size) { E.drag = null; E.pan = null; hideLoupe(); drawEditor(); }
}
cv.addEventListener('pointerup', endPointer); cv.addEventListener('pointercancel', endPointer);
const clampScale = (s) => { const fit = Math.min(cv.width / E.dpr / E.iw, cv.height / E.dpr / E.ih); return Math.max(fit * 0.5, Math.min(s, 8)); };
function zoomAt(f, sx, sy) {
  const ns = clampScale(E.scale * f), ix = (sx - E.ox) / E.scale, iy = (sy - E.oy) / E.scale;
  E.scale = ns; E.ox = sx - ix * ns; E.oy = sy - iy * ns; drawEditor();
}
cv.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = localXY(e); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), x, y); }, { passive: false });
cv.addEventListener('dblclick', (e) => { const [x, y] = localXY(e); zoomAt(2, x, y); });
$('#zIn').addEventListener('click', () => zoomAt(1.6, cv.width / E.dpr / 2, cv.height / E.dpr / 2));
$('#zOut').addEventListener('click', () => zoomAt(1 / 1.6, cv.width / E.dpr / 2, cv.height / E.dpr / 2));
$('#zFit').addEventListener('click', fitView);
document.addEventListener('keydown', (e) => {
  if ($('#editor').classList.contains('show')) { if (e.key === 'Escape') closeEditor(); if (e.key === 'Enter' && !e.target.closest('dialog')) saveEditor(); }
});

// ---- 放大鏡
const loupe = $('#loupe');
function showLoupe(sx, sy) {
  const r = $('#edStage').getBoundingClientRect();
  const L = Math.round(Math.max(140, Math.min(240, Math.min(r.width, r.height) * 0.38)));
  const m = 14;
  const right = r.width - L - m - 64; // 避開右下角嘅放大掣
  const spots = [[m, m + 40], [right, m + 40], [m, r.height - L - m], [right, r.height - L - m]];
  let best = spots[0], bd = -1;
  for (const s of spots) { const d = Math.hypot(s[0] + L / 2 - sx, s[1] + L / 2 - sy); if (d > bd) { bd = d; best = s; } }
  loupe.style.width = loupe.style.height = L + 'px'; loupe.style.left = best[0] + 'px'; loupe.style.top = best[1] + 'px'; loupe.style.display = 'block';
  const dpr = E.dpr; loupe.width = loupe.height = Math.round(L * dpr);
  const ctx = loupe.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const f = E.drag?.focus || toImg(sx, sy);
  const zs = Math.min(Math.max(E.scale * 3.5, 1.2), 14); // 屏幕像素 / 圖片像素
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, L, L);
  ctx.imageSmoothingEnabled = zs < 3;
  const ox = L / 2 - f[0] * zs, oy = L / 2 - f[1] * zs;
  ctx.drawImage(E.img, ox, oy, E.iw * zs, E.ih * zs);
  const P = edPoints().map(([x, y]) => [x * zs + ox, y * zs + oy]);
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffb36b';
  for (const [a, b] of edEdges()) { ctx.beginPath(); ctx.moveTo(...P[a]); ctx.lineTo(...P[b]); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L / 2 - 14, L / 2); ctx.lineTo(L / 2 + 14, L / 2); ctx.moveTo(L / 2, L / 2 - 14); ctx.lineTo(L / 2, L / 2 + 14); ctx.stroke();
  ctx.beginPath(); ctx.arc(L / 2, L / 2, 4, 0, Math.PI * 2); ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 2; ctx.stroke();
}
function hideLoupe() { loupe.style.display = 'none'; }

// ================================================================ 相機
const C = { stream: null, track: null, imageCapture: null, replaceId: null, guide: true, shape: 'spread', loop: 0, busy: false, last: null, count: 0, smooth: null, stable: 0, capturing: false };
async function openCamera(replaceId = null) {
  if (!S.book) return;
  C.replaceId = replaceId; C.count = 0; C.shape = bookSettings().guide || 'spread'; C.smooth = null; C.stable = 0;
  $('#camTitle').textContent = replaceId ? '重影呢一版' : '影相';
  $('#camLast').innerHTML = '未影';
  $('#camShape').textContent = C.shape === 'spread' ? '跨頁框' : '單頁框';
  $('#camera').classList.add('show'); document.body.style.overflow = 'hidden';
  Q.paused = true;
  try {
    C.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
  } catch (e) {
    closeCamera();
    openDialog('開唔到相機', [h('p', {}, '可能係冇俾權限，或者呢部機冇相機。'), h('p', {}, '可以用「上載相片」揀已經影好嘅相。網址一定要係 https:// 先開到相機。')], [{ text: '知道' }]);
    return;
  }
  C.track = C.stream.getVideoTracks()[0];
  try { await C.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { }
  C.imageCapture = ('ImageCapture' in window) ? new ImageCapture(C.track) : null;
  const v = $('#camVideo'); v.srcObject = C.stream; await v.play().catch(() => {});
  const st = C.track.getSettings?.() || {};
  $('#camRes').textContent = st.width ? `${st.width}×${st.height}` : '';
  V.getCornerSession().catch(() => {});
  cancelAnimationFrame(C.loop); camLoop();
}
function closeCamera() {
  cancelAnimationFrame(C.loop);
  C.stream?.getTracks().forEach((t) => t.stop()); C.stream = null; C.track = null; C.imageCapture = null;
  $('#camera').classList.remove('show'); document.body.style.overflow = '';
  Q.paused = false;
  if (S.view === 'book') { renderGrid(); updateStatus(); }
}
function videoRect() {
  const v = $('#camVideo'), r = $('#camStage').getBoundingClientRect();
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9, s = Math.min(r.width / vw, r.height / vh);
  return { x: (r.width - vw * s) / 2, y: (r.height - vh * s) / 2, w: vw * s, h: vh * s, W: r.width, H: r.height };
}
function guideRect(vr) {
  const asp = C.shape === 'spread' ? 1.42 : 0.7;
  let w = vr.w * 0.9, hh = w / asp; if (hh > vr.h * 0.9) { hh = vr.h * 0.9; w = hh * asp; }
  return { x: vr.x + (vr.w - w) / 2, y: vr.y + (vr.h - hh) / 2, w, h: hh };
}
let lastDet = 0;
const camAna = V.makeCanvas(512, 384);
async function camLoop() {
  C.loop = requestAnimationFrame(camLoop);
  const v = $('#camVideo'), oc = $('#camOverlay');
  if (!v.videoWidth) return;
  const vr = videoRect(), dpr = window.devicePixelRatio || 1;
  if (oc.width !== Math.round(vr.W * dpr)) { oc.width = Math.round(vr.W * dpr); oc.height = Math.round(vr.H * dpr); }
  const ctx = oc.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vr.W, vr.H);
  if (C.guide) {
    const g = guideRect(vr);
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.rect(0, 0, vr.W, vr.H); ctx.rect(g.x, g.y, g.w, g.h); ctx.fill('evenodd');
    ctx.setLineDash([10, 8]); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2; ctx.strokeRect(g.x, g.y, g.w, g.h);
    if (C.shape === 'spread') { ctx.beginPath(); ctx.moveTo(g.x + g.w / 2, g.y); ctx.lineTo(g.x + g.w / 2, g.y + g.h); ctx.globalAlpha = 0.5; ctx.stroke(); }
    ctx.restore();
  }
  if (C.smooth) {
    const q = C.smooth, P = [0, 1, 2, 3].map((i) => [vr.x + q[2 * i] * vr.w, vr.y + q[2 * i + 1] * vr.h]);
    ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = C.stable >= 3 ? '#4fe0b0' : '#ffb36b'; ctx.stroke();
    ctx.fillStyle = C.stable >= 3 ? 'rgba(79,224,176,.12)' : 'rgba(255,179,107,.08)'; ctx.fill();
  }
  const now = performance.now();
  if (!C.busy && now - lastDet > 220) {
    C.busy = true; lastDet = now;
    try {
      const s = Math.min(512 / v.videoWidth, 512 / v.videoHeight);
      camAna.width = Math.round(v.videoWidth * s); camAna.height = Math.round(v.videoHeight * s);
      camAna.getContext('2d').drawImage(v, 0, 0, camAna.width, camAna.height);
      const r = await V.detectCornersML(camAna);
      if (r.quad && r.score > 0.5) {
        const moved = C.smooth ? Math.max(...r.quad.map((x, i) => Math.abs(x - C.smooth[i]))) : 1;
        C.stable = moved < 0.015 ? C.stable + 1 : 0;
        C.smooth = C.smooth ? C.smooth.map((x, i) => x * 0.4 + r.quad[i] * 0.6) : r.quad;
        $('#camHint').textContent = C.stable >= 3 ? '✓ 已對準，可以影' : '搵到書，請拎穩';
      } else { C.smooth = null; C.stable = 0; $('#camHint').textContent = C.guide ? '將本書放喺框入面' : '對準本書'; }
    } catch (e) { /* 模型未載入 */ }
    C.busy = false;
  }
}
async function capture() {
  if (!C.stream || C.capturing) return;
  C.capturing = true;
  const fl = $('#camFlash'); fl.classList.add('go'); setTimeout(() => fl.classList.remove('go'), 60);
  let blob = null;
  try {
    if (C.imageCapture?.takePhoto) blob = await Promise.race([C.imageCapture.takePhoto(), sleep(4000).then(() => null)]);
  } catch (e) { blob = null; }
  if (!blob) {
    const v = $('#camVideo'), c = V.makeCanvas(v.videoWidth, v.videoHeight);
    c.getContext('2d').drawImage(v, 0, 0); blob = await canvasToBlob(c, 'image/jpeg', 0.93);
  }
  const ts = Date.now();
  let guide = null;
  if (C.guide) {
    const v = $('#camVideo'), vr = videoRect(), g = guideRect(vr);
    const nx = (x) => (x - vr.x) / vr.w, ny = (y) => (y - vr.y) / vr.h;
    guide = { quad: [nx(g.x), ny(g.y), nx(g.x + g.w), ny(g.y), nx(g.x + g.w), ny(g.y + g.h), nx(g.x), ny(g.y + g.h)], aspect: v.videoWidth / v.videoHeight, mode: C.shape };
  }
  const file = new File([blob], `cam_${new Date(ts).toISOString().replace(/[:.]/g, '-')}.jpg`, { type: blob.type || 'image/jpeg' });
  const url = URL.createObjectURL(blob); C.count++;
  $('#camLast').innerHTML = ''; $('#camLast').append(h('img', { src: url, alt: '' }), h('b', {}, C.count));
  if (C.replaceId) { const id = C.replaceId; C.capturing = false; closeCamera(); await replaceShot(id, file, ts, guide); return; }
  await addFilesQuiet(file, ts, guide);
  C.capturing = false;
}
async function addFilesQuiet(file, ts, guide = null) {
  const id = uid(), order = S.shots.reduce((m, s) => Math.max(m, s.order), -1) + 1;
  await dbPut('blobs', file, id + '|orig');
  const s = { id, bookId: S.book.id, order, name: file.name, time: ts, added: ts, size: file.size, rot: 0, status: 'queued', include: {}, dewarp: true, edited: false, guide };
  await dbPut('shots', s); S.shots.push(s); enqueue(id); touchBook();
}
$('#camShutter').addEventListener('click', capture);
$('#camClose').addEventListener('click', closeCamera);
$('#camGuide').addEventListener('click', (e) => { C.guide = !C.guide; e.currentTarget.classList.toggle('on', C.guide); });
$('#camShape').addEventListener('click', async (e) => {
  C.shape = C.shape === 'spread' ? 'single' : 'spread'; e.currentTarget.textContent = C.shape === 'spread' ? '跨頁框' : '單頁框';
  S.book.settings = { ...bookSettings(), guide: C.shape }; touchBook();
});
document.addEventListener('keydown', (e) => { if ($('#camera').classList.contains('show') && (e.code === 'Space' || e.key === 'Enter')) { e.preventDefault(); capture(); } if ($('#camera').classList.contains('show') && e.key === 'Escape') closeCamera(); });

// ================================================================ 匯出 PDF
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
function exportDialog() {
  const st = bookSettings();
  if (!S.shots.length) { toast('仲未有相'); return; }
  const hc = h('input', { type: 'number', min: 5, max: 60, step: 0.1, value: st.heightCm });
  let res = st.res;
  const seg = h('div', { class: 'seg' });
  const draw = () => { seg.innerHTML = ''; for (const [k, t] of [['small', '慳位 1600px'], ['std', '標準 2400px'], ['high', '高清 3200px']]) seg.append(h('button', { type: 'button', class: res === k ? 'on' : '', onclick: () => { res = k; draw(); } }, t)); };
  draw();
  const q = h('select', {}, ...[[0.75, '細啲檔案（75%）'], [0.85, '平衡（85%）'], [0.92, '靚啲（92%）']].map(([v, t]) => { const o = h('option', { value: v }, t); if (+v === +st.jpegQ) o.selected = true; return o; }));
  const notReady = S.shots.filter((s) => s.status !== 'ready').length;
  openDialog('匯出 PDF', [
    notReady ? h('p', { class: 'badge warn', style: 'display:block;padding:8px 12px;border-radius:10px' }, `仲有 ${notReady} 張相未處理好（或者出錯），呢啲唔會包括喺 PDF 入面。`) : null,
    h('div', { class: 'field' }, h('label', {}, '每頁高度（厘米）'), hc, h('div', { class: 'hint' }, '只影響打印出嚟幾大，同埋閱讀器「100%」顯示幾大。一般書大約 18–23 厘米。闊度會跟返每頁自己嘅比例。')),
    h('div', { class: 'field' }, h('label', {}, '圖片解像度（每頁高度）'), seg, h('div', { class: 'hint' }, '決定啲字有幾清楚同檔案有幾大。標準大約 290 dpi（21 厘米高時），睇字已經好清楚。唔會放大超過原相解像度。')),
    h('div', { class: 'field' }, h('label', {}, '圖片質素'), q),
  ], [
    { text: '取消' },
    { text: '匯出', primary: true, act: async () => {
      S.book.settings = { ...st, heightCm: Math.max(5, Math.min(60, +hc.value || 21)), res, jpegQ: +q.value };
      await touchBook(); await exportPdf();
    } },
  ]);
}
async function exportPdf() {
  const st = bookSettings(), dir = S.book.dir;
  const shots = orderedShots().filter((s) => s.status === 'ready');
  const list = [];
  for (const s of shots) for (const k of pageKeys(s)) if (included(s, k)) list.push({ s, k });
  if (!list.length) { toast('冇頁可以匯出'); return; }
  const prog = h('div', { class: 'progress', style: 'max-width:none' }, h('i', {}));
  const msg = h('p', {}, '準備緊…');
  let cancelled = false;
  const d = openDialog('匯出緊 PDF', [msg, prog], [{ text: '取消', act: () => { cancelled = true; } }]);
  d.addEventListener('cancel', (e) => { e.preventDefault(); });
  Q.paused = true;
  try {
    await loadScript(LIBS.pdf);
    const { PDFDocument } = window.PDFLib;
    const pdf = await PDFDocument.create();
    pdf.setTitle(S.book.title); pdf.setCreator('書影 BookScan'); pdf.setProducer('書影 BookScan (pdf-lib)');
    pdf.setLanguage(dir === 'rtl' ? 'zh-Hant' : 'en');
    try {
      const vp = pdf.catalog.getOrCreateViewerPreferences();
      if (dir === 'rtl' && window.PDFLib.ReadingDirection) vp.setReadingDirection(window.PDFLib.ReadingDirection.R2L);
      vp.setDisplayDocTitle(true);
    } catch (e) { console.warn(e); }
    const uni = st.uniformAspect ? median(shots.filter((s) => s.mode === 'spread').flatMap((s) => ['L', 'R'].map((k) => s.aspects?.[k]).filter(Boolean))) : null;
    const hPt = st.heightCm / 2.54 * 72, targetH = RES_PRESETS[st.res] || 2400;
    let cur = null, full = null;
    for (let i = 0; i < list.length; i++) {
      if (cancelled) throw new Error('cancel');
      const { s, k } = list[i];
      msg.textContent = `第 ${i + 1} / ${list.length} 頁`; prog.firstChild.style.width = (i / list.length * 100) + '%';
      if (cur !== s.id) {
        const bmp = await loadBitmap(await dbGet('blobs', s.id + '|orig'));
        full = V.canvasToImg(V.orientedCanvas(bmp, s.rot || 0, 6000)); bmp.close?.(); cur = s.id;
      }
      const q = V.pageQuads(s.quad, s.spine, s.mode)[k];
      const aspect = (s.mode === 'spread' && uni) ? uni : (s.aspects?.[k] || V.pageAspect(q, full.w, full.h));
      const qp = V.denorm(q, full.w, full.h);
      const srcH = (Math.hypot(qp[6] - qp[0], qp[7] - qp[1]) + Math.hypot(qp[4] - qp[2], qp[5] - qp[3])) / 2;
      const outH = Math.round(Math.max(400, Math.min(targetH, srcH * 1.1))), outW = Math.max(20, Math.round(outH * aspect));
      let grid = null;
      if (st.dewarp && s.dewarp !== false) {
        grid = s.grids?.[k] || null;
        if (!grid) { try { const mid = V.canvasToImg(V.scaleCanvas(imageDataToCanvas(new ImageData(full.data, full.w, full.h)), V.MID_SIDE)); grid = await V.uvdocGrid(mid, q); } catch (e) { grid = null; } }
      }
      const c = imageDataToCanvas(V.renderPage(full, q, grid, outW, outH));
      const jpg = new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', st.jpegQ)).arrayBuffer());
      const img = await pdf.embedJpg(jpg);
      const page = pdf.addPage([hPt * aspect, hPt]);
      page.drawImage(img, { x: 0, y: 0, width: hPt * aspect, height: hPt });
      await sleep(0);
    }
    msg.textContent = '砌緊 PDF 檔…'; prog.firstChild.style.width = '100%';
    const bytes = await pdf.save({ useObjectStreams: true });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = h('a', { href: URL.createObjectURL(blob), download: (S.book.title || 'book').replace(/[\\/:*?"<>|]/g, '_') + '.pdf' });
    document.body.append(a); a.click(); a.remove();
    d.close();
    const size = S.shots.reduce((n, s) => n + (s.size || 0), 0);
    openDialog('PDF 已下載', [
      h('p', {}, `${list.length} 頁，檔案大約 ${fmtBytes(blob.size)}。`),
      h('p', {}, `呢本書嘅相仲佔用你部機大約 ${fmtBytes(size)}。確認 PDF 冇問題之後，可以去書架刪除呢本書釋放空間。`)], [{ text: '好' }]);
  } catch (e) {
    d.close(); if (e.message !== 'cancel') { console.error(e); openDialog('匯出失敗', [h('p', {}, e.message)], [{ text: '知道' }]); }
  } finally { Q.paused = false; }
}

// ================================================================ 匯出訓練資料
async function exportTraining() {
  const shots = orderedShots().filter((s) => s.status === 'ready');
  if (!shots.length) { toast('未有處理好嘅相'); return; }
  toast('整緊訓練資料…', 6000);
  await loadScript(LIBS.zip);
  const files = {}, labels = [];
  for (const s of shots) {
    const bmp = await loadBitmap(await dbGet('blobs', s.id + '|orig'));
    const c = V.orientedCanvas(bmp, s.rot || 0, 1280); bmp.close?.();
    const name = `images/${String(labels.length + 1).padStart(5, '0')}.jpg`;
    files[name] = [new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', 0.92)).arrayBuffer()), { level: 0 }];
    labels.push({ file: name, width: c.width, height: c.height, mode: s.mode, quad: s.quad, spine: s.mode === 'spread' ? s.spine : null,
      auto_quad: s.auto?.quad || null, auto_spine: s.auto?.spine || null, auto_mode: s.auto?.mode || null, edited: !!s.edited, detect: s.detect || null });
  }
  files['labels.json'] = new TextEncoder().encode(JSON.stringify({ format: 'bookscan-v1', note: 'quad 次序：左上、右上、右下、左下；座標係 0–1 正規化', items: labels }, null, 1));
  const zip = window.fflate.zipSync(files);
  const a = h('a', { href: URL.createObjectURL(new Blob([zip], { type: 'application/zip' })), download: `training_${(S.book.title || 'book').replace(/[\\/:*?"<>|]/g, '_')}.zip` });
  document.body.append(a); a.click(); a.remove();
  toast(`已匯出 ${labels.length} 張（其中 ${labels.filter((l) => l.edited).length} 張有手動調整）`);
}

// ================================================================ 開始
(async function init() {
  try { await db(); } catch (e) { $('#main').append(h('div', { class: 'empty' }, h('h2', {}, '用唔到瀏覽器儲存'), h('p', {}, '可能係無痕模式，或者瀏覽器禁止咗網站資料。'))); return; }
  const m = location.hash.match(/book=([\w-]+)/);
  if (m) await openBook(m[1]); else await openLibrary();
  if (!isSecureContext) toast('提示：要用 https:// 網址先開到相機同埋快取模型', 6000);
})();
window.__bookscan = { S, Q, V, E, addFiles, exportPdf, openEditor, processShot, edScreen: () => edPoints().map(([x, y]) => toScreen(x, y)) }; // 方便測試
