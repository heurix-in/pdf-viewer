
/* Heurix PDF Viewer — web edition (phase 1)
   Runs entirely in the browser. PDFs are read from this computer and are never uploaded.
   Rendering: pdf.js (canvas + selectable text layer).
   Single-file edition: pdf.js is embedded (compressed) in this page.
   Each page also has an empty .annot-layer, reserved for phase 2 (comments, highlights, signatures). */
/* ---- Load the embedded engines (compressed inside this file) ---- */
async function unpack(id) {
  const b64 = document.getElementById(id).textContent.trim();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
}
let pdfjsLib;
try {
  const [libUrl, workerUrl] = await Promise.all([unpack('pdfjs-lib'), unpack('pdfjs-worker')]);
  pdfjsLib = await import(libUrl);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
} catch (e) {
  console.error('Could not start the PDF engine', e);
  document.getElementById('bootNote').classList.add('show');
  throw e;
}

/* Optional extras (Asian-language fonts, scanned-image formats) are used only when a "vendor"
   folder is hosted next to this page. The viewer works without them for most PDFs. */
const hosted = /^https?:$/.test(location.protocol);
const V = (p) => (hosted ? new URL(p, location.href).href : undefined);
const DOC_OPTIONS = {
  cMapUrl: V('./vendor/cmaps/'), cMapPacked: true,
  standardFontDataUrl: V('./vendor/standard_fonts/'),
  wasmUrl: V('./vendor/wasm/'), iccUrl: V('./vendor/iccs/'),
  isEvalSupported: false, enableXfa: false
};

const CSS_UNITS = 96 / 72;            // 100% zoom = real paper size on screen
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
const VIEW_PAD = 24, THUMB_W = 132;
const MAX_CANVAS_PX = 16_777_216;     // keeps memory sane on huge zooms
const KEEP_RENDERED = 8;              // pages around the current one that stay rendered
const MAX_MATCHES = 10000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, props) => { const n = document.createElement(tag); if (cls) n.className = cls; if (props) Object.assign(n, props); return n; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const idle = () => new Promise(r => setTimeout(r, 0));

const viewer = $('viewer'), pagesEl = $('pages');

const S = {
  pdf: null, task: null, bytes: null, name: '', handle: null, docId: 0,
  pages: [], zoom: 1, mode: 'width', rotation: 0, current: 1,
  rendering: 0, renderTimer: 0, firstLayout: true,
  search: { query: '', caseSensitive: false, wholeWord: false, matches: [], index: -1, token: 0, done: true, texts: new Map(), pendingScroll: false, lastPage: 0 },
  outlineLoaded: false, printing: false
};

/* =========================================================
   Opening & closing documents
   ========================================================= */
async function openDocument({ data, name, handle = null }) {
  if (S.pdf && !(await confirmLeave())) return;   // unsaved comments: save, discard or cancel
  closeDocument();
  const docId = ++S.docId;
  const original = data instanceof Uint8Array ? data : new Uint8Array(data);
  S.name = name || 'document.pdf'; S.handle = handle;
  showLoading(`Opening ${S.name}`, 'Reading the document');
  // Comments saved earlier by Heurix are lifted out of the file so they stay editable (no double drawing).
  const prep = await annotPrepare(original);
  if (docId !== S.docId) return;
  const bytes = prep.bytes;
  S.bytes = bytes.slice();                       // working copy: the file without Heurix comments
  S.srcBytes = S.bytes;                          // the same file before any existing markups are removed

  const task = pdfjsLib.getDocument({ ...DOC_OPTIONS, data: bytes.slice() });
  S.task = task;
  task.onPassword = (update, reason) => {
    hideLoading(); A.encrypted = true;
    askPassword(S.name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then(pw => {
      if (pw === null) { task.destroy(); return; }
      showLoading(`Opening ${S.name}`, 'Unlocking'); update(pw);
    });
  };

  let pdf;
  try { pdf = await task.promise; }
  catch (e) {
    if (docId !== S.docId) return;
    hideLoading(); S.task = null; S.bytes = null;
    const cancelled = /destroy|abort/i.test(e?.message || '') || e?.name === 'AbortException';
    if (!cancelled) toast(e?.name === 'InvalidPDFException' ? `${S.name} isn't a valid PDF, or the file is damaged.` : `Could not open ${S.name}: ${e?.message || e}`, 'error');
    showStart(); return;
  }
  if (docId !== S.docId) { pdf.destroy(); return; }
  S.pdf = pdf;
  annotDocOpened(prep);

  document.body.classList.remove('no-doc');
  document.title = `${S.name} — Heurix PDF Viewer`;
  $('docName').textContent = S.name; $('docName').title = S.name;
  $('pageTotal').textContent = `/ ${pdf.numPages}`;

  const first = await pdf.getPage(1);
  if (docId !== S.docId) return;
  const base = rawSize(first);
  S.pages = Array.from({ length: pdf.numPages }, (_, i) => makePage(i + 1, base));
  S.pages[0].page = first;
  pagesEl.replaceChildren(...S.pages.map(p => p.div));
  buildThumbs();

  S.zoom = fitZoom(S.mode = 'width');
  S.firstLayout = true;
  layout(); S.current = 1; viewer.scrollTop = 0; centerCurrentHorizontally();
  updatePageUI(); updateZoomUI();
  hideLoading();
  viewer.focus({ preventScroll: true });
  observePages();
  scheduleRender(0);

  resolveAllPages(docId);                        // real sizes for every page, in the background
  scanForeign(docId);                            // comments made in other PDF apps (read-only list)
  S.outlineLoaded = false;
  if ($('tabOutline').classList.contains('active')) loadOutline();
  if (!$('searchPanel').hidden && $('searchInput').value.trim()) startSearch();
}

function closeDocument() {
  S.docId++;
  annotDocClosed();
  for (const p of S.pages) { p.task?.cancel(); p.textLayer?.cancel(); }
  thumbObserver?.disconnect(); pageObserver?.disconnect(); pageObserver = null; nearby.clear(); thumbQueue.length = 0;
  if (S.task) { S.task.destroy().catch(() => {}); S.task = null; }
  S.pdf = null; S.pages = []; S.bytes = null; S.srcBytes = null; S.rotation = 0; S.current = 1;
  resetSearch(true);
  pagesEl.replaceChildren(); $('thumbs').replaceChildren(); $('outline').replaceChildren();
  S.outlineLoaded = false;
}

async function goHome() { if (S.pdf && !(await confirmLeave())) return; closeDocument(); showStart(); }

function showStart() {
  document.body.classList.add('no-doc');
  document.title = 'Heurix PDF Viewer';
  hideLoading(); closeSearch(true);
  renderRecent();
}

/* =========================================================
   Page records & layout
   ========================================================= */
function rawSize(page) { const vp = page.getViewport({ scale: 1, rotation: page.rotate }); return { w: vp.width, h: vp.height }; }

function makePage(num, base) {
  const div = el('div', 'page loading-page');
  div.dataset.page = num; div.dataset.label = num;
  div.setAttribute('role', 'region'); div.setAttribute('aria-label', `Page ${num}`);
  const canvasWrap = el('div', 'canvas-wrap');
  const hlLayer = el('div', 'hl-layer');
  const textLayerDiv = el('div', 'textLayer');
  const annotLayer = el('div', 'annot-layer');     // phase 2: comments, highlights, ink, signatures
  const linkLayer = el('div', 'link-layer');
  div.append(canvasWrap, hlLayer, textLayerDiv, annotLayer, linkLayer);
  textLayerDiv.addEventListener('mousedown', () => textLayerDiv.classList.add('selecting'));
  return { num, w: base.w, h: base.h, sized: false, page: null, div, canvasWrap, hlLayer, textLayerDiv, annotLayer, linkLayer,
           top: 0, rendered: false, renderedKey: '', renderingKey: '', task: null, textLayer: null, annots: null };
}
document.addEventListener('mouseup', () => document.querySelectorAll('.textLayer.selecting').forEach(t => t.classList.remove('selecting')));

const dims = (p) => (S.rotation % 180 ? { w: p.h, h: p.w } : { w: p.w, h: p.h });
const renderKey = () => `${S.zoom.toFixed(4)}|${S.rotation}`;

async function getPage(p) { if (!p.page) { p.page = await S.pdf.getPage(p.num); setRawSize(p, p.page); } return p.page; }
function setRawSize(p, page) { const s = rawSize(page); const changed = !p.sized && (Math.abs(s.w - p.w) > .5 || Math.abs(s.h - p.h) > .5); p.w = s.w; p.h = s.h; p.sized = true; return changed; }

async function resolveAllPages(docId) {
  const BATCH = 16;
  S.pages[0].sized = true;
  for (let i = 1; i < S.pages.length; i += BATCH) {
    const chunk = S.pages.slice(i, i + BATCH).filter(p => !p.sized);
    const pages = await Promise.all(chunk.map(p => p.page ? p.page : S.pdf?.getPage(p.num))).catch(() => []);
    if (docId !== S.docId) return;
    let changed = false;
    pages.forEach((pg, k) => { if (pg) { chunk[k].page = pg; changed = setRawSize(chunk[k], pg) || changed; } });
    if (changed) { const a = captureAnchor(); layout(); restoreAnchor(a); refreshThumbSizes(); }
    await idle();
  }
}

function layout() {
  const z = S.zoom * CSS_UNITS, key = renderKey();
  for (const p of S.pages) {
    const { w, h } = dims(p);
    p.div.style.width = `${Math.floor(w * z)}px`;
    p.div.style.height = `${Math.floor(h * z)}px`;
    p.div.style.setProperty('--scale-factor', z);
    if (p.rendered && p.renderedKey !== key) { p.hlLayer.replaceChildren(); p.linkLayer.replaceChildren(); }
    if (p.task && p.renderingKey !== key) { p.task.cancel(); }
  }
  if (S.firstLayout) {
    S.firstLayout = false;
    S.pages.slice(0, 4).forEach((p, i) => { p.div.style.setProperty('--d', i); p.div.classList.add('enter'); p.div.addEventListener('animationend', () => p.div.classList.remove('enter'), { once: true }); });
  }
  computeTops();
  repositionPop(); repositionObjbar(); repositionTextEdit();
}
function computeTops() { for (const p of S.pages) p.top = p.div.offsetTop; }

function pageIndexAtY(y) {
  let lo = 0, hi = S.pages.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.pages[mid].top <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/* Keep the same point of the document under the same spot on screen across zoom / rotation / relayout. */
function captureAnchor(clientX, clientY) {
  if (!S.pages.length) return null;
  const vr = viewer.getBoundingClientRect();
  const ox = (clientX ?? vr.left + vr.width / 2) - vr.left;
  const oy = (clientY ?? vr.top + Math.min(vr.height / 2, 200)) - vr.top;
  const p = S.pages[pageIndexAtY(viewer.scrollTop + oy)];
  const r = p.div.getBoundingClientRect();
  return { p, ox, oy, fx: clamp((vr.left + ox - r.left) / r.width, 0, 1), fy: clamp((vr.top + oy - r.top) / r.height, 0, 1.05) };
}
function restoreAnchor(a) {
  if (!a) return;
  const vr = viewer.getBoundingClientRect(), r = a.p.div.getBoundingClientRect();
  viewer.scrollLeft += (r.left + a.fx * r.width) - (vr.left + a.ox);
  viewer.scrollTop += (r.top + a.fy * r.height) - (vr.top + a.oy);
}

/* =========================================================
   Rendering (only pages near the screen)
   ========================================================= */
let pageObserver = null;
const nearby = new Set();
function observePages() {
  pageObserver?.disconnect(); nearby.clear();
  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) { const n = +e.target.dataset.page; e.isIntersecting ? nearby.add(n) : nearby.delete(n); }
    scheduleRender(0);
  }, { root: viewer, rootMargin: '120% 40%' });
  S.pages.forEach(p => pageObserver.observe(p.div));
}

function scheduleRender(delay = 0) {
  clearTimeout(S.renderTimer);
  S.renderTimer = setTimeout(pumpRender, delay);
}

function pumpRender() {
  if (!S.pdf) return;
  if (!pageObserver) observePages();
  const key = renderKey();
  const todo = [...nearby].map(n => S.pages[n - 1])
    .filter(p => p && p.renderedKey !== key && p.renderingKey !== key)
    .sort((a, b) => Math.abs(a.num - S.current) - Math.abs(b.num - S.current));
  while (S.rendering < 2 && todo.length) {
    const p = todo.shift();
    S.rendering++;
    renderPage(p).catch(e => console.warn('render', e)).finally(() => { S.rendering--; scheduleRender(0); });
  }
  if (!todo.length && S.rendering === 0) releaseFarPages();
}

function releaseFarPages() {
  for (const p of S.pages) {
    if (p.rendered && !nearby.has(p.num) && Math.abs(p.num - S.current) > KEEP_RENDERED) {
      const c = p.canvasWrap.querySelector('canvas'); if (c) { c.width = c.height = 0; }
      p.canvasWrap.replaceChildren(); p.textLayerDiv.replaceChildren(); p.hlLayer.replaceChildren(); p.linkLayer.replaceChildren(); p.annotLayer.replaceChildren();
      p.textLayer = null; p.rendered = false; p.renderedKey = ''; p.div.classList.add('loading-page');
    }
  }
}

async function renderPage(p) {
  const docId = S.docId, key = renderKey();
  p.renderingKey = key;
  const page = await getPage(p);
  if (docId !== S.docId || renderKey() !== key) { p.renderingKey = ''; return; }

  const z = S.zoom * CSS_UNITS;
  const vp = page.getViewport({ scale: z, rotation: (page.rotate + S.rotation) % 360 });
  let out = Math.min(window.devicePixelRatio || 1, 3);
  if (vp.width * vp.height * out * out > MAX_CANVAS_PX) out = Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height));
  const canvas = el('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width * out));
  canvas.height = Math.max(1, Math.floor(vp.height * out));
  const ctx = canvas.getContext('2d', { alpha: false });
  const task = page.render({ canvasContext: ctx, canvas, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
  p.task = task;
  try { await task.promise; }
  catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); p.renderingKey = ''; canvas.width = canvas.height = 0; return; }
  finally { if (p.task === task) p.task = null; }
  if (docId !== S.docId || renderKey() !== key) { p.renderingKey = ''; canvas.width = canvas.height = 0; return; }

  const old = p.canvasWrap.querySelector('canvas'); if (old) { old.width = old.height = 0; }
  p.canvasWrap.replaceChildren(canvas);
  p.div.classList.remove('loading-page');

  // Selectable / searchable text
  p.textLayer?.cancel();
  p.textLayerDiv.replaceChildren();
  const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: p.textLayerDiv, viewport: vp });
  p.textLayer = tl;
  try { await tl.render(); } catch (e) { if (e?.name !== 'AbortException') console.warn(e); }
  if (docId !== S.docId || renderKey() !== key) { p.renderingKey = ''; return; }
  p.textLayerDiv.append(el('div', 'endOfContent'));

  await renderLinks(p, page, vp);
  p.rendered = true; p.renderedKey = key; p.renderingKey = '';
  drawAnnots(p);
  drawHighlights(p);
  const m = S.search.matches[S.search.index];
  if (S.search.pendingScroll && m && m.page === p.num) scrollToCurrentMatch();
}

/* Links inside the PDF */
async function renderLinks(p, page, vp) {
  try { p.annots ??= await page.getAnnotations({ intent: 'display' }); } catch { p.annots = []; }
  p.linkLayer.replaceChildren();
  for (const a of p.annots) {
    if (a.subtype !== 'Link' || !a.rect) continue;
    const r = vp.convertToViewportRectangle(a.rect);
    const link = el('a');
    Object.assign(link.style, { left: `${Math.min(r[0], r[2])}px`, top: `${Math.min(r[1], r[3])}px`, width: `${Math.abs(r[2] - r[0])}px`, height: `${Math.abs(r[3] - r[1])}px` });
    if (a.url) {
      link.href = a.url; link.title = a.url; link.rel = 'noopener noreferrer';
      link.addEventListener('click', (e) => { e.preventDefault(); openExternal(a.url); });
    } else if (a.dest) {
      link.href = '#'; link.title = 'Go to linked location';
      link.addEventListener('click', (e) => { e.preventDefault(); goToDest(a.dest); });
    } else if (a.action) {
      const actions = { NextPage: () => goToPage(S.current + 1), PrevPage: () => goToPage(S.current - 1), FirstPage: () => goToPage(1), LastPage: () => goToPage(S.pages.length) };
      if (!actions[a.action]) continue;
      link.href = '#'; link.addEventListener('click', (e) => { e.preventDefault(); actions[a.action](); });
    } else continue;
    p.linkLayer.append(link);
  }
}

async function openExternal(url) {
  const ok = await confirmDialog({ title: 'Open external link?', body: `This document links to:\n${url}`, ok: 'Open link', icon: 'i-link' });
  if (ok) window.open(url, '_blank', 'noopener');
}

async function goToDest(dest) {
  if (!S.pdf) return;
  try {
    if (typeof dest === 'string') dest = await S.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const ref = dest[0];
    const idx = (ref && typeof ref === 'object') ? await S.pdf.getPageIndex(ref) : (Number.isInteger(ref) ? ref : null);
    if (idx == null || !S.pages[idx]) return;
    const kind = dest[1]?.name;
    let x = null, y = null;
    if (kind === 'XYZ') { x = dest[2]; y = dest[3]; } else if (kind === 'FitH' || kind === 'FitBH') { y = dest[2]; }
    if (y == null) { goToPage(idx + 1); return; }
    const p = S.pages[idx], page = await getPage(p);
    const vp = page.getViewport({ scale: S.zoom * CSS_UNITS, rotation: (page.rotate + S.rotation) % 360 });
    const [vx, vy] = vp.convertToViewportPoint(x ?? 0, y);
    computeTops();
    viewer.scrollTop = p.top + vy - 12;
    if (x != null) viewer.scrollLeft = Math.max(0, p.div.offsetLeft + vx - 24);
  } catch (e) { console.warn('Link target could not be resolved', e); }
}

/* =========================================================
   Navigation
   ========================================================= */
function goToPage(n, { smooth = false } = {}) {
  if (!S.pages.length) return;
  n = clamp(Math.round(n) || 1, 1, S.pages.length);
  computeTops();
  viewer.scrollTo({ top: S.pages[n - 1].top - 12, behavior: smooth ? 'smooth' : 'auto' });
  setCurrent(n);
}

function setCurrent(n) {
  if (n === S.current && $('pageInput').value === String(n)) return;
  S.current = n; updatePageUI(); syncThumb();
}

let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!S.pages.length) return;
    const atBottom = viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 4;
    setCurrent(atBottom ? S.pages.length : pageIndexAtY(viewer.scrollTop + viewer.clientHeight * 0.35) + 1);
  });
}, { passive: true });

function updatePageUI() {
  const inp = $('pageInput');
  if (document.activeElement !== inp) inp.value = S.current;
  $('prevBtn').disabled = S.current <= 1;
  $('nextBtn').disabled = S.current >= S.pages.length;
}

/* =========================================================
   Zoom & rotation
   ========================================================= */
function fitZoom(mode) {
  const p = S.pages[S.current - 1] || S.pages[0];
  if (!p) return 1;
  const { w, h } = dims(p);
  const availW = Math.max(120, viewer.clientWidth - VIEW_PAD * 2);
  const availH = Math.max(120, viewer.clientHeight - VIEW_PAD * 2);
  let z = availW / (w * CSS_UNITS);
  if (mode === 'page') z = Math.min(z, availH / (h * CSS_UNITS));
  return clamp(z, MIN_ZOOM, MAX_ZOOM);
}

function setZoom(z, { mode = 'custom', clientX, clientY } = {}) {
  if (!S.pdf) return;
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(z - S.zoom) < 1e-4 && mode === S.mode) return;
  const a = captureAnchor(clientX, clientY);
  S.zoom = z; S.mode = mode;
  layout(); restoreAnchor(a);
  if (mode !== 'custom') centerCurrentHorizontally();
  updateZoomUI(); scheduleRender(140);
}
function centerCurrentHorizontally() {
  const p = S.pages[S.current - 1]; if (!p) return;
  viewer.scrollLeft = p.div.offsetLeft + p.div.offsetWidth / 2 - viewer.clientWidth / 2;
}
function setZoomMode(mode) { S.mode = mode; setZoom(fitZoom(mode), { mode }); }
const zoomIn = () => setZoom(ZOOM_STEPS.find(s => s > S.zoom * 1.01) ?? MAX_ZOOM);
const zoomOut = () => setZoom([...ZOOM_STEPS].reverse().find(s => s < S.zoom * 0.99) ?? MIN_ZOOM);

function updateZoomUI() {
  const sel = $('zoomSelect'), custom = $('zoomCustom');
  const pct = `${Math.round(S.zoom * 100)}%`;
  if (S.mode === 'width' || S.mode === 'page') { sel.value = S.mode; custom.hidden = true; }
  else {
    const preset = [...sel.options].find(o => !isNaN(+o.value) && Math.abs(+o.value - S.zoom) < 1e-3);
    if (preset) { sel.value = preset.value; custom.hidden = true; }
    else { custom.textContent = pct; custom.hidden = false; sel.value = 'custom'; }
  }
  $('zoomOutBtn').disabled = S.zoom <= MIN_ZOOM + 1e-3;
  $('zoomInBtn').disabled = S.zoom >= MAX_ZOOM - 1e-3;
  $('zoomSelect').title = `Zoom: ${pct}`;
}

function rotate(delta) {
  if (!S.pdf) return;
  const keep = S.current;
  S.rotation = (S.rotation + delta + 360) % 360;
  redrawAllAnnots();
  if (S.mode !== 'custom') S.zoom = fitZoom(S.mode);
  layout(); goToPage(keep);
  for (const p of S.pages) { p.renderedKey = ''; }
  updateZoomUI(); scheduleRender(0); refreshThumbSizes(true);
}

viewer.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !S.pdf) return;
  e.preventDefault();
  const factor = Math.exp(clamp(-e.deltaY, -50, 50) * 0.002);   // ~10% per mouse notch, smooth on trackpads
  setZoom(S.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
}, { passive: false });

new ResizeObserver(() => {
  if (!S.pdf || S.mode === 'custom') return;
  requestAnimationFrame(() => setZoom(fitZoom(S.mode), { mode: S.mode }));
}).observe(viewer);

/* =========================================================
   Thumbnails & outline
   ========================================================= */
let thumbObserver = null;
const thumbQueue = []; let thumbBusy = false;

function buildThumbs() {
  const box = $('thumbs'); box.replaceChildren();
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { const t = e.target; if (!t._done && !t._queued) { t._queued = true; thumbQueue.push(t); } }
    pumpThumbs();
  }, { root: $('panePages'), rootMargin: '300px 0px' });
  for (const p of S.pages) {
    const btn = el('button', 'thumb', { type: 'button', title: `Page ${p.num}` });
    btn.dataset.page = p.num;
    const frame = el('div', 'thumb-frame');
    btn.append(frame, el('span', 'thumb-num', { textContent: p.num }));
    btn.addEventListener('click', () => goToPage(p.num));
    p.thumb = btn; p.thumbFrame = frame;
    box.append(btn);
  }
  refreshThumbSizes();
  S.pages.forEach(p => thumbObserver.observe(p.thumb));
  syncThumb();
}

function refreshThumbSizes(rerender = false) {
  for (const p of S.pages) {
    if (!p.thumbFrame) continue;
    const { w, h } = dims(p);
    p.thumbFrame.style.width = `${THUMB_W}px`;
    p.thumbFrame.style.height = `${Math.round(THUMB_W * h / w)}px`;
    if (rerender && p.thumb._done) { p.thumb._done = false; p.thumb._queued = false; p.thumbFrame.replaceChildren(); thumbObserver?.unobserve(p.thumb); thumbObserver?.observe(p.thumb); }
  }
}

async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  const docId = S.docId;
  try {
    while (thumbQueue.length) {
      const t = thumbQueue.shift();
      if (docId !== S.docId) return;
      const p = S.pages[+t.dataset.page - 1]; if (!p || t._done) continue;
      const page = await getPage(p);
      const rot = (page.rotate + S.rotation) % 360;
      const vp1 = page.getViewport({ scale: 1, rotation: rot });
      const out = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: THUMB_W / vp1.width, rotation: rot });
      const c = el('canvas'); c.width = Math.floor(vp.width * out); c.height = Math.floor(vp.height * out);
      try { await page.render({ canvasContext: c.getContext('2d', { alpha: false }), canvas: c, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null }).promise; }
      catch { t._queued = false; continue; }
      if (docId !== S.docId) return;
      p.thumbFrame.replaceChildren(c); t._done = true; t._queued = false;
      await idle();
    }
  } finally { thumbBusy = false; }
}

let thumbScrollTimer = 0;
function syncThumb() {
  document.querySelectorAll('.thumb.active').forEach(t => t.classList.remove('active'));
  const p = S.pages[S.current - 1]; if (!p?.thumb) return;
  p.thumb.classList.add('active');
  clearTimeout(thumbScrollTimer);
  thumbScrollTimer = setTimeout(() => {
    const pane = $('panePages'); if (!pane.classList.contains('active')) return;
    const r = p.thumb.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) p.thumb.scrollIntoView({ block: 'center' });
  }, 120);
}

async function loadOutline() {
  if (!S.pdf || S.outlineLoaded) return;
  S.outlineLoaded = true;
  const box = $('outline');
  let items = null;
  try { items = await S.pdf.getOutline(); } catch { items = null; }
  if (!items?.length) { box.replaceChildren(el('div', 'empty', { textContent: 'This document has no bookmarks.' })); return; }
  const build = (list, depth) => {
    const ul = el('ul');
    for (const it of list) {
      const li = el('li'), row = el('div', 'ol-row');
      const kids = it.items?.length ? it.items : null;
      if (kids) {
        const tg = el('button', 'ol-toggle', { type: 'button', innerHTML: '<svg><use href="#i-right"/></svg>' });
        const open = depth < 1;
        tg.setAttribute('aria-expanded', open); tg.setAttribute('aria-label', 'Expand or collapse');
        if (!open) li.classList.add('collapsed');
        tg.addEventListener('click', () => { const o = li.classList.toggle('collapsed'); tg.setAttribute('aria-expanded', !o); });
        row.append(tg);
      } else row.append(el('span', 'ol-spacer'));
      const link = el('button', 'ol-link' + (it.bold ? ' b' : '') + (it.italic ? ' i' : ''), { type: 'button', textContent: it.title || '(untitled)' });
      link.addEventListener('click', () => it.dest ? goToDest(it.dest) : it.url ? openExternal(it.url) : null);
      row.append(link); li.append(row);
      if (kids) li.append(build(kids, depth + 1));
      ul.append(li);
    }
    return ul;
  };
  box.replaceChildren(build(items, 0));
}

function setTab(name) {
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $('panePages').classList.toggle('active', name === 'pages');
  $('paneOutline').classList.toggle('active', name === 'outline');
  $('paneResults').classList.toggle('active', name === 'results');
  $('paneComments').classList.toggle('active', name === 'comments');
  if (name === 'comments') renderComments(true);
  if (name !== 'results' && !S.search.matches.length) $('tabResults').hidden = true;
  if (name === 'outline') loadOutline();
  if (name === 'pages') syncThumb();
  if (name === 'results') renderResults(true);
}

function toggleSidebar(force) {
  const closed = force === undefined ? !document.body.classList.contains('sidebar-closed') : !force;
  document.body.classList.toggle('sidebar-closed', closed);
  $('sidebarBtn').setAttribute('aria-pressed', !closed);
}

/* =========================================================
   Search
   ========================================================= */
