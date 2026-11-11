
/* =====================================================================
   Edit mode: the interface for changing the PDF itself
   (select objects, erase text, move / resize / recolour / delete, add images)
   ===================================================================== */
const ED = { doc: null, docP: null, docId: -1, pages: new Map(), open: new Map(), cycle: null, hoverRaf: 0, warned: false };
const EDTOL = 5;                                               // click tolerance in screen pixels
const I6 = () => [1, 0, 0, 1, 0, 0];
function edEmpty() { return { del: [], cut: {}, xf: {}, sty: {}, add: [], txt: {} }; }
function edHas(e) { return !!(e && (e.del.length || e.add.length || Object.keys(e.cut).length || Object.keys(e.xf).length || Object.keys(e.sty).length || Object.keys(e.txt || {}).length)); }
const edTx = () => (A.ed.txt || (A.ed.txt = {}));
function edKey() { return edHas(A.ed) ? JSON.stringify(A.ed) : ''; }

Object.assign(TOOL_HINT, {
  osel: 'Click an object, or drag a box around several. Double-click a group to open it',
  etext: 'Drag a box over the words you want to erase',
  etxt: 'Click a line of text to change its words. Enter applies, Esc cancels',
  addimg: 'Click on the page to place the picture, or drag to size it'
});

function edReset() {
  for (const a of A.edAssets.values()) { try { URL.revokeObjectURL(a.url); } catch { /* ignore */ } }
  ED.doc = null; ED.docP = null; ED.docId = -1; ED.pages = new Map(); ED.open = new Map(); ED.cycle = null;
  A.ed = edEmpty(); A.edSel = new Set(); A.edHover = null; A.appliedEd = ''; A.edPending = null; A.edAssets = new Map();
  if (A.mode === 'edit') setMode('comment');
}

/* ---------- reading the page content ---------- */
function edDoc() {
  if (ED.docP && ED.docId === S.docId) return ED.docP;
  ED.docId = S.docId; ED.pages = new Map(); ED.open = new Map();
  ED.docP = (async () => { const PL = await loadPdfLib(); return PL.PDFDocument.load(S.srcBytes, loadOpts(PL)); })();
  ED.docP.catch(() => { ED.docP = null; });
  return ED.docP;
}

function edPage(n, force) {
  const c = ED.pages.get(n);
  if (c && (c.busy || !force)) return c.A;
  ED.pages.set(n, { A: c ? c.A : null, busy: true });
  const id = S.docId;
  (async () => {
    let res = null, err = false;
    try {
      const PL = await loadPdfLib(), doc = await edDoc();
      const a = await HXEdit.analyzePage(PL, doc, n - 1, ED.open.get(n) || new Set());
      a.runs = new Map(); a.byUid = new Map(); a.runOwner = new Map();
      for (const o of a.objs) { a.byUid.set(o.uid, o); if (o.kind === 'text') for (const r of o.runs) { a.runs.set(a.prefix + r.id, r); a.runOwner.set(a.prefix + r.id, o.uid); } }
      res = a;
    } catch (e) { console.warn('Could not read the content of page', n, e); err = true; }
    if (id !== S.docId) return;
    ED.pages.set(n, { A: res, err });
    const p = S.pages[n - 1]; if (p && p.rendered) drawAnnots(p);
    if (err && A.mode === 'edit' && !ED.warned) { ED.warned = true; toast('This page’s content could not be read, so only added pictures can be edited here.', 'error'); }
  })();
  return c ? c.A : null;
}

const edAddOf = (n) => A.ed.add.filter((a) => a.page === n);
function edTextAlive(o) {
  for (const r of o.runs) {
    const cut = A.ed.cut[o.prefix + r.id]; if (!cut) return true;
    let c = 0; for (const [a, b] of cut) c += b - a; if (c < r.glyphs.length) return true;
  }
  return false;
}
function edObjs(n) {
  const info = ED.pages.get(n)?.A, out = [];
  if (info) {
    const gone = new Set(A.ed.del), hasCut = Object.keys(A.ed.cut).length > 0;
    for (const o of info.objs) {
      if (o.hidden || gone.has(o.uid) || (o.kind === 'path' && o.clip)) continue;
      if (o.kind === 'text') { if (gone.has(o.parentUid)) continue; if (hasCut && !edTx()[o.uid] && !edTextAlive({ runs: o.runs, prefix: info.prefix })) continue; }
      out.push(o);
    }
  }
  for (const a of edAddOf(n)) out.push({ uid: `add:${a.id}`, kind: 'image', added: true, add: a, page: n });
  return out;
}
const edPageOfUid = (uid) => { if (uid.startsWith('add:')) { const a = A.ed.add.find((x) => `add:${x.id}` === uid); return a ? a.page : 0; } return HXEdit.pageOfId(uid); };
const edFind = (uid) => { const n = edPageOfUid(uid); return edObjs(n).find((o) => o.uid === uid) || null; };

const EDFAM = { Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif', Times: '"Times New Roman", Times, "Liberation Serif", serif', Courier: '"Courier New", Courier, "Liberation Mono", monospace' };
const edFamOf = (std) => (/^Times/.test(std) ? 'Times' : /^Courier/.test(std) ? 'Courier' : 'Helvetica');
function edTxtWidth(tx, size) {
  const std = tx.f || 'Helvetica';
  measureCtx.font = `${/Italic|Oblique/.test(std) ? 'italic ' : ''}${/Bold/.test(std) ? 'bold ' : ''}${size}px ${EDFAM[edFamOf(std)]}`;
  return measureCtx.measureText(tx.t || '').width;
}
function edBox(o) {
  if (o.added) return [o.add.x0, o.add.y0, o.add.x1, o.add.y1];
  const tx = o.kind === 'text' && A.ed.txt && A.ed.txt[o.uid];
  if (tx) {
    const b = o.bbox, F = o.runs[0].F, flat = Math.abs(F[1]) < 1e-6 && Math.abs(F[2]) < 1e-6 && F[0] > 0 && F[3] > 0;
    if (flat) { const w = edTxtWidth(tx, tx.s > 0 ? tx.s : o.fs); return [b[0], b[1], Math.max(b[2], b[0] + w), b[3]]; }
    return b;
  }
  const xf = A.ed.xf[o.uid]; if (!xf) return o.bbox;
  const b = o.bbox, pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => HXEdit.ap(xf, x, y));
  return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
}
const edResizable = (o) => o.kind !== 'text';
const edIsPaintedPath = (o) => o.kind === 'path' && !o.clip && o.paint;

