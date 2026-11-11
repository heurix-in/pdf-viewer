
/* =====================================================================
   Measurement tools: Distance, Perimeter and Area, with a scale
   (the constants MEAS and MEAS_TOOLS live in the main part of the file)
   ===================================================================== */
const UNIT_PT = { pt: 1, in: 72, ft: 864, yd: 2592, mi: 4561920, mm: 72 / 25.4, cm: 72 / 2.54, m: 72 / 0.0254, km: 72 / 0.0000254 };
const UNIT_ORDER = [['mm', 'millimetres (mm)'], ['cm', 'centimetres (cm)'], ['m', 'metres (m)'], ['km', 'kilometres (km)'], ['in', 'inches (in)'], ['ft', 'feet (ft)'], ['yd', 'yards (yd)'], ['mi', 'miles (mi)'], ['pt', 'points (pt)']];
const METRIC = new Set(['mm', 'cm', 'm', 'km']);
const DEF_SCALE = { pv: 1, pu: 'mm', rv: 1, ru: 'mm' };
Object.assign(A, { scale: { ...DEF_SCALE }, mdraft: null, showScale: false });
Object.assign(TOOL_HINT, {
  dist: 'Click and drag, or click two points. Hold Shift to lock to horizontal, vertical or 45°. Press Esc when you are done',
  peri: 'Click each point along the path, then double-click or press Enter to finish. Shift locks the angle. Backspace removes the last point',
  area: 'Click each corner of the shape, then double-click, press Enter or click the first point to close it. Shift locks the angle',
  calib: 'Click two points whose real distance you know, then type that distance'
});
Object.assign(TYPE_LABEL, { dist: 'Distance', peri: 'Perimeter', area: 'Area' });
Object.assign(TYPE_ICON, { dist: 'i-dist', peri: 'i-peri', area: 'i-area' });

/* ---------- scale and numbers ---------- */
const scaleOk = (s) => !!s && [s.pv, s.rv].every((v) => typeof v === 'number' && isFinite(v) && v > 0) && UNIT_PT[s.pu] > 0 && UNIT_PT[s.ru] > 0;
const scaleK = (s) => s.rv / (s.pv * UNIT_PT[s.pu]);                       // real units per PDF point
const numStr = (v) => String(+Number(v).toPrecision(7));
const scaleText = (s) => `${numStr(s.pv)} ${s.pu} = ${numStr(s.rv)} ${s.ru}`;
function fmtMeas(v) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v), dec = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/* ---------- geometry ---------- */
const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function pathLen(pts, closed) { let t = 0; for (let i = 1; i < pts.length; i++) t += segLen(pts[i - 1], pts[i]); if (closed && pts.length > 2) t += segLen(pts[pts.length - 1], pts[0]); return t; }
function polyArea(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function polyCentroid(pts) {
  let s = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], c = a[0] * b[1] - b[0] * a[1]; s += c; cx += (a[0] + b[0]) * c; cy += (a[1] + b[1]) * c; }
  if (Math.abs(s) < 1e-6) return [pts.reduce((t, q) => t + q[0], 0) / pts.length, pts.reduce((t, q) => t + q[1], 0) / pts.length];
  return [cx / (3 * s), cy / (3 * s)];
}
function pointAlong(pts, frac) {
  const total = pathLen(pts, false); if (!total) return pts[0].slice();
  let want = total * frac;
  for (let i = 1; i < pts.length; i++) { const l = segLen(pts[i - 1], pts[i]); if (want <= l) { const t = l ? want / l : 0; return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; } want -= l; }
  return pts[pts.length - 1].slice();
}
const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
const bboxPts = (pts) => [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))].map(r2);
// keep the line on 0, 45, 90 ... degrees from the previous point
function measSnap(p0, p) {
  const dx = p[0] - p0[0], dy = p[1] - p0[1]; if (!dx && !dy) return p;
  const th = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), c = Math.cos(th), s = Math.sin(th), l = dx * c + dy * s;
  return [p0[0] + l * c, p0[1] + l * s];
}