const textInflight = new Map();
function getPageText(i) {
  const cache = S.search.texts;
  if (cache.has(i)) return Promise.resolve(cache.get(i));
  if (!textInflight.has(i)) {
    const docId = S.docId;
    textInflight.set(i, loadPageText(i).finally(() => { if (docId === S.docId) textInflight.delete(i); }));
  }
  return textInflight.get(i);
}
async function loadPageText(i) {
  const cache = S.search.texts;
  const page = await getPage(S.pages[i]);
  const tc = await page.getTextContent({ disableNormalization: true });
  let text = ''; const starts = [], strs = [];
  for (const it of tc.items) {
    if (it.str === undefined) continue;
    starts.push(text.length); strs.push(it.str);
    text += it.str;
    if (it.hasEOL) text += ' ';
  }
  const entry = { text, starts, strs };
  cache.set(i, entry);
  return entry;
}

function buildRegex(q, caseSensitive, wholeWord) {
  let src = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, caseSensitive ? 'gu' : 'giu');
}

function firstMatchOnPageIndex(page) { // first index whose page >= page
  const m = S.search.matches; let lo = 0, hi = m.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid].page < page) lo = mid + 1; else hi = mid; }
  return lo;
}
function matchesOnPage(page) {
  const m = S.search.matches, a = firstMatchOnPageIndex(page);
  let b = a; while (b < m.length && m[b].page === page) b++;
  return { from: a, to: b };
}

let searchDebounce = 0;
async function startSearch() {
  const s = S.search, token = ++s.token, q = $('searchInput').value;
  s.query = q; s.matches = []; s.index = -1; s.done = false; s.pendingScroll = false;
  clearAllHighlights(); updateSearchUI(); renderResults();
  if (!q.trim() || !S.pdf) { s.done = true; updateSearchUI(); return; }
  let re;
  try { re = buildRegex(q, s.caseSensitive, s.wholeWord); } catch { s.done = true; updateSearchUI(); return; }
  const n = S.pages.length, startAt = S.current - 1, docId = S.docId;
  let jumped = false;
  const LOOKAHEAD = 8, pending = new Map();
  const fetchText = (k) => { if (k < n && !pending.has(k)) pending.set(k, getPageText((startAt + k) % n).catch(() => null)); };
  for (let k = 0; k < LOOKAHEAD; k++) fetchText(k);
  for (let k = 0; k < n; k++) {
    const pi = (startAt + k) % n;
    fetchText(k + LOOKAHEAD);
    const entry = await pending.get(k); pending.delete(k);
    if (!entry) continue;
    if (token !== s.token || docId !== S.docId) return;
    re.lastIndex = 0;
    const found = []; let m;
    while ((m = re.exec(entry.text)) && s.matches.length + found.length < MAX_MATCHES) {
      if (!m[0].length) { re.lastIndex++; continue; }
      found.push({ page: pi + 1, start: m.index, end: m.index + m[0].length });
    }
    if (found.length) {
      const at = firstMatchOnPageIndex(pi + 2);
      s.matches.splice(at, 0, ...found);
      if (s.index >= at) s.index += found.length;
      S.pages[pi].thumb?.classList.add('has-hits');
      if (!jumped) { jumped = true; goToMatch(at); }
      else { const p = S.pages[pi]; if (p.rendered) drawHighlights(p); }
      renderResultsSoon();
    }
    if (k % 8 === 0) { updateSearchUI(); await idle(); }
    if (s.matches.length >= MAX_MATCHES) break;
  }
  if (token !== s.token) return;
  s.done = true; updateSearchUI(); renderResults();
}

function goToMatch(i) {
  const s = S.search; if (!s.matches.length) return;
  s.index = (i + s.matches.length) % s.matches.length;
  const m = s.matches[s.index];
  const prev = s.lastPage; s.lastPage = m.page;
  if (prev && prev !== m.page && S.pages[prev - 1]) drawHighlights(S.pages[prev - 1]);
  s.pendingScroll = true;
  const p = S.pages[m.page - 1];
  if (p.rendered && p.renderedKey === renderKey()) { drawHighlights(p); scrollToCurrentMatch(); }
  else { goToPage(m.page); scheduleRender(0); }
  updateSearchUI(); markActiveResult();
}
const nextMatch = () => { if (S.search.matches.length) goToMatch(S.search.index + 1); else if ($('searchInput').value.trim()) startSearch(); };
const prevMatch = () => { if (S.search.matches.length) goToMatch(S.search.index - 1); };

function drawHighlights(p) {
  p.hlLayer.replaceChildren();
  const s = S.search;
  if (!p.rendered || !p.textLayer || !s.matches.length) return;
  const { from, to } = matchesOnPage(p.num); if (from === to) return;
  const entry = s.texts.get(p.num - 1); if (!entry) return;
  const divs = p.textLayer.textDivs, strs = p.textLayer.textContentItemsStr;
  const base = p.div.getBoundingClientRect();
  const range = document.createRange();
  const frag = document.createDocumentFragment();
  for (let mi = from; mi < to; mi++) {
    const m = s.matches[mi], current = mi === s.index;
    let i = itemAt(entry.starts, m.start);
    for (; i < entry.starts.length && entry.starts[i] < m.end; i++) {
      const str = entry.strs[i];
      if (strs[i] !== str) continue;                 // text layer mismatch: skip safely
      const ls = Math.max(0, m.start - entry.starts[i]), le = Math.min(str.length, m.end - entry.starts[i]);
      const node = divs[i]?.firstChild;
      if (le <= ls || !node) continue;
      try { range.setStart(node, ls); range.setEnd(node, le); } catch { continue; }
      for (const r of range.getClientRects()) {
        if (r.width < .5 || r.height < .5) continue;
        const d = el('div', current ? 'hl current' : 'hl');
        Object.assign(d.style, { left: `${r.left - base.left}px`, top: `${r.top - base.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        frag.append(d);
      }
    }
  }
  p.hlLayer.append(frag);
}
function itemAt(starts, pos) { let lo = 0, hi = starts.length - 1, ans = 0; while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans; }

function scrollToCurrentMatch() {
  const s = S.search, m = s.matches[s.index]; if (!m) return;
  const p = S.pages[m.page - 1];
  const hl = p.hlLayer.querySelector('.hl.current'); if (!hl) return;
  s.pendingScroll = false;
  const r = hl.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
  if (r.top < vr.top + 40 || r.bottom > vr.bottom - 40) viewer.scrollTop += r.top - vr.top - vr.height * 0.3;
  if (r.left < vr.left + 20 || r.right > vr.right - 20) viewer.scrollLeft += r.left - vr.left - vr.width * 0.3;
  p.hlLayer.querySelectorAll('.hl.current').forEach(h => { h.classList.remove('pulse'); void h.offsetWidth; h.classList.add('pulse'); });
}

function clearAllHighlights() { for (const p of S.pages) { p.hlLayer.replaceChildren(); p.thumb?.classList.remove('has-hits'); } S.search.lastPage = 0; }

function resetSearch(clearInput) {
  const s = S.search; s.token++; s.matches = []; s.index = -1; s.done = true; s.pendingScroll = false; s.texts = new Map(); textInflight.clear();
  if (clearInput) $('searchInput').value = '';
  clearAllHighlights(); updateSearchUI(); renderResults();
}

function updateSearchUI() {
  const s = S.search, c = $('searchCount'), total = s.matches.length;
  c.classList.remove('none');
  if (!s.query.trim()) c.textContent = '';
  else if (!total && s.done) { c.textContent = 'No results'; c.classList.add('none'); }
  else if (!total) c.textContent = 'Searching…';
  else c.textContent = `${s.index + 1} of ${total}${s.done ? (total >= MAX_MATCHES ? '+' : '') : '…'}`;
  $('searchPrevBtn').disabled = $('searchNextBtn').disabled = !total;
  const b = $('resultsBadge'); b.hidden = !total; b.textContent = total > 999 ? '999+' : total;
  const rt = $('tabResults'); rt.hidden = !total && !rt.classList.contains('active');
}

let resultsTimer = 0;
function renderResultsSoon() { clearTimeout(resultsTimer); resultsTimer = setTimeout(() => renderResults(), 200); }
function renderResults(force) {
  const box = $('results');
  if (!force && !$('paneResults').classList.contains('active')) return;
  const s = S.search;
  if (!s.query.trim()) { box.replaceChildren(el('div', 'empty', { textContent: 'Use Ctrl+F to find text. Every match is listed here.' })); return; }
  if (!s.matches.length) { box.replaceChildren(el('div', 'empty', { textContent: s.done ? `No matches for “${s.query.trim()}”.` : 'Searching…' })); return; }
  const LIMIT = 400, frag = document.createDocumentFragment(); let lastPage = 0;
  s.matches.slice(0, LIMIT).forEach((m, i) => {
    if (m.page !== lastPage) { lastPage = m.page; frag.append(el('div', 'res-page', { textContent: `Page ${m.page}` })); }
    const t = s.texts.get(m.page - 1)?.text || '';
    const a = Math.max(0, m.start - 40), b = Math.min(t.length, m.end + 60);
    const btn = el('button', 'res', { type: 'button' }); btn.dataset.i = i;
    btn.append((a > 0 ? '…' : '') + t.slice(a, m.start).trimStart(), el('mark', '', { textContent: t.slice(m.start, m.end) }), t.slice(m.end, b).trimEnd() + (b < t.length ? '…' : ''));
    btn.addEventListener('click', () => goToMatch(i));
    frag.append(btn);
  });
  if (s.matches.length > LIMIT) frag.append(el('div', 'res-more', { textContent: `Showing the first ${LIMIT} of ${s.matches.length} matches.` }));
  box.replaceChildren(frag); markActiveResult();
}
function markActiveResult() {
  const box = $('results');
  box.querySelectorAll('.res.active').forEach(r => r.classList.remove('active'));
  const cur = box.querySelector(`.res[data-i="${S.search.index}"]`);
  if (cur) { cur.classList.add('active'); if ($('paneResults').classList.contains('active')) cur.scrollIntoView({ block: 'nearest' }); }
}

function openSearch() {
  if (!S.pdf) return;
  const panel = $('searchPanel'), input = $('searchInput');
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 120 && !sel.includes('\n')) { input.value = sel; }
  panel.hidden = false; $('searchBtn').setAttribute('aria-expanded', 'true');
  input.focus(); input.select();
  if (input.value.trim() && (input.value !== S.search.query || !S.search.matches.length)) startSearch();
}
function closeSearch(silent) {
  $('searchPanel').hidden = true; $('searchBtn').setAttribute('aria-expanded', 'false');
  S.search.token++; clearAllHighlights(); S.search.matches = []; S.search.index = -1; S.search.query = ''; S.search.done = true;
  updateSearchUI(); renderResults();
  if (!silent) viewer.focus({ preventScroll: true });
}

/* =========================================================
   Print & save
   ========================================================= */
let printCancelled = false;
async function printDocument() {
  if (!S.pdf || S.printing) return;
  S.printing = true; printCancelled = false;
  const docId = S.docId, n = S.pages.length, urls = [];
  const prog = $('printProgress'); prog.hidden = false;
  const style = el('style');
  let tempDoc = null;
  try {
    let srcPdf = S.pdf;
    if (A.items.length) { $('printSub').textContent = 'Adding your comments…'; tempDoc = await openAnnotatedForPrint(); srcPdf = tempDoc; }
    const pageOf = (i) => (tempDoc ? srcPdf.getPage(i + 1) : getPage(S.pages[i]));
    const firstPage = await pageOf(0);
    const fv = firstPage.getViewport({ scale: 1, rotation: firstPage.rotate });
    style.textContent = `@page{size:${fv.width}pt ${fv.height}pt;margin:0}`;
    document.head.append(style);
    let done = 0, next = 0;
    const renderForPrint = async (i) => {
      const page = await pageOf(i);
      let scale = 150 / 72;
      const v1 = page.getViewport({ scale: 1, rotation: page.rotate });
      if (v1.width * v1.height * scale * scale > 25e6) scale = Math.sqrt(25e6 / (v1.width * v1.height));
      const vp = page.getViewport({ scale, rotation: page.rotate });
      const c = el('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), canvas: c, viewport: vp, intent: 'print', annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      c.width = c.height = 0;
      urls[i] = URL.createObjectURL(blob);
      done++; $('printSub').textContent = `Page ${done} of ${n}`; $('printBar').style.width = `${(done / n) * 100}%`;
    };
    const worker = async () => {
      while (next < n) {
        if (printCancelled || docId !== S.docId) throw new Error('cancelled');
        await renderForPrint(next++);
      }
    };
    $('printSub').textContent = `Page 0 of ${n}`;
    await worker();
    if (printCancelled || docId !== S.docId) throw new Error('cancelled');
    $('printBar').style.width = '100%';
    const imgs = urls.map(u => { const img = new Image(); img.src = u; return img; });
    $('printContainer').replaceChildren(...imgs.map(img => { const d = el('div', 'print-page'); d.append(img); return d; }));
    await Promise.all(imgs.map(i => i.decode().catch(() => {})));
    prog.hidden = true; await nextFrame();
    window.print();
  } catch (e) {
    if (e?.message !== 'cancelled') toast(`Printing failed: ${e?.message || e}`, 'error');
  } finally {
    prog.hidden = true; tempDoc?.destroy();
    setTimeout(() => { $('printContainer').replaceChildren(); urls.forEach(u => u && URL.revokeObjectURL(u)); style.remove(); }, 1000);
    S.printing = false;
  }
}

/* =========================================================
   Opening files: file picker, drag & drop, recent files, "Open with" (installed app)
   ========================================================= */
const fsAccess = 'showOpenFilePicker' in window;          // Edge / Chrome
const PDF_TYPES = [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }];
const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

async function openViaDialog() {
  if (fsAccess) {
    try { const [h] = await window.showOpenFilePicker({ types: PDF_TYPES, multiple: false }); if (h) await openHandle(h); }
    catch (e) { if (e?.name !== 'AbortError') { console.warn(e); $('fileInput').click(); } }
  } else $('fileInput').click();
}

/* Open from a file handle (picker, drag & drop, recent list, or Windows "Open with"). */
const EMBED = window.parent !== window && location.protocol === 'http:' && location.hostname === '127.0.0.1';
function toParent(msg) { try { window.parent.postMessage(msg, location.origin); return true; } catch (_) { return false; } }
async function openHandle(handle, recentId = null, here = false) {
  if (EMBED && S.pdf && !here && toParent(handle.__server ? { hx: 'open', token: handle.token, name: handle.name } : { hx: 'open', handle })) return true;   // a second PDF opens in a new tab
  let file;
  try { file = await handle.getFile(); }
  catch (e) {
    if (e?.name === 'NotFoundError') { toast(`${handle.name} has been moved or deleted.`, 'error'); if (recentId) { await idbDel(recentId).catch(() => {}); renderRecent(); } }
    else toast(`Could not open ${handle.name}: ${e?.message || e}`, 'error');
    return false;
  }
  if (!isPdf(file)) { toast(`${file.name} is not a PDF.`, 'error'); return false; }
  addRecent(handle, file).catch((e) => console.warn('Recent files', e));
  await openDocument({ data: new Uint8Array(await file.arrayBuffer()), name: file.name, handle });
  return true;
}

async function openFileObject(file, here = false) {
  if (!isPdf(file)) { toast(`${file.name} is not a PDF.`, 'error'); return; }
  if (EMBED && S.pdf && !here && toParent({ hx: 'open', file })) return;
  openDocument({ data: new Uint8Array(await file.arrayBuffer()), name: file.name });
}

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0]; e.target.value = '';
  if (file) openFileObject(file);
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const file = e.dataTransfer.files?.[0];
  const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
  if (item && typeof item.getAsFileSystemHandle === 'function') {      // must be requested during the drop event
    item.getAsFileSystemHandle()
      .then(h => (h && h.kind === 'file' ? openHandle(h) : file && openFileObject(file)))
      .catch(() => file && openFileObject(file));
  } else if (file) openFileObject(file);
});

/* Recent files: the browser keeps a reference to each file (never its contents) in IndexedDB. */
const DB_NAME = 'heurix-pdf-viewer', STORE = 'recent', MAX_RECENT = 12;
let dbPromise = null;
function idb() {
  dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function idbTx(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, mode); const req = fn(tx.objectStore(STORE)); tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); });
}
const idbAll = () => idbTx('readonly', st => st.getAll());
const idbPut = (rec) => idbTx('readwrite', st => st.put(rec));
const idbDel = (id) => idbTx('readwrite', st => st.delete(id));
const idbClear = () => idbTx('readwrite', st => st.clear());

async function getRecent() { try { return ((await idbAll()) || []).sort((a, b) => b.openedAt - a.openedAt); } catch { return []; } }
async function addRecent(handle, file) {
  if (!handle || handle.__server || !('indexedDB' in window)) return;
  for (const r of await getRecent()) { try { if (await r.handle.isSameEntry(handle)) await idbDel(r.id); } catch { /* stale handle */ } }
  await idbPut({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, size: file.size, openedAt: Date.now(), handle });
  for (const r of (await getRecent()).slice(MAX_RECENT)) await idbDel(r.id);
}
async function openRecent(r) {
  try {   // the browser asks once per session before reading a remembered file
    const opts = { mode: 'read' };
    if (r.handle.queryPermission && (await r.handle.queryPermission(opts)) !== 'granted' && (await r.handle.requestPermission(opts)) !== 'granted') {
      toast(`Permission to open ${r.name} was not given.`, 'error'); return;
    }
  } catch (e) { console.warn(e); }
  openHandle(r.handle, r.id);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function timeAgo(ts) {
  const s = (ts - Date.now()) / 1000, units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return 'just now';
}
function fmtSize(b) { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3); return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`; }

async function renderRecent() {
  const card = $('recentCard');
  if (!fsAccess) { card.hidden = true; return; }        // other browsers can't reopen files later
  const list = await getRecent();
  card.hidden = false;
  const ul = $('recentList');
  $('clearRecentBtn').hidden = !list.length;
  if (!list.length) { ul.replaceChildren(el('li', 'recent-empty', { textContent: 'PDFs you open will appear here.' })); return; }
  ul.replaceChildren(...list.map(r => {
    const li = el('li', 'recent-item');
    const open = el('button', 'recent-open', { type: 'button', title: `Open ${r.name}` });
    const text = el('div'); text.style.minWidth = '0';
    text.append(el('div', 'r-name', { textContent: r.name }), el('div', 'r-meta', { textContent: [timeAgo(r.openedAt), fmtSize(r.size)].filter(Boolean).join('  ·  ') }));
    open.append(el('span', 'r-icon'), text);
    open.addEventListener('click', () => openRecent(r));
    const rm = el('button', 'icon-btn sm recent-remove', { type: 'button', title: 'Remove from list', innerHTML: '<svg><use href="#i-x"/></svg>' });
    rm.setAttribute('aria-label', `Remove ${r.name} from recent files`);
    rm.addEventListener('click', async () => { await idbDel(r.id); renderRecent(); });
    li.append(open, rm);
    return li;
  }));
}


/* =========================================================
   Small UI helpers: loading, toast, dialogs
   ========================================================= */
function showLoading(title, sub) { $('loadingTitle').textContent = title; $('loadingSub').textContent = sub || ''; $('loading').hidden = false; }
function hideLoading() { $('loading').hidden = true; }

let toastTimer = 0;
function toast(msg, type = '', ms = 0) {
  const t = $('toast'); t.className = `toast ${type}`; t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || (type === 'error' ? 6000 : 3200));
}

function modal({ title, body, icon = 'i-lock', ok = 'OK', cancel = 'Cancel', alt = '', input = false, inputType = 'password', placeholder = '', value = '', error = '' }) {
  return new Promise((resolve) => {
    const m = $('modal'), box = m.querySelector('.modal'), inp = $('modalInput'), err = $('modalError'), okBtn = $('modalOk'), altBtn = $('modalAlt');
    $('modalTitle').textContent = title; $('modalBody').textContent = body;
    $('modalIcon').innerHTML = `<svg><use href="#${icon}"/></svg>`;
    okBtn.textContent = ok; $('modalCancel').textContent = cancel;
    altBtn.hidden = !alt; altBtn.textContent = alt;
    inp.type = inputType; inp.placeholder = placeholder; inp.hidden = !input; inp.value = value; err.hidden = !error; err.textContent = error;
    m.hidden = false;
    if (error) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
    setTimeout(() => { (input ? inp : okBtn).focus(); if (input) inp.select(); }, 30);
    const done = (v) => { m.hidden = true; cleanup(); resolve(v); };
    const onOk = () => done(input ? inp.value : true);
    const onAlt = () => done('alt');
    const onCancel = () => done(input ? null : false);
    const onKey = (e) => {
      if (e.key === 'Enter') { if (e.target instanceof HTMLButtonElement && e.target !== okBtn) return; e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    const onBackdrop = (e) => { if (e.target === m) onCancel(); };
    okBtn.addEventListener('click', onOk); altBtn.addEventListener('click', onAlt); $('modalCancel').addEventListener('click', onCancel);
    m.addEventListener('keydown', onKey); m.addEventListener('mousedown', onBackdrop);
    function cleanup() { okBtn.removeEventListener('click', onOk); altBtn.removeEventListener('click', onAlt); $('modalCancel').removeEventListener('click', onCancel); m.removeEventListener('keydown', onKey); m.removeEventListener('mousedown', onBackdrop); }
  });
}
const askPassword = (name, wrong) => modal({ title: 'This PDF is password protected', body: `Enter the password to open ${name}.`, ok: 'Unlock', input: true, error: wrong ? 'That password is incorrect. Try again.' : '' });
const confirmDialog = ({ title, body, ok, icon }) => modal({ title, body, ok, icon });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'error'));
}
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  $('fullscreenBtn').innerHTML = `<svg><use href="#${fs ? 'i-collapse' : 'i-expand'}"/></svg>`;
  $('fullscreenBtn').title = fs ? 'Exit full screen (F11)' : 'Full screen (F11)';
});

function showKeys(show = true) { $('keysModal').hidden = !show; if (show) $('keysClose').focus(); }

/* =========================================================
   Wiring
   ========================================================= */
$('homeBtn').addEventListener('click', goHome);
$('openBtn').addEventListener('click', openViaDialog);
$('startOpenBtn').addEventListener('click', openViaDialog);
$('sidebarBtn').addEventListener('click', () => toggleSidebar());
$('prevBtn').addEventListener('click', () => goToPage(S.current - 1));
$('nextBtn').addEventListener('click', () => goToPage(S.current + 1));
$('zoomInBtn').addEventListener('click', zoomIn);
$('zoomOutBtn').addEventListener('click', zoomOut);
$('zoomSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'width' || v === 'page') setZoomMode(v); else if (v !== 'custom') setZoom(+v);
  viewer.focus({ preventScroll: true });
});
$('rotateBtn').addEventListener('click', () => rotate(90));
$('searchBtn').addEventListener('click', () => ($('searchPanel').hidden ? openSearch() : closeSearch()));
$('printBtn').addEventListener('click', printDocument);
$('saveBtn').addEventListener('click', () => saveDocument());
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
$('keysBtn').addEventListener('click', () => showKeys(true));
$('keysClose').addEventListener('click', () => showKeys(false));
$('keysModal').addEventListener('mousedown', (e) => { if (e.target === $('keysModal')) showKeys(false); });
$('printCancel').addEventListener('click', () => { printCancelled = true; });
$('clearRecentBtn').addEventListener('click', async () => { await idbClear().catch(() => {}); renderRecent(); });
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

const pageInput = $('pageInput');
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); goToPage(parseInt(pageInput.value, 10)); viewer.focus({ preventScroll: true }); }
  else if (e.key === 'Escape') { pageInput.value = S.current; viewer.focus({ preventScroll: true }); }
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', () => { pageInput.value = S.current; });

const searchInput = $('searchInput');
searchInput.addEventListener('input', () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(startSearch, 250); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchInput.value !== S.search.query) { clearTimeout(searchDebounce); startSearch(); }
    else e.shiftKey ? prevMatch() : nextMatch();
  } else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
$('searchNextBtn').addEventListener('click', nextMatch);
$('searchPrevBtn').addEventListener('click', prevMatch);
$('searchCloseBtn').addEventListener('click', () => closeSearch());
for (const [id, key] of [['optCase', 'caseSensitive'], ['optWord', 'wholeWord']]) {
  $(id).addEventListener('click', () => { S.search[key] = !S.search[key]; $(id).setAttribute('aria-pressed', S.search[key]); startSearch(); searchInput.focus(); });
}
$('optShowAll').addEventListener('click', () => { toggleSidebar(true); setTab('results'); });

document.addEventListener('keydown', (e) => {
  if (!$('modal').hidden) return;                         // dialog handles its own keys
  if (!$('keysModal').hidden) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); showKeys(false); } return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName);

  if (mod && k === 'o') { e.preventDefault(); openViaDialog(); return; }
  if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
  if (!S.pdf) { if (e.key === '?' && !typing) showKeys(true); return; }

  if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
  if (e.key === 'F3') { e.preventDefault(); e.shiftKey ? prevMatch() : ($('searchPanel').hidden ? openSearch() : nextMatch()); return; }
  if (mod && k === 'p') { e.preventDefault(); printDocument(); return; }
  if (mod && k === 's') { e.preventDefault(); saveDocument({ as: e.shiftKey }); return; }
  if (mod && k === 'g') { e.preventDefault(); pageInput.focus(); return; }
  if (mod && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomOut(); return; }
  if (mod && e.key === '0') { e.preventDefault(); setZoomMode('width'); return; }
  if (mod && e.key === '1') { e.preventDefault(); setZoom(1); return; }
  if (mod && e.key === '2') { e.preventDefault(); setZoomMode('page'); return; }
  if (typing || mod || e.altKey) return;

  const noHScroll = viewer.scrollWidth <= viewer.clientWidth + 1;
  switch (e.key) {
    case 'Escape': if (!$('searchPanel').hidden) { e.preventDefault(); closeSearch(); } break;
    case 'r': case 'R': e.preventDefault(); rotate(e.shiftKey ? -90 : 90); break;
    case 'Home': e.preventDefault(); goToPage(1); break;
    case 'End': e.preventDefault(); goToPage(S.pages.length); break;
    case 'ArrowRight': if (noHScroll && !A.sel) { e.preventDefault(); goToPage(S.current + 1); } break;   // with a shape selected, arrows nudge it instead
    case 'ArrowLeft': if (noHScroll && !A.sel) { e.preventDefault(); goToPage(S.current - 1); } break;
    case 'n': case 'j': goToPage(S.current + 1); break;
    case 'p': case 'k': goToPage(S.current - 1); break;
    case '?': showKeys(true); break;
  }
});

/* =========================================================
   Start-up
   ========================================================= */

/* =====================================================================
   Phase 2a — comments
   Highlight, underline, strikethrough, sticky notes, replies, a comments list,
   undo / redo, and saving everything into the PDF as standard annotations
   (they show in Adobe Acrobat, Edge, Chrome, Preview and other readers).

   How it fits together
   - Comments live in memory (A.items) in PDF page coordinates, so they stay in place when you zoom or rotate.
   - The page canvas never changes. Comments are drawn on top in each page's .annot-layer.
   - Comments saved earlier by Heurix are lifted out of the file when it opens (so they stay editable,
     and are never drawn twice). Save writes them back, with appearance streams for other readers.
   ===================================================================== */

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};