function edIsBackdrop(p, o) {
  if (o.kind === 'text' || o.added) return false;
  const v = p.page.view, b = edBox(o);
  return (b[2] - b[0]) * (b[3] - b[1]) > 0.8 * (v[2] - v[0]) * (v[3] - v[1]);
}

function edHitAt(p, x, y) {
  const tol = EDTOL / (S.zoom * CSS_UNITS), list = edObjs(p.num), all = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    if (o.added) { const b = edBox(o); if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) all.push(o); continue; }
    let qx = x, qy = y, t = tol; const xf = A.ed.xf[o.uid];
    if (xf) { const iv = HXEdit.inv(xf); if (!iv) continue; [qx, qy] = HXEdit.ap(iv, x, y); t = tol / HXEdit.scaleOf(xf); }
    if (HXEdit.hitTest(o, qx, qy, t)) all.push(o);
  }
  const top = all.filter((o) => !edIsBackdrop(p, o));
  return { top: top[0] || null, all };
}

/* ---------- drawing the overlay ---------- */
function edActiveFor() { return A.mode === 'edit' || edKey() !== A.appliedEd; }

function drawEdit(p, vp, px, py, frag) {
  const inEdit = A.mode === 'edit', pending = edKey() !== A.appliedEd;
  if (!inEdit && !pending) return;
  if (inEdit && !ED.pages.has(p.num)) edPage(p.num);
  const box = (r, cls) => {
    const b = boxOf(vp, r), d = el('div', `ed-box ${cls}`);
    d.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`; frag.append(d); return d;
  };
  const info = ED.pages.get(p.num)?.A, op = A.op && A.op.p === p ? A.op : null;

  if (pending) {
    for (const a of edAddOf(p.num)) {
      const asset = A.edAssets.get(a.asset); if (!asset) continue;
      const b = boxOf(vp, [a.x0, a.y0, a.x1, a.y1]), im = el('img', 'ed-img', { src: asset.url, alt: '', draggable: false });
      im.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`; frag.append(im);
    }
    if (info) {
      for (const uid in edTx()) {
        const o = info.byUid.get(uid), tx = A.ed.txt[uid]; if (!o) continue;
        const F = o.runs[0].F, flat = Math.abs(F[1]) < 1e-6 && Math.abs(F[2]) < 1e-6 && F[0] > 0 && F[3] > 0 && !((p.page.rotate + S.rotation) % 360);
        if (!flat) { box(o.bbox, 'gone'); continue; }
        const size = tx.s > 0 ? tx.s : o.fs, b = boxOf(vp, edBox(o)), d = el('div', 'ed-newtxt', { textContent: tx.t });
        d.style.cssText = `left:${px(b.x)};top:${py(b.y)};min-width:${px(b.w)};height:${py(b.h)};font:${/Italic|Oblique/.test(tx.f) ? 'italic ' : ''}${/Bold/.test(tx.f) ? 'bold ' : ''}calc(var(--total-scale-factor) * ${size}px) ${EDFAM[edFamOf(tx.f || '')]};color:${tx.c || '#000'}`;
        frag.append(d);
      }
      for (const uid of A.ed.del) { const o = info.byUid.get(uid); if (o && o.bbox) box(o.bbox, 'gone'); }
      for (const uid in A.ed.cut) {
        const r = info.runs.get(uid); if (!r) continue;
        for (const q of HXEdit.rangeQuads(r, A.ed.cut[uid])) box([Math.min(...q.map((z) => z[0])), Math.min(...q.map((z) => z[1])), Math.max(...q.map((z) => z[0])), Math.max(...q.map((z) => z[1]))], 'gone');
      }
    }
  }
  if (!inEdit) return;

  const objs = edObjs(p.num), by = new Map(objs.map((o) => [o.uid, o]));
  const moving = op && op.kind === 'edmove' ? op : null;
  for (const uid of A.edSel) {
    const o = by.get(uid); if (!o) continue;
    let r = edBox(o);
    if (moving && moving.moving.has(uid)) r = [r[0] + moving.d[0], r[1] + moving.d[1], r[2] + moving.d[0], r[3] + moving.d[1]];
    if (op && op.kind === 'edresize' && op.uid === uid && op.nb) r = op.nb;
    box(r, 'sel');
  }
  if (A.edHover && !A.edSel.has(A.edHover) && !op) { const o = by.get(A.edHover); if (o) box(edBox(o), 'hover'); }

  if (A.edSel.size === 1 && !op) {                                                    // resize handles
    const uid = [...A.edSel][0], o = by.get(uid);
    if (o && edResizable(o)) {
      const b = boxOf(vp, edBox(o));
      const pts = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
      for (const h in pts) {
        const d = el('div', 'ed-h'); d.dataset.h = h; d.dataset.uid = uid;
        d.style.cssText = `left:${px(b.x + pts[h][0] * b.w)};top:${py(b.y + pts[h][1] * b.h)}`; frag.append(d);
      }
    }
  }
  if (op && (op.kind === 'edmarq' || op.kind === 'edtext' || op.kind === 'edimg') && op.rb) {
    const b = boxOf(vp, op.rb), d = el('div', 'an-rubber'); d.style.cssText = `left:${px(b.x)};top:${py(b.y)};width:${px(b.w)};height:${py(b.h)}`;
    if (op.kind === 'edimg') d.style.borderColor = 'var(--violet-2)'; frag.append(d);
  }
  if (op && op.kind === 'edtext' && op.hit) for (const q of op.hit.boxes) box([Math.min(...q.map((z) => z[0])), Math.min(...q.map((z) => z[1])), Math.max(...q.map((z) => z[0])), Math.max(...q.map((z) => z[1]))], 'gone');
}