/* ---------- the value of a measurement ---------- */
function measInfo(a) {
  const sc = scaleOk(a.scale) ? a.scale : A.scale, k = scaleK(sc), pts = a.pts || [];
  if (a.calib) { const L = pts.length > 1 ? segLen(pts[0], pts[pts.length - 1]) : 0; const u = METRIC.has(A.scale.ru) ? 'mm' : 'in'; return { text: `${fmtMeas(L / UNIT_PT[u])} ${u} on the page`, at: pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : (pts[0] || [0, 0]), value: L }; }
  if (a.type === 'dist') {
    const L = pts.length > 1 ? segLen(pts[0], pts[1]) : 0;
    return { text: `${fmtMeas(L * k)} ${sc.ru}`, at: pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : (pts[0] || [0, 0]), value: L * k };
  }
  if (a.type === 'peri') {
    const L = pathLen(pts, false);
    return { text: `Perimeter ${fmtMeas(L * k)} ${sc.ru}`, at: pts.length ? pointAlong(pts, 0.5) : [0, 0], value: L * k };
  }
  const A2 = pts.length > 2 ? polyArea(pts) : 0;
  return { text: `Area ${fmtMeas(A2 * k * k)} ${sc.ru}²`, at: pts.length > 2 ? polyCentroid(pts) : (pts[0] || [0, 0]), value: A2 * k * k };
}