const COLORS = {
  yellow: { label: 'Yellow', fill: '#FFE14D', line: '#B58900' },
  green:  { label: 'Green',  fill: '#7BE495', line: '#1E8E3E' },
  blue:   { label: 'Blue',   fill: '#7CCBFF', line: '#1A73E8' },
  pink:   { label: 'Pink',   fill: '#FF9ECF', line: '#D81B7A' },
  orange: { label: 'Orange', fill: '#FFB566', line: '#E8710A' },
  red:    { label: 'Red',    fill: '#FF8A80', line: '#D93025' },
  black:  { label: 'Black',  fill: '#C9C5D0', line: '#1C1428' }
};
const NOTE_SIZE = 20;                       // sticky note icon, in PDF points
const TYPE_LABEL = { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', note: 'Sticky note', text: 'Text box', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', arrow: 'Arrow', line: 'Line', ink: 'Drawing', stamp: 'Stamp', signature: 'Signature' };
const TYPE_ICON = { highlight: 'i-highlight', underline: 'i-underline', strike: 'i-strike', note: 'i-note', text: 'i-textbox', rect: 'i-rect', ellipse: 'i-ellipse', cloud: 'i-cloud', arrow: 'i-arrow', line: 'i-line', ink: 'i-pen', stamp: 'i-stamp', signature: 'i-sign' };
const TOOL_HINT = {
  select: '', pan: 'Drag the page to move around. Hold Space to pan for a moment, or press Esc to go back to selecting', highlight: 'Select text to highlight it', underline: 'Select text to underline it',
  strike: 'Select text to strike it through', note: 'Click on the page to place a sticky note',
  text: 'Click, or drag a box, then type', rect: 'Drag to draw a rectangle', ellipse: 'Drag to draw an ellipse', cloud: 'Drag to draw a revision cloud', arrow: 'Drag from the tail to the point', line: 'Drag to draw a line',
  erase: 'Click a markup to remove it, or drag a box around several. Hold Alt to also catch ones that only touch the box',
  ink: 'Draw freehand with the mouse or a pen', stamp: 'Click on the page to place the stamp', sign: 'Click on the page to place your signature'
};
const FOREIGN_LABEL = {
  Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly underline', Text: 'Sticky note',
  FreeText: 'Text box', Caret: 'Insert', Stamp: 'Stamp', Ink: 'Drawing', Line: 'Line', Square: 'Rectangle', Circle: 'Ellipse',
  Polygon: 'Shape', PolyLine: 'Shape', FileAttachment: 'Attachment'
};

const savedWidth = parseInt(LS.get('hx-w'), 10);
const A = {
  items: [], undo: [], redo: [], hkey: '', ht: 0, savedSnap: '{"i":[],"r":[]}', dirty: false,
  author: LS.get('hx-author') || '',
  color: COLORS[LS.get('hx-color')] ? LS.get('hx-color') : 'yellow',
  tool: 'select', ribbonOpen: LS.get('hx-ribbon') !== '0',
  encrypted: false, foreign: [], openId: null, pendingNew: null, hoverId: null, filter: 'all',
  sel: null, editing: null, op: null, draft: null, images: {}, lock: false, clip: null, pasteN: 0, stampSpec: null, sigPending: null, lastPtr: { x: 0, y: 0 }, fontSize: 12,
  ed: edEmpty(), edSel: new Set(), edHover: null, edAssets: new Map(), appliedEd: '', mode: 'comment', edPending: null,
  widthIdx: [0, 1, 2].includes(savedWidth) ? savedWidth : 1, drawColor: COLORS[LS.get('hx-dcolor')] ? LS.get('hx-dcolor') : null
};

const uid = () => `heurix-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
const snap = () => JSON.stringify({ i: A.items, r: [...(A.removed || [])].sort(), e: edHas(A.ed) ? A.ed : undefined });
const findAnn = (id) => A.items.find((a) => a.id === id);
const colorOf = (a) => COLORS[a.color] || COLORS.yellow;
const hasComment = (a) => !!(a.text && a.text.trim()) || a.replies.length > 0;
const unionRect = (rs) => [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
const lineThickness = (r) => Math.max(0.8, Math.abs(r[3] - r[1]) * 0.07);   // PDF points

/* ---------------------------------------------------------------------
   State, history (undo / redo)
   --------------------------------------------------------------------- */
function refreshState() {
  A.dirty = snap() !== A.savedSnap;
  $('docName').classList.toggle('dirty', A.dirty);
  $('ribbonSaveBtn').classList.toggle('dirty', A.dirty);
  $('undoBtn').disabled = !A.undo.length;
  $('redoBtn').disabled = !A.redo.length;
}

function pushHistory(key = '') {
  const t = Date.now();
  if (key && key === A.hkey && t - A.ht < 1500) { A.ht = t; return; }   // typing is one undo step
  A.undo.push(snap()); if (A.undo.length > 150) A.undo.shift();
  A.redo.length = 0; A.hkey = key; A.ht = t;
}

function restoreSnapshot(json) {
  const d = JSON.parse(json); A.items = Array.isArray(d) ? d : d.i; A.hkey = '';
  if (!Array.isArray(d)) {
    const next = new Set(d.r);
    if (next.size !== A.removed.size || [...next].some((x) => !A.removed.has(x))) { A.removed = next; A.fsel = new Set([...A.fsel].filter((x) => !next.has(x))); scheduleApplyRemovals(); }
  }
  if (!Array.isArray(d)) {
    const ne = d.e ? JSON.stringify(d.e) : '';
    if (ne !== edKey()) { A.ed = d.e ? JSON.parse(ne) : edEmpty(); A.edSel = new Set(); scheduleApplyRemovals(300); }
  }
  if (A.editing && !findAnn(A.editing)) { A.editing = null; $('textEdit').hidden = true; }
  if (A.sel && !findAnn(A.sel)) A.sel = null;
  if (A.openId && !findAnn(A.openId)) closePop(true);
  redrawAllAnnots(); renderComments(); refreshState(); refreshObjbar();
  if (A.openId) renderPop();
}
function undo() { if (!A.undo.length) return; A.redo.push(snap()); restoreSnapshot(A.undo.pop()); }
function redo() { if (!A.redo.length) return; A.undo.push(snap()); restoreSnapshot(A.redo.pop()); }

function afterChange(pageNums = []) {
  for (const n of new Set(pageNums)) { const p = S.pages[n - 1]; if (p) drawAnnots(p); }
  renderCommentsSoon(); refreshState();
}

/* ---------------------------------------------------------------------
   Geometry (PDF space  <->  screen)
   --------------------------------------------------------------------- */
const vp1 = (p) => p.page.getViewport({ scale: 1, rotation: (p.page.rotate + S.rotation) % 360 });
function boxOf(vp, rect) {
  const r = vp.convertToViewportRectangle(rect);
  return { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
}
function pdfPointAt(p, cx, cy) {
  const r = p.div.getBoundingClientRect(), vp = vp1(p);
  return vp.convertToPdfPoint(((cx - r.left) / r.width) * vp.width, ((cy - r.top) / r.height) * vp.height);
}

/* ---------------------------------------------------------------------
   Drawing the marks on the pages
   --------------------------------------------------------------------- */
const NOTE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 3.5h17A1.5 1.5 0 0 1 22 5v10a1.5 1.5 0 0 1-1.5 1.5H10L5 21v-4.5H3.5A1.5 1.5 0 0 1 2 15V5a1.5 1.5 0 0 1 1.5-1.5Z"/><path class="ln" d="M6 8.5h12M6 12h7"/></svg>';

function drawAnnots(p) {
  const layer = p.annotLayer;
  layer.replaceChildren();
  if (!p.page) return;
  const list = A.items.filter((a) => a.page === p.num);
  if (A.draft && A.draft.page === p.num) list.push(A.draft);
  if (!list.length && !existingActive() && !edActiveFor()) return;
  const vp = vp1(p), W = vp.width, H = vp.height;
  const px = (v) => `${((100 * v) / W).toFixed(4)}%`, py = (v) => `${((100 * v) / H).toFixed(4)}%`;
  const frag = document.createDocumentFragment(), parts = { frag, svg: null };

  for (const a of list) {
    if (isObj(a)) { drawObject(a, vp, px, py, parts); continue; }
    const col = colorOf(a);
    const style = (extra) => `--c:${col.fill};--l:${col.line};${extra}`;
    const active = a.id === A.openId ? ' is-active' : '';
    const mark = (cls, b) => {
      const d = el('div', `an ${cls}${active}`);
      d.dataset.id = a.id;
      d.style.cssText = style(`left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`);
      frag.append(d);
    };

    if (a.type === 'note') {
      const b = boxOf(vp, a.rects[0]);
      const btn = el('button', `an an-note${active}`, { type: 'button', innerHTML: NOTE_SVG });
      btn.dataset.id = a.id;
      btn.setAttribute('aria-label', `Sticky note by ${a.author || 'unknown'}`);
      btn.style.cssText = style(`left:${px(b.x)};top:${py(b.y)}`);
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (A.openId === a.id) closePop(); else openPop(a.id); });
      frag.append(btn);
      continue;
    }

    a.rects.forEach((r) => {
      const b = boxOf(vp, r);
      if (a.type === 'highlight') mark('an-hl', b);
      else {
        const th = lineThickness(r);
        if (a.type === 'underline') mark('an-ul', { x: b.x, y: b.y + b.h - 1.4 * th - th / 2, w: b.w, h: th });
        else mark('an-st', { x: b.x, y: b.y + b.h / 2 - th / 2, w: b.w, h: th });
      }
    });
    if (hasComment(a)) {                               // small speech bubble at the end of the first line
      const b = boxOf(vp, a.rects[0]);
      const flag = el('div', 'an an-flag');
      flag.dataset.id = a.id;
      flag.style.cssText = style(`left:${px(b.x + b.w)};top:${py(b.y)}`);
      frag.append(flag);
    }
  }
  const sel = A.sel && list.find((x) => x.id === A.sel && x.id !== 'draft');
  if (sel) drawSelection(sel, vp, px, py, frag);
  drawExisting(p, vp, px, py, frag);
  drawEdit(p, vp, px, py, frag);
  layer.append(frag);
}

function redrawAllAnnots() {
  for (const p of S.pages) { if (p.rendered && p.page) drawAnnots(p); else p.annotLayer.replaceChildren(); }
}

function setActive(id) {
  document.querySelectorAll('.an.is-active').forEach((n) => n.classList.remove('is-active'));
  if (id) document.querySelectorAll(`.an[data-id="${id}"]`).forEach((n) => n.classList.add('is-active'));
  document.querySelectorAll('.cm.active').forEach((n) => n.classList.remove('active'));
  if (id) document.querySelector(`.cm[data-id="${id}"]`)?.classList.add('active');
}

function flashAnnot(id) {
  const els = document.querySelectorAll(`.an[data-id="${id}"]`);
  els.forEach((n) => { n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash'); });
  setTimeout(() => els.forEach((n) => n.classList.remove('flash')), 2200);
}

/* ---------------------------------------------------------------------
   Hit testing and hover
   --------------------------------------------------------------------- */
function hitTest(cx, cy, target) {
  const pageEl = target?.closest?.('.page'); if (!pageEl) return null;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return null;
  const [x, y] = pdfPointAt(p, cx, cy);
  for (let i = A.items.length - 1; i >= 0; i--) {
    const a = A.items[i];
    if (a.page !== p.num || !isMarkup(a)) continue;
    for (const r of a.rects) if (x >= r[0] - 1 && x <= r[2] + 1 && y >= r[1] - 1 && y <= r[3] + 1) return a;
  }
  return null;
}

function setHover(id) {
  if (id === A.hoverId) return;
  if (A.hoverId) document.querySelectorAll(`.an[data-id="${A.hoverId}"]`).forEach((n) => n.classList.remove('is-hover'));
  A.hoverId = id;
  if (id) document.querySelectorAll(`.an[data-id="${id}"]`).forEach((n) => n.classList.add('is-hover'));
  viewer.classList.toggle('hover-annot', !!id);
}

let hoverRaf = 0;
viewer.addEventListener('pointermove', (e) => {
  if (hoverRaf || e.buttons) return;
  const { clientX, clientY, target } = e;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const o = A.tool === 'select' && !A.op && !A.editing ? hitObject(clientX, clientY, target) : null;
    const f = !o && A.tool === 'select' && !A.op && !A.editing ? hitForeign(clientX, clientY, target) : null;
    viewer.dataset.hover = o ? 'move' : f ? 'pick' : '';
    setForeignHover(f ? f.id : null);
    if (A.tool === 'erase' && !A.op) eraseHover(clientX, clientY, target);
    const a = o || A.tool === 'note' || A.tool === 'pan' || document.body.classList.contains('space-pan') ? null : hitTest(clientX, clientY, target);
    setHover(a ? a.id : null);
  });
}, { passive: true });
viewer.addEventListener('pointerleave', () => setHover(null));

/* ---------------------------------------------------------------------
   Reading the text selection
   --------------------------------------------------------------------- */
function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!viewer.contains(range.commonAncestorContainer)) return null;
  const groups = [];
  for (const p of S.pages) {
    if (!p.rendered || !p.page || !range.intersectsNode(p.textLayerDiv)) continue;
    const pr = p.div.getBoundingClientRect();
    const raw = []; let text = '', prevTop = null;
    for (const span of p.textLayerDiv.querySelectorAll('span:not(.markedContent)')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== 3 || !range.intersectsNode(span)) continue;
      const so = node === range.startContainer ? range.startOffset : 0;
      const eo = node === range.endContainer ? range.endOffset : node.length;
      if (eo <= so) continue;
      const sub = document.createRange(); sub.setStart(node, so); sub.setEnd(node, eo);
      let top = null;
      for (const cr of sub.getClientRects()) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;
        raw.push({ l: cr.left - pr.left, t: cr.top - pr.top, r: cr.right - pr.left, b: cr.bottom - pr.top });
        top ??= cr.top;
      }
      if (top === null) continue;
      const piece = node.data.slice(so, eo);
      if (prevTop !== null && Math.abs(top - prevTop) > 4 && text && !/\s$/.test(text) && !/^\s/.test(piece)) text += ' ';
      text += piece; prevTop = top;
    }
    if (raw.length) groups.push({ p, raw, pw: pr.width, ph: pr.height, text: text.replace(/\s+/g, ' ').trim() });
  }
  return groups.length ? groups : null;
}

function mergeLines(raw) {
  const lines = [];
  for (const r of raw.slice().sort((a, b) => a.t - b.t || a.l - b.l)) {
    const h = r.b - r.t;
    const line = lines.find((L) => Math.min(L.b, r.b) - Math.max(L.t, r.t) > 0.5 * Math.min(L.b - L.t, h));
    if (line) { line.items.push(r); line.t = Math.min(line.t, r.t); line.b = Math.max(line.b, r.b); }
    else lines.push({ t: r.t, b: r.b, items: [r] });
  }
  const out = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.l - b.l);
    let cur = null;
    for (const r of L.items) {
      if (cur && r.l - cur.r <= (L.b - L.t) * 0.9) cur.r = Math.max(cur.r, r.r);
      else { cur = { l: r.l, r: r.r, t: L.t, b: L.b }; out.push(cur); }
    }
  }
  return out;
}

function groupToPdfRects(g) {
  const vp = vp1(g.p), sx = vp.width / g.pw, sy = vp.height / g.ph;
  return mergeLines(g.raw).map((m) => {
    const [x1, y1] = vp.convertToPdfPoint(m.l * sx, m.t * sy), [x2, y2] = vp.convertToPdfPoint(m.r * sx, m.b * sy);
    return [r2(Math.min(x1, x2)), r2(Math.min(y1, y2)), r2(Math.max(x1, x2)), r2(Math.max(y1, y2))];
  }).filter((r) => r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5);
}

/* ---------------------------------------------------------------------
   Creating comments
   --------------------------------------------------------------------- */
function canEdit(showMessage = true) {
  if (!A.encrypted) return true;
  if (showMessage) toast('This PDF is password protected, so comments can’t be added to it.', 'error');
  return false;
}

async function ensureAuthor() {
  if (A.author) return true;
  const v = await modal({
    title: 'Your name', icon: 'i-user', ok: 'Continue', input: true, inputType: 'text', placeholder: 'For example: Ali Al-Sabah',
    body: 'Your name is shown on your comments and saved in the PDF, so colleagues can see who wrote them.'
  });
  const name = (v || '').trim();
  if (!name) return false;
  setAuthor(name); return true;
}
function setAuthor(name) { A.author = name.slice(0, 60); LS.set('hx-author', A.author); updateAuthorLabel(); }
function updateAuthorLabel() { $('authorLabel').textContent = A.author ? A.author : 'Set your name'; }

async function markSelection(type, { comment = false } = {}) {
  const groups = readSelection();
  if (!groups || !canEdit()) return;
  const data = groups.map((g) => ({ page: g.p.num, rects: groupToPdfRects(g), quote: g.text.slice(0, 600) })).filter((d) => d.rects.length);
  if (!data.length) return;
  window.getSelection().removeAllRanges(); hideSelbar();
  if (!(await ensureAuthor())) return;
  pushHistory();
  const created = data.map((d) => {
    const a = { id: uid(), type, page: d.page, color: A.color, rects: d.rects, quote: d.quote, text: '', author: A.author, created: nowISO(), modified: nowISO(), replies: [] };
    A.items.push(a); return a;
  });
  afterChange(created.map((a) => a.page));
  if (comment) openPop(created[0].id, { focus: 'text' });
}

async function placeNote(cx, cy, target) {
  const pageEl = target?.closest?.('.page'); if (!pageEl) return;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page || !canEdit()) return;
  const vp = vp1(p), pr = pageEl.getBoundingClientRect();
  const x = clampN(((cx - pr.left) / pr.width) * vp.width, 0, vp.width - NOTE_SIZE);
  const y = clampN(((cy - pr.top) / pr.height) * vp.height, 0, vp.height - NOTE_SIZE);
  const [ax, ay] = vp.convertToPdfPoint(x, y), [bx, by] = vp.convertToPdfPoint(x + NOTE_SIZE, y + NOTE_SIZE);
  const rect = [r2(Math.min(ax, bx)), r2(Math.min(ay, by)), r2(Math.max(ax, bx)), r2(Math.max(ay, by))];
  if (!(await ensureAuthor())) return;
  pushHistory();
  const a = { id: uid(), type: 'note', page: p.num, color: A.color, rects: [rect], quote: '', text: '', author: A.author, created: nowISO(), modified: nowISO(), replies: [] };
  A.items.push(a); A.pendingNew = a.id;
  if (!A.lock) setTool('select');
  afterChange([p.num]);
  openPop(a.id, { focus: 'text' });
}
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------------
   Tools, colours, ribbon
   --------------------------------------------------------------------- */
function setTool(t, force) {
  A.lock = false;
  A.tool = !force && A.tool === t && t !== 'select' && t !== 'osel' ? (A.mode === 'edit' ? 'osel' : 'select') : t;
  document.body.dataset.tool = A.tool;
  document.querySelectorAll('.rb-tool').forEach((b) => { const on = b.dataset.tool === A.tool; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
  { const pb = $('panBtn'); if (pb) pb.setAttribute('aria-pressed', A.tool === 'pan'); }
  updateHint();
  if (A.tool !== 'select') { hideSelbar(); selectObj(null); clearForeignSel(); closeMenu(); }
  if (A.tool !== 'erase' && A.preview.size) setPreview(new Set());
  if (A.editing) endTextEdit();
  syncSwatches(); refreshObjbar(); syncLockUI();
  if (A.mode === 'edit') edSyncUI();
}
function updateHint() {
  $('rbHint').textContent = A.encrypted ? 'Password-protected PDFs can’t be commented on.' : TOOL_HINT[A.tool] + (A.lock ? ' · tool stays on, press Esc to stop' : '');
  $('rbHint').title = $('rbHint').textContent;
}
function setColor(key) {
  const sel = A.sel && findAnn(A.sel);
  if (sel && isObj(sel) && sel.type !== 'signature' && sel.color !== key) {
    pushHistory(); sel.color = key; sel.modified = nowISO(); afterChange([sel.page]); refreshObjbar();
  }
  if (objContext()) { A.drawColor = key; LS.set('hx-dcolor', key); } else { A.color = key; LS.set('hx-color', key); }
  syncSwatches();
}
function buildSwatches(box, onPick, current) {
  box.replaceChildren(...Object.entries(COLORS).map(([key, c]) => {
    const b = el('button', 'sw', { type: 'button', title: c.label });
    b.dataset.color = key; b.style.setProperty('--c', c.fill); b.style.setProperty('--l', c.line);
    b.setAttribute('role', 'radio'); b.setAttribute('aria-label', c.label); b.setAttribute('aria-checked', key === current);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onPick(key));
    return b;
  }));
}
function updateRibbon() {
  document.querySelectorAll('.rb-tool').forEach((b) => { if (b.dataset.tool !== 'select' && b.dataset.tool !== 'pan') b.disabled = A.encrypted; });
  document.querySelectorAll('.rb-m[data-mode="edit"]').forEach((b) => { b.disabled = A.encrypted; });
  updateHint(); updateAuthorLabel();
  $('ribbon').classList.toggle('is-closed', !A.ribbonOpen);
  document.body.classList.toggle('ribbon-open', A.ribbonOpen);
  $('annotBtn').setAttribute('aria-pressed', A.ribbonOpen);
}

buildSwatches($('rbSwatches'), (k) => setColor(k), A.color);
buildSwatches($('sbSwatches'), (k) => setColor(k), A.color);

document.querySelectorAll('.rb-tool').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault());           // keep the text selection
  b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (['highlight', 'underline', 'strike'].includes(t) && readSelection()) { markSelection(t); return; }
    if (t === 'addimg') { edAddImage(); return; }
    if (t === 'stamp' || t === 'sign') { if (canEdit()) (t === 'stamp' ? openStampMenu : openSignMenu)(b); return; }
    if (t !== 'select' && t !== 'pan' && !canEdit()) return;
    setTool(t, t === 'osel');
  });
});
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('panBtn').addEventListener('click', () => setTool('pan'));
$('annotBtn').addEventListener('click', () => { A.ribbonOpen = !A.ribbonOpen; LS.set('hx-ribbon', A.ribbonOpen ? '1' : '0'); updateRibbon(); });
$('ribbonSaveBtn').addEventListener('click', () => saveDocument());
$('saveAsBtn').addEventListener('click', () => saveDocument({ as: true }));
$('authorBtn').addEventListener('click', async () => {
  const v = await modal({ title: 'Your name', icon: 'i-user', ok: 'Save', input: true, inputType: 'text', value: A.author, placeholder: 'For example: Ali Al-Sabah', body: 'Shown on the comments you add from now on.' });
  if (v && v.trim()) setAuthor(v.trim());
});
$('cmFilter').addEventListener('change', (e) => { A.filter = e.target.value; renderComments(true); });

/* ---------------------------------------------------------------------
   Selection bar
   --------------------------------------------------------------------- */
function hideSelbar() { $('selbar').hidden = true; }
function showSelbar() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || A.tool !== 'select' || A.encrypted) return hideSelbar();
  const range = sel.getRangeAt(0);
  if (!viewer.contains(range.commonAncestorContainer) || !readSelection()) return hideSelbar();
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return hideSelbar();
  const bar = $('selbar'), first = rects[0], last = rects[rects.length - 1], vr = viewer.getBoundingClientRect();
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight;
  let y = first.top - h - 10; if (y < vr.top + 6) y = last.bottom + 10;
  const x = clampN(first.left + first.width / 2 - w / 2, 8, innerWidth - w - 8);
  bar.style.left = `${Math.round(x)}px`; bar.style.top = `${Math.round(clampN(y, 8, innerHeight - h - 8))}px`;
}
$('selbar').addEventListener('mousedown', (e) => e.preventDefault());
$('selbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'comment') markSelection('highlight', { comment: true }); else markSelection(act);
});
document.addEventListener('selectionchange', () => { const s = window.getSelection(); if (!s || s.isCollapsed) hideSelbar(); });

/* ---------------------------------------------------------------------
   Pointer gestures on the pages
   --------------------------------------------------------------------- */
let downAt = null;
viewer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (objPointerDown(e)) return;
  if (A.sel) selectObj(null);
  if (A.fsel.size) clearForeignSel();
  downAt = { x: e.clientX, y: e.clientY };
  hideSelbar();
});
viewer.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !downAt) return;
  const d = downAt; downAt = null;
  const target = e.target, cx = e.clientX, cy = e.clientY;
  const moved = Math.hypot(cx - d.x, cy - d.y) > 4;
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && readSelection()) {                       // the user selected text
      if (['highlight', 'underline', 'strike'].includes(A.tool)) markSelection(A.tool); else showSelbar();
      return;
    }
    if (moved || A.mode === 'edit') return;                                 // a drag that selected nothing
    if (target.closest?.('.link-layer a, .an-note')) return;
    if (A.tool === 'note') { placeNote(cx, cy, target); return; }
    if (A.tool === 'stamp' || A.tool === 'sign') { placeImageObject(A.tool === 'stamp' ? 'stamp' : 'signature', cx, cy, target, e.shiftKey); return; }
    const hit = hitTest(cx, cy, target);
    if (hit) openPop(hit.id);
  }, 0);
});
viewer.addEventListener('scroll', () => { hideSelbar(); repositionPop(); }, { passive: true });
window.addEventListener('resize', () => { hideSelbar(); repositionPop(); });
document.addEventListener('pointerdown', (e) => {                            // click elsewhere closes the card
  if (!A.openId) return;
  if (e.target.closest('#pop, .an-note, #selbar, .modal-backdrop')) return;
  closePop();
}, true);

/* ---------------------------------------------------------------------
   Comment card (popover)
   --------------------------------------------------------------------- */
const iconButton = (icon, label, cls, onClick) => {
  const b = el('button', cls, { type: 'button', title: label, innerHTML: `<svg><use href="#${icon}"/></svg>` });
  b.setAttribute('aria-label', label); b.addEventListener('click', onClick); return b;
};
const autosize = (ta, max = 240) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, max)}px`; };

function openPop(id, { focus = '' } = {}) {
  if (!findAnn(id)) return;
  if (A.openId && A.openId !== id) closePop(true);
  A.openId = id;
  renderPop(focus);
  setActive(id);
}

function renderPop(focus = '') {
  const a = findAnn(A.openId), pop = $('pop');
  if (!a) { closePop(true); return; }
  const col = colorOf(a);
  pop.style.setProperty('--c', col.fill); pop.style.setProperty('--l', col.line);
  pop.style.visibility = 'hidden'; pop.hidden = false;
  const keepText = pop.querySelector('.pop-text'); const hadFocus = keepText && document.activeElement === keepText;
  const caret = hadFocus ? keepText.selectionStart : null;
  pop.replaceChildren();

  const head = el('div', 'pop-head');
  head.append(
    el('div', 'pop-dot', { innerHTML: `<svg><use href="#${TYPE_ICON[a.type]}"/></svg>` }),
    (() => { const w = el('div', 'pop-who'); w.append(el('b', '', { textContent: a.author || 'Unknown', dir: 'auto' }), el('small', '', { textContent: `${TYPE_LABEL[a.type]} · ${timeAgo(Date.parse(a.created))}` })); return w; })(),
    iconButton('i-x', 'Close', 'icon-btn sm', () => closePop())
  );
  pop.append(head);
  if (a.quote) pop.append(el('blockquote', 'pop-quote', { textContent: a.quote, dir: 'auto' }));

  const ta = el('textarea', 'pop-text', { placeholder: a.type === 'note' ? 'Write a note…' : 'Add a comment…', value: a.text, dir: 'auto', rows: 3 });
  ta.setAttribute('aria-label', 'Comment text');
  ta.addEventListener('input', () => {
    pushHistory(`t:${a.id}`); a.text = ta.value; a.modified = nowISO();
    autosize(ta); refreshState(); softRefresh(a); repositionPop();
  });
  pop.append(ta);

  const colors = el('div', 'pop-colors'); colors.append(el('span', '', { textContent: 'Colour' }));
  const sw = el('div', 'rb-group swatches'); sw.style.padding = '0'; sw.style.border = '0';
  buildSwatches(sw, (key) => {
    if (a.color === key) return;
    pushHistory(); a.color = key; a.modified = nowISO();
    if (isObj(a)) { A.drawColor = key; LS.set('hx-dcolor', key); } else { A.color = key; LS.set('hx-color', key); }
    syncSwatches();
    drawAnnots(S.pages[a.page - 1]); renderCommentsSoon(); refreshState(); renderPop();
  }, a.color);
  colors.append(sw); pop.append(colors);

  const replies = el('div', 'pop-replies');
  for (const r of a.replies) {
    const row = el('div', 'rep');
    const top = el('div', 'rep-top'); top.append(el('b', '', { textContent: r.author || 'Unknown', dir: 'auto' }), el('span', '', { textContent: timeAgo(Date.parse(r.created)) }));
    row.append(top, el('p', '', { textContent: r.text, dir: 'auto' }),
      iconButton('i-x', 'Delete this reply', 'icon-btn sm rep-x', () => {
        pushHistory(); a.replies = a.replies.filter((x) => x.id !== r.id); a.modified = nowISO();
        afterChange([a.page]); renderPop();
      }));
    replies.append(row);
  }
  pop.append(replies);

  const compose = el('div', 'pop-reply');
  const rta = el('textarea', '', { placeholder: 'Reply…', rows: 1, dir: 'auto' }); rta.setAttribute('aria-label', 'Reply');
  const send = el('button', 'primary', { type: 'button', textContent: 'Reply', disabled: true });
  const submit = async () => {
    const t = rta.value.trim(); if (!t || !(await ensureAuthor())) return;
    pushHistory(); a.replies.push({ id: uid(), author: A.author, text: t, created: nowISO() }); a.modified = nowISO();
    afterChange([a.page]); renderPop('reply');
  };
  rta.addEventListener('input', () => { send.disabled = !rta.value.trim(); autosize(rta, 120); repositionPop(); });
  rta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
  send.addEventListener('click', submit);
  compose.append(rta, send); pop.append(compose);

  const foot = el('div', 'pop-foot');
  const del = el('button', 'pop-del', { type: 'button', innerHTML: '<svg><use href="#i-trash"/></svg>Delete' });
  del.addEventListener('click', () => {
    pushHistory(); A.items = A.items.filter((x) => x.id !== a.id); if (A.pendingNew === a.id) A.pendingNew = null;
    closePop(true); afterChange([a.page]);
  });
  foot.append(el('span', '', { textContent: 'Ctrl+Enter sends a reply' }), del);
  pop.append(foot);

  autosize(ta); repositionPop();
  if (focus === 'text' || (hadFocus && !focus)) { ta.focus(); const n = caret ?? ta.value.length; ta.setSelectionRange(n, n); }
  else if (focus === 'reply') rta.focus();
}