function edRedraw(pages) {
  const set = new Set(pages || S.pages.filter((p) => p.rendered).map((p) => p.num));
  for (const n of set) { const p = S.pages[n - 1]; if (p && p.rendered) drawAnnots(p); }
}
const edSelPages = () => new Set([...A.edSel].map(edPageOfUid).filter(Boolean));

function edSelChanged(extraPages) {
  const pages = edSelPages(); for (const n of extraPages || []) pages.add(n);
  edRedraw(pages); refreshObjbar(); edSyncUI();
}
function edSetSel(next, extra) {
  const before = edSelPages(); A.edSel = next;
  for (const n of extra || []) before.add(n);
  for (const n of edSelPages()) before.add(n);
  edRedraw(before); refreshObjbar(); edSyncUI();
}

/* ---------- pointer handling ---------- */
function edPointerDown(e) {
  const t = e.target, hd = t.closest?.('.ed-h');
  if (hd) return edBeginResize(e, hd);
  if (!['osel', 'etext', 'addimg', 'etxt'].includes(A.tool)) return false;
  const pageEl = t.closest?.('.page'); if (!pageEl) return false;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return false;
  e.preventDefault(); closePop(true); try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
  const start = pdfPointAt(p, e.clientX, e.clientY), base = { p, start, cx: e.clientX, cy: e.clientY, moved: false };
  if (A.tool === 'etext') { edPage(p.num); beginOp({ ...base, kind: 'edtext', rb: null, hit: null }); return true; }
  if (A.tool === 'etxt') {
    const c = ED.pages.get(p.num);
    if (!c?.A) { edPage(p.num); toast(c?.err ? 'This page’s content could not be read.' : 'Reading this page… try again in a moment.'); return true; }
    const hit = edHitAt(p, start[0], start[1]).all.find((o) => o.kind === 'text');
    if (hit) edStartText(hit, p); else toast('Click on a line of text to change it. Text inside a group: use Select objects and double-click the group first.');
    return true;
  }
  if (A.tool === 'addimg') {
    if (!A.edPending) { edAddImage(); return true; }
    beginOp({ ...base, kind: 'edimg', rb: null }); return true;
  }
  const c = ED.pages.get(p.num);
  if (!c?.A && !edAddOf(p.num).length && !c?.err) { edPage(p.num); toast('Reading this page… try again in a moment.'); return true; }
  const { top, all } = edHitAt(p, start[0], start[1]);
  let hit = top;
  if (e.altKey && all.length) {
    const cy = ED.cycle; let i = 0;
    if (cy && cy.n === p.num && Math.hypot(cy.x - e.clientX, cy.y - e.clientY) < 4) i = (cy.i + 1) % all.length;
    ED.cycle = { n: p.num, x: e.clientX, y: e.clientY, i }; hit = all[i];
  }
  if (hit) {
    if (e.shiftKey) { const n = new Set(A.edSel); if (n.has(hit.uid)) n.delete(hit.uid); else n.add(hit.uid); edSetSel(n, [p.num]); return true; }
    if (!A.edSel.has(hit.uid)) edSetSel(new Set([hit.uid]), [p.num]);
    const moving = new Set([...A.edSel].filter((u) => edPageOfUid(u) === p.num));
    beginOp({ ...base, kind: 'edmove', d: [0, 0], moving });
  } else {
    if (!e.shiftKey && A.edSel.size) edSetSel(new Set(), [p.num]);
    beginOp({ ...base, kind: 'edmarq', rb: null, baseSel: e.shiftKey ? new Set(A.edSel) : new Set() });
  }
  return true;
}

function edBeginResize(e, hd) {
  const o = edFind(hd.dataset.uid); if (!o) return true;
  const p = S.pages[edPageOfUid(o.uid) - 1]; if (!p) return true;
  e.preventDefault(); e.stopPropagation();
  beginOp({ kind: 'edresize', p, uid: o.uid, h: hd.dataset.h, b0: edBox(o).slice(), keep: o.kind === 'image', nb: null, moved: false, cx: e.clientX, cy: e.clientY });
  return true;
}

function edMarquee(op) {
  const rb = op.rb, touch = op.alt, ids = new Set(op.baseSel);
  for (const o of edObjs(op.p.num)) {
    if (edIsBackdrop(op.p, o)) continue;
    const b = edBox(o);
    const inside = b[0] >= rb[0] && b[2] <= rb[2] && b[1] >= rb[1] && b[3] <= rb[3];
    const hit = touch && !(b[2] < rb[0] || b[0] > rb[2] || b[3] < rb[1] || b[1] > rb[3]);
    if (inside || hit) ids.add(o.uid);
  }
  return ids;
}

function edOpMove(op, e) {
  if (!op.moved && Math.hypot(e.clientX - op.cx, e.clientY - op.cy) < 4) return;
  op.moved = true; hideObjbar();
  const cur = pdfPointAt(op.p, e.clientX, e.clientY);
  if (op.kind === 'edmove') {
    let dx = cur[0] - op.start[0], dy = cur[1] - op.start[1];
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    op.d = [dx, dy];
  } else if (op.kind === 'edmarq') {
    op.rb = normRect(op.start, cur); op.alt = e.altKey;
    const next = edMarquee(op), same = next.size === A.edSel.size && [...next].every((u) => A.edSel.has(u));
    if (!same) { A.edSel = next; edSyncUI(); }
  } else if (op.kind === 'edtext') {
    op.rb = normRect(op.start, cur);
    op.hit = edGlyphHit(ED.pages.get(op.p.num)?.A, op.rb);
  } else if (op.kind === 'edimg') {
    op.rb = edImageRect(op, cur, true);
  } else if (op.kind === 'edresize') edResizeMove(op, e);
  redrawOpPage(op);
}