/* ---------- drawing on the page ---------- */
function drawMeasure(a, vp, px, py, parts) {
  const { frag } = parts, col = lineColor(a), active = a.id === A.openId ? ' is-active' : '', w = a.width || 2;
  const P = (a.pts || []).map((q) => vp.convertToViewportPoint(q[0], q[1]));
  if (!P.length) return;
  const g = svgEl('g', { class: `an${active}`, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  g.dataset.id = a.id;
  if (a.calib) g.setAttribute('stroke-dasharray', '7 5');
  const d = `M${P.map((q) => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join('L')}${a.type === 'area' && P.length >= 3 ? 'Z' : ''}`;
  const path = svgEl('path', { d });
  if (a.type === 'area' && P.length >= 3) { path.setAttribute('fill', col); path.setAttribute('fill-opacity', '0.14'); }
  g.append(path);
  if (a.type === 'dist' && P.length > 1) {                                       // dimension-line ticks at both ends
    const dx = P[1][0] - P[0][0], dy = P[1][1] - P[0][1], l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * 5, ny = (dx / l) * 5;
    g.append(svgEl('path', { d: `M${P[0][0] - nx} ${P[0][1] - ny}L${P[0][0] + nx} ${P[0][1] + ny}M${P[1][0] - nx} ${P[1][1] - ny}L${P[1][0] + nx} ${P[1][1] + ny}` }));
  }
  if (a.type !== 'dist') for (const q of P) g.append(svgEl('circle', { cx: q[0], cy: q[1], r: w / 2 + 1.6, fill: col, stroke: 'none' }));
  svgLayer(parts, vp).append(g);
  if (P.length >= (a.type === 'area' ? 3 : 2) || a.calib) {
    const info = measInfo(a), c = vp.convertToViewportPoint(info.at[0], info.at[1]);
    const lab = el('div', `an an-meas${active}${a.calib ? ' calib' : ''}`, { textContent: info.text });
    lab.dataset.id = a.id; lab.style.cssText = `--l:${col};left:${px(c[0])};top:${py(c[1])}`;
    frag.append(lab);
  }
  if (a.id !== 'draft' && hasComment(a)) {
    const b = boxOf(vp, a.rects[0]), flag = el('div', 'an an-flag'); flag.dataset.id = a.id;
    flag.style.cssText = `--l:${col};left:${px(b.x + b.w)};top:${py(b.y)}`; frag.append(flag);
  }
}

/* ---------- clicks and drags ---------- */
function measDraftBuild() {
  const m = A.mdraft;
  if (!m) { A.draft = null; return; }
  const pts = m.cur ? [...m.pts, m.cur] : m.pts.slice(), type = m.tool === 'calib' ? 'dist' : m.tool;
  A.draft = pts.length ? { id: 'draft', type, page: m.page, pts, calib: m.tool === 'calib', color: m.tool === 'calib' ? 'blue' : defColor(type), width: WIDTHS[A.widthIdx], rects: [bboxPts(pts)], scale: A.scale, text: '', replies: [], quote: '' } : null;
}
function measRedraw(page) { const p = S.pages[(page || (A.mdraft && A.mdraft.page)) - 1]; if (p?.rendered) drawAnnots(p); }
const measPoint = (m, raw, shift) => (shift && m.pts.length ? measSnap(m.pts[m.pts.length - 1], raw) : raw).map(r2);
function measCancel() { const pg = A.mdraft && A.mdraft.page; A.mdraft = null; A.draft = null; if (pg) measRedraw(pg); }

function measPointerDown(e, pageEl) {
  const p = S.pages[+pageEl.dataset.page - 1]; if (!p?.page) return false;
  if (!canEdit()) return true;
  e.preventDefault(); closePop(true); try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
  const tool = A.tool, raw = pdfPointAt(p, e.clientX, e.clientY), need = tool === 'area' ? 3 : 2;
  if (A.mdraft && A.mdraft.page !== p.num) measCancel();
  let m = A.mdraft;
  if (m && (tool === 'peri' || tool === 'area') && m.pts.length) {
    const tol = 8 / (S.zoom * CSS_UNITS);
    if (tool === 'area' && m.pts.length >= 3 && segLen(raw, m.pts[0]) <= tol) { measFinish(); return true; }
  }
  if (!m) m = A.mdraft = { tool, page: p.num, pts: [], cur: null };
  const pt = measPoint(m, raw, e.shiftKey);
  if (!m.pts.length) {
    m.pts.push(pt); m.cur = null;
    beginOp({ kind: 'meas', p, cx: e.clientX, cy: e.clientY, moved: false });
    measDraftBuild(); measRedraw(); return true;
  }
  if (segLen(pt, m.pts[m.pts.length - 1]) * S.zoom * CSS_UNITS < 2) return true;
  m.pts.push(pt); m.cur = null;
  if (tool === 'dist' || tool === 'calib') { measFinish(); return true; }
  measDraftBuild(); measRedraw(); return true;
}
function measMove(op, e) {
  const m = A.mdraft; if (!m) return;
  if (!op.moved && Math.hypot(e.clientX - op.cx, e.clientY - op.cy) < 4) return;
  op.moved = true;
  m.cur = measPoint(m, pdfPointAt(op.p, e.clientX, e.clientY), e.shiftKey);
  measDraftBuild(); redrawOpPage(op);
}
function measUp(op) {
  const m = A.mdraft; if (!m) return;
  if (op.moved && m.cur && segLen(m.cur, m.pts[0]) * S.zoom * CSS_UNITS >= 6) {
    m.pts.push(m.cur); m.cur = null;
    if (m.tool === 'dist' || m.tool === 'calib') { measFinish(); return; }
  } else m.cur = null;
  measDraftBuild(); measRedraw();
}
viewer.addEventListener('dblclick', (e) => {                                  // double-click finishes a perimeter or an area
  const m = A.mdraft; if (!m || (m.tool !== 'peri' && m.tool !== 'area')) return;
  if (m.pts.length >= (m.tool === 'area' ? 3 : 2)) { e.preventDefault(); measFinish(); }
});
let measRaf = 0;
function measHover(cx, cy, shift) {
  const m = A.mdraft; if (!m || A.op || !m.pts.length) return;
  const p = S.pages[m.page - 1]; if (!p?.page) return;
  m.cur = measPoint(m, pdfPointAt(p, cx, cy), shift);
  measDraftBuild();
  if (!measRaf) measRaf = requestAnimationFrame(() => { measRaf = 0; measRedraw(); });
}
viewer.addEventListener('pointermove', (e) => { if (A.mdraft && !e.buttons) measHover(e.clientX, e.clientY, e.shiftKey); }, { passive: true });

async function measFinish() {
  const m = A.mdraft; if (!m) return;
  const tool = m.tool, need = tool === 'area' ? 3 : 2, pts = m.pts.map((q) => q.slice());
  while (pts.length > 1 && segLen(pts[pts.length - 1], pts[pts.length - 2]) < 0.01) pts.pop();         // a double-click adds the last point twice
  const p = S.pages[m.page - 1];
  A.mdraft = null; A.draft = null; if (p) drawAnnots(p);
  if (pts.length < need) { toast(tool === 'area' ? 'An area needs at least three corners.' : 'A measurement needs at least two points.'); return; }
  if (tool === 'calib') { measAskReal(pts, p); return; }
  if (tool === 'dist' && segLen(pts[0], pts[1]) < 0.5) return;
  if (!(await ensureAuthor())) return;
  const a = { id: uid(), type: tool, page: m.page, pts, rects: [bboxPts(pts)], color: defColor(tool), width: WIDTHS[A.widthIdx], scale: { ...A.scale }, text: '', quote: '', replies: [], author: A.author, created: nowISO(), modified: nowISO() };
  pushHistory(); A.items.push(a); afterChange([a.page]);
}

document.addEventListener('keydown', (e) => {
  if (!S.pdf || !$('modal').hidden || !$('sigDlg').hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && k === 'c') { e.preventDefault(); e.stopImmediatePropagation(); measCalibrate(); return; }
  const m = A.mdraft; if (!m || /^(input|textarea|select)$/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); measCancel(); }
  else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); measFinish(); }
  else if (e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); m.pts.pop(); m.cur = null; if (!m.pts.length) measCancel(); else { measDraftBuild(); measRedraw(); } }
  else if (e.key === 'Shift' && !e.repeat) measHover(A.lastPtr?.x || 0, A.lastPtr?.y || 0, true);
}, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Shift' && A.mdraft) measHover(A.lastPtr?.x || 0, A.lastPtr?.y || 0, false); });