function anchorRect(a) {
  const els = [...document.querySelectorAll(`.an[data-id="${a.id}"]`)].filter((n) => !n.classList.contains('an-flag'));
  if (!els.length) return null;
  let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const n of els) { const q = n.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
  return { left: l, top: t, right: r, bottom: b };
}

function repositionPop() {
  const pop = $('pop');
  if (!A.openId || pop.hidden) return;
  const a = findAnn(A.openId); if (!a) return;
  const r = anchorRect(a), vr = viewer.getBoundingClientRect();
  if (!r) { pop.style.visibility = 'hidden'; return; }
  const inView = r.bottom > vr.top + 4 && r.top < vr.bottom - 4 && r.right > vr.left && r.left < vr.right;
  pop.style.visibility = inView ? 'visible' : 'hidden';
  if (!inView) return;
  const pg = S.pages[a.page - 1].div.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight, m = 10;
  let x, y;
  if (pg.right + 14 + w <= innerWidth - m) x = pg.right + 14;             // beside the page, like a margin note
  else if (pg.left - 14 - w >= m) x = pg.left - 14 - w;
  else { x = clampN(r.left, m, innerWidth - w - m); y = r.bottom + 10; if (y + h > innerHeight - m) y = r.top - h - 10; }
  if (y === undefined) y = r.top - 12;
  y = clampN(y, Math.max(vr.top, m), Math.max(m, innerHeight - h - m));
  pop.style.left = `${Math.round(x)}px`; pop.style.top = `${Math.round(y)}px`;
}

function closePop(silent = false) {
  const id = A.openId; if (!id) return;
  const a = findAnn(id);
  A.openId = null;
  const pop = $('pop'); pop.hidden = true; pop.replaceChildren();
  setActive(null);
  if (a && a.type === 'note' && !a.text.trim() && !a.replies.length) {     // an empty note is just clutter
    if (A.pendingNew === id && A.undo.length) { A.undo.pop(); A.hkey = ''; }
    A.items = A.items.filter((x) => x.id !== id);
    afterChange([a.page]);
  } else if (a) { drawAnnots(S.pages[a.page - 1]); }
  if (A.pendingNew === id) A.pendingNew = null;
  refreshState(); renderCommentsSoon();
}

let softTimer = 0;
function softRefresh(a) {
  clearTimeout(softTimer);
  softTimer = setTimeout(() => { const p = S.pages[a.page - 1]; if (p) drawAnnots(p); renderComments(); }, 250);
}

/* ---------------------------------------------------------------------
   Going to a comment
   --------------------------------------------------------------------- */
function scrollToPdfRect(p, rect) {
  const page = p.page, z = S.zoom * CSS_UNITS;
  const vp = page.getViewport({ scale: z, rotation: (page.rotate + S.rotation) % 360 });
  const r = vp.convertToViewportRectangle(rect);
  const top = Math.min(r[1], r[3]), left = Math.min(r[0], r[2]), w = Math.abs(r[2] - r[0]);
  computeTops();
  viewer.scrollTop = Math.max(0, p.top + top - viewer.clientHeight * 0.3);
  const x = p.div.offsetLeft + left;
  if (x < viewer.scrollLeft + 20 || x + w > viewer.scrollLeft + viewer.clientWidth - 20) viewer.scrollLeft = Math.max(0, x - viewer.clientWidth * 0.25);
}