function edGlyphHit(info, rb) {
  if (!info) return null;
  const raw = HXEdit.glyphsInRect(info, rb), gone = new Set(A.ed.del), cut = {}, boxes = []; let count = 0;
  for (const k in raw.cut) {
    if (gone.has(info.runOwner.get(k))) continue;
    cut[k] = raw.cut[k]; const run = info.runs.get(k);
    for (const [a, b] of raw.cut[k]) count += b - a;
    if (run) for (const q of HXEdit.rangeQuads(run, raw.cut[k])) boxes.push(q);
  }
  return { cut, count, boxes };
}

function edResizeMove(op, e) {
  const p = op.p, vp = vp1(p), r = p.div.getBoundingClientRect();
  const vx = ((e.clientX - r.left) / r.width) * vp.width, vy = ((e.clientY - r.top) / r.height) * vp.height;
  const vb = boxOf(vp, op.b0); let L = vb.x, T = vb.y, R = vb.x + vb.w, B = vb.y + vb.h;
  const h = op.h, MIN = 6;
  if (h.includes('w')) L = Math.min(vx, R - MIN); if (h.includes('e')) R = Math.max(vx, L + MIN);
  if (h.includes('n')) T = Math.min(vy, B - MIN); if (h.includes('s')) B = Math.max(vy, T + MIN);
  if ((op.keep || e.shiftKey) && h.length === 2 && vb.w > 0 && vb.h > 0) {
    const ratio = vb.w / vb.h; let nw = R - L, nh = B - T;
    if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
    if (h.includes('w')) L = R - nw; else R = L + nw;
    if (h.includes('n')) T = B - nh; else B = T + nh;
  }
  const a = vp.convertToPdfPoint(L, T), c = vp.convertToPdfPoint(R, B);
  op.nb = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
}

function edImageRect(op, cur, drag) {
  const pend = A.edPending, rot = ((op.p.page.rotate || 0) % 360 + 360) % 360, ar = pend.w / pend.h, R = rot % 180 ? 1 / ar : ar;
  const s = op.start;
  if (drag) {
    let w = Math.abs(cur[0] - s[0]), h = Math.abs(cur[1] - s[1]);
    if (w / Math.max(h, 1e-6) > R) w = h * R; else h = w / Math.max(R, 1e-6);
    const x0 = cur[0] < s[0] ? s[0] - w : s[0], y0 = cur[1] < s[1] ? s[1] - h : s[1];
    return [x0, y0, x0 + w, y0 + h].map(r2);
  }
  const v = op.p.page.view, pw = v[2] - v[0], ph = v[3] - v[1];
  let dw = Math.min(pend.w * 0.75, (rot % 180 ? ph : pw) * 0.4);                       // displayed width in points
  dw = Math.max(dw, 24); let dh = dw / ar;
  const w = rot % 180 ? dh : dw, h = rot % 180 ? dw : dh;
  let x0 = s[0] - w / 2, y0 = s[1] - h / 2;
  x0 = clampN(x0, v[0], Math.max(v[0], v[2] - w)); y0 = clampN(y0, v[1], Math.max(v[1], v[3] - h));
  return [x0, y0, x0 + w, y0 + h].map(r2);
}

function edOpUp(op) {
  const p = op.p;
  if (op.kind === 'edmove') {
    if (!op.moved) { edSelChanged([p.num]); return; }
    const movable = [...op.moving].filter((u) => { const o = edFind(u); return o && o.kind !== 'text'; });
    if (!movable.length) { toast('Text lines can’t be dragged. Erase them, then add a text box in Comment mode, or move the shapes and pictures.'); edRedraw([p.num]); return; }
    if (Math.hypot(op.d[0], op.d[1]) * S.zoom * CSS_UNITS < 1) { edRedraw([p.num]); return; }
    pushHistory(); edTranslate(movable, op.d); edChanged([p.num]); return;
  }
  if (op.kind === 'edresize') {
    if (!op.moved || !op.nb) { edRedraw([p.num]); return; }
    const o = edFind(op.uid), b0 = op.b0, nb = op.nb; if (!o) return;
    pushHistory();
    if (o.added) { Object.assign(o.add, { x0: r2(nb[0]), y0: r2(nb[1]), x1: r2(nb[2]), y1: r2(nb[3]) }); }
    else {
      const w0 = b0[2] - b0[0], h0 = b0[3] - b0[1];
      const sx = w0 > 0.01 ? (nb[2] - nb[0]) / w0 : 1, sy = h0 > 0.01 ? (nb[3] - nb[1]) / h0 : 1;
      const X = [sx, 0, 0, sy, w0 > 0.01 ? nb[0] - sx * b0[0] : (nb[0] + nb[2]) / 2 - (b0[0] + b0[2]) / 2 + 0, h0 > 0.01 ? nb[1] - sy * b0[1] : (nb[1] + nb[3]) / 2 - (b0[1] + b0[3]) / 2 + 0];
      if (w0 <= 0.01) X[4] = nb[0] - b0[0]; if (h0 <= 0.01) X[5] = nb[1] - b0[1];
      A.ed.xf[o.uid] = HXEdit.mul(A.ed.xf[o.uid] || I6(), X);
    }
    edChanged([p.num]); return;
  }
  if (op.kind === 'edmarq') { edSelChanged([p.num]); return; }
  if (op.kind === 'edtext') {
    const hit = op.hit; op.rb = null; op.hit = null;
    if (!op.moved) { toast('Drag a box over the words you want to erase.'); edRedraw([p.num]); return; }
    if (!hit || !hit.count) { edRedraw([p.num]); return; }
    pushHistory(); HXEdit.mergeCut(A.ed.cut, hit.cut);
    toast(`Erased ${hit.count} ${hit.count === 1 ? 'character' : 'characters'}. Press Ctrl+Z to bring ${hit.count === 1 ? 'it' : 'them'} back.`, 'success');
    edChanged([p.num]); return;
  }
  if (op.kind === 'edimg') {
    const pend = A.edPending; if (!pend) { edRedraw([p.num]); return; }
    const rect = op.moved && op.rb && (op.rb[2] - op.rb[0]) * S.zoom * CSS_UNITS > 8 ? op.rb : edImageRect(op, op.start, false);
    const a = { id: uid(), page: p.num, asset: pend.id, x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3], rot: ((p.page.rotate || 0) % 360 + 360) % 360 };
    pushHistory(); A.ed.add.push(a); A.edSel = new Set([`add:${a.id}`]); A.edPending = null;
    setTool('osel'); edChanged([p.num]); return;
  }
}