/* ---------- selecting and editing the points of one ---------- */
function measHit(a, x, y, tol) {
  const P = a.pts, w = (a.width || 2) / 2 + tol; if (!P || P.length < 2) return false;
  if (a.type === 'area' && P.length > 2) {
    for (let i = 0; i < P.length; i++) if (distPointSeg([x, y], P[i], P[(i + 1) % P.length]) <= w) return true;
    return a.id === A.sel && inPoly(x, y, P);
  }
  for (let i = 1; i < P.length; i++) if (distPointSeg([x, y], P[i - 1], P[i]) <= w) return true;
  return false;
}

/* ---------- scale: the boxes in the ribbon, the menu and calibration ---------- */
const selMeasure = () => { const a = A.sel && findAnn(A.sel); return a && MEAS.has(a.type) ? a : null; };
function syncScaleUI() {
  const g = $('msScale'); if (!g) return;
  const ms = selMeasure(), show = A.mode === 'comment' && (MEAS_TOOLS.has(A.tool) || !!ms || A.showScale);
  g.hidden = !show; if (!show) return;
  g.style.top = `${Math.round($('ribbon').getBoundingClientRect().bottom + 8)}px`;
  const sc = ms && scaleOk(ms.scale) ? ms.scale : A.scale, set = (id, v) => { const n = $(id); if (document.activeElement !== n) n.value = v; };
  set('msPv', numStr(sc.pv)); set('msPu', sc.pu); set('msRv', numStr(sc.rv)); set('msRu', sc.ru);
  $('msScale').title = ms ? 'Scale of the selected measurement' : 'Scale for new measurements';
}
function measSetScale(sc, opt = {}) {
  const sel = selMeasure(), targets = opt.items || (sel ? [sel] : []);
  if (targets.length) {
    pushHistory(targets.length === 1 && !opt.items ? `ms:${targets[0].id}` : '');
    for (const t of targets) { t.scale = { ...sc }; t.modified = nowISO(); }
    afterChange(targets.map((t) => t.page)); refreshObjbar();
  }
  A.scale = { ...sc }; syncScaleUI();
}
function fillUnits(sel) { sel.replaceChildren(...UNIT_ORDER.map(([v, l]) => el('option', '', { value: v, textContent: v === 'pt' ? 'pt' : v, title: l }))); }
for (const id of ['msPu', 'msRu', 'calUnit']) fillUnits($(id));
function onScaleBox() {
  const sc = { pv: parseFloat($('msPv').value), pu: $('msPu').value, rv: parseFloat($('msRv').value), ru: $('msRu').value };
  if (!scaleOk(sc)) { toast('Type a number bigger than zero in both boxes.', 'error'); syncScaleUI(); return; }
  measSetScale(sc);
}
for (const id of ['msPv', 'msPu', 'msRv', 'msRu']) $(id).addEventListener('change', onScaleBox);
$('msCal').addEventListener('click', () => measCalibrate());
window.addEventListener('resize', () => syncScaleUI());
for (const id of ['msPv', 'msRv']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); });