async function waitRendered(p, ms = 4000) {
  const t0 = performance.now(); scheduleRender(0);
  while (performance.now() - t0 < ms) {
    if (p.rendered && p.renderedKey === renderKey()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

async function focusAnnotation(id) {
  const a = findAnn(id); if (!a) return;
  const p = S.pages[a.page - 1]; await getPage(p);
  closePop(true);
  scrollToPdfRect(p, unionRect(a.rects).slice(0, 4));
  await waitRendered(p);
  if (isObj(a) && !DRAWINGS.includes(a.type)) selectObj(id); else openPop(id);
  flashAnnot(id);
}

async function spotlightForeign(f) {
  const p = S.pages[f.page - 1]; await getPage(p);
  if (f.rect) scrollToPdfRect(p, f.rect); else goToPage(f.page);
  await waitRendered(p);
  if (!f.rect) return;
  const vp = vp1(p), b = boxOf(vp, f.rect);
  const d = el('div', 'an an-spot');
  d.style.cssText = `left:${(100 * b.x / vp.width).toFixed(3)}%;top:${(100 * b.y / vp.height).toFixed(3)}%;width:${(100 * b.w / vp.width).toFixed(3)}%;height:${(100 * b.h / vp.height).toFixed(3)}%`;
  p.annotLayer.append(d); setTimeout(() => d.remove(), 2000);
}

/* ---------------------------------------------------------------------
   Comments list (sidebar)
   --------------------------------------------------------------------- */
let cmTimer = 0;
function renderCommentsSoon() { clearTimeout(cmTimer); cmTimer = setTimeout(() => renderComments(), 200); updateBadge(); }
function updateBadge() {
  const n = A.items.filter(listed).length + visForeign().length, b = $('commentsBadge');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
}
const sortKey = (a) => a.rects[0] || [0, 0, 0, 0];
const DRAWINGS = ['rect', 'ellipse', 'cloud', 'arrow', 'line', 'ink'];
const listed = (a) => a.type !== 'stamp' && a.type !== 'signature' && (!DRAWINGS.includes(a.type) || hasComment(a));
const passFilter = (a) => listed(a) && (A.filter === 'all' || (A.filter === 'withcomment' ? hasComment(a) || a.type === 'text' : A.filter === 'textbox' ? a.type === 'text' : A.filter === 'drawing' ? DRAWINGS.includes(a.type) : a.type === A.filter));

function commentCard(a) {
  const col = colorOf(a);
  const b = el('button', 'cm', { type: 'button' });
  b.dataset.id = a.id; b.style.setProperty('--c', col.fill); b.style.setProperty('--l', col.line);
  if (a.id === A.openId) b.classList.add('active');
  const top = el('div', 'cm-top', { innerHTML: `<svg><use href="#${TYPE_ICON[a.type]}"/></svg>` });
  top.append(el('b', '', { textContent: a.author || 'Unknown', dir: 'auto' }), el('span', '', { textContent: timeAgo(Date.parse(a.created)) }));
  b.append(top);
  if (a.quote) b.append(el('p', 'cm-quote', { textContent: `“${a.quote}”`, dir: 'auto' }));
  if (a.text.trim()) b.append(el('p', 'cm-text', { textContent: a.text, dir: 'auto' }));
  else if (a.type === 'note') b.append(el('p', 'cm-quote', { textContent: 'Empty note' }));
  if (a.replies.length) b.append(el('div', 'cm-replies', { textContent: `${a.replies.length} ${a.replies.length === 1 ? 'reply' : 'replies'}` }));
  b.addEventListener('click', () => focusAnnotation(a.id));
  return b;
}

function renderComments(force) {
  updateBadge();
  if (!force && !$('paneComments').classList.contains('active')) return;
  const box = $('comments'), frag = document.createDocumentFragment();
  const mine = A.items.filter(passFilter).sort((a, b) => a.page - b.page || sortKey(b)[3] - sortKey(a)[3] || sortKey(a)[0] - sortKey(b)[0]);
  if (!A.items.some(listed) && !visForeign().length) {
    frag.append(el('div', 'empty', { textContent: 'No comments yet. Select text to highlight it, or use the sticky note tool.' }));
  } else {
    let last = 0;
    for (const a of mine) {
      if (a.page !== last) { last = a.page; frag.append(el('div', 'cm-page', { textContent: `Page ${a.page}` })); }
      frag.append(commentCard(a));
    }
    if (!mine.length && A.items.some(listed)) frag.append(el('div', 'empty', { textContent: 'No comments match this filter.' }));
    if (A.filter === 'all' || A.filter === 'withcomment') renderExistingSection(frag, A.filter === 'withcomment');
  }
  box.replaceChildren(frag);
}

/* Export the comments list (opens in Excel; written as UTF-8 so Arabic stays readable) */
function exportComments() {
  const fmt = (iso) => { if (!iso) return ''; const d = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const rows = [['Page', 'Type', 'Author', 'Date', 'Comment', 'Selected text', 'Replies', 'Source']];
  const mine = A.items.filter(listed).sort((a, b) => a.page - b.page || sortKey(b)[3] - sortKey(a)[3] || sortKey(a)[0] - sortKey(b)[0]);
  for (const a of mine) rows.push([a.page, TYPE_LABEL[a.type], a.author, fmt(a.created), a.text, a.quote, a.replies.map((r) => `${r.author}: ${r.text}`).join(' | '), 'Added in this viewer']);
  for (const f of visForeign()) rows.push([f.page, FOREIGN_LABEL[f.type] || f.type, f.author, fmt(f.created), f.text, '', (f.replies || []).map((r) => `${r.author}: ${r.text}`).join(' | '), 'Original file']);
  if (rows.length === 1) { toast('There are no comments to export yet.'); return; }
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };   // stops spreadsheet formulas from running
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = el('a', '', { href: url, download: `${(S.name || 'document').replace(/\.pdf$/i, '')} - comments.csv` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Exported ${rows.length - 1} ${rows.length === 2 ? 'comment' : 'comments'}.`, 'success');
}
$('cmExport').addEventListener('click', exportComments);

/* Comments made in other apps (read-only) */
const parsePdfDate = (s) => {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{0,2}'?)?/.exec(s || '');
  if (!m) return null;
  let off = 0;
  if (m[7] && m[7] !== 'Z') { const t = /([+-])(\d{2})'?(\d{2})?/.exec(m[7]); off = (t[1] === '-' ? -1 : 1) * (+t[2] * 60 + +(t[3] || 0)); }
  const ms = Date.UTC(+m[1], +(m[2] || 1) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - off * 60000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const FOREIGN_TYPES = new Set(['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'FreeText', 'Caret', 'Stamp', 'Ink', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'FileAttachment']);

/* ---------------------------------------------------------------------
   PDF writer / reader (pdf-lib, loaded the first time it is needed)
   --------------------------------------------------------------------- */
let pdfLibPromise = null;
function loadPdfLib() {
  pdfLibPromise ??= (async () => {
    const url = await unpack('pdflib-src');
    await new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = url; s.onload = res;
      s.onerror = () => rej(new Error('Could not load the PDF writer.')); document.head.append(s);
    });
    return window.PDFLib;
  })();
  return pdfLibPromise;
}

function hasBytes(bytes, str) {
  const n = [...str].map((c) => c.charCodeAt(0));
  let i = -1;
  while ((i = bytes.indexOf(n[0], i + 1)) !== -1) {
    let ok = true;
    for (let k = 1; k < n.length; k++) if (bytes[i + k] !== n[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/* pdf-lib pauses between small batches of objects to keep pages responsive; that makes big files
   take ~50x longer. These options process everything in one go (a few hundred milliseconds). */
const loadOpts = (PL) => ({ updateMetadata: false, parseSpeed: PL.ParseSpeeds.Fastest });
const SAVE_OPTS = { useObjectStreams: false, objectsPerTick: Infinity };

const toPdfDate = (iso) => {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
const hexRgb = (hex) => [1, 3, 5].map((i) => r2(parseInt(hex.slice(i, i + 2), 16) / 255));

/* Write the comments into a loaded pdf-lib document. */
async function writeAnnotations(doc, PL, items, assets = new Map()) {
  const { PDFString, PDFHexString } = PL;
  const ctx = doc.context, pages = doc.getPages();
  const T = (s) => PDFHexString.fromText(s || '');
  const S_ = (s) => PDFString.of(s);
  const form = (bbox, content, blend, res = null) => ctx.register(ctx.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: bbox,
    Resources: res || (blend ? { ExtGState: { GS: { Type: 'ExtGState', BM: 'Multiply' } } } : {})
  }));

  for (const a of items) {
    const page = pages[a.page - 1]; if (!page) continue;
    if (isObj(a)) { await writeObjectAnnot(a, { ctx, PL, doc, page, assets, T, S_, form }); continue; }
    const col = COLORS[a.color] || COLORS.yellow;
    let rect, quad = null, ap, subtype, C, F = 4, extra = {};

    if (a.type === 'note') {
      rect = a.rects[0]; subtype = 'Text'; C = hexRgb(col.fill); F = 28; extra = { Name: 'Comment', Open: false };
      const [x, y] = rect, f = hexRgb(col.fill).join(' ');
      ap = form([...rect], [
        'q', `${f} rg`, '0.23 0.19 0.29 RG', '1 w',
        `${r2(x + 1)} ${r2(y + 5)} 18 13 re B`,
        `${r2(x + 4)} ${r2(y + 5)} m ${r2(x + 4)} ${r2(y + 1)} l ${r2(x + 9)} ${r2(y + 5)} l h B`,
        `${r2(x + 4)} ${r2(y + 14)} m ${r2(x + 16)} ${r2(y + 14)} l S`,
        `${r2(x + 4)} ${r2(y + 10.5)} m ${r2(x + 12)} ${r2(y + 10.5)} l S`, 'Q'
      ].join('\n'));
    } else {
      rect = unionRect(a.rects);
      quad = a.rects.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);   // Acrobat's corner order
      if (a.type === 'highlight') {
        subtype = 'Highlight'; C = hexRgb(col.fill);
        ap = form([...rect], ['/GS gs', `${C.join(' ')} rg`, ...a.rects.map(([x1, y1, x2, y2]) => `${x1} ${y1} ${r2(x2 - x1)} ${r2(y2 - y1)} re f`)].join('\n'), true);
      } else {
        subtype = a.type === 'underline' ? 'Underline' : 'StrikeOut'; C = hexRgb(col.line);
        ap = form([...rect], [`${C.join(' ')} RG`, ...a.rects.flatMap((r) => {
          const th = r2(lineThickness(r));
          const y = a.type === 'underline' ? r2(r[1] + 1.4 * th) : r2((r[1] + r[3]) / 2);
          return [`${th} w`, `${r[0]} ${y} m ${r[2]} ${y} l S`];
        })].join('\n'));
      }
    }

    const dict = {
      Type: 'Annot', Subtype: subtype, Rect: rect.map(r2), C, F, T: T(a.author), Contents: T(a.text),
      M: S_(toPdfDate(a.modified)), CreationDate: S_(toPdfDate(a.created)), NM: S_(a.id), Subj: T(TYPE_LABEL[a.type]),
      HXColor: S_(a.color), AP: { N: ap }, ...extra
    };
    if (quad) dict.QuadPoints = quad;
    if (a.quote) dict.HXQuote = T(a.quote);
    const ref = ctx.register(ctx.obj(dict));
    page.node.addAnnot(ref);

    for (const r of a.replies) {                         // replies are standard "Text" annotations that point at their parent
      const rr = a.type === 'note' ? rect : [rect[0], r2(a.rects[0][3] - 1), r2(rect[0] + 1), a.rects[0][3]];
      const rap = form([0, 0, 1, 1], '');
      page.node.addAnnot(ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Text', Rect: rr.map(r2), IRT: ref, RT: 'R', Name: 'Comment', C: hexRgb(col.fill), F: 28,
        T: T(r.author), Contents: T(r.text), M: S_(toPdfDate(r.created)), CreationDate: S_(toPdfDate(r.created)),
        NM: S_(r.id), Subj: T('Reply'), AP: { N: rap }
      })));
    }
  }
}

/* Lift Heurix comments out of a loaded pdf-lib document (and remove them from it). */
function extractHeurix(doc, PL) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = PL;
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const text = (v) => { try { return v && v.decodeText ? v.decodeText() : ''; } catch { return ''; } };
  const nums = (arr) => { const o = []; if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) { const n = arr.lookup(i); if (n instanceof PDFNumber) o.push(n.asNumber()); } return o; };
  const nearest = (c) => {
    if (!c || c.length !== 3) return 'yellow';
    let best = 'yellow', bd = 1e9;
    for (const [k, v] of Object.entries(COLORS)) for (const hex of [v.fill, v.line]) {
      const [r, g, b] = hexRgb(hex), d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };
  const found = new Map(), replies = [], all = [];

  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots(); if (!annots) return;
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i); let d;
      try { d = annots.lookup(i, PDFDict); } catch { keep.push(raw); continue; }
      const nm = text(d.lookup(N('NM')));
      if (!nm.startsWith('heurix-')) { keep.push(raw); continue; }
      const sub = text(d.lookup(N('Subtype')));
      const author = text(d.lookup(N('T'))), contents = text(d.lookup(N('Contents')));
      const created = parsePdfDate(text(d.lookup(N('CreationDate')))) || parsePdfDate(text(d.lookup(N('M')))) || nowISO();
      const modified = parsePdfDate(text(d.lookup(N('M')))) || created;
      const irt = d.get(N('IRT'));
      let handled = false;

      if (irt instanceof PDFRef) { replies.push({ parent: irt.toString(), r: { id: nm, author, text: contents, created } }); handled = true; }
      else if (text(d.lookup(N('HXType')))) {
        const it = readObjectAnnot(d, N, text, PL, { id: nm, page: pi + 1, author, text: contents, created, modified });
        if (it) { if (raw instanceof PDFRef) found.set(raw.toString(), it); all.push(it); handled = true; }
      } else if (sub === 'Highlight' || sub === 'Underline' || sub === 'StrikeOut') {
        const q = nums(d.lookup(N('QuadPoints'))), rects = [];
        for (let k = 0; k + 7 < q.length; k += 8) {
          const xs = [q[k], q[k + 2], q[k + 4], q[k + 6]], ys = [q[k + 1], q[k + 3], q[k + 5], q[k + 7]];
          rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
        if (!rects.length) { const rc = nums(d.lookup(N('Rect'))); if (rc.length === 4) rects.push(rc); }
        if (rects.length) {
          const hx = text(d.lookup(N('HXColor')));
          const item = { id: nm, type: sub === 'Highlight' ? 'highlight' : sub === 'Underline' ? 'underline' : 'strike', page: pi + 1, rects,
            color: COLORS[hx] ? hx : nearest(nums(d.lookup(N('C')))), quote: text(d.lookup(N('HXQuote'))), text: contents, author, created, modified, replies: [] };
          if (raw instanceof PDFRef) found.set(raw.toString(), item);
          all.push(item); handled = true;
        }
      } else if (sub === 'Text') {
        const rc = nums(d.lookup(N('Rect')));
        if (rc.length === 4) {
          const hx = text(d.lookup(N('HXColor')));
          const item = { id: nm, type: 'note', page: pi + 1, rects: [rc], color: COLORS[hx] ? hx : nearest(nums(d.lookup(N('C')))), quote: '', text: contents, author, created, modified, replies: [] };
          if (raw instanceof PDFRef) found.set(raw.toString(), item);
          all.push(item); handled = true;
        }
      }

      if (!handled) { keep.push(raw); continue; }
      dropObjectRefs(d, ctx, PL);
      try {                                             // drop the annotation and its appearance from the document
        const ap = d.lookup(N('AP'), PDFDict), nref = ap && ap.get(N('N'));
        if (nref instanceof PDFRef) ctx.delete(nref);
      } catch { /* no appearance */ }
      if (raw instanceof PDFRef) ctx.delete(raw);
    }
    if (keep.length !== annots.size()) {
      if (keep.length) page.node.set(N('Annots'), ctx.obj(keep)); else page.node.delete(N('Annots'));
    }
  });

  for (const { parent, r } of replies) found.get(parent)?.replies.push(r);
  const items = all;
  items.forEach((it) => it.replies.sort((a, b) => a.created.localeCompare(b.created)));
  return items.sort((a, b) => a.created.localeCompare(b.created));
}

/* Called while a document opens: restore the comments Heurix saved earlier. */
async function annotPrepare(original) {
  const res = { bytes: original, items: [], encrypted: false, checkEncrypted: false };
  try {
    if (hasBytes(original, 'heurix-') && original.length < 150 * 1024 * 1024) {
      const PL = await loadPdfLib();
      const doc = await PL.PDFDocument.load(original, loadOpts(PL));
      const items = extractHeurix(doc, PL);
      if (items.length) { res.items = items; res.bytes = await doc.save(SAVE_OPTS); }
    } else if (hasBytes(original, '/Encrypt')) res.checkEncrypted = true;
  } catch (e) {
    if (/encrypt/i.test(e?.name || '') || /encrypt/i.test(e?.message || '')) res.encrypted = true;
    else console.warn('Could not read earlier comments', e);
  }
  return res;
}

async function confirmEncrypted(docId) {
  try {
    const PL = await loadPdfLib();
    await PL.PDFDocument.load(S.bytes, loadOpts(PL));
  } catch (e) {
    if (docId === S.docId && (/encrypt/i.test(e?.name || '') || /encrypt/i.test(e?.message || ''))) { A.encrypted = true; updateRibbon(); }
  }
}

function annotDocOpened(prep) {
  A.items = prep.items; A.savedSnap = snap(); A.undo = []; A.redo = []; A.hkey = ''; A.foreign = [];
  A.encrypted = A.encrypted || prep.encrypted; A.openId = null; A.pendingNew = null;
  setTool('select'); updateRibbon(); refreshState(); renderComments(); updateBadge();
  if (prep.checkEncrypted) confirmEncrypted(S.docId);
}

function annotDocClosed() {
  clearTimeout(softTimer); clearTimeout(cmTimer);
  A.items = []; A.undo = []; A.redo = []; A.hkey = ''; A.foreign = []; A.encrypted = false; A.openId = null; A.pendingNew = null;
  existingDocClosed(); A.savedSnap = snap(); A.dirty = false; A.hoverId = null;
  A.sel = null; A.editing = null; A.op = null; A.draft = null; A.stampSpec = null; A.sigPending = null;
  $('textEdit').hidden = true; hideObjbar(); closeMenu();
  const pop = $('pop'); pop.hidden = true; pop.replaceChildren(); hideSelbar();
  refreshState(); renderComments(); updateBadge();
}

/* ---------------------------------------------------------------------
   Saving and printing
   --------------------------------------------------------------------- */
async function buildAnnotatedBytes() {
  if (A.removed.size || A.applied || edKey() || A.appliedEd) await flushRemovals();       // make sure the removals and edits are in the file
  if (!A.items.length) return S.bytes;
  const PL = await loadPdfLib();
  const doc = await PL.PDFDocument.load(S.bytes, loadOpts(PL));
  await writeAnnotations(doc, PL, A.items, await prepareAssets(A.items));
  return doc.save(SAVE_OPTS);
}

async function openAnnotatedForPrint() {
  const bytes = await buildAnnotatedBytes();
  return pdfjsLib.getDocument({ ...DOC_OPTIONS, data: bytes }).promise;
}

function markSaved() { A.savedSnap = snap(); refreshState(); }

async function writeToHandle(handle, bytes) {
  const w = await handle.createWritable(); await w.write(bytes); await w.close();
}

let saving = false;
async function saveDocument(opts = {}) {
  if (!S.pdf || saving) return false;
  saving = true;
  try { return await saveDocumentNow(opts); } finally { saving = false; }
}

async function saveDocumentNow({ as = false } = {}) {
  if (A.encrypted && (A.items.length || A.removed.size || edHas(A.ed))) { toast('Changes can’t be saved into a password-protected PDF.', 'error'); return false; }
  if (!as && !A.dirty && S.handle) { toast('There are no changes to save.'); return true; }
  let bytes;
  if (A.items.length || edHas(A.ed)) { toast(A.items.length ? 'Saving your comments…' : 'Saving your changes…'); await nextFrame(); }
  try { bytes = await buildAnnotatedBytes(); }
  catch (e) { console.error(e); toast(`Could not save the changes into the PDF: ${e?.message || e}`, 'error'); return false; }
  const base = (S.name || 'document').replace(/\.pdf$/i, '');

  if (!as && S.handle?.createWritable) {                 // save over the file that was opened
    try {
      const opts = { mode: 'readwrite' };
      if ((await S.handle.queryPermission(opts)) !== 'granted' && (await S.handle.requestPermission(opts)) !== 'granted') throw new DOMException('denied', 'NotAllowedError');
      await writeToHandle(S.handle, bytes);
      markSaved(); toast(`Saved ${S.handle.name}`, 'success'); return true;
    } catch (e) { if (e?.name === 'AbortError') return false; console.warn('Could not save over the original; asking where to save', e); }
  }
  if ('showSaveFilePicker' in window) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: `${base}.pdf`, types: PDF_TYPES });
      await writeToHandle(h, bytes);
      S.handle = h; S.name = h.name; $('docName').textContent = h.name; $('docName').title = h.name;
      document.title = `${S.name} — Heurix PDF Viewer`;
      markSaved(); toast(`Saved ${h.name}`, 'success'); return true;
    } catch (e) { if (e?.name === 'AbortError') return false; console.warn('Save dialog failed, downloading instead', e); }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = el('a', '', { href: url, download: A.items.length || edHas(A.ed) ? `${base}-edited.pdf` : `${base}.pdf` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  markSaved(); toast(A.items.length ? 'Downloaded a copy with your comments.' : 'Downloaded a copy with your changes.', 'success'); return true;
}

async function confirmLeave() {
  if (!A.dirty) return true;
  const r = await modal({ title: 'Save your changes?', icon: 'i-save', ok: 'Save', alt: 'Don’t save', cancel: 'Cancel', body: `${S.name} has changes that haven’t been saved.` });
  if (r === true) return saveDocument();
  return r === 'alt';
}
window.addEventListener('beforeunload', (e) => { if (A.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------------------------------------------------------------
   Keyboard
   --------------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (!S.pdf || !$('modal').hidden) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName);

  if (mod && !e.altKey && !typing && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && !e.altKey && !typing && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    if (!$('menu').hidden) { closeMenu(); return; }
    if (A.openId) { e.preventDefault(); closePop(); return; }
    if (!$('selbar').hidden) { hideSelbar(); return; }
    if (A.fsel.size && A.tool === 'select') { clearForeignSel(); return; }
    if (A.sel && A.tool === 'select') { selectObj(null); return; }
    if (A.tool !== 'select') { setTool('select'); }
    return;
  }
  if (typing || mod || e.altKey) return;
  const t = { h: 'highlight', u: 'underline', s: 'strike', c: 'note' }[k];
  if (!t) return;
  e.preventDefault();
  if (t !== 'note' && readSelection()) { markSelection(t); return; }
  if (canEdit()) setTool(t);
});

updateRibbon();

// Exposed for diagnostics and automated tests.
const annotApi = { removeMarkups, itemsInBox, visForeign, flushRemovals, hitForeign, selectForeign, stripForeign, exportComments, cloneObject, cloudCmds, selectObj, startTextEdit, hitObject, prepareAssets, frameOf, layoutText, stampSpecs, armSignature, deleteObj, fitText, textCanvas, stampCanvas, buildAnnotatedBytes, writeAnnotations, extractHeurix, loadPdfLib, annotPrepare, markSelection, readSelection, groupToPdfRects, openPop, closePop, undo, redo, setTool, setColor, findAnn, focusAnnotation, saveDocument, hitTest, drawAnnots };

/* =====================================================================
   Phase 2b — text boxes, rectangles, ellipses, arrows, freehand drawing, stamps, signatures

   - Shapes and drawings are vector graphics (crisp at any zoom, and in the saved PDF).
   - Text boxes, stamps and signatures are laid out in an upright "frame" and saved as a transparent
     picture, so they look identical in every PDF reader, including Arabic text.
   - Everything keeps its settings inside the PDF, so it stays editable when the file is reopened.
   ===================================================================== */

const OBJ_TYPES = new Set(['text', 'rect', 'ellipse', 'cloud', 'arrow', 'line', 'ink', 'stamp', 'signature']);
const isObj = (a) => OBJ_TYPES.has(a.type);
const isMarkup = (a) => a.type === 'highlight' || a.type === 'underline' || a.type === 'strike';
const isVector = (a) => a.type !== 'text' && a.type !== 'stamp' && a.type !== 'signature';
const BOXY = new Set(['rect', 'ellipse', 'cloud']);        // shapes defined by a box
const LINEAR = new Set(['arrow', 'line']);                 // shapes defined by two end points
const FRAMED = new Set(['text', 'stamp', 'signature']);        // drawn upright inside their own frame
const OBJ_TOOLS = new Set(['text', 'rect', 'ellipse', 'cloud', 'arrow', 'line', 'ink']);
const WIDTHS = [1, 2.5, 5];
const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
const FONT = 'Helvetica, Arial, "Liberation Sans", "Segoe UI", Tahoma, sans-serif';
const TEXT_PAD = 3, LINE_H = 1.25, MIN_BOX = 14, SVGNS = 'http://www.w3.org/2000/svg';
const FONTS = { sans: FONT, serif: '"Times New Roman", Times, "Liberation Serif", Georgia, serif', mono: '"Courier New", Courier, "Liberation Mono", Consolas, monospace' };
const FILLS = { white: '#FFFFFF', yellow: '#FFF7C2', green: '#DDF6E3', blue: '#DCEFFF', pink: '#FFE0F0', orange: '#FFE9CF', grey: '#ECE9F1' };
const fontFamily = (a) => FONTS[a.font] || FONT;
const fontStr = (a, size) => `${a.italic ? 'italic ' : ''}${a.bold ? 700 : 400} ${size}px ${fontFamily(a)}`;
const TS_KEYS = ['size', 'bold', 'italic', 'align', 'font', 'bg', 'border'];
function loadTextStyle() {
  const d = { size: 12, bold: false, italic: false, align: null, font: 'sans', bg: null, border: false };
  try { const t = { ...d, ...JSON.parse(LS.get('hx-ts') || '{}') }; if (t.bg && !FILLS[t.bg]) t.bg = null; if (!FONTS[t.font]) t.font = 'sans'; return t; } catch { return d; }
}
A.textStyle = loadTextStyle();
const saveTextStyle = () => LS.set('hx-ts', JSON.stringify(A.textStyle));
const lineColor = (a) => colorOf(a).line;
const defColor = (tool) => A.drawColor || (tool === 'text' ? 'black' : 'red');
const normRect = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map(r2);
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------------------------------------------------------------
   Frames: where an upright object sits on the page (page space), for any page rotation
   --------------------------------------------------------------------- */
const ROT = { 0: { u: [1, 0], v: [0, -1] }, 90: { u: [0, -1], v: [-1, 0] }, 180: { u: [-1, 0], v: [0, 1] }, 270: { u: [0, 1], v: [1, 0] } };

function frameOf(a) {
  const r = a.rects[0], rot = a.rot || 0, { u, v } = ROT[rot];
  const sw = r[2] - r[0], sh = r[3] - r[1], sideways = rot % 180 !== 0;
  const O = rot === 0 ? [r[0], r[3]] : rot === 90 ? [r[2], r[3]] : rot === 180 ? [r[2], r[1]] : [r[0], r[1]];
  return { O, u, v, W: sideways ? sh : sw, H: sideways ? sw : sh };
}
function rectFromFrame(O, W, H, rot) {
  const { u, v } = ROT[rot];
  const pts = [O, [O[0] + W * u[0], O[1] + W * u[1]], [O[0] + H * v[0], O[1] + H * v[1]], [O[0] + W * u[0] + H * v[0], O[1] + W * u[1] + H * v[1]]];
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r2);
}
/* Which way is "right" on screen, in page space? That is the page rotation an upright object needs. */
function uprightRot(p) {
  const vp = vp1(p), a = vp.convertToPdfPoint(0, 0), b = vp.convertToPdfPoint(1, 0), du = [b[0] - a[0], b[1] - a[1]];
  let best = 0, bd = 1e9;
  for (const r of [0, 90, 180, 270]) { const d = (ROT[r].u[0] - du[0]) ** 2 + (ROT[r].u[1] - du[1]) ** 2; if (d < bd) { bd = d; best = r; } }
  return best;
}

/* ---------------------------------------------------------------------
   Text layout (shared by the screen, the editor and the saved picture)
   --------------------------------------------------------------------- */
const measureCtx = document.createElement('canvas').getContext('2d');
const RTL_CH = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const firstStrongRtl = (s) => { for (const ch of s) if (/\p{L}/u.test(ch)) return RTL_CH.test(ch); return false; };

function layoutText(a, width, textOverride) {
  const size = a.size || 12, ctx = measureCtx; ctx.font = fontStr(a, size);
  const w = (t) => ctx.measureText(t).width, maxW = Math.max(8, width - 2 * TEXT_PAD), lines = [];
  for (const para of String(textOverride ?? a.text).split('\n')) {
    const rtl = firstStrongRtl(para), align = a.align || (rtl ? 'right' : 'left');
    if (!para.trim()) { lines.push({ t: '', rtl, align }); continue; }
    let cur = '';
    const start = (word) => {
      if (w(word.trimEnd()) <= maxW) { cur = word; return; }
      let chunk = '';                                           // a single word wider than the box: break it
      for (const ch of word.trimEnd()) { if (chunk && w(chunk + ch) > maxW) { lines.push({ t: chunk, rtl, align }); chunk = ''; } chunk += ch; }
      cur = chunk;
    };
    for (const word of para.split(/(?<= )/)) {
      if (!cur) start(word);
      else if (w((cur + word).trimEnd()) <= maxW) cur += word;
      else { lines.push({ t: cur.trimEnd(), rtl, align }); cur = ''; start(word); }
    }
    if (cur) lines.push({ t: cur.trimEnd(), rtl, align });
  }
  const m = ctx.measureText('Hg'), lh = size * LINE_H;
  return { lines, lh, h: lines.length * lh + 2 * TEXT_PAD, fa: m.fontBoundingBoxAscent ?? size * 0.9, fd: m.fontBoundingBoxDescent ?? size * 0.25 };
}

/* The box is as wide as the user made it and as tall as its text needs. */
function fitText(a) {
  const fr = frameOf(a), lay = layoutText(a, fr.W);
  a.rects[0] = rectFromFrame(fr.O, fr.W, Math.max(MIN_BOX, lay.h), a.rot || 0);
}

function textCanvas(a, ppp = 4) {
  const fr = frameOf(a), size = a.size || 12, lay = layoutText(a, fr.W);
  const s = Math.min(ppp, 4096 / Math.max(fr.W, fr.H));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(fr.W * s)); c.height = Math.max(1, Math.ceil(fr.H * s));
  const ctx = c.getContext('2d'); ctx.scale(s, s);
  if (a.bg && FILLS[a.bg]) { ctx.fillStyle = FILLS[a.bg]; ctx.fillRect(0, 0, fr.W, fr.H); }
  if (a.border) { ctx.strokeStyle = lineColor(a); ctx.lineWidth = 0.9; ctx.strokeRect(0.45, 0.45, fr.W - 0.9, fr.H - 0.9); }
  ctx.font = fontStr(a, size); ctx.fillStyle = lineColor(a); ctx.textBaseline = 'alphabetic';
  lay.lines.forEach((ln, i) => {
    const y = TEXT_PAD + i * lay.lh + (lay.lh - (lay.fa + lay.fd)) / 2 + lay.fa;
    ctx.direction = ln.rtl ? 'rtl' : 'ltr'; ctx.textAlign = ln.align;
    ctx.fillText(ln.t, ln.align === 'center' ? fr.W / 2 : ln.align === 'right' ? fr.W - TEXT_PAD : TEXT_PAD, y);
  });
  return c;
}

/* ---------------------------------------------------------------------
   Stamps
   --------------------------------------------------------------------- */
function stampSpecs() {
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  return [
    { kind: 'approved', label: 'APPROVED', color: 'green' }, { kind: 'reviewed', label: 'REVIEWED', color: 'blue' },
    { kind: 'rejected', label: 'REJECTED', color: 'red' }, { kind: 'draft', label: 'DRAFT', color: 'orange' },
    { kind: 'confidential', label: 'CONFIDENTIAL', color: 'red' }, { kind: 'date', label: date, sub: A.author || 'Your name', color: 'blue' }
  ];
}
function stampMetrics(spec) {
  const ctx = measureCtx; ctx.font = `bold 22px ${FONT}`;
  const tw = ctx.measureText(spec.label).width; let sw = 0;
  if (spec.sub) { ctx.font = `600 10px ${FONT}`; sw = ctx.measureText(spec.sub).width; }
  return { W: Math.ceil(Math.max(tw, sw) + 26), H: Math.ceil(22 * 1.25 + (spec.sub ? 14 : 0) + 18) };
}
function stampCanvas(spec, hex, ppp = 4) {
  const { W, H } = stampMetrics(spec), s = Math.min(ppp, 4096 / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
  const ctx = c.getContext('2d'); ctx.scale(s, s);
  ctx.strokeStyle = hex; ctx.fillStyle = hex; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
  const r = 5, x = 1.5, y = 1.5, w = W - 3, h = H - 3;
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const m = measureCtx; m.font = `bold 22px ${FONT}`; const mm = m.measureText('H');
  ctx.font = `bold 22px ${FONT}`; ctx.direction = firstStrongRtl(spec.label) ? 'rtl' : 'ltr';
  const top = spec.sub ? 9 : (H - 22 * 1.25) / 2;
  ctx.fillText(spec.label, W / 2, top + (22 * 1.25 - ((mm.fontBoundingBoxAscent ?? 20) + (mm.fontBoundingBoxDescent ?? 5))) / 2 + (mm.fontBoundingBoxAscent ?? 20));
  if (spec.sub) { ctx.font = `600 10px ${FONT}`; ctx.direction = firstStrongRtl(spec.sub) ? 'rtl' : 'ltr'; ctx.fillText(spec.sub, W / 2, 9 + 22 * 1.25 + 9); }
  return c;
}
const stampUrlCache = new Map();
function stampUrl(a) {
  const hex = lineColor(a), key = `${a.stamp.label}|${a.stamp.sub || ''}|${hex}`;
  if (!stampUrlCache.has(key)) stampUrlCache.set(key, stampCanvas(a.stamp, hex, 3).toDataURL('image/png'));
  return stampUrlCache.get(key);
}

/* ---------------------------------------------------------------------
   Pictures and signatures
   --------------------------------------------------------------------- */
const canvasPng = async (c) => new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
const dataUrlBytes = (url) => { const b = atob(url.slice(url.indexOf(',') + 1)), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const bytesDataUrl = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return `data:image/png;base64,${btoa(s)}`; };
const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 7) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return `i${(h >>> 0).toString(36)}${s.length.toString(36)}`; };
const registerImage = (url) => { const k = hashStr(url); A.images[k] = url; return k; };
const loadSigs = () => { try { return JSON.parse(LS.get('hx-sigs') || '[]'); } catch { return []; } };
const saveSigs = (list) => { try { LS.set('hx-sigs', JSON.stringify(list.slice(0, 6))); } catch { /* storage full */ } };

/* ---------------------------------------------------------------------
   Paths for drawings and arrows
   --------------------------------------------------------------------- */
function distPointSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? clampN(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) { const d = distPointSeg(pts[i], pts[s], pts[e]); if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function smoothCmds(pts) {
  const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (!n) return [];
  if (n === 1) return [{ c: 'M', p: pts[0] }, { c: 'L', p: [pts[0][0] + 0.01, pts[0][1]] }];
  if (n === 2) return [{ c: 'M', p: pts[0] }, { c: 'L', p: pts[1] }];
  const out = [{ c: 'M', p: pts[0] }, { c: 'L', p: mid(pts[0], pts[1]) }];
  for (let i = 1; i < n - 1; i++) out.push({ c: 'Q', cp: pts[i], p: mid(pts[i], pts[i + 1]) });
  out.push({ c: 'L', p: pts[n - 1] });
  return out;
}
const svgPath = (cmds) => cmds.map((k) => (k.c === 'Q' ? `Q${k.cp[0].toFixed(2)} ${k.cp[1].toFixed(2)} ${k.p[0].toFixed(2)} ${k.p[1].toFixed(2)}` : `${k.c}${k.p[0].toFixed(2)} ${k.p[1].toFixed(2)}`)).join('');
function pdfPathOps(cmds) {
  const out = [], f = (q) => `${r2(q[0])} ${r2(q[1])}`; let cur = null;
  for (const k of cmds) {
    if (k.c === 'M') out.push(`${f(k.p)} m`);
    else if (k.c === 'L') out.push(`${f(k.p)} l`);
    else if (k.c === 'C') out.push(`${f(k.c1)} ${f(k.c2)} ${f(k.p)} c`);
    else if (k.c === 'Z') out.push('h');
    else {
      const c1 = [cur[0] + (2 / 3) * (k.cp[0] - cur[0]), cur[1] + (2 / 3) * (k.cp[1] - cur[1])];
      const c2 = [k.p[0] + (2 / 3) * (k.cp[0] - k.p[0]), k.p[1] + (2 / 3) * (k.cp[1] - k.p[1])];
      out.push(`${f(c1)} ${f(c2)} ${f(k.p)} c`);
    }
    if (k.p) cur = k.p;
  }
  return out;
}
/* A revision cloud: scallops bulging outward around a box (page space, y up, counter-clockwise) */
function cloudCmds(r) {
  const bw = r[2] - r[0], bh = r[3] - r[1], size = clampN(Math.min(bw, bh) / 3.5, 12, 24);
  const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], cmds = [{ c: 'M', p: corners[0] }];
  let bulge = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n = Math.max(1, Math.round(len / size)), step = len / n, d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], nr = [d[1], -d[0]], h = step * 0.5;
    bulge = Math.max(bulge, h);
    for (let k = 0; k < n; k++) {                          // each bump is a half circle bulging outward
      const p0 = [a[0] + d[0] * step * k, a[1] + d[1] * step * k], p1 = [a[0] + d[0] * step * (k + 1), a[1] + d[1] * step * (k + 1)], o = (4 / 3) * h;
      cmds.push({ c: 'C', c1: [p0[0] + nr[0] * o, p0[1] + nr[1] * o], c2: [p1[0] + nr[0] * o, p1[1] + nr[1] * o], p: p1 });
    }
  }
  cmds.push({ c: 'Z' });
  return { cmds, bulge };
}
const cloudBulge = (a) => cloudCmds(a.rects[0]).bulge;
const snapAngle = (p0, p) => { const dx = p[0] - p0[0], dy = p[1] - p0[1], l = Math.hypot(dx, dy), st = Math.PI / 12, ang = Math.round(Math.atan2(dy, dx) / st) * st; return [p0[0] + l * Math.cos(ang), p0[1] + l * Math.sin(ang)]; };

function arrowHead(p0, p1, w) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, len = Math.max(9, w * 4.5), ang = Math.PI / 6;
  const rot = (s) => [ux * Math.cos(s) - uy * Math.sin(s), ux * Math.sin(s) + uy * Math.cos(s)];
  const a = rot(ang), b = rot(-ang);
  return [[p1[0] - len * a[0], p1[1] - len * a[1]], [p1[0] - len * b[0], p1[1] - len * b[1]]];
}
function refreshBBox(a) {
  let pts;
  if (a.type === 'arrow') pts = [...a.pts, ...arrowHead(a.pts[0], a.pts[1], a.width || 2)];
  else if (a.type === 'line') pts = a.pts;
  else if (a.type === 'ink') pts = a.strokes.flat();
  else return;
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const q of pts) { x1 = Math.min(x1, q[0]); y1 = Math.min(y1, q[1]); x2 = Math.max(x2, q[0]); y2 = Math.max(y2, q[1]); }
  a.rects = [[x1, y1, x2, y2].map(r2)];
}

/* ---------------------------------------------------------------------
   Drawing objects on the page (called by drawAnnots)
   --------------------------------------------------------------------- */
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
function svgLayer(parts, vp) {
  if (!parts.svg) { parts.svg = svgEl('svg', { class: 'an-svg', viewBox: `0 0 ${vp.width} ${vp.height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }); parts.frag.append(parts.svg); }
  return parts.svg;
}

function drawObject(a, vp, px, py, parts) {
  const { frag } = parts, col = lineColor(a), active = a.id === A.openId ? ' is-active' : '';

  if (a.id === 'draft' && a.type === 'text') {                           // rubber band while dragging out a text box
    const b = boxOf(vp, a.rects[0]);
    svgLayer(parts, vp).append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'rgba(124,58,237,.06)', stroke: '#7c3aed', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }));
    return;
  }

  if (FRAMED.has(a.type)) {
    const fr = frameOf(a), { O, u, v, W, H } = fr;
    const c = vp.convertToViewportPoint(O[0] + (u[0] * W) / 2 + (v[0] * H) / 2, O[1] + (u[1] * W) / 2 + (v[1] * H) / 2);
    const o = vp.convertToViewportPoint(O[0], O[1]), ux = vp.convertToViewportPoint(O[0] + u[0], O[1] + u[1]);
    const ang = (Math.atan2(ux[1] - o[1], ux[0] - o[0]) * 180) / Math.PI;
    const box = (n) => { n.dataset.id = a.id; n.style.left = px(c[0]); n.style.top = py(c[1]); n.style.width = `calc(var(--total-scale-factor) * ${r2(W)}px)`; n.style.height = `calc(var(--total-scale-factor) * ${r2(H)}px)`; n.style.transform = `translate(-50%,-50%) rotate(${r2(ang)}deg)`; };
    if (a.type === 'text') {
      const size = a.size || 12, lay = layoutText(a, W);
      const d = el('div', `an an-text${a.id === A.editing ? ' is-editing' : ''}${active}`); box(d);
      d.style.fontSize = `calc(var(--total-scale-factor) * ${size}px)`; d.style.color = col;
      d.style.fontFamily = fontFamily(a); d.style.fontWeight = a.bold ? 700 : 400; d.style.fontStyle = a.italic ? 'italic' : 'normal';
      d.style.padding = `calc(var(--total-scale-factor) * ${TEXT_PAD}px)`; d.style.boxSizing = 'border-box';
      if (a.bg && FILLS[a.bg]) d.style.background = FILLS[a.bg];
      if (a.border) d.style.boxShadow = `inset 0 0 0 calc(var(--total-scale-factor) * 0.9px) ${col}`;
      for (const ln of lay.lines) {
        const row = el('div', 'ln', { textContent: ln.t });
        row.style.height = row.style.lineHeight = `calc(var(--total-scale-factor) * ${r2(lay.lh)}px)`;
        row.style.direction = ln.rtl ? 'rtl' : 'ltr'; row.style.textAlign = ln.align;
        d.append(row);
      }
      frag.append(d);
    } else {
      const url = a.type === 'stamp' ? stampUrl(a) : A.images[a.img];
      if (!url) return;
      const img = el('img', `an an-img${active}`, { src: url, alt: '', draggable: false }); box(img); frag.append(img);
    }
    return;
  }

  const g = svgEl('g', { class: `an${active}`, fill: 'none', stroke: col, 'stroke-width': a.width || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  g.dataset.id = a.id;
  if (a.type === 'rect') { const b = boxOf(vp, a.rects[0]); g.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h })); }
  else if (a.type === 'ellipse') { const b = boxOf(vp, a.rects[0]); g.append(svgEl('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 })); }
  else if (a.type === 'cloud') {
    const q = (pt) => vp.convertToViewportPoint(pt[0], pt[1]).map((n) => n.toFixed(2)).join(' ');
    const d = cloudCmds(a.rects[0]).cmds.map((k) => (k.c === 'M' ? `M${q(k.p)}` : k.c === 'C' ? `C${q(k.c1)} ${q(k.c2)} ${q(k.p)}` : 'Z')).join('');
    g.append(svgEl('path', { d }));
  } else if (LINEAR.has(a.type)) {
    const p0 = vp.convertToViewportPoint(...a.pts[0]), p1 = vp.convertToViewportPoint(...a.pts[1]);
    let d = `M${p0[0]} ${p0[1]}L${p1[0]} ${p1[1]}`;
    if (a.type === 'arrow') { const [h1, h2] = arrowHead(p0, p1, a.width || 2); d += `M${h1[0]} ${h1[1]}L${p1[0]} ${p1[1]}L${h2[0]} ${h2[1]}`; }
    g.append(svgEl('path', { d }));
  } else if (a.type === 'ink') {
    for (const st of a.strokes) g.append(svgEl('path', { d: svgPath(smoothCmds(st.map((q) => vp.convertToViewportPoint(q[0], q[1])))) }));
  }
  svgLayer(parts, vp).append(g);
  if (a.id !== 'draft' && hasComment(a)) {
    const b = boxOf(vp, a.rects[0]), flag = el('div', 'an an-flag'); flag.dataset.id = a.id;
    flag.style.cssText = `--l:${col};left:${px(b.x + b.w)};top:${py(b.y)}`; frag.append(flag);
  }
}

const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
function handlesFor(a, vp) {
  if (BOXY.has(a.type)) {
    const b = boxOf(vp, a.rects[0]), xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h], out = [];
    const names = [['nw', 0, 0], ['n', 1, 0], ['ne', 2, 0], ['e', 2, 1], ['se', 2, 2], ['s', 1, 2], ['sw', 0, 2], ['w', 0, 1]];
    for (const [name, i, j] of names) out.push({ name, x: xs[i], y: ys[j], cursor: CURSORS[name] });
    return out;
  }
  if (LINEAR.has(a.type)) return a.pts.map((q, i) => { const v = vp.convertToViewportPoint(q[0], q[1]); return { name: `p${i}`, x: v[0], y: v[1], round: true, cursor: 'crosshair' }; });
  if (a.type === 'text' || a.type === 'stamp' || a.type === 'signature') {
    const { O, u, v, W, H } = frameOf(a);
    if (a.type === 'text') { const q = vp.convertToViewportPoint(O[0] + W * u[0] + (H / 2) * v[0], O[1] + W * u[1] + (H / 2) * v[1]); return [{ name: 'e', x: q[0], y: q[1], cursor: 'ew-resize' }]; }
    const q = vp.convertToViewportPoint(O[0] + W * u[0] + H * v[0], O[1] + W * u[1] + H * v[1]); return [{ name: 'br', x: q[0], y: q[1], cursor: 'nwse-resize' }];
  }
  return [];
}

function drawSelection(a, vp, px, py, frag) {
  let b = boxOf(vp, a.rects[0]);
  const m = (isVector(a) ? (a.width || 2) / 2 + 3 : 2) + (a.type === 'cloud' ? cloudBulge(a) : 0);
  b = { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
  const f = el('div', 'an-frame'); f.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`; frag.append(f);
  for (const h of handlesFor(a, vp)) {
    const d = el('div', `an-handle${h.round ? ' round' : ''}`); d.dataset.h = h.name; d.dataset.id = a.id;
    d.style.cssText = `left:${px(h.x)};top:${py(h.y)};cursor:${h.cursor}`; frag.append(d);
  }
}

/* ---------------------------------------------------------------------
   Hit testing
   --------------------------------------------------------------------- */
function objHit(a, x, y, tol) {
  const r = a.rects[0], w = (a.width || 2) / 2 + tol;
  switch (a.type) {
    case 'text': case 'stamp': case 'signature': return x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol;
    case 'rect': {
      if (!(x >= r[0] - w && x <= r[2] + w && y >= r[1] - w && y <= r[3] + w)) return false;
      return a.id === A.sel || !(x > r[0] + w && x < r[2] - w && y > r[1] + w && y < r[3] - w);
    }
    case 'cloud': {
      const wb = (a.width || 2) / 2 + tol, ob = wb + cloudBulge(a);
      if (!(x >= r[0] - ob && x <= r[2] + ob && y >= r[1] - ob && y <= r[3] + ob)) return false;
      return a.id === A.sel || !(x > r[0] + wb && x < r[2] - wb && y > r[1] + wb && y < r[3] - wb);
    }
    case 'ellipse': {
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2;
      if (((x - cx) / (rx + w)) ** 2 + ((y - cy) / (ry + w)) ** 2 > 1) return false;
      return a.id === A.sel || !(rx > w && ry > w && ((x - cx) / (rx - w)) ** 2 + ((y - cy) / (ry - w)) ** 2 < 1);
    }
    case 'arrow': case 'line': {
      const [p0, p1] = a.pts, P = [x, y];
      if (a.type === 'line') return distPointSeg(P, p0, p1) <= w;
      const [h1, h2] = arrowHead(p0, p1, a.width || 2);
      return Math.min(distPointSeg(P, p0, p1), distPointSeg(P, h1, p1), distPointSeg(P, h2, p1)) <= w;
    }
    case 'ink': {
      if (!(x >= r[0] - w && x <= r[2] + w && y >= r[1] - w && y <= r[3] + w)) return false;
      for (const st of a.strokes) for (let i = 0; i < st.length; i++) if (distPointSeg([x, y], st[i], st[Math.min(i + 1, st.length - 1)]) <= w) return true;
      return false;
    }
    default: return false;
  }
}
function hitObject(cx, cy, target) {
  const pageEl = target?.closest?.('.page'); if (!pageEl) return null;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return null;
  const [x, y] = pdfPointAt(p, cx, cy), tol = 6 / (S.zoom * CSS_UNITS);
  for (let i = A.items.length - 1; i >= 0; i--) {
    const a = A.items[i];
    if (a.page === p.num && isObj(a) && objHit(a, x, y, tol)) return a;
  }
  return null;
}

/* ---------------------------------------------------------------------
   Selecting
   --------------------------------------------------------------------- */
function selectObj(id) {
  if (id && A.fsel.size) { const t = pagesOfIds(A.fsel); A.fsel.clear(); redrawPages(t); }
  if (A.sel === id) { refreshObjbar(); return; }
  const prev = A.sel && findAnn(A.sel);
  A.sel = id;
  const now = id && findAnn(id);
  for (const a of [prev, now]) if (a) { const p = S.pages[a.page - 1]; if (p) drawAnnots(p); }
  syncSwatches(); refreshObjbar();
}

/* ---------------------------------------------------------------------
   Moving, resizing and drawing (pointer operations)
   --------------------------------------------------------------------- */
const geomOf = (a) => clone({ rects: a.rects, pts: a.pts, strokes: a.strokes, w: a.width });
function applyMove(a, o, dx, dy) {
  a.rects = o.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy].map(r2));
  if (o.pts) a.pts = o.pts.map((q) => [r2(q[0] + dx), r2(q[1] + dy)]);
  if (o.strokes) a.strokes = o.strokes.map((s) => s.map((q) => [r2(q[0] + dx), r2(q[1] + dy)]));
}

let opRaf = 0;
function redrawOpPage(op) { if (opRaf) return; opRaf = requestAnimationFrame(() => { opRaf = 0; drawAnnots(op.p); }); }

function beginOp(op) {
  A.op = op; document.body.classList.add('is-dragging');
  window.addEventListener('pointermove', opMove); window.addEventListener('pointerup', opUp); window.addEventListener('pointercancel', opUp);
}
function endOp() {
  window.removeEventListener('pointermove', opMove); window.removeEventListener('pointerup', opUp); window.removeEventListener('pointercancel', opUp);
  document.body.classList.remove('is-dragging'); A.op = null;
}

function objPointerDown(e) {
  if (e.button !== 0 || A.op) return false;
  if (A.mode === 'edit') return edPointerDown(e);
  const t = e.target, handle = t.closest?.('.an-handle');
  if (handle) { startResize(e, handle); return true; }
  const pageEl = t.closest?.('.page'); if (!pageEl) return false;
  if (A.tool === 'erase') return beginErase(e, pageEl);
  if (OBJ_TOOLS.has(A.tool)) { if (!canEdit()) return true; return beginDraw(e, pageEl); }
  if (A.tool === 'select') {
    const a = hitObject(e.clientX, e.clientY, t);
    if (a) { e.preventDefault(); selectObj(a.id); closePop(true); beginMove(e, a); return true; }
    if (!t.closest('.link-layer a')) {                           // an existing markup that came with the PDF
      const f = hitForeign(e.clientX, e.clientY, t);
      if (f) { e.preventDefault(); closePop(true); selectForeign(f.id, e.shiftKey); return true; }
    }
  }
  return false;
}

function beginMove(e, a) {
  const p = S.pages[a.page - 1];
  beginOp({ kind: 'move', id: a.id, p, start: pdfPointAt(p, e.clientX, e.clientY), cx: e.clientX, cy: e.clientY, before: snap(), orig: geomOf(a), moved: false });
}

function startResize(e, handle) {
  const a = findAnn(handle.dataset.id); if (!a) return;
  e.preventDefault(); e.stopPropagation();
  const p = S.pages[a.page - 1];
  beginOp({ kind: 'resize', id: a.id, h: handle.dataset.h, p, before: snap(), orig: geomOf(a), moved: false, cx: e.clientX, cy: e.clientY });
}

function opMove(e) {
  const op = A.op; if (!op) return;
  if (op.kind === 'erase') { eraseMove(op, e); return; }
  if (op.kind.startsWith('ed')) { edOpMove(op, e); return; }
  const a = op.kind === 'draw' ? A.draft : findAnn(op.id); if (!a) return;
  if (!op.moved && Math.hypot(e.clientX - op.cx, e.clientY - op.cy) < 3) return;
  op.moved = true; hideObjbar();
  const cur = pdfPointAt(op.p, e.clientX, e.clientY);

  if (op.kind === 'move') {
    let dx = cur[0] - op.start[0], dy = cur[1] - op.start[1];
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }      // Shift keeps the move on one axis
    applyMove(a, op.orig, dx, dy);
  }
  else if (op.kind === 'resize') applyResize(a, op, cur, e);
  else if (op.kind === 'draw') {
    if (a.type === 'ink') { const st = a.strokes[0], last = st[st.length - 1]; if (Math.hypot(cur[0] - last[0], cur[1] - last[1]) * S.zoom * CSS_UNITS > 1.5) { st.push(cur.map(r2)); refreshBBox(a); } }
    else if (LINEAR.has(a.type)) { a.pts[1] = (e.shiftKey ? snapAngle(a.pts[0], cur) : cur).map(r2); refreshBBox(a); }
    else {
      let q = cur;
      if (e.shiftKey && a.type !== 'text') { const dx = cur[0] - op.start[0], dy = cur[1] - op.start[1], m = Math.max(Math.abs(dx), Math.abs(dy)); q = [op.start[0] + (dx < 0 ? -m : m), op.start[1] + (dy < 0 ? -m : m)]; }
      a.rects[0] = normRect(op.start, q);
    }
  }
  redrawOpPage(op);
}

function applyResize(a, op, cur) {
  const o = op.orig, vp = vp1(op.p);
  if (LINEAR.has(a.type)) { const i = +op.h.slice(1); a.pts = clone(o.pts); a.pts[i] = cur.map(r2); refreshBBox(a); return; }
  if (BOXY.has(a.type)) {
    const pr = op.p.div.getBoundingClientRect();
    const px = ((A.lastPtr.x - pr.left) / pr.width) * vp.width, py = ((A.lastPtr.y - pr.top) / pr.height) * vp.height;
    const b = boxOf(vp, o.rects[0]); let l = b.x, t = b.y, r = b.x + b.w, bt = b.y + b.h;
    if (op.h.includes('w')) l = Math.min(px, r - 6); if (op.h.includes('e')) r = Math.max(px, l + 6);
    if (op.h.includes('n')) t = Math.min(py, bt - 6); if (op.h.includes('s')) bt = Math.max(py, t + 6);
    const c1 = vp.convertToPdfPoint(l, t), c2 = vp.convertToPdfPoint(r, bt);
    a.rects = [normRect(c1, c2)]; return;
  }
  const fr = frameOf({ rects: o.rects, rot: a.rot }), P = [cur[0] - fr.O[0], cur[1] - fr.O[1]];
  const pu = P[0] * fr.u[0] + P[1] * fr.u[1], pv = P[0] * fr.v[0] + P[1] * fr.v[1];
  if (a.type === 'text') { a.rects = [rectFromFrame(fr.O, Math.max(40, pu), fr.H, a.rot || 0)]; fitText(a); return; }
  const sc = clampN(Math.max(pu / fr.W, pv / fr.H), 0.2, 8);
  a.rects = [rectFromFrame(fr.O, fr.W * sc, fr.H * sc, a.rot || 0)];
}

function opUp(e) {
  const op = A.op; if (!op) return;
  endOp();
  if (op.kind === 'erase') { finishErase(op); return; }
  if (op.kind.startsWith('ed')) { edOpUp(op, e); return; }
  if (op.kind === 'draw') { finishDraw(op); return; }
  const a = findAnn(op.id);
  if (!a || !op.moved) { if (a) { refreshObjbar(); } return; }
  A.undo.push(op.before); if (A.undo.length > 150) A.undo.shift(); A.redo.length = 0; A.hkey = '';
  a.modified = nowISO();
  afterChange([a.page]); refreshObjbar();
}
window.addEventListener('pointermove', (e) => { A.lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });

/* Drawing a new shape / arrow / pen stroke / text box */
function beginDraw(e, pageEl) {
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return false;
  e.preventDefault();
  const tool = A.tool, start = pdfPointAt(p, e.clientX, e.clientY).map(r2);
  const d = { id: 'draft', type: tool, page: p.num, color: defColor(tool), rects: [[start[0], start[1], start[0], start[1]]], width: WIDTHS[A.widthIdx], text: '', replies: [], quote: '' };
  if (LINEAR.has(tool)) d.pts = [start, start];
  if (tool === 'ink') d.strokes = [[start]];
  A.draft = d; selectObj(null); closePop(true);
  beginOp({ kind: 'draw', p, start, tool, moved: false, cx: e.clientX, cy: e.clientY, vstart: [e.clientX, e.clientY] });
  return true;
}

async function finishDraw(op) {
  const d = A.draft, p = op.p; A.draft = null;
  const done = () => drawAnnots(p);
  if (!d) return done();
  const tool = op.tool, minDrag = 8 / (S.zoom * CSS_UNITS);
  const a = { ...d, id: uid(), author: A.author, created: nowISO(), modified: nowISO() };
  const r = d.rects[0], w = r[2] - r[0], h = r[3] - r[1];

  if (BOXY.has(tool)) {
    if (w < minDrag && h < minDrag) { const c = op.start; a.rects = [[c[0] - 70, c[1] - 45, c[0] + 70, c[1] + 45].map(r2)]; }   // a plain click makes a default-sized shape
  } else if (LINEAR.has(tool)) {
    if (Math.hypot(d.pts[1][0] - d.pts[0][0], d.pts[1][1] - d.pts[0][1]) < minDrag) return done();
  } else if (tool === 'ink') {
    const st = d.strokes[0]; if (st.length < 2) return done();
    a.strokes = [simplify(st, 0.35).map((q) => q.map(r2))]; refreshBBox(a);
  } else if (tool === 'text') {
    const vp = vp1(p), pr = p.div.getBoundingClientRect(), toV = (cx, cy) => [((cx - pr.left) / pr.width) * vp.width, ((cy - pr.top) / pr.height) * vp.height];
    const v0 = toV(op.vstart[0], op.vstart[1]), v1 = toV(A.lastPtr.x, A.lastPtr.y);
    const W = Math.abs(v1[0] - v0[0]) > 30 ? Math.abs(v1[0] - v0[0]) : 180;
    const O = vp.convertToPdfPoint(Math.min(v0[0], v1[0]), Math.min(v0[1], v1[1]));
    Object.assign(a, A.textStyle);                                 // the last style used (font, size, fill, ...)
    a.rot = uprightRot(p); a.rects = [rectFromFrame(O, W, 20, a.rot)]; fitText(a);
  }
  if (!(await ensureAuthor())) return done();
  a.author = A.author;
  pushHistory(); A.items.push(a);
  if (tool === 'text') A.pendingNew = a.id;
  const keep = tool === 'ink' || A.lock;                           // pen and a "kept" tool stay armed
  if (!keep) setTool('select');
  afterChange([a.page]);
  if (tool === 'text') startTextEdit(a.id);
  else if (!keep) selectObj(a.id);
}

/* Placing a stamp or a signature with one click */
async function placeImageObject(kind, cx, cy, target, keep = false) {
  const pageEl = target?.closest?.('.page'); if (!pageEl) return;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page || !canEdit()) return;
  let W, H, a;
  if (kind === 'stamp') {
    const spec = A.stampSpec; if (!spec) return;
    ({ W, H } = stampMetrics(spec));
    a = { type: 'stamp', color: spec.color, stamp: { kind: spec.kind, label: spec.label, sub: spec.sub || '' } };
  } else {
    const sg = A.sigPending; if (!sg) return;
    W = Math.min(150, (72 * sg.w) / sg.h); H = (W * sg.h) / sg.w;
    a = { type: 'signature', color: 'black', img: sg.img };
  }
  if (!(await ensureAuthor())) return;
  const vp = vp1(p), pr = p.div.getBoundingClientRect();
  const v = [((cx - pr.left) / pr.width) * vp.width - W / 2, ((cy - pr.top) / pr.height) * vp.height - H / 2];
  const O = vp.convertToPdfPoint(clampN(v[0], 0, vp.width - W), clampN(v[1], 0, vp.height - H));
  a.rot = uprightRot(p); a.rects = [rectFromFrame(O, W, H, a.rot)];
  Object.assign(a, { id: uid(), page: p.num, quote: '', text: '', author: A.author, created: nowISO(), modified: nowISO(), replies: [] });
  pushHistory(); A.items.push(a);
  const stay = keep || A.lock;
  if (!stay) setTool('select');
  afterChange([a.page]);
  if (!stay) selectObj(a.id);
}

/* ---------------------------------------------------------------------
   Editing text in place
   --------------------------------------------------------------------- */
function startTextEdit(id) {
  const a = findAnn(id); if (!a || a.type !== 'text') return;
  A.editing = id; hideObjbar(); closePop(true);
  if (A.sel !== id) { A.sel = id; }
  const p = S.pages[a.page - 1]; if (p) drawAnnots(p);
  const ta = $('textEdit'); ta.value = a.text; ta.hidden = false;
  positionTextEdit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

function positionTextEdit() {
  const ta = $('textEdit'), a = A.editing && findAnn(A.editing);
  if (!a) return;
  const p = S.pages[a.page - 1]; if (!p?.page) return;
  const vp = vp1(p), pr = p.div.getBoundingClientRect(), z = S.zoom * CSS_UNITS, { O, u, v, W, H } = frameOf(a), size = a.size || 12;
  const c = vp.convertToViewportPoint(O[0] + (u[0] * W) / 2 + (v[0] * H) / 2, O[1] + (u[1] * W) / 2 + (v[1] * H) / 2);
  const o = vp.convertToViewportPoint(O[0], O[1]), ux = vp.convertToViewportPoint(O[0] + u[0], O[1] + u[1]);
  const ang = (Math.atan2(ux[1] - o[1], ux[0] - o[0]) * 180) / Math.PI;
  const cx = pr.left + (c[0] / vp.width) * pr.width, cy = pr.top + (c[1] / vp.height) * pr.height;
  ta.style.cssText = `left:${cx}px;top:${cy}px;width:${W * z}px;height:${Math.max(H, layoutText(a, W, ta.value).h) * z}px;padding:${TEXT_PAD * z}px;font-size:${size * z}px;line-height:${size * LINE_H * z}px;color:${lineColor(a)};font-family:${fontFamily(a)};font-weight:${a.bold ? 700 : 400};font-style:${a.italic ? 'italic' : 'normal'};text-align:${a.align || 'start'};background:${a.bg && FILLS[a.bg] ? FILLS[a.bg] : 'rgba(255,255,255,.88)'};transform:translate(-50%,-50%) rotate(${ang}deg)`;
  ta.dir = 'auto';
  const vr = viewer.getBoundingClientRect();
  ta.style.visibility = cy > vr.top - 40 && cy < vr.bottom + 40 ? 'visible' : 'hidden';
}
function repositionTextEdit() { if (A.editing) positionTextEdit(); }

function endTextEdit() {
  const id = A.editing; if (!id) return;
  A.editing = null; const ta = $('textEdit'); ta.hidden = true;
  const a = findAnn(id);
  if (a && !a.text.trim()) {
    if (A.pendingNew === id && A.undo.length) { A.undo.pop(); A.hkey = ''; }
    A.items = A.items.filter((x) => x.id !== id); if (A.sel === id) A.sel = null;
  }
  if (A.pendingNew === id) A.pendingNew = null;
  if (a) { const p = S.pages[a.page - 1]; if (p) drawAnnots(p); }
  refreshState(); renderCommentsSoon(); refreshObjbar();
  viewer.focus({ preventScroll: true });
}
$('textEdit').addEventListener('input', () => {
  const a = findAnn(A.editing); if (!a) return;
  const ta = $('textEdit');
  pushHistory(`tx:${a.id}`); a.text = ta.value; a.modified = nowISO(); fitText(a);
  const p = S.pages[a.page - 1]; if (p) drawAnnots(p);
  positionTextEdit(); refreshState(); renderCommentsSoon();
});
$('textEdit').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); endTextEdit(); }
});
$('textEdit').addEventListener('blur', () => { if (A.editing) endTextEdit(); });

/* ---------------------------------------------------------------------
   Object bar (colour, thickness, size, comment, delete)
   --------------------------------------------------------------------- */
function hideObjbar() { $('objbar').hidden = true; }
function recolor(a, key) {
  if (a.color === key) return;
  pushHistory(); a.color = key; a.modified = nowISO(); A.drawColor = key; LS.set('hx-dcolor', key);
  afterChange([a.page]); syncSwatches(); refreshObjbar();
}
function setObjWidth(a, idx) {
  if (a.width === WIDTHS[idx]) return;
  pushHistory(); a.width = WIDTHS[idx]; refreshBBox(a); a.modified = nowISO(); afterChange([a.page]); refreshObjbar();
}
function applyTextStyle(a, patch) {
  pushHistory(); Object.assign(a, patch); a.modified = nowISO(); fitText(a);
  for (const k of TS_KEYS) if (k in patch) A.textStyle[k] = patch[k];            // new text boxes start with the last style used
  saveTextStyle(); afterChange([a.page]); refreshObjbar();
}
function stepFont(a, d) {
  const i = Math.max(0, FONT_SIZES.findIndex((s) => s >= (a.size || 12))), n = clampN(i + d, 0, FONT_SIZES.length - 1);
  if (FONT_SIZES[n] !== a.size) applyTextStyle(a, { size: FONT_SIZES[n] });
}
function deleteObj(a) {
  pushHistory(); A.items = A.items.filter((x) => x.id !== a.id);
  if (A.sel === a.id) A.sel = null; if (A.openId === a.id) closePop(true);
  afterChange([a.page]); refreshObjbar();
}

const ALIGN_NEXT = { null: 'left', left: 'center', center: 'right', right: null };
function openFillMenu(anchor, a) {
  openMenu(anchor, (m) => {
    m.append(el('div', 'menu-title', { textContent: 'Box fill' }));
    const grid = el('div', 'fill-grid');
    for (const key of [null, ...Object.keys(FILLS)]) {
      const b = el('button', `fillsw${key ? '' : ' none'}${(a.bg || null) === key ? ' on' : ''}`, { type: 'button', title: key ? key[0].toUpperCase() + key.slice(1) : 'No fill' });
      if (key) b.style.background = FILLS[key];
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => { closeMenu(); applyTextStyle(a, { bg: key }); });
      grid.append(b);
    }
    m.append(grid);
    const o = el('button', 'menu-item', { type: 'button' });
    o.append(el('span', 'mi-check', { innerHTML: a.border ? '<svg><use href="#i-check"/></svg>' : '' }), el('span', '', { textContent: 'Outline around the box' }));
    o.addEventListener('click', () => { applyTextStyle(a, { border: !a.border }); const nb = document.querySelector('.ob-fill'); if (nb) openFillMenu(nb, a); });
    m.append(o);
  });
}
function openFontMenu(anchor, a) {
  openMenu(anchor, (m) => {
    m.append(el('div', 'menu-title', { textContent: 'Font' }));
    for (const [key, label] of [['sans', 'Sans-serif (Arial)'], ['serif', 'Serif (Times)'], ['mono', 'Typewriter (Courier)']]) {
      const b = el('button', 'menu-item', { type: 'button' });
      const t = el('span', '', { textContent: label }); t.style.fontFamily = FONTS[key]; t.style.fontSize = '15px';
      b.append(el('span', 'mi-check', { innerHTML: (a.font || 'sans') === key ? '<svg><use href="#i-check"/></svg>' : '' }), t);
      b.addEventListener('click', () => { closeMenu(); applyTextStyle(a, { font: key }); });
      m.append(b);
    }
  });
}

function refreshObjbar() {
  if (A.mode === 'edit') { refreshEditBar(); return; }
  const bar = $('objbar'), a = A.sel ? findAnn(A.sel) : null;
  if (!a && A.fsel.size && !A.op && !A.editing && A.tool === 'select') { refreshForeignBar(); return; }
  if (!a || !isObj(a) || A.op || A.editing || A.tool !== 'select') { bar.hidden = true; return; }
  bar.replaceChildren();
  const btn = (cls, html, title, fn) => { const b = el('button', cls, { type: 'button', innerHTML: html, title }); b.setAttribute('aria-label', title); b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', fn); return b; };
  const on = (b, v) => { b.setAttribute('aria-pressed', !!v); if (v) b.classList.add('on'); return b; };
  const sep = () => el('span', 'sb-sep');
  if (a.type !== 'signature') {
    const sw = el('div', 'sb-swatches'); buildSwatches(sw, (k) => recolor(a, k), a.color); bar.append(sw);
  }
  if (isVector(a)) {
    bar.append(sep());
    WIDTHS.forEach((w, i) => bar.append(on(btn('ob-w', `<i style="height:${[1.5, 3, 5][i]}px"></i>`, ['Thin line', 'Medium line', 'Thick line'][i], () => setObjWidth(a, i)), a.width === w)));
    if (a.type !== 'ink' || true) bar.append(sep(), btn('', '<svg><use href="#i-comment"/></svg>', 'Add a comment', () => openPop(a.id, { focus: 'text' })));
  }
  if (a.type === 'text') {
    const alignIcon = { left: 'i-alignl', center: 'i-alignc', right: 'i-alignr' }[a.align || 'left'];
    const fb = btn('ob-aa', `<span style="font-family:${fontFamily(a).replace(/"/g, "'")}">Aa</span>`, 'Font', () => openFontMenu(fb, a));
    const fill = btn('ob-fill', `<i class="fillchip"${a.bg ? ` style="background:${FILLS[a.bg]}"` : ''}></i>Fill`, 'Box fill and outline', () => openFillMenu(fill, a));
    bar.append(sep(),
      btn('', '<b>A</b>−', 'Smaller text', () => stepFont(a, -1)), btn('ob-fs', `${a.size || 12} pt`, 'Text size', () => {}), btn('', '<b>A</b>+', 'Larger text', () => stepFont(a, 1)),
      sep(), on(btn('ob-t', '<b>B</b>', 'Bold', () => applyTextStyle(a, { bold: !a.bold })), a.bold), on(btn('ob-t', '<i>I</i>', 'Italic', () => applyTextStyle(a, { italic: !a.italic })), a.italic),
      btn('', `<svg><use href="#${alignIcon}"/></svg>`, `Alignment: ${a.align || 'automatic'}. Click to change`, () => applyTextStyle(a, { align: ALIGN_NEXT[String(a.align ?? null)] })),
      fb, fill, sep(), btn('', '<svg><use href="#i-textbox"/></svg>Edit', 'Edit the text (Enter)', () => startTextEdit(a.id)));
  }
  bar.append(sep(), btn('ob-del', '<svg><use href="#i-trash"/></svg>', 'Delete (Delete key)', () => deleteObj(a)));
  bar.hidden = false; repositionObjbar();
}
function repositionObjbar() {
  if (A.mode === 'edit') { repositionEditBar(); return; }
  const bar = $('objbar'), a = A.sel ? findAnn(A.sel) : null;
  if (bar.hidden || (!a && !A.fsel.size)) return;
  const r = a ? anchorRect(a) : foreignAnchorRect(), vr = viewer.getBoundingClientRect();
  if (!r) { bar.style.visibility = 'hidden'; return; }
  const inView = r.bottom > vr.top + 4 && r.top < vr.bottom - 4 && r.right > vr.left && r.left < vr.right;
  bar.style.visibility = inView ? 'visible' : 'hidden'; if (!inView) return;
  const w = bar.offsetWidth, h = bar.offsetHeight;
  let y = r.top - h - 12; if (y < vr.top + 6) y = r.bottom + 12;
  bar.style.left = `${Math.round(clampN((r.left + r.right) / 2 - w / 2, 8, innerWidth - w - 8))}px`;
  bar.style.top = `${Math.round(clampN(y, 8, innerHeight - h - 8))}px`;
}