function edTranslate(uids, d) {
  for (const uid of uids) {
    const o = edFind(uid); if (!o) continue;
    if (o.added) { const a = o.add; a.x0 = r2(a.x0 + d[0]); a.x1 = r2(a.x1 + d[0]); a.y0 = r2(a.y0 + d[1]); a.y1 = r2(a.y1 + d[1]); }
    else A.ed.xf[uid] = HXEdit.mul(A.ed.xf[uid] || I6(), [1, 0, 0, 1, d[0], d[1]]);
  }
}

/* ---------- applying changes to the file ---------- */
function edChanged(pages) {
  scheduleApplyRemovals(450);
  edRedraw(new Set([...(pages || []), ...edSelPages()]));
  refreshState(); refreshObjbar(); edSyncUI();
}

function edDeleteSel() {
  if (!A.edSel.size || !canEdit()) return;
  const uids = [...A.edSel], pages = edSelPages();
  pushHistory();
  let n = 0;
  for (const uid of uids) {
    const o = edFind(uid); if (!o) continue;
    n++;
    if (o.added) { A.ed.add = A.ed.add.filter((a) => `add:${a.id}` !== uid); continue; }
    A.ed.del.push(uid); delete A.ed.xf[uid]; delete A.ed.sty[uid]; delete edTx()[uid];
    if (o.kind === 'text') for (const r of o.runs) delete A.ed.cut[`p${HXEdit.pageOfId(uid)}:${r.id}`];
  }
  A.edSel = new Set(); A.edHover = null;
  edChanged([...pages]);
  toast(`Deleted ${n} ${n === 1 ? 'object' : 'objects'}. Press Ctrl+Z to bring ${n === 1 ? 'it' : 'them'} back.`, 'success');
}

function edNudge(dx, dy, big) {
  const step = big ? 10 : 1, uids = [...A.edSel].filter((u) => { const o = edFind(u); return o && o.kind !== 'text'; });
  if (!uids.length) return;
  const byPage = new Map(); for (const u of uids) { const n = edPageOfUid(u); (byPage.get(n) || byPage.set(n, []).get(n)).push(u); }
  pushHistory('ednudge');
  for (const [n, list] of byPage) {
    const p = S.pages[n - 1], vp = vp1(p), o0 = vp.convertToPdfPoint(0, 0), q = vp.convertToPdfPoint(dx * step, dy * step);
    edTranslate(list, [q[0] - o0[0], q[1] - o0[1]]);
  }
  edChanged([...byPage.keys()]);
}

/* ---------- selection helpers ---------- */
function edSelectAll(kind) {
  const p = S.pages[S.current - 1]; if (!p?.page) return;
  const c = ED.pages.get(p.num);
  if (!c?.A && !edAddOf(p.num).length) { edPage(p.num); toast(c?.err ? 'This page’s content could not be read.' : 'Reading this page… try again in a moment.'); return; }
  const ids = new Set();
  for (const o of edObjs(p.num)) {
    if (edIsBackdrop(p, o)) continue;
    if (kind === 'all' || (kind === 'text' && o.kind === 'text') || (kind === 'image' && o.kind === 'image') || (kind === 'shape' && (o.kind === 'path' || o.kind === 'form'))) ids.add(o.uid);
  }
  if (A.tool !== 'osel') setTool('osel');
  edSetSel(ids, [p.num]);
  toast(ids.size ? `Selected ${ids.size} ${ids.size === 1 ? 'object' : 'objects'} on page ${p.num}.` : 'Nothing of that kind on this page.');
}

function edAnchorRect() {
  const els = [...document.querySelectorAll('.ed-box.sel')]; if (!els.length) return null;
  let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const n of els) { const q = n.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
  return { left: l, top: t, right: r, bottom: b };
}

function edLabel(o) { return o.added ? 'Picture you added' : { text: 'Text line', image: 'Picture', path: 'Shape or line', form: 'Group' }[o.kind] || 'Object'; }