function measAdoptScale() {
  const last = A.items.filter((a) => MEAS.has(a.type) && scaleOk(a.scale)).sort((x, y) => Date.parse(x.created) - Date.parse(y.created)).pop();
  A.scale = last ? { ...last.scale } : { ...DEF_SCALE }; A.showScale = false; syncScaleUI();
}

const SCALE_PRESETS = [
  ['Metric ratios', [1, 2, 5, 10, 20, 50, 100, 200, 500].map((n) => ({ label: `1 : ${n}`, sc: n >= 20 ? { pv: 1, pu: 'mm', rv: n / 1000, ru: 'm' } : { pv: 1, pu: 'mm', rv: n, ru: 'mm' } }))],
  ['Architectural', [['1/8" = 1\'', 0.125], ['1/4" = 1\'', 0.25], ['1/2" = 1\'', 0.5], ['1" = 1\'', 1]].map(([label, pv]) => ({ label, sc: { pv, pu: 'in', rv: 1, ru: 'ft' } }))],
  ['Engineering', [10, 20, 50, 100].map((n) => ({ label: `1" = ${n}'`, sc: { pv: 1, pu: 'in', rv: n, ru: 'ft' } }))]
];
const sameScale = (a, b) => Math.abs(scaleK(a) / scaleK(b) - 1) < 1e-9 && a.ru === b.ru;
function openScaleMenu(anchor) {
  openMenu(anchor, (m) => {
    const item = (label, sub, fn, on, icon) => {
      const b = el('button', 'menu-item', { type: 'button' }); b.setAttribute('role', 'menuitem');
      b.append(el('span', 'mi-check', { innerHTML: on ? '<svg><use href="#i-check"/></svg>' : (icon ? `<svg><use href="#${icon}"/></svg>` : '') }));
      const t = el('span', '', { textContent: label }); if (sub) t.append(el('small', '', { textContent: ` ${sub}`, style: 'font-weight:500;color:var(--muted)' }));
      b.append(t); b.addEventListener('click', () => { closeMenu(); fn(); }); m.append(b);
    };
    m.append(el('div', 'menu-title', { textContent: 'Measurement scale' }), el('div', 'menu-note', { textContent: `Now: ${scaleText(A.scale)}` }));
    item('Calibrate…', 'Ctrl+Shift+C', measCalibrate, false, 'i-scale');
    item('Custom scale…', 'type your own', () => { A.showScale = true; syncScaleUI(); $('msPv').focus(); $('msPv').select(); }, false, 'i-edit');
    for (const [title, list] of SCALE_PRESETS) {
      m.append(el('div', 'menu-sep'), el('div', 'menu-title', { textContent: title }));
      for (const it of list) item(it.label, '', () => { measSetScale(it.sc); toast(`Scale set to ${scaleText(it.sc)}.`, 'success'); }, sameScale(A.scale, it.sc));
    }
  });
}