/* ---------------------------------------------------------------------
   Colours and line thickness in the ribbon
   --------------------------------------------------------------------- */
function objContext() { return OBJ_TOOLS.has(A.tool) || !!(A.sel && findAnn(A.sel) && isObj(findAnn(A.sel))); }
function syncSwatches() {
  const key = objContext() ? defColorKey() : A.color;
  document.querySelectorAll('#rbSwatches .sw, #sbSwatches .sw').forEach((b) => b.setAttribute('aria-checked', b.dataset.color === key));
  const sel = A.sel && findAnn(A.sel), idx = sel && isVector(sel) ? WIDTHS.indexOf(sel.width) : A.widthIdx;
  document.querySelectorAll('#rbWidths .rb-w').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.w === idx));
  $('rbWidths').hidden = !(OBJ_TOOLS.has(A.tool) && A.tool !== 'text') && !(sel && isVector(sel));          // thickness only matters for lines and shapes
}
function defColorKey() { const s = A.sel && findAnn(A.sel); return s && isObj(s) && s.type !== 'signature' ? s.color : defColor(A.tool); }

$('rbWidths').addEventListener('click', (e) => {
  const b = e.target.closest('.rb-w'); if (!b) return;
  const i = +b.dataset.w; A.widthIdx = i; LS.set('hx-w', String(i));
  const s = A.sel && findAnn(A.sel); if (s && isVector(s)) setObjWidth(s, i);
  syncSwatches();
});

/* ---------------------------------------------------------------------
   Menus: stamps and signatures
   --------------------------------------------------------------------- */