function refreshEditBar() {
  const bar = $('objbar');
  if (A.mode !== 'edit' || !A.edSel.size || A.op || A.tool !== 'osel') { bar.hidden = true; return; }
  const objs = [...A.edSel].map(edFind).filter(Boolean);
  if (!objs.length) { bar.hidden = true; return; }
  bar.replaceChildren();
  const btn = (cls, html, title, fn) => { const b = el('button', cls, { type: 'button', innerHTML: html, title }); b.setAttribute('aria-label', title); b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', fn); return b; };
  const label = el('span', 'ob-label');
  label.append(el('b', '', { textContent: objs.length === 1 ? edLabel(objs[0]) : `${objs.length} objects` }));
  label.append(el('small', '', { textContent: objs.length === 1 && objs[0].kind === 'text' ? 'Double-click to change the words' : 'Drag to move' }));
  bar.append(label);
  if (objs.length === 1 && objs[0].kind === 'text') bar.append(el('span', 'sb-sep'), btn('', '<svg><use href="#i-texte"/></svg>Edit text', 'Change the words of this line (Enter)', () => edStartText(objs[0])));
  if (objs.length === 1 && objs[0].kind === 'form' && !objs[0].added) bar.append(el('span', 'sb-sep'), btn('', 'Open group', 'Select the things inside this group (double-click)', () => edOpenGroup(objs[0])));
  bar.append(el('span', 'sb-sep'), btn('ob-del', '<svg><use href="#i-trash"/></svg>Delete', 'Delete (Delete key)', edDeleteSel));
  bar.hidden = false; repositionObjbar();
}
function repositionEditBar() {
  const bar = $('objbar'); if (bar.hidden) return;
  const r = edAnchorRect(), vr = viewer.getBoundingClientRect();
  if (!r) { bar.style.visibility = 'hidden'; return; }
  const inView = r.bottom > vr.top + 4 && r.top < vr.bottom - 4 && r.right > vr.left && r.left < vr.right;
  bar.style.visibility = inView ? 'visible' : 'hidden'; if (!inView) return;
  const w = bar.offsetWidth, h = bar.offsetHeight;
  let y = r.top - h - 12; if (y < vr.top + 6) y = r.bottom + 12;
  bar.style.left = `${Math.round(clampN((r.left + r.right) / 2 - w / 2, 8, innerWidth - w - 8))}px`;
  bar.style.top = `${Math.round(clampN(y, 8, innerHeight - h - 8))}px`;
}

function edOpenGroup(o) {
  const n = HXEdit.pageOfId(o.uid), set = ED.open.get(n) || new Set(); set.add(o.id); ED.open.set(n, set);
  A.edSel = new Set(); edPage(n, true); toast('Group opened. You can now select the things inside it.');
  edRedraw([n]); refreshObjbar(); edSyncUI();
}
viewer.addEventListener('dblclick', (e) => {
  if (A.mode !== 'edit' || A.tool !== 'osel') return;
  const pageEl = e.target.closest?.('.page'); if (!pageEl) return;
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return;
  const pt = pdfPointAt(p, e.clientX, e.clientY), { all } = edHitAt(p, pt[0], pt[1]);
  const t = all.find((o) => o.kind === 'text'); if (t && (!all.find((o) => o.kind === 'form') || all.indexOf(t) < all.findIndex((o) => o.kind === 'form'))) { e.preventDefault(); edStartText(t, p); return; }
  const f = all.find((o) => o.kind === 'form'); if (f) { e.preventDefault(); edOpenGroup(f); }
});

/* ---------- hover ---------- */
viewer.addEventListener('pointermove', (e) => {
  if (A.mode !== 'edit' || (A.tool !== 'osel' && A.tool !== 'etxt') || e.buttons || A.op || ED.hoverRaf) return;
  const { clientX, clientY, target } = e;
  ED.hoverRaf = requestAnimationFrame(() => {
    ED.hoverRaf = 0;
    const pageEl = target.closest?.('.page'); let uid = null;
    const p = pageEl ? S.pages[+pageEl.dataset.page - 1] : null;
    if (p?.page && !target.closest('.ed-h')) { const pt = pdfPointAt(p, clientX, clientY); const hh = edHitAt(p, pt[0], pt[1]); const h = A.tool === 'etxt' ? hh.all.find((o) => o.kind === 'text') : hh.top; uid = h ? h.uid : null; }
    viewer.dataset.hover = uid && A.tool === 'osel' ? 'move' : '';
    if (uid !== A.edHover) { const before = A.edHover; A.edHover = uid; edRedraw(new Set([before, uid].filter(Boolean).map(edPageOfUid).filter(Boolean))); }
  });
}, { passive: true });
viewer.addEventListener('pointerleave', () => { if (A.edHover) { const n = edPageOfUid(A.edHover); A.edHover = null; if (n) edRedraw([n]); } });

/* ---------- ribbon, modes and colours ---------- */
function setMode(m) {
  if (m === A.mode) return;
  if (m === 'edit' && !canEdit()) return;
  A.mode = m; document.body.dataset.mode = m;
  document.querySelectorAll('.rb-m').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  A.edSel = new Set(); A.edHover = null; closeMenu(); hideObjbar();
  setTool(m === 'edit' ? 'osel' : 'select', true);
  if (m === 'edit') { for (const n of [S.current, S.current + 1, S.current - 1]) if (S.pages[n - 1]) edPage(n); if (!LS.get('hx-edtip')) { LS.set('hx-edtip', '1'); toast('Edit mode changes the PDF itself. Erased text and deleted objects are really removed from the file.'); } }
  redrawAllAnnots(); edSyncUI();
}
document.querySelectorAll('.rb-m').forEach((b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); b.addEventListener('click', () => setMode(b.dataset.mode)); });

function edSyncUI() {
  const del = $('edDelete'); if (del) del.disabled = !A.edSel.size;
  const box = $('edStyle'); if (!box) return;
  const paths = [...A.edSel].map(edFind).filter((o) => o && edIsPaintedPath(o));
  const showFill = paths.some((o) => o.paint.fill), showLine = paths.some((o) => o.paint.stroke);
  box.hidden = !paths.length || A.mode !== 'edit';
  const lab = box.querySelectorAll('label');
  lab[0].hidden = !showFill; lab[1].hidden = !showLine; lab[2].hidden = !showLine;
  const first = paths[0];
  if (first) {
    const st = A.ed.sty[first.uid] || {};
    $('edFill').value = st.f || first.fill || '#cccccc';
    $('edLine').value = st.s || first.stroke || '#000000';
    $('edWidth').value = typeof st.w === 'number' ? st.w : Math.round((first.lw || 1) * 100) / 100;
  }
}
function edStyle(patch) {
  const paths = [...A.edSel].map(edFind).filter((o) => o && edIsPaintedPath(o)); if (!paths.length) return;
  pushHistory('edsty');
  for (const o of paths) A.ed.sty[o.uid] = { ...(A.ed.sty[o.uid] || {}), ...patch };
  edChanged([...edSelPages()]);
}
$('edFill').addEventListener('input', (e) => edStyle({ f: e.target.value }));
$('edLine').addEventListener('input', (e) => edStyle({ s: e.target.value }));
$('edWidth').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) edStyle({ w: Math.min(v, 100) }); });
$('edDelete').addEventListener('click', edDeleteSel);
$('edSelAll').addEventListener('click', () => {
  openMenu($('edSelAll'), (m) => {
    m.append(el('div', 'menu-title', { textContent: 'Select on this page' }));
    for (const [k, label, icon] of [['all', 'Everything', 'i-selall'], ['text', 'All text lines', 'i-texterase'], ['image', 'All pictures', 'i-image'], ['shape', 'All shapes and lines', 'i-rect']]) {
      const b = el('button', 'menu-item', { type: 'button' }); b.setAttribute('role', 'menuitem');
      b.append(el('span', 'mi-check', { innerHTML: `<svg><use href="#${icon}"/></svg>` }), el('span', '', { textContent: label }));
      b.addEventListener('click', () => { closeMenu(); edSelectAll(k); });
      m.append(b);
    }
  });
});