function measCalibrate() {
  if (!S.pdf) return;
  if (A.mode === 'edit') setMode('comment');
  if (!canEdit()) return;
  setTool('calib', true);
  toast('Click two points whose real distance you know, for example the ends of a dimension on the drawing.');
}
const calS = { pts: null, p: null };
function measAskReal(pts, p) {
  const L = segLen(pts[0], pts[1]); calS.pts = pts; calS.p = p;
  const du = METRIC.has(A.scale.ru) ? 'mm' : 'in';
  $('calLen').textContent = `${fmtMeas(L / UNIT_PT[du])} ${du}`;
  $('calUnit').value = A.scale.ru; $('calReal').value = ''; $('calNote').className = 'ed-txtnote'; $('calNote').textContent = 'Every measurement on this page will use the new scale.';
  const dlg = $('calDlg'); dlg.hidden = false;
  const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], vp = vp1(p), v = vp.convertToViewportPoint(mid[0], mid[1]), r = p.div.getBoundingClientRect();
  const sx = r.left + (v[0] / vp.width) * r.width, sy = r.top + (v[1] / vp.height) * r.height, w = dlg.offsetWidth, h = dlg.offsetHeight, vr = viewer.getBoundingClientRect();
  let y = sy + 18; if (y + h > innerHeight - 8) y = sy - h - 18;
  dlg.style.left = `${Math.round(clampN(sx - w / 2, 8, innerWidth - w - 8))}px`; dlg.style.top = `${Math.round(clampN(y, vr.top + 4, innerHeight - h - 8))}px`;
  setTool('select', true);
  A.calDraft = { id: 'draft', type: 'dist', page: p.num, pts, calib: true, color: 'blue', width: WIDTHS[A.widthIdx], rects: [bboxPts(pts)], scale: A.scale, text: '', replies: [], quote: '' };
  A.draft = A.calDraft; drawAnnots(p);
  $('calReal').focus();
}
function calClose(ok) {
  const dlg = $('calDlg'); if (dlg.hidden) return;
  if (ok) {
    const v = parseFloat($('calReal').value), unit = $('calUnit').value;
    if (!(v > 0)) { $('calNote').className = 'ed-txtnote warn'; $('calNote').textContent = 'Type the real length as a number bigger than zero.'; $('calReal').focus(); return; }
    const L = segLen(calS.pts[0], calS.pts[1]), pu = METRIC.has(unit) ? 'cm' : 'in', sc = { pv: 1, pu, rv: +(v / (L / UNIT_PT[pu])).toPrecision(6), ru: unit };
    const items = A.items.filter((a) => MEAS.has(a.type) && a.page === calS.p.num);
    measSetScale(sc, { items });
    toast(`Scale set: ${scaleText(sc)}.${items.length ? ` ${items.length} ${items.length === 1 ? 'measurement' : 'measurements'} on this page updated.` : ''}`, 'success');
  }
  dlg.hidden = true; const pg = calS.p; A.calDraft = null; if (A.draft && A.draft.calib) A.draft = null; calS.pts = null; calS.p = null;
  if (pg) drawAnnots(pg);
  if (A.tool === 'calib') setTool('select', true);
}
$('calOk').addEventListener('click', () => calClose(true));
$('calCancel').addEventListener('click', () => calClose(false));
$('calDlg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); calClose(true); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); calClose(false); }
  else e.stopPropagation();
});