function closeMenu() { $('menu').hidden = true; }
function openMenu(anchor, build) {
  const m = $('menu'); m.replaceChildren(); build(m); m.hidden = false;
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.round(clampN(r.left, 8, innerWidth - w - 8))}px`; m.style.top = `${Math.round(Math.min(r.bottom + 6, innerHeight - h - 8))}px`;
}
document.addEventListener('pointerdown', (e) => { if (!$('menu').hidden && !e.target.closest('#menu, .rb-tool[data-menu]')) closeMenu(); }, true);

function openStampMenu(anchor) {
  openMenu(anchor, (m) => {
    m.append(el('div', 'menu-title', { textContent: 'Stamps' }));
    for (const spec of stampSpecs()) {
      const b = el('button', 'menu-item', { type: 'button' }); b.setAttribute('role', 'menuitem');
      b.append(el('img', '', { src: stampCanvas(spec, COLORS[spec.color].line, 2).toDataURL('image/png'), alt: spec.sub ? `${spec.label}, ${spec.sub}` : spec.label }));
      b.addEventListener('click', async () => {
        closeMenu();
        if (spec.kind === 'date') { if (!(await ensureAuthor())) return; spec.sub = A.author; }
        A.stampSpec = spec; setTool('stamp');
        if (A.tool !== 'stamp') setTool('stamp');
      });
      m.append(b);
    }
    m.append(el('div', 'menu-note', { textContent: 'Choose a stamp, then click on the page where it should go. The “date and name” stamp uses today’s date and your name.' }));
  });
}

function openSignMenu(anchor) {
  const sigs = loadSigs();
  openMenu(anchor, (m) => {
    m.append(el('div', 'menu-title', { textContent: 'Signature' }));
    for (const sg of sigs) {
      const row = el('div', 'menu-item'); row.tabIndex = 0; row.setAttribute('role', 'menuitem'); row.style.cursor = 'pointer';
      row.append(el('img', '', { src: sg.url, alt: 'Saved signature' }));
      const x = el('button', 'mi-x', { type: 'button', title: 'Remove this saved signature', innerHTML: '<svg><use href="#i-x"/></svg>' }); x.setAttribute('aria-label', 'Remove this saved signature');
      x.addEventListener('click', (e) => { e.stopPropagation(); saveSigs(loadSigs().filter((s) => s.id !== sg.id)); openSignMenu(anchor); });
      row.append(x);
      const use = () => { closeMenu(); armSignature(sg); };
      row.addEventListener('click', use); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') use(); });
      m.append(row);
    }
    if (sigs.length) m.append(el('div', 'menu-sep'));
    const add = el('button', 'menu-item', { type: 'button', innerHTML: '<svg><use href="#i-sign"/></svg>Create a new signature…' });
    add.addEventListener('click', () => { closeMenu(); openSigDialog(); });
    m.append(add, el('div', 'menu-note', { textContent: 'Signatures are placed as pictures. They are not certified digital signatures.' }));
  });
}

function armSignature(sg) {
  const key = registerImage(sg.url);
  A.sigPending = { img: key, w: sg.w, h: sg.h };
  if (A.tool === 'sign') setTool('select');
  setTool('sign');
}

/* ---------------------------------------------------------------------
   Signature dialog: draw, type or upload
   --------------------------------------------------------------------- */
const SIG_FONTS = [
  { name: 'Great Vibes', css: '"Great Vibes","Segoe Script","Brush Script MT","Snell Roundhand",cursive', k: 1.0 },
  { name: 'Dancing Script', css: '"Dancing Script","Segoe Script","Brush Script MT",cursive', k: 0.85 },
  { name: 'Caveat', css: '"Caveat","Ink Free","Segoe Print","Bradley Hand",cursive', k: 1.0 },
  { name: 'Homemade Apple', css: '"Homemade Apple","Lucida Handwriting","Segoe Script",cursive', k: 0.62 }
];
const SIG_INKS = { black: '#1c1428', blue: '#1a3fb0' };
const SIG = { tab: 'draw', ink: 'black', font: 0, hasInk: false, upload: null, result: null, drawing: false, last: null };

function sigPadCtx() { return $('sigPad').getContext('2d'); }
function sigClearPad() { const c = $('sigPad'); c.getContext('2d').clearRect(0, 0, c.width, c.height); SIG.hasInk = false; sigUpdate(); }

function trimToPng(src) {
  const { width, height } = src, d = src.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (d[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return null;
  const pad = 8, w = x1 - x0 + 1 + 2 * pad, h = y1 - y0 + 1 + 2 * pad, k = Math.min(1, 760 / w);
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, x0 - pad, y0 - pad, w, h, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
}

async function sigRenderTyped() {
  const text = $('sigText').value.trim(), f = SIG_FONTS[SIG.font];
  if (!text) { SIG.result = null; return; }
  try { await document.fonts.load(`80px ${f.css}`, text); } catch { /* fall back to a system script font */ }
  const c = document.createElement('canvas'); c.width = 1600; c.height = 420;
  const ctx = c.getContext('2d'); const size = 190 * f.k;
  ctx.font = `${size}px ${f.css}`; ctx.fillStyle = SIG_INKS[SIG.ink]; ctx.textBaseline = 'middle';
  let s = size; while (ctx.measureText(text).width > 1500 && s > 30) { s -= 6; ctx.font = `${s}px ${f.css}`; }
  ctx.fillText(text, 40, 210);
  SIG.result = trimToPng(c);
}

function sigRenderUpload() {
  const img = SIG.upload; if (!img) { SIG.result = null; return; }
  const k = Math.min(1, 1400 / img.naturalWidth), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
  if ($('sigBg').checked) {
    const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= 232) d[i + 3] = 0; else if (lum > 170) d[i + 3] = Math.round(((232 - lum) / 62) * d[i + 3]);
    }
    ctx.putImageData(im, 0, 0);
  }
  SIG.result = trimToPng(c);
}

async function sigUpdate() {
  if (SIG.tab === 'draw') SIG.result = SIG.hasInk ? trimToPng($('sigPad')) : null;
  else if (SIG.tab === 'type') await sigRenderTyped();
  else sigRenderUpload();
  const box = $('sigPreviewBox');
  box.hidden = !SIG.result || SIG.tab === 'draw';
  if (SIG.result) $('sigPreview').src = SIG.result.url;
  $('sigUse').disabled = !SIG.result;
}

function sigTab(name) {
  SIG.tab = name;
  document.querySelectorAll('.sig-tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $('sigDraw').classList.toggle('active', name === 'draw'); $('sigType').classList.toggle('active', name === 'type'); $('sigUpload').classList.toggle('active', name === 'upload');
  sigUpdate();
  if (name === 'type') $('sigText').focus();
}

function openSigDialog() {
  SIG.result = null; SIG.hasInk = false; SIG.upload = null; $('sigText').value = ''; $('sigFile').value = '';
  sigClearPad();
  const inks = $('sigInks'); inks.replaceChildren(...Object.entries(SIG_INKS).map(([k, hex]) => {
    const b = el('button', 'sw', { type: 'button', title: k === 'black' ? 'Black ink' : 'Blue ink' }); b.dataset.ink = k; b.style.setProperty('--c', hex);
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', k === SIG.ink); b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => { SIG.ink = k; inks.querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-checked', x.dataset.ink === k)); sigPadRecolor(); sigUpdate(); });
    return b;
  }));
  buildSigFonts();
  $('sigDlg').hidden = false; sigTab('draw');
}
function closeSigDialog() { $('sigDlg').hidden = true; }

function sigPadRecolor() {                        // change the ink colour of what is already drawn
  const c = $('sigPad'), ctx = c.getContext('2d'); if (!SIG.hasInk) return;
  ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = SIG_INKS[SIG.ink]; ctx.fillRect(0, 0, c.width, c.height); ctx.globalCompositeOperation = 'source-over';
}

function buildSigFonts() {
  const box = $('sigFonts'), text = $('sigText').value.trim() || 'Your name';
  box.replaceChildren(...SIG_FONTS.map((f, i) => {
    const b = el('button', `sig-font${i === SIG.font ? ' active' : ''}`, { type: 'button', textContent: text }); b.style.fontFamily = f.css; b.style.color = SIG_INKS[SIG.ink]; b.title = f.name;
    b.addEventListener('click', () => { SIG.font = i; buildSigFonts(); sigUpdate(); });
    return b;
  }));
}

(() => {                                          // drawing on the pad
  const pad = $('sigPad');
  const pt = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height]; };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId); SIG.drawing = true; SIG.last = pt(e);
    const ctx = sigPadCtx(); ctx.strokeStyle = SIG_INKS[SIG.ink]; ctx.fillStyle = SIG_INKS[SIG.ink]; ctx.lineWidth = 6; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(SIG.last[0], SIG.last[1], 3, 0, Math.PI * 2); ctx.fill(); SIG.hasInk = true; e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!SIG.drawing) return;
    const ctx = sigPadCtx(), p = pt(e), l = SIG.last, m = [(l[0] + p[0]) / 2, (l[1] + p[1]) / 2];
    ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.quadraticCurveTo(l[0], l[1], m[0], m[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); SIG.last = p;
  });
  const end = () => { if (!SIG.drawing) return; SIG.drawing = false; sigUpdate(); };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
})();

document.querySelectorAll('.sig-tab').forEach((t) => t.addEventListener('click', () => sigTab(t.dataset.tab)));
$('sigClear').addEventListener('click', sigClearPad);
$('sigText').addEventListener('input', () => { buildSigFonts(); sigUpdate(); });
$('sigBg').addEventListener('change', sigUpdate);
$('sigFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  const url = URL.createObjectURL(f), img = new Image();
  img.onload = () => { SIG.upload = img; sigUpdate(); URL.revokeObjectURL(url); };
  img.onerror = () => { toast('That image could not be read.', 'error'); URL.revokeObjectURL(url); };
  img.src = url;
});
$('sigClose').addEventListener('click', closeSigDialog); $('sigCancel').addEventListener('click', closeSigDialog);
$('sigDlg').addEventListener('mousedown', (e) => { if (e.target === $('sigDlg')) closeSigDialog(); });
$('sigDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSigDialog(); } });
$('sigUse').addEventListener('click', () => {
  const r = SIG.result; if (!r) return;
  const sg = { id: uid(), url: r.url, w: r.w, h: r.h };
  if ($('sigRemember').checked) saveSigs([sg, ...loadSigs()]);
  closeSigDialog(); armSignature(sg);
  toast('Click on the page where the signature should go.');
});

/* ---------------------------------------------------------------------
   Saving the new types into the PDF
   --------------------------------------------------------------------- */
async function prepareAssets(items) {
  const png = new Map();
  for (const a of items) {
    if (a.type === 'text') png.set(a.id, await canvasPng(textCanvas(a, 4)));
    else if (a.type === 'stamp') png.set(a.id, await canvasPng(stampCanvas(a.stamp, lineColor(a), 4)));
    else if (a.type === 'signature' && A.images[a.img]) png.set(a.id, dataUrlBytes(A.images[a.img]));
  }
  return png;
}

async function writeObjectAnnot(a, H) {
  const { ctx, PL, doc, page, assets, T, S_, form } = H;
  const hex = lineColor(a), rgb = hexRgb(hex).join(' '), w = a.width || 2, r = a.rects[0];
  let subtype, rect = r, ap, extra = {}, hx = { rect: r };
  if (a.type === 'rect') {
    subtype = 'Square'; rect = [r[0] - w / 2, r[1] - w / 2, r[2] + w / 2, r[3] + w / 2]; hx.width = w;
    ap = form(rect, `${rgb} RG ${w} w 1 j ${r[0]} ${r[1]} ${r2(r[2] - r[0])} ${r2(r[3] - r[1])} re S`);
    extra = { BS: { W: w, S: 'S' } };
  } else if (a.type === 'cloud') {
    const { cmds, bulge } = cloudCmds(r), m = bulge + w / 2;
    subtype = 'Square'; rect = [r[0] - m, r[1] - m, r[2] + m, r[3] + m]; hx.width = w;
    ap = form(rect, [`${rgb} RG ${w} w 1 j`, ...pdfPathOps(cmds), 'S'].join('\n'));
    extra = { BS: { W: w, S: 'S' }, BE: { S: 'C', I: 1 }, RD: [m, m, m, m].map(r2) };
  } else if (a.type === 'ellipse') {
    subtype = 'Circle'; rect = [r[0] - w / 2, r[1] - w / 2, r[2] + w / 2, r[3] + w / 2]; hx.width = w;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2, k = 0.5523;
    const f = (...n) => n.map(r2).join(' ');
    ap = form(rect, [`${rgb} RG ${w} w`, `${f(cx + rx, cy)} m`, `${f(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry)} c`, `${f(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy)} c`,
      `${f(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry)} c`, `${f(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy)} c`, 'h S'].join('\n'));
    extra = { BS: { W: w, S: 'S' } };
  } else if (LINEAR.has(a.type)) {
    const arrow = a.type === 'arrow';
    subtype = 'Line'; rect = [r[0] - w / 2, r[1] - w / 2, r[2] + w / 2, r[3] + w / 2]; hx.width = w; hx.pts = a.pts;
    const [p0, p1] = a.pts, [h1, h2] = arrowHead(p0, p1, w), f = (q) => `${r2(q[0])} ${r2(q[1])}`;
    ap = form(rect, [`${rgb} RG ${w} w 1 J 1 j`, `${f(p0)} m ${f(p1)} l S`, ...(arrow ? [`${f(h1)} m ${f(p1)} l ${f(h2)} l S`] : [])].join('\n'));
    extra = { L: [...p0, ...p1].map(r2), LE: ['None', arrow ? 'OpenArrow' : 'None'], BS: { W: w, S: 'S' } };
  } else if (a.type === 'ink') {
    subtype = 'Ink'; rect = [r[0] - w / 2, r[1] - w / 2, r[2] + w / 2, r[3] + w / 2]; hx.width = w; hx.strokes = a.strokes;
    ap = form(rect, [`${rgb} RG ${w} w 1 J 1 j`, ...a.strokes.flatMap((st) => [...pdfPathOps(smoothCmds(st)), 'S'])].join('\n'));
    extra = { InkList: a.strokes.map((st) => st.flatMap((q) => q.map(r2))), BS: { W: w, S: 'S' } };
  } else {                                           // text box, stamp, signature: a transparent picture in the object's frame
    const png = assets.get(a.id); if (!png) return null;
    const img = await doc.embedPng(png), fr = frameOf(a);
    const m = [fr.W * fr.u[0], fr.W * fr.u[1], -fr.H * fr.v[0], -fr.H * fr.v[1], fr.O[0] + fr.H * fr.v[0], fr.O[1] + fr.H * fr.v[1]].map(r2);
    ap = form(r, `q ${m.join(' ')} cm /Im0 Do Q`, false, { XObject: { Im0: img.ref } });
    hx.rot = a.rot || 0;
    if (a.type === 'text') {
      subtype = 'FreeText'; hx.size = a.size || 12;
      for (const k of ['bold', 'italic', 'align', 'font', 'bg', 'border']) if (a[k]) hx[k] = a[k];
      extra = { DA: PL.PDFString.of(`${rgb} rg /Helv ${a.size || 12} Tf`), Q: 0 };
    } else {
      subtype = 'Stamp';
      if (a.type === 'stamp') { hx.stamp = a.stamp; hx.color = a.color; }
      else extra = { HXImage: ctx.register(ctx.stream(png)) };
    }
  }
  const dict = {
    Type: 'Annot', Subtype: subtype, Rect: rect.map(r2), C: hexRgb(hex), F: 4, T: T(a.author), Contents: T(a.type === 'stamp' || a.type === 'signature' ? '' : a.text),
    M: S_(toPdfDate(a.modified)), CreationDate: S_(toPdfDate(a.created)), NM: S_(a.id), Subj: T(TYPE_LABEL[a.type]),
    HXColor: S_(a.color), HXType: S_(a.type), HXData: ctx.register(ctx.flateStream(new TextEncoder().encode(JSON.stringify(hx)))), AP: { N: ap }, ...extra
  };
  const ref = ctx.register(ctx.obj(dict));
  page.node.addAnnot(ref);
  for (const rp of a.replies || []) {
    const rr = [r[0], r2(r[3] - 1), r2(r[0] + 1), r[3]];
    page.node.addAnnot(ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Text', Rect: rr, IRT: ref, RT: 'R', Name: 'Comment', C: hexRgb(hex), F: 28,
      T: T(rp.author), Contents: T(rp.text), M: S_(toPdfDate(rp.created)), CreationDate: S_(toPdfDate(rp.created)), NM: S_(rp.id), Subj: T('Reply'), AP: { N: form([0, 0, 1, 1], '') }
    })));
  }
  return ref;
}

/* Reading the new types back (so they stay editable) */
function readObjectAnnot(d, N, text, PL, base) {
  const type = text(d.lookup(N('HXType')));
  if (!OBJ_TYPES.has(type)) return null;
  let hx = {};
  try { const s = d.lookup(N('HXData')); hx = JSON.parse(new TextDecoder().decode(PL.decodePDFRawStream(s).decode())); } catch { return null; }
  if (!hx.rect) return null;
  const hxc = text(d.lookup(N('HXColor')));
  const item = { ...base, type, rects: [hx.rect], color: COLORS[hxc] ? hxc : (hx.color && COLORS[hx.color] ? hx.color : 'black'), quote: '', replies: [] };
  if (hx.width) item.width = hx.width;
  if (hx.pts) item.pts = hx.pts; if (hx.strokes) item.strokes = hx.strokes;
  if (type === 'text') {
    item.size = hx.size || 12; item.rot = hx.rot || 0;
    for (const k of ['bold', 'italic', 'align', 'font', 'border']) if (hx[k]) item[k] = hx[k];
    if (hx.bg === true) { item.bg = 'yellow'; item.border = true; }                 // files saved by an earlier version
    else if (FILLS[hx.bg]) item.bg = hx.bg;
  }
  if (type === 'stamp') { item.stamp = hx.stamp; item.rot = hx.rot || 0; if (hx.color && COLORS[hx.color] && !COLORS[hxc]) item.color = hx.color; }
  if (type === 'signature') {
    item.rot = hx.rot || 0;
    try { const s = d.lookup(N('HXImage')); item.img = registerImage(bytesDataUrl(PL.decodePDFRawStream(s).decode())); } catch { return null; }
  }
  if (type === 'stamp' || type === 'signature') item.text = '';
  return item;
}

/* Remove the extra objects an annotation owns, so they do not stay behind in the file */
function dropObjectRefs(d, ctx, PL) {
  const { PDFName, PDFRef, PDFDict } = PL, N = (s) => PDFName.of(s);
  for (const key of ['HXData', 'HXImage']) { const r = d.get(N(key)); if (r instanceof PDFRef) ctx.delete(r); }
  try {
    const ap = d.lookup(N('AP'), PDFDict), n = ap && ap.lookup(N('N'));
    const xo = n && n.dict && n.dict.lookup(N('Resources'), PDFDict)?.lookup(N('XObject'), PDFDict);
    if (xo) for (const k of xo.keys()) { const r = xo.get(k); if (r instanceof PL.PDFRef) ctx.delete(r); }
  } catch { /* nothing to drop */ }
}

/* ---------------------------------------------------------------------
   Pointer and keyboard wiring for the new tools
   --------------------------------------------------------------------- */
viewer.addEventListener('dblclick', (e) => {
  if (A.tool !== 'select') return;
  const a = hitObject(e.clientX, e.clientY, e.target);
  if (a?.type === 'text') { e.preventDefault(); window.getSelection()?.removeAllRanges(); selectObj(a.id); startTextEdit(a.id); }
});

document.addEventListener('keydown', (e) => {
  if (!S.pdf || !$('modal').hidden || !$('sigDlg').hidden) return;
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName), mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (typing || mod || e.altKey) return;
  if (A.fsel.size && A.tool === 'select' && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeMarkups(new Set(A.fsel)); return; }
  const sel = A.sel && findAnn(A.sel);
  if (sel && isObj(sel) && !A.editing) {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteObj(sel); return; }
    if (e.key === 'Enter' && sel.type === 'text') { e.preventDefault(); startTextEdit(sel.id); return; }
    const step = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {                                                    // nudge in screen directions
      e.preventDefault();
      const p = S.pages[sel.page - 1], vp = vp1(p), o0 = vp.convertToPdfPoint(0, 0), q = vp.convertToPdfPoint(d[0], d[1]);
      pushHistory(`mv:${sel.id}`); applyMove(sel, geomOf(sel), q[0] - o0[0], q[1] - o0[1]); sel.modified = nowISO(); afterChange([sel.page]); refreshObjbar();
      return;
    }
  }
  if (k === 'm') { e.preventDefault(); setTool('pan'); return; }
  const t = { t: 'text', b: 'rect', o: 'ellipse', l: 'cloud', a: 'arrow', i: 'line', d: 'ink', e: 'erase' }[k];
  if (t) { e.preventDefault(); if (canEdit()) setTool(t); return; }
  if (k === 'g') { e.preventDefault(); if (canEdit()) openSignMenu($('ribbon').querySelector('[data-tool="sign"]')); }
});

window.addEventListener('resize', () => { repositionObjbar(); repositionTextEdit(); });
viewer.addEventListener('scroll', () => { repositionObjbar(); repositionTextEdit(); }, { passive: true });

/* ---------------------------------------------------------------------
   Copy, paste and duplicate
   --------------------------------------------------------------------- */
function cloneObject(src, page, dx, dy) {
  const p = S.pages[page - 1]; if (!p) return null;
  const a = clone(src); a.id = uid(); a.page = page; a.replies = []; a.created = a.modified = nowISO(); a.author = A.author || src.author;
  if (FRAMED.has(a.type) && p.page) {                                          // keep it upright on a page that is turned differently
    const fr = frameOf(a), nr = uprightRot(p);
    if (nr !== (a.rot || 0)) { a.rot = nr; a.rects = [rectFromFrame(fr.O, fr.W, fr.H, nr)]; }
  }
  applyMove(a, geomOf(a), dx, dy);
  const v = p.page && p.page.view;                                              // keep it on the page
  if (v) {
    const r = a.rects[0]; let sx = 0, sy = 0;
    if (r[2] > v[2]) sx = v[2] - r[2]; if (r[0] + sx < v[0]) sx = v[0] - r[0];
    if (r[3] > v[3]) sy = v[3] - r[3]; if (r[1] + sy < v[1]) sy = v[1] - r[1];
    if (sx || sy) applyMove(a, geomOf(a), sx, sy);
  }
  return a;
}
function addClone(a) { pushHistory(); A.items.push(a); afterChange([a.page]); selectObj(a.id); }

document.addEventListener('keydown', (e) => {
  if (!S.pdf || !$('modal').hidden || !$('sigDlg').hidden || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName) || A.editing) return;
  const k = e.key.toLowerCase(), sel = A.sel && findAnn(A.sel), hasText = !!window.getSelection()?.toString();
  if (k === 'c' && sel && isObj(sel) && !hasText) { e.preventDefault(); A.clip = clone(sel); A.pasteN = 0; toast('Copied. Press Ctrl+V to paste it, here or in another PDF.'); }
  else if (k === 'v' && A.clip && !hasText) {
    e.preventDefault(); if (!canEdit()) return;
    const same = A.clip.page === S.current && A.pasteN === 0 || A.clip.page === S.current, n = ++A.pasteN, off = same ? 14 * n : 0;
    const a = cloneObject(A.clip, S.current, off, -off); if (a) addClone(a);
  } else if (k === 'd' && sel && isObj(sel)) {
    e.preventDefault(); if (!canEdit()) return;
    const a = cloneObject(sel, sel.page, 14, -14); if (a) addClone(a);
  }
});

/* ---------------------------------------------------------------------
   Keep a tool on: double-click a tool to place several items in a row
   --------------------------------------------------------------------- */
function syncLockUI() { document.querySelectorAll('.rb-tool').forEach((b) => b.classList.toggle('locked', A.lock && b.dataset.tool === A.tool)); }
for (const t of ['note', 'text', 'rect', 'ellipse', 'cloud', 'arrow', 'line']) {
  const b = document.querySelector(`.rb-tool[data-tool="${t}"]`);
  b?.addEventListener('dblclick', () => { if (!canEdit()) return; setTool(t); if (A.tool !== t) setTool(t); A.lock = true; updateHint(); syncLockUI(); });
}

syncSwatches();

/* =====================================================================
   Existing markups — the comments, boxes, text and drawings that came inside the PDF
   (made in other apps such as Acrobat or Bluebeam). You can select them, erase them, or remove
   them all.

   How it works
   - The PDF engine paints them into the page, so removing one means rebuilding the file without
     it and refreshing the page view. That takes a moment on big drawings.
   - Removal is real: the markup, its appearance, its pop-up, its replies and anything left
     unreferenced are deleted from the saved file. The text of a removed comment is not kept
     hidden inside the PDF.
   - Until you save, Undo (Ctrl+Z) brings removed markups back.
   ===================================================================== */

Object.assign(A, { removed: new Set(), foreignAll: new Map(), foreignByPage: new Map(), fsel: new Set(), preview: new Set(), fhover: null, applied: '', fchip: 'all', fauthor: 'all', fshown: 120 });
Object.assign(FOREIGN_LABEL, { PolyLine: 'Polyline', Polygon: 'Polygon', Redact: 'Redaction', Caret: 'Insert mark' });

const FOREIGN_SKIP = new Set(['Link', 'Widget', 'Popup']);
const FOREIGN_ICON = { Highlight: 'i-highlight', Underline: 'i-underline', StrikeOut: 'i-strike', Squiggly: 'i-underline', Text: 'i-note', FreeText: 'i-textbox', Square: 'i-rect', Circle: 'i-ellipse', Polygon: 'i-cloud', PolyLine: 'i-line', Line: 'i-line', Ink: 'i-pen', Stamp: 'i-stamp' };
function visForeign() { return A.foreign.filter((f) => !A.removed.has(f.id)); }
function removedKey() { return [...A.removed].sort().join(','); }
function foreignLabel(f) { return FOREIGN_LABEL[f.type] || f.type; }

/* ---------------------------------------------------------------------
   Finding them (a list of every markup, with its shape for click testing)
   --------------------------------------------------------------------- */
const arrOf = (v) => (v ? Array.from(v) : []);
const toPts = (v) => {
  const a = arrOf(v); if (!a.length) return [];
  if (a[0] && typeof a[0] === 'object' && 'x' in a[0]) return a.map((q) => [q.x, q.y]);
  const out = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out;
};
function foreignGeom(an) {
  const w = an.borderStyle?.width || 0, sub = an.subtype;
  const q = toPts(an.quadPoints);
  if (q.length >= 4 && (sub === 'Highlight' || sub === 'Underline' || sub === 'StrikeOut' || sub === 'Squiggly')) {
    const quads = [];
    for (let i = 0; i + 3 < q.length; i += 4) { const xs = q.slice(i, i + 4).map((p) => p[0]), ys = q.slice(i, i + 4).map((p) => p[1]); quads.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]); }
    return { k: 'quads', quads };
  }
  const lc = arrOf(an.lineCoordinates);
  if (lc.length >= 4) return { k: 'line', pts: [[lc[0], lc[1]], [lc[2], lc[3]]], w };
  const vt = toPts(an.vertices);
  if (vt.length >= 2) return { k: 'poly', pts: vt, closed: sub === 'Polygon', w };
  const lists = arrOf(an.inkLists).map(toPts).filter((l) => l.length);
  if (lists.length) return { k: 'ink', lists, w };
  if (sub === 'Square' || sub === 'Circle') return { k: 'band', ell: sub === 'Circle', w };
  return { k: 'box' };
}

async function scanForeign(docId) {
  const out = [];
  for (let i = 0; i < S.pages.length; i++) {
    if (docId !== S.docId) return;
    const p = S.pages[i]; let list;
    try { const page = await getPage(p); p.annots ??= await page.getAnnotations({ intent: 'display' }); list = p.annots; } catch { continue; }
    for (const an of list) {
      if (FOREIGN_SKIP.has(an.subtype) || !an.rect) continue;
      const c = an.color;
      out.push({
        id: an.id, page: i + 1, type: an.subtype, text: (an.contentsObj?.str || '').trim(), author: (an.titleObj?.str || '').trim(),
        rect: Array.from(an.rect), bw: an.borderStyle?.width || 0, geom: foreignGeom(an), inReplyTo: an.inReplyTo || null, hasRef: /^\d+R\d*$/.test(String(an.id)),
        created: parsePdfDate(an.creationDate) || parsePdfDate(an.modificationDate),
        color: c && c.length === 3 ? `#${[...c].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : null
      });
    }
    if (i % 12 === 11) await idle();
  }
  if (docId !== S.docId) return;
  const byId = new Map(out.map((o) => [o.id, o])), top = [];
  for (const o of out) { const parent = o.inReplyTo && byId.get(o.inReplyTo); if (parent) (parent.replies ??= []).push(o); else top.push(o); }
  A.foreign = top; A.foreignAll = byId; A.foreignByPage = new Map();
  for (const f of top) (A.foreignByPage.get(f.page) ?? A.foreignByPage.set(f.page, []).get(f.page)).push(f);
  renderComments(); updateBadge();
  if (top.length) toast(`This PDF already contains ${top.length} ${top.length === 1 ? 'markup' : 'markups'} from other apps. Click one to select it, or use the Remove tool (E) to delete them.`, '', 7000);
}

/* ---------------------------------------------------------------------
   Click testing
   --------------------------------------------------------------------- */
function foreignHit(f, x, y, tol) {
  const r = f.rect, g = f.geom, w = Math.max(f.bw || 0, 1) / 2 + tol;
  if (!(x >= r[0] - w && x <= r[2] + w && y >= r[1] - w && y <= r[3] + w)) return false;
  switch (g.k) {
    case 'quads': return g.quads.some((q) => x >= q[0] - 1 && x <= q[2] + 1 && y >= q[1] - 1 && y <= q[3] + 1);
    case 'line': return distPointSeg([x, y], g.pts[0], g.pts[1]) <= w;
    case 'poly': {
      const P = g.pts;
      for (let i = 0; i < P.length - 1; i++) if (distPointSeg([x, y], P[i], P[i + 1]) <= w) return true;
      return g.closed && distPointSeg([x, y], P[P.length - 1], P[0]) <= w;
    }
    case 'ink': for (const l of g.lists) for (let i = 0; i < l.length; i++) if (distPointSeg([x, y], l[i], l[Math.min(i + 1, l.length - 1)]) <= w) return true; return false;
    case 'band': {                                       // hollow shapes: only the outline counts
      if (g.ell) {
        const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2;
        if (((x - cx) / (rx + w)) ** 2 + ((y - cy) / (ry + w)) ** 2 > 1) return false;
        return !(rx > 2 * w && ry > 2 * w && ((x - cx) / (rx - w)) ** 2 + ((y - cy) / (ry - w)) ** 2 < 1);
      }
      return !(x > r[0] + w && x < r[2] - w && y > r[1] + w && y < r[3] - w);
    }
    default: return true;
  }
}

function hitForeign(cx, cy, target) {
  const pageEl = target?.closest?.('.page'); if (!pageEl) return null;
  const p = S.pages[+pageEl.dataset.page - 1], list = p && A.foreignByPage.get(p.num);
  if (!p?.page || !list) return null;
  const [x, y] = pdfPointAt(p, cx, cy), tol = 5 / (S.zoom * CSS_UNITS);
  let best = null, area = Infinity;
  for (const f of list) {
    if (A.removed.has(f.id) || !foreignHit(f, x, y, tol)) continue;
    const a = (f.rect[2] - f.rect[0]) * (f.rect[3] - f.rect[1]);
    if (a <= area) { area = a; best = f; }             // when several overlap, the smallest one wins
  }
  return best;
}

/* ---------------------------------------------------------------------
   Selecting, highlighting and drawing the frames
   --------------------------------------------------------------------- */