/* ---------- changing the words of a line ---------- */
const edTE = { o: null, p: null, li: null, orig: null, open: false };
const WIN_OK = /^[ -~ -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]$/;
const edCutOf = (o) => (r) => { const c = A.ed.cut[o.prefix + r.id]; if (!c) return null; const set = new Set(); for (const [a, b] of c) for (let i = a; i < b; i++) set.add(i); return set; };
const edHexOf = (h) => (/^#[0-9a-f]{6}$/i.test(h || '') ? h.toLowerCase() : '#000000');

function edStartText(o, p) {
  if (!canEdit() || !o || o.kind !== 'text') return;
  if (A.mode !== 'edit') setMode('edit');
  const page = p || S.pages[edPageOfUid(o.uid) - 1]; if (!page?.page) return;
  const info = ED.pages.get(page.num)?.A; o.prefix = o.prefix || info?.prefix || `p${page.num}:`;
  const li = HXEdit.lineInfo(o, edCutOf(o)), tx = edTx()[o.uid];
  if (li.vert) { toast('Vertical text can’t be changed here. You can erase it and add a text box in Comment mode.'); return; }
  edTE.o = o; edTE.p = page; edTE.li = li; edTE.open = true;
  edTE.orig = { t: li.text, f: li.std, s: Math.round(li.size * 100) / 100, c: edHexOf(li.fill) };
  const unreadable = !tx && li.total > 0 && li.unknown > li.total / 2;
  const cur = tx || edTE.orig;
  $('edTxtIn').value = unreadable ? '' : cur.t;
  $('edTxtFam').value = edFamOf(cur.f || li.std); $('edTxtB').setAttribute('aria-pressed', /Bold/.test(cur.f || li.std)); $('edTxtI').setAttribute('aria-pressed', /Italic|Oblique/.test(cur.f || li.std));
  $('edTxtSize').value = Math.round((cur.s > 0 ? cur.s : li.size) * 10) / 10; $('edTxtCol').value = edHexOf(cur.c || li.fill);
  $('edTxtNote').className = 'ed-txtnote'; $('edTxtNote').textContent = unreadable ? 'The viewer can’t read the words of this line (its font has no text map). Type the new text.' : 'The line is rewritten in a standard font (Sans, Serif or Mono) of the same size and colour.';
  A.edSel = new Set([o.uid]); closeMenu(); hideObjbar(); edRedraw([page.num]); edSyncUI();
  const ed = $('edTxtEd'); ed.hidden = false; edPlaceText();
  const inp = $('edTxtIn'); inp.focus(); inp.select();
}
function edPlaceText() {
  const ed = $('edTxtEd'); if (ed.hidden || !edTE.o) return;
  const r = edAnchorRect(), vr = viewer.getBoundingClientRect();
  const w = ed.offsetWidth, h = ed.offsetHeight;
  if (!r) { ed.style.left = `${Math.round((innerWidth - w) / 2)}px`; ed.style.top = `${Math.round(vr.top + 20)}px`; return; }
  let y = r.top - h - 10; if (y < vr.top + 6) y = r.bottom + 10;
  ed.style.left = `${Math.round(clampN(r.left, 8, innerWidth - w - 8))}px`; ed.style.top = `${Math.round(clampN(y, 8, innerHeight - h - 8))}px`;
}
function edTextValues() {
  const fam = $('edTxtFam').value, b = $('edTxtB').getAttribute('aria-pressed') === 'true', i = $('edTxtI').getAttribute('aria-pressed') === 'true';
  const size = parseFloat($('edTxtSize').value);
  return { t: $('edTxtIn').value.replace(/[\r\n\t]+/g, ' '), f: HXEdit.stdName(fam, b, i), s: isFinite(size) && size >= 1 ? Math.min(size, 400) : edTE.orig.s, c: edHexOf($('edTxtCol').value) };
}
function edTextNote() {
  const note = $('edTxtNote'), v = edTextValues(); let bad = '';
  for (const ch of v.t.normalize('NFC')) if (!WIN_OK.test(ch) && !bad.includes(ch) && !/[‐-‒−­   ​]/.test(ch) && ch.normalize('NFD')[0] === ch) bad += ch;
  note.className = bad ? 'ed-txtnote warn' : 'ed-txtnote';
  if (bad) note.textContent = `${[...bad].slice(0, 6).join(' ')} can’t be drawn in this font and will show as “?”. Letters from other scripts need a text box in Comment mode.`;
}
function edCloseText(apply) {
  if (!edTE.open) return;
  const o = edTE.o, p = edTE.p, v = apply ? edTextValues() : null, orig = edTE.orig;
  edTE.open = false; $('edTxtEd').hidden = true; edTE.o = null;
  if (!apply || !o) { edRedraw(p ? [p.num] : []); return; }
  const had = edTx()[o.uid];
  const same = v.t === orig.t && v.f === orig.f && Math.abs(v.s - orig.s) < 0.05 && v.c === orig.c;
  const prev = had || null;
  if (same) { if (!had) return; pushHistory(); delete A.ed.txt[o.uid]; edChanged([p.num]); toast('The line is back to its original text.'); return; }
  if (prev && prev.t === v.t && prev.f === v.f && Math.abs((prev.s || 0) - v.s) < 0.05 && prev.c === v.c) return;
  if (!v.t.trim()) {
    pushHistory(); delete A.ed.txt[o.uid]; A.ed.del.push(o.uid); A.edSel = new Set();
    edChanged([p.num]); toast('That line is now empty, so it was deleted. Press Ctrl+Z to bring it back.', 'success'); return;
  }
  pushHistory(); A.ed.txt[o.uid] = v; edChanged([p.num]);
  let bad = 0; for (const ch of v.t.normalize('NFC')) if (!WIN_OK.test(ch) && !/[‐-‒−­   ​]/.test(ch) && ch.normalize('NFD')[0] === ch) bad++;
  toast(bad ? `Text changed. ${bad} ${bad === 1 ? 'character' : 'characters'} can’t be drawn in this font and became “?”.` : 'Text changed. Press Ctrl+Z to undo.', bad ? '' : 'success');
}
$('edTxtIn').addEventListener('input', edTextNote);
for (const id of ['edTxtFam', 'edTxtSize', 'edTxtCol']) $(id).addEventListener('input', edTextNote);
for (const id of ['edTxtB', 'edTxtI']) $(id).addEventListener('click', (e) => { const b = e.currentTarget; b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); $('edTxtIn').focus(); });
$('edTxtOk').addEventListener('click', () => edCloseText(true));
$('edTxtCancel').addEventListener('click', () => edCloseText(false));
$('edTxtEd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); edCloseText(true); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); edCloseText(false); }
  else e.stopPropagation();
});
document.addEventListener('pointerdown', (e) => {
  if (!edTE.open || $('edTxtEd').contains(e.target)) return;
  edCloseText(true);                                           // clicking elsewhere keeps what was typed
}, true);
window.addEventListener('resize', edPlaceText);
viewer.addEventListener('scroll', edPlaceText, { passive: true });