/* ---------- writing one into the PDF (a standard measurement annotation, plus our own data) ---------- */
const measFonts = new WeakMap();
async function measWriteParts(a, H) {
  const { ctx, doc, S_, form } = H, hex = lineColor(a), rgb = hexRgb(hex).join(' '), w = a.width || 2, pts = a.pts, f = (q) => `${r2(q[0])} ${r2(q[1])}`;
  let font = measFonts.get(doc); if (!font) { font = doc.embedStandardFont('Helvetica-Bold'); measFonts.set(doc, font); }
  const sc = scaleOk(a.scale) ? a.scale : A.scale, k = scaleK(sc), info = measInfo(a);
  const size = 10, label = info.text.replace(/²/g, '²'), tw = font.widthOfTextAtSize(label, size), bw = tw + 8, bh = size + 6, cx = info.at[0], cy = info.at[1];
  const ops = [`${rgb} RG ${w} w 1 J 1 j`];
  const circle = (x, y, r) => { const c = 0.5523 * r; return `${r2(x + r)} ${r2(y)} m ${r2(x + r)} ${r2(y + c)} ${r2(x + c)} ${r2(y + r)} ${r2(x)} ${r2(y + r)} c ${r2(x - c)} ${r2(y + r)} ${r2(x - r)} ${r2(y + c)} ${r2(x - r)} ${r2(y)} c ${r2(x - r)} ${r2(y - c)} ${r2(x - c)} ${r2(y - r)} ${r2(x)} ${r2(y - r)} c ${r2(x + c)} ${r2(y - r)} ${r2(x + r)} ${r2(y - c)} ${r2(x + r)} ${r2(y)} c h f`; };
  const path = pts.map((q, i) => `${f(q)} ${i ? 'l' : 'm'}`).join(' ');
  if (a.type === 'area') ops.push('q /GS gs', `${rgb} rg`, `${path} h B`, 'Q');
  else ops.push(`${path} S`);
  if (a.type === 'dist' && pts.length > 1) {
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1], l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * 5, ny = (dx / l) * 5;
    for (const q of pts) ops.push(`${r2(q[0] - nx)} ${r2(q[1] - ny)} m ${r2(q[0] + nx)} ${r2(q[1] + ny)} l S`);
  } else for (const q of pts) ops.push(`${rgb} rg`, circle(q[0], q[1], w / 2 + 1.6));
  ops.push('q 1 1 1 rg', `${rgb} RG 0.8 w`, `${r2(cx - bw / 2)} ${r2(cy - bh / 2)} ${r2(bw)} ${r2(bh)} re B Q`, `BT /F1 ${size} Tf ${rgb} rg ${r2(cx - tw / 2)} ${r2(cy - size * 0.35)} Td ${font.encodeText(label).toString()} Tj ET`);
  const bb = bboxPts(pts), m = w / 2 + 6;
  const rect = [Math.min(bb[0] - m, cx - bw / 2 - 1), Math.min(bb[1] - m, cy - bh / 2 - 1), Math.max(bb[2] + m, cx + bw / 2 + 1), Math.max(bb[3] + m, cy + bh / 2 + 1)].map(r2);
  const ap = form(rect, ops.join('\n'), false, { Font: { F1: font.ref }, ExtGState: { GS: { Type: 'ExtGState', ca: 0.14, CA: 1 } } });
  const nf = (u, c) => ctx.obj({ Type: 'NumberFormat', U: S_(u), C: c, F: 'D', D: 100 });
  const measure = ctx.obj({ Type: 'Measure', Subtype: 'RL', R: S_(scaleText(sc)), X: [nf(sc.ru, k)], D: [nf(sc.ru, 1)], A: [nf(`sq ${sc.ru}`, 1)] });
  const extra = { BS: { W: w, S: 'S' }, Measure: measure };
  let subtype;
  if (a.type === 'dist') { subtype = 'Line'; Object.assign(extra, { L: [...pts[0], ...pts[1]].map(r2), LE: ['None', 'None'], IT: 'LineDimension' }); }
  else { subtype = a.type === 'area' ? 'Polygon' : 'PolyLine'; Object.assign(extra, { Vertices: pts.flatMap((q) => q.map(r2)), IT: a.type === 'area' ? 'PolygonDimension' : 'PolyLineDimension' }); }
  return { subtype, rect, ap, extra, hx: { rect: a.rects[0], width: w, pts, scale: sc } };
}