function pagesOfIds(ids) {
  const s = new Set();
  for (const id of ids) { const f = A.foreignAll.get(id); if (f) s.add(f.page); else { const a = findAnn(id); if (a) s.add(a.page); } }
  return s;
}
function redrawPages(set) { for (const n of set) { const p = S.pages[n - 1]; if (p && p.rendered) drawAnnots(p); } }

function selectForeign(id, add = false) {
  const touched = pagesOfIds(A.fsel);
  if (!add) A.fsel.clear();
  if (id) {
    if (A.sel) selectObj(null);
    if (add && A.fsel.has(id)) A.fsel.delete(id); else A.fsel.add(id);
  }
  for (const n of pagesOfIds(A.fsel)) touched.add(n);
  redrawPages(touched); refreshObjbar();
}
function clearForeignSel() { if (A.fsel.size) selectForeign(null); }

function setForeignHover(id) {
  if (id === A.fhover) return;
  const touched = pagesOfIds([A.fhover, id].filter(Boolean));
  A.fhover = id; redrawPages(touched);
}

function existingActive() {
  return A.fsel.size > 0 || !!A.fhover || A.preview.size > 0 || A.op?.kind === 'erase' || (A.removed.size > 0 && A.applied !== removedKey());
}

function drawExisting(p, vp, px, py, frag) {
  const mk = (rect, cls, id) => {
    const b = boxOf(vp, rect), d = el('div', `an-ffr ${cls}`); d.dataset.fid = id;
    d.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`; frag.append(d);
  };
  const rectOfId = (id) => {
    const f = A.foreignAll.get(id); if (f) return f.page === p.num ? f.rect : null;
    const a = findAnn(id); return a && a.page === p.num ? unionRect(a.rects) : null;
  };
  if (A.removed.size && A.applied !== removedKey()) for (const id of A.removed) { const f = A.foreignAll.get(id); if (f && f.page === p.num) mk(f.rect, 'pending', id); }
  for (const id of A.fsel) { const r = rectOfId(id); if (r) mk(r, 'sel', id); }
  if (A.fhover && !A.fsel.has(A.fhover)) { const r = rectOfId(A.fhover); if (r) mk(r, 'hover', A.fhover); }
  for (const id of A.preview) { const r = rectOfId(id); if (r) mk(r, 'pending', id); }
  const op = A.op;
  if (op?.kind === 'erase' && op.p === p && op.rb) {
    const b = boxOf(vp, op.rb), d = el('div', 'an-rubber');
    d.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`; frag.append(d);
  }
}

/* The little bar that appears above selected existing markups */
function foreignAnchorRect() {
  const els = [...document.querySelectorAll('.an-ffr.sel')]; if (!els.length) return null;
  let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const n of els) { const q = n.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
  return { left: l, top: t, right: r, bottom: b };
}
function refreshForeignBar() {
  const bar = $('objbar');
  const recs = [...A.fsel].map((id) => A.foreignAll.get(id)).filter(Boolean);
  if (!recs.length || A.op || A.tool !== 'select') { bar.hidden = true; return; }
  bar.replaceChildren();
  const btn = (cls, html, title, fn) => { const b = el('button', cls, { type: 'button', innerHTML: html, title }); b.setAttribute('aria-label', title); b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', fn); return b; };
  const label = el('span', 'ob-label');
  const one = recs.length === 1 ? recs[0] : null;
  label.append(el('b', '', { textContent: one ? foreignLabel(one) : `${recs.length} markups`, dir: 'auto' }));
  label.append(el('small', '', { textContent: one ? (one.author || 'From the original file') : 'From the original file', dir: 'auto' }));
  bar.append(label);
  const types = new Set(recs.map((r) => r.type));
  if (types.size === 1) {
    const type = recs[0].type, all = visForeign().filter((f) => f.type === type);
    if (all.length > recs.length) bar.append(el('span', 'sb-sep'), btn('', `Select all ${foreignLabel(recs[0]).toLowerCase()}s (${all.length})`, 'Select every markup of this kind', () => { A.fsel = new Set(all.map((f) => f.id)); redrawPages(new Set(all.map((f) => f.page))); refreshObjbar(); }));
  }
  bar.append(el('span', 'sb-sep'), btn('ob-del', `<svg><use href="#i-trash"/></svg>Remove${recs.length > 1 ? ` ${recs.length}` : ''}`, 'Remove from the PDF (Delete key)', () => removeMarkups(new Set(A.fsel))));
  bar.hidden = false; repositionObjbar();
}

/* ---------------------------------------------------------------------
   The Remove tool: click one markup, or drag a box around several
   --------------------------------------------------------------------- */
function anyAt(cx, cy, target) {
  const note = target?.closest?.('.an-note'); if (note) return { id: note.dataset.id };
  return hitObject(cx, cy, target) || hitTest(cx, cy, target) || hitForeign(cx, cy, target);
}

function itemsInBox(p, box, touching) {
  const ids = new Set();
  const inside = (r) => (touching ? !(r[2] < box[0] || r[0] > box[2] || r[3] < box[1] || r[1] > box[3]) : r[0] >= box[0] && r[2] <= box[2] && r[1] >= box[1] && r[3] <= box[3]);
  for (const a of A.items) if (a.page === p.num && inside(unionRect(a.rects))) ids.add(a.id);
  for (const f of A.foreignByPage.get(p.num) || []) if (!A.removed.has(f.id) && inside(f.rect)) ids.add(f.id);
  return ids;
}

function setPreview(ids, pageNum) {
  const same = ids.size === A.preview.size && [...ids].every((i) => A.preview.has(i));
  if (same) return;
  const touched = pagesOfIds(A.preview); A.preview = ids;
  for (const n of pagesOfIds(ids)) touched.add(n);
  if (pageNum) touched.add(pageNum);
  redrawPages(touched);
}
function eraseHover(cx, cy, target) {
  const hit = anyAt(cx, cy, target);
  setPreview(new Set(hit ? [hit.id] : []));
}
viewer.addEventListener('pointerleave', () => { if (A.tool === 'erase' && !A.op) setPreview(new Set()); setForeignHover(null); });

function beginErase(e, pageEl) {
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page || !canEdit()) return true;
  e.preventDefault(); closePop(true);
  const start = pdfPointAt(p, e.clientX, e.clientY);
  beginOp({ kind: 'erase', p, start, moved: false, cx: e.clientX, cy: e.clientY, target: e.target, rb: null });
  return true;
}
function eraseMove(op, e) {
  if (!op.moved && Math.hypot(e.clientX - op.cx, e.clientY - op.cy) < 4) return;
  op.moved = true;
  op.rb = normRect(op.start, pdfPointAt(op.p, e.clientX, e.clientY));
  setPreview(itemsInBox(op.p, op.rb, e.altKey), op.p.num); redrawOpPage(op);
}
function finishErase(op) {
  const ids = op.moved ? new Set(A.preview) : (() => { const h = anyAt(op.cx, op.cy, op.target); return new Set(h ? [h.id] : []); })();
  A.preview = new Set(); op.rb = null;
  if (ids.size) removeMarkups(ids); else drawAnnots(op.p);
}

/* ---------------------------------------------------------------------
   Removing
   --------------------------------------------------------------------- */
function removeMarkups(ids) {
  if (!ids.size || !canEdit()) return 0;
  const own = new Set([...ids].filter((id) => findAnn(id))), ex = [...ids].filter((id) => A.foreignAll.has(id) && !A.removed.has(id));
  const n = own.size + ex.length; if (!n) return 0;
  const pages = pagesOfIds(ids);
  pushHistory();
  if (own.size) {
    A.items = A.items.filter((a) => !own.has(a.id));
    if (A.sel && own.has(A.sel)) A.sel = null;
    if (A.openId && own.has(A.openId)) closePop(true);
  }
  for (const id of ex) { A.removed.add(id); A.fsel.delete(id); }
  A.preview = new Set(); A.fhover = null;
  redrawPages(pages); renderCommentsSoon(); refreshState(); refreshObjbar();
  if (ex.length) scheduleApplyRemovals();
  toast(`Removed ${n} ${n === 1 ? 'markup' : 'markups'}. Press Ctrl+Z to bring ${n === 1 ? 'it' : 'them'} back.`, 'success');
  return n;
}

/* Rebuilding the file without the removed markups, then refreshing the view */
let applyTimer = 0, applyChain = Promise.resolve(), applying = false;
function scheduleApplyRemovals(delay = 150) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => { applyChain = applyChain.then(runApply); }, delay);
}
async function flushRemovals() {
  clearTimeout(applyTimer); applyChain = applyChain.then(runApply); await applyChain;
  if (A.applied !== removedKey() || A.appliedEd !== edKey()) throw new Error('The changes could not be applied to the PDF.');
}
async function runApply() {
  const key = removedKey(), ek = edKey(); if ((A.applied === key && A.appliedEd === ek) || !S.srcBytes) return;
  applying = true;
  try {
    const ids = new Set(A.removed);
    const specs = [...ids].map((id) => A.foreignAll.get(id)).filter(Boolean).map((f) => ({ id: f.id, page: f.page, sub: f.type, rect: f.rect, hasRef: f.hasRef }));
    let bytes = specs.length ? await stripForeign(S.srcBytes, specs) : S.srcBytes;
    if (ek) bytes = await edApplyBytes(bytes, ek);
    S.bytes = bytes; await swapDocument(bytes); A.applied = key; A.appliedEd = ek;
  } catch (e) { console.error(e); toast(`Could not apply the changes: ${e?.message || e}`, 'error'); }
  finally { applying = false; redrawPages(new Set(S.pages.map((p) => p.num))); }
}

async function stripForeign(src, specs) {
  const PL = await loadPdfLib();
  const doc = await PL.PDFDocument.load(src, loadOpts(PL));
  removeExistingAnnots(doc, PL, specs);
  return doc.save(SAVE_OPTS);
}

function removeExistingAnnots(doc, PL, specs) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = PL, ctx = doc.context, N = (s) => PDFName.of(s), pages = doc.getPages();
  const byPage = new Map(); for (const sp of specs) (byPage.get(sp.page) ?? byPage.set(sp.page, []).get(sp.page)).push(sp);
  const refId = (r) => (r.generationNumber ? `${r.objectNumber}R${r.generationNumber}` : `${r.objectNumber}R`);
  const nameOf = (v) => { try { return v && v.decodeText ? v.decodeText() : ''; } catch { return ''; } };
  const nums = (arr) => { const o = []; if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) { const n = arr.lookup(i); if (n instanceof PDFNumber) o.push(n.asNumber()); } return o; };
  const killedDicts = [];

  for (const [pn, list] of byPage) {
    const page = pages[pn - 1], annots = page && page.node.Annots(); if (!annots) continue;
    const entries = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i); let d; try { d = annots.lookup(i, PDFDict); } catch { continue; }
      entries.push({ i, raw, d, ref: raw instanceof PDFRef ? raw : null });
    }
    const wanted = new Set(list.filter((s) => s.hasRef).map((s) => s.id)), kill = new Set();
    for (const e of entries) if (e.ref && wanted.has(refId(e.ref))) kill.add(e.i);
    for (const sp of list.filter((s) => !s.hasRef)) {                         // annotations stored inline: match by kind and position
      for (const e of entries) {
        if (e.ref || nameOf(e.d.lookup(N('Subtype'))) !== sp.sub) continue;
        const rc = nums(e.d.lookup(N('Rect')));
        if (rc.length === 4 && rc.every((v, k) => Math.abs(v - sp.rect[k]) < 0.6)) { kill.add(e.i); break; }
      }
    }
    let grew = true;                                                          // replies and pop-ups go with their parent
    while (grew) {
      grew = false;
      const killedRefs = new Set(entries.filter((e) => kill.has(e.i) && e.ref).map((e) => refId(e.ref)));
      for (const e of entries) {
        if (kill.has(e.i)) continue;
        const irt = e.d.get(N('IRT')), par = e.d.get(N('Parent')), isPopup = nameOf(e.d.lookup(N('Subtype'))) === 'Popup';
        if ((irt instanceof PDFRef && killedRefs.has(refId(irt))) || (isPopup && par instanceof PDFRef && killedRefs.has(refId(par)))) { kill.add(e.i); grew = true; }
      }
      for (const e of entries) {                                              // the pop-up that belongs to a removed markup
        if (!kill.has(e.i)) continue;
        const pop = e.d.get(N('Popup'));
        if (pop instanceof PDFRef) for (const o of entries) if (!kill.has(o.i) && o.ref && refId(o.ref) === refId(pop)) { kill.add(o.i); grew = true; }
      }
    }
    for (const e of entries) if (kill.has(e.i) && e.ref) killedDicts.push(e.ref);
    const keep = entries.filter((e) => !kill.has(e.i)).map((e) => e.raw);
    if (keep.length) page.node.set(N('Annots'), ctx.obj(keep)); else page.node.delete(N('Annots'));
  }
  gcUnreachable(doc, PL);
  for (const r of killedDicts) ctx.delete(r);                                 // even if something else still pointed at it
}

/* Delete every object that nothing in the document refers to any more */
function gcUnreachable(doc, PL) {
  const ctx = doc.context, { PDFRef, PDFDict, PDFArray, PDFStream } = PL;
  if (ctx.indirectObjects.size > 400000) return;
  const seen = new Set(), stack = [], key = (r) => `${r.objectNumber}:${r.generationNumber}`;
  const walk = (o) => {
    if (o instanceof PDFRef) { const k = key(o); if (!seen.has(k)) { seen.add(k); stack.push(o); } }
    else if (o instanceof PDFDict) { for (const v of o.values()) walk(v); }
    else if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) walk(o.get(i)); }
    else if (o instanceof PDFStream) walk(o.dict);
  };
  const t = ctx.trailerInfo; walk(t.Root); walk(t.Info); walk(t.Encrypt); walk(t.ID);
  while (stack.length) { const o = ctx.lookup(stack.pop()); if (o) walk(o); }
  const dead = []; for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(key(ref))) dead.push(ref);
  for (const r of dead) ctx.delete(r);
}

/* Load the rebuilt file into the viewer, keeping the page, zoom and scroll position */
async function swapDocument(bytes) {
  const docId = S.docId, task = pdfjsLib.getDocument({ ...DOC_OPTIONS, data: bytes.slice() });
  const pdf = await task.promise;
  if (docId !== S.docId) { pdf.destroy(); return; }
  const oldPdf = S.pdf;
  for (const p of S.pages) { p.task?.cancel(); p.textLayer?.cancel(); }
  S.pdf = pdf; S.task = task;
  for (const p of S.pages) { p.page = null; p.annots = null; p.renderedKey = ''; p.renderingKey = ''; p.task = null; }
  await Promise.all(S.pages.filter((p) => p.rendered).map(async (p) => { try { p.page = await pdf.getPage(p.num); } catch { /* reloaded later */ } }));
  refreshThumbSizes(true); scheduleRender(0);
  try { oldPdf?.destroy(); } catch { /* already gone */ }
}

/* ---------------------------------------------------------------------
   The list in the Comments tab
   --------------------------------------------------------------------- */
async function focusForeign(f) {
  if (A.tool !== 'select') setTool('select');
  const p = S.pages[f.page - 1]; await getPage(p); closePop(true);
  scrollToPdfRect(p, f.rect); await waitRendered(p);
  selectForeign(f.id);
}

function foreignCard(f) {
  const hex = f.color || '#8a8394';
  const b = el('div', 'cm ro', { tabIndex: 0 }); b.setAttribute('role', 'button');
  b.style.setProperty('--c', hex); b.style.setProperty('--l', hex);
  if (A.fsel.has(f.id)) b.classList.add('active');
  const top = el('div', 'cm-top', { innerHTML: `<svg><use href="#${FOREIGN_ICON[f.type] || 'i-highlight'}"/></svg>` });
  top.append(el('b', '', { textContent: f.author || foreignLabel(f), dir: 'auto' }), el('span', '', { textContent: f.created ? timeAgo(Date.parse(f.created)) : '' }));
  b.append(top);
  b.append(el('p', 'cm-quote', { textContent: foreignLabel(f) }));
  if (f.text) b.append(el('p', 'cm-text', { textContent: f.text, dir: 'auto' }));
  for (const r of f.replies || []) b.append(el('div', 'cm-rep', { textContent: `${r.author ? r.author + ': ' : ''}${r.text}`, dir: 'auto' }));
  const x = el('button', 'icon-btn sm cm-x', { type: 'button', title: 'Remove this markup', innerHTML: '<svg><use href="#i-trash"/></svg>' });
  x.setAttribute('aria-label', 'Remove this markup');
  x.addEventListener('click', (e) => { e.stopPropagation(); removeMarkups(new Set([f.id])); });
  b.append(x);
  b.addEventListener('click', () => focusForeign(f));
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter') focusForeign(f); });
  b.addEventListener('mouseenter', () => setPreview(new Set(), 0) || setForeignHover(f.id));
  b.addEventListener('mouseleave', () => setForeignHover(null));
  return b;
}

function renderExistingSection(frag, onlyWithText) {
  let all = visForeign(); if (onlyWithText) all = all.filter((f) => f.text);
  if (!all.length) return;
  const head = el('div', 'cm-group', { textContent: `In the original file · ${all.length}` });
  head.append(el('small', '', { textContent: 'Made in other PDF apps. Click one to select it, then press Delete, or use the Remove tool (E).' }));
  frag.append(head);

  const counts = new Map(); for (const f of all) counts.set(f.type, (counts.get(f.type) || 0) + 1);
  if (A.fchip !== 'all' && !counts.has(A.fchip)) A.fchip = 'all';
  const chips = el('div', 'ex-chips');
  const chip = (key, label, n) => {
    const c = el('button', `ex-chip${A.fchip === key ? ' on' : ''}`, { type: 'button', textContent: `${label} ${n}` });
    c.addEventListener('click', () => { A.fchip = key; A.fshown = 120; renderComments(true); }); chips.append(c);
  };
  chip('all', 'All', all.length);
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) chip(t, FOREIGN_LABEL[t] || t, n);
  frag.append(chips);

  const authors = [...new Set(all.map((f) => f.author).filter(Boolean))].sort();
  if (authors.length > 1) {
    const sel = el('select', 'ex-author'); sel.setAttribute('aria-label', 'Show markups by');
    sel.append(el('option', '', { value: 'all', textContent: 'All authors' }), ...authors.map((a) => el('option', '', { value: a, textContent: a })));
    if (!authors.includes(A.fauthor)) A.fauthor = 'all';
    sel.value = A.fauthor; sel.addEventListener('change', () => { A.fauthor = sel.value; A.fshown = 120; renderComments(true); });
    frag.append(sel);
  }

  const shown = all.filter((f) => (A.fchip === 'all' || f.type === A.fchip) && (A.fauthor === 'all' || f.author === A.fauthor))
    .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
  const rm = el('button', 'ex-remove', { type: 'button', disabled: !shown.length, innerHTML: `<svg><use href="#i-trash"/></svg>Remove ${shown.length === all.length ? 'all ' : 'these '}${shown.length}…` });
  rm.addEventListener('click', async () => {
    const ok = await modal({
      title: `Remove ${shown.length} ${shown.length === 1 ? 'markup' : 'markups'}?`, icon: 'i-trash', ok: 'Remove', cancel: 'Cancel',
      body: 'They are deleted from the PDF when you save, including the text of any comments. Until then you can bring them back with Undo (Ctrl+Z).'
    });
    if (ok) removeMarkups(new Set(shown.map((f) => f.id)));
  });
  frag.append(rm);

  let lp = 0;
  for (const f of shown.slice(0, A.fshown)) { if (f.page !== lp) { lp = f.page; frag.append(el('div', 'cm-page', { textContent: `Page ${f.page}` })); } frag.append(foreignCard(f)); }
  if (shown.length > A.fshown) {
    const more = el('button', 'ex-more', { type: 'button', textContent: `Show ${Math.min(120, shown.length - A.fshown)} more` });
    more.addEventListener('click', () => { A.fshown += 120; renderComments(true); }); frag.append(more);
  }
}

/* ---------------------------------------------------------------------
   Document lifecycle
   --------------------------------------------------------------------- */
function existingDocClosed() {
  clearTimeout(applyTimer); applyChain = Promise.resolve();
  A.removed = new Set(); A.foreignAll = new Map(); A.foreignByPage = new Map(); A.fsel = new Set(); A.preview = new Set(); A.fhover = null; A.applied = ''; edReset(); A.fchip = 'all'; A.fauthor = 'all'; A.fshown = 120;
}


/* ---------------------------------------------------------------------
   Pan (hand) tool: drag the page to move around.
   Also: hold Space and drag, or drag with the middle mouse button.
   --------------------------------------------------------------------- */
const PAN = { on: false, id: null, x: 0, y: 0, sl: 0, st: 0, moved: false, vx: 0, vy: 0, lt: 0, lx: 0, ly: 0, raf: 0, space: false, spaceMoved: false, spaceAt: 0, swallow: false };
const calmMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function panCoast() {
  PAN.raf = 0;
  if (Math.abs(PAN.vx) < 0.02 && Math.abs(PAN.vy) < 0.02) return;
  const dt = 16;
  viewer.scrollLeft += PAN.vx * dt; viewer.scrollTop += PAN.vy * dt;
  PAN.vx *= 0.93; PAN.vy *= 0.93;
  PAN.raf = requestAnimationFrame(panCoast);
}
function panHalt() { if (PAN.raf) cancelAnimationFrame(PAN.raf); PAN.raf = 0; }
function panEnd(e) {
  if (!PAN.on || (e && e.pointerId !== PAN.id)) return;
  PAN.on = false;
  try { viewer.releasePointerCapture(PAN.id); } catch (_) { /* already released */ }
  document.body.classList.remove('is-panning');
  PAN.swallow = PAN.moved;
  if (PAN.moved && e && e.type === 'pointerup' && !calmMotion && performance.now() - PAN.lt < 90 && Math.hypot(PAN.vx, PAN.vy) > 0.15) PAN.raf = requestAnimationFrame(panCoast);
}
viewer.addEventListener('pointerdown', (e) => {
  PAN.swallow = false;
  if (!S.pdf || e.pointerType === 'touch') return;                          // a finger already scrolls the page by itself
  const want = e.button === 1 || (e.button === 0 && (A.tool === 'pan' || PAN.space));
  if (!want) return;
  e.preventDefault(); e.stopImmediatePropagation();
  panHalt(); hideSelbar();
  Object.assign(PAN, { on: true, id: e.pointerId, x: e.clientX, y: e.clientY, sl: viewer.scrollLeft, st: viewer.scrollTop, moved: false, vx: 0, vy: 0, lt: performance.now(), lx: e.clientX, ly: e.clientY });
  if (PAN.space) PAN.spaceMoved = true;
  try { viewer.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
  document.body.classList.add('is-panning');
}, true);
viewer.addEventListener('pointermove', (e) => {
  if (!PAN.on || e.pointerId !== PAN.id) return;
  const dx = e.clientX - PAN.x, dy = e.clientY - PAN.y;
  if (!PAN.moved && Math.hypot(dx, dy) < 3) return;
  PAN.moved = true;
  viewer.scrollLeft = PAN.sl - dx; viewer.scrollTop = PAN.st - dy;
  const now = performance.now(), dt = Math.max(1, now - PAN.lt);
  PAN.vx = 0.6 * PAN.vx + 0.4 * (-(e.clientX - PAN.lx) / dt);
  PAN.vy = 0.6 * PAN.vy + 0.4 * (-(e.clientY - PAN.ly) / dt);
  PAN.lt = now; PAN.lx = e.clientX; PAN.ly = e.clientY;
}, true);
viewer.addEventListener('pointerup', panEnd, true);
viewer.addEventListener('pointercancel', panEnd, true);
viewer.addEventListener('lostpointercapture', panEnd, true);
viewer.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }, true);   // no auto-scroll cursor
viewer.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }, true);
viewer.addEventListener('click', (e) => { if (PAN.swallow) { PAN.swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);   // a drag that ends on a link is not a click
viewer.addEventListener('wheel', panHalt, { passive: true });

function spaceOff() { if (!PAN.space) return; PAN.space = false; document.body.classList.remove('space-pan'); }
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (!S.pdf || !$('modal').hidden || !$('sigDlg').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t !== document.body && t !== viewer && !(t instanceof Node && viewer.contains(t))) return;      // leave Space alone on buttons and fields
  if (/^(input|textarea|select|button)$/i.test(t.tagName) || t.isContentEditable || A.editing) return;
  e.preventDefault();
  if (e.repeat) return;
  PAN.space = true; PAN.spaceMoved = false; PAN.spaceAt = performance.now(); panHalt();
  document.body.classList.add('space-pan');
}, true);
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const wasSpace = PAN.space, moved = PAN.spaceMoved, quick = performance.now() - PAN.spaceAt < 350;
  spaceOff();
  if (wasSpace && !moved && quick && S.pdf && !PAN.on) {                                              // a plain tap of Space still pages down (Shift: up)
    viewer.scrollBy({ top: (e.shiftKey ? -1 : 1) * viewer.clientHeight * 0.9, behavior: 'smooth' });
  }
}, true);
window.addEventListener('blur', () => { spaceOff(); });

/*@@EXTRA@@*/

document.body.classList.add('ready');
showStart();

/* ---------------------------------------------------------------------
   Desktop app (Heurix-PDF-Viewer.exe): the launcher serves a tab strip ("shell") from 127.0.0.1
   and shows each document in its own frame. In a normal browser none of this runs.
   --------------------------------------------------------------------- */
function makeServerHandle(token, name) {
  const url = `/__file?t=${encodeURIComponent(token)}`;
  return {
    kind: 'file', name, token, __server: true,
    async getFile() {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) { const e = new Error(r.status === 404 ? 'File not found' : `HTTP ${r.status}`); e.name = r.status === 404 ? 'NotFoundError' : 'Error'; throw e; }
      return new File([await r.blob()], name, { type: 'application/pdf', lastModified: Date.now() });
    },
    async createWritable() {
      const parts = [];
      return {
        async write(d) { parts.push(d); },
        async close() {
          const r = await fetch(url, { method: 'PUT', headers: { 'X-Heurix': '1' }, body: new Blob(parts) });
          if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        }
      };
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async isSameEntry(o) { return o === this; }
  };
}
if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  const tok = new URLSearchParams(location.search).get('f');
  if (tok) (async () => {
    try { const m = await (await fetch(`/__meta?t=${encodeURIComponent(tok)}`)).json(); await openHandle(makeServerHandle(tok, m.name), null, true); }
    catch (e) { toast(`Could not open the file: ${e?.message || e}`, 'error'); }
  })();
}
if (EMBED) {
  // This page lives inside a tab. The tab strip is told what is open, and asks us to open or close things.
  let last = '';
  setInterval(() => {
    const name = S.pdf ? S.name : '', st = JSON.stringify([name, !!A.dirty]);
    if (st !== last) { last = st; toParent({ hx: 'state', name, dirty: !!A.dirty }); }
  }, 250);
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const m = e.data; if (!m || typeof m !== 'object') return;
    if (m.hx === 'open') {
      if (m.token) await openHandle(makeServerHandle(m.token, m.name), null, true);
      else if (m.handle) await openHandle(m.handle, null, true);
      else if (m.file) await openFileObject(m.file, true);
    } else if (m.hx === 'requestclose') {
      let ok = true;
      try { ok = !S.pdf || (await confirmLeave()); } catch (_) { ok = true; }
      toParent({ hx: 'closeresult', ok });
    } else if (m.hx === 'focus') {
      try { $('viewer').focus({ preventScroll: true }); } catch (_) { /* not focusable yet */ }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); toParent({ hx: 'key', k: e.shiftKey ? 'prev' : 'next' }); }
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); toParent({ hx: 'key', k: 'new' }); }
  }, true);
  toParent({ hx: 'ready' });
}

// Exposed for diagnostics and for the phase-2 annotation module.
window.HeurixViewer = { state: S, annots: A, annotApi, openDocument, openHandle, goToPage, setZoom, rotate, getPage, pdfjsLib };