/* ---------- adding a picture ---------- */
const jpegSize = (b) => {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1]; if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
};
async function edLoadImage(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8, isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const probe = URL.createObjectURL(new Blob([buf], { type: isJpg ? 'image/jpeg' : isPng ? 'image/png' : (file.type || 'image/png') }));
  const img = new Image(); img.src = probe;
  try { await img.decode(); } catch { URL.revokeObjectURL(probe); throw new Error('This file is not a picture the viewer can read.'); }
  let w = img.naturalWidth || 400, h = img.naturalHeight || 300, bytes = buf, mime = 'image/jpeg', ok = isJpg;
  if (isJpg) { const sz = jpegSize(buf); if (!sz || sz.w !== w || sz.h !== h) ok = false; }              // phone photos with a rotation flag are redrawn upright
  if (!ok) {
    const max = 4096, k = Math.min(1, max / Math.max(w, h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const cv = el('canvas'); cv.width = cw; cv.height = ch; const cx = cv.getContext('2d');
    if (isJpg) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch); }
    cx.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise((r) => cv.toBlob(r, isJpg ? 'image/jpeg' : 'image/png', 0.92));
    if (!blob) { URL.revokeObjectURL(probe); throw new Error('The picture could not be prepared.'); }
    bytes = new Uint8Array(await blob.arrayBuffer()); mime = isJpg ? 'image/jpeg' : 'image/png'; w = cw; h = ch;
  }
  URL.revokeObjectURL(probe);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime })), id = `as${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  A.edAssets.set(id, { mime, bytes, url, w, h });
  return { id, w, h };
}
function edAddImage() {
  if (!canEdit()) return;
  const inp = el('input', '', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml' });
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try {
      A.edPending = await edLoadImage(f);
      if (A.mode !== 'edit') setMode('edit');
      if (A.tool === 'addimg') A.tool = 'osel';
      setTool('addimg', true);
    } catch (e) { toast(e?.message || 'That picture could not be opened.', 'error'); }
  });
  inp.click();
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (A.mode !== 'edit' || !S.pdf || !$('modal').hidden || !$('sigDlg').hidden) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (mod && !e.altKey && k === 'a') { stop(); edSelectAll('all'); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (A.edSel.size) { stop(); edDeleteSel(); } return; }
  if (e.key === 'Escape') {
    if (!$('menu').hidden) return;
    if (A.edSel.size) { stop(); edSetSel(new Set()); } else if (A.tool !== 'osel') { stop(); A.edPending = null; setTool('osel', true); }
    return;
  }
  if (A.edSel.size && A.tool === 'osel' && /^Arrow/.test(e.key)) {
    stop(); const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; edNudge(d[0], d[1], e.shiftKey); return;
  }
  if (k === 'v') { stop(); setTool('osel', true); return; }
  if (e.key === 'Enter' && A.edSel.size === 1 && A.tool === 'osel') { const o = edFind([...A.edSel][0]); if (o && o.kind === 'text') { stop(); edStartText(o); return; } }
  if (k === 't') { stop(); setTool('etxt', true); return; }
  if (k === 'x') { stop(); setTool('etext', true); return; }
  if (k === 'p') { stop(); edAddImage(); return; }
  if (k === 'm') { stop(); setTool('pan', true); return; }
  if (e.key.length === 1 && 'tbolaidegcush'.includes(k)) stop();                    // comment shortcuts are off in Edit mode
}, true);

/* ---------- building the edited file ---------- */
async function edApplyBytes(bytes, edJson) {
  const PL = await loadPdfLib(), doc = await PL.PDFDocument.load(bytes, loadOpts(PL));
  await HXEdit.applyEdits(PL, doc, JSON.parse(edJson), A.edAssets);
  return doc.save(SAVE_OPTS);
}
