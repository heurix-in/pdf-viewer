/* =====================================================================
   Heurix PDF content editor engine
   Reads the drawing instructions of a page (text, lines and shapes, images, groups), gives each
   one a stable id and a bounding box, and rewrites the instructions to delete, move, resize or
   recolour them. Deleted text is removed from the file itself, not covered up.
   ===================================================================== */
const HXEdit = (() => {
  'use strict';

  /* ---------- small helpers ---------- */
  const WS = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
  const DL = new Uint8Array(256); for (const ch of '()<>[]{}/%') DL[ch.charCodeAt(0)] = 1;
  const T_EOF = 0, T_NUM = 1, T_NAME = 2, T_STR = 3, T_OP = 4, T_AO = 5, T_AC = 6, T_DO = 7, T_DC = 8;
  class Nm { constructor(v) { this.v = v; } }

  const I6 = () => [1, 0, 0, 1, 0, 0];
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
  const inv = (M) => {
    const d = M[0] * M[3] - M[1] * M[2]; if (Math.abs(d) < 1e-12) return null;
    return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d];
  };
  const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const scaleOf = (M) => Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;
  const fmt = (n) => { const s = (Math.round(n * 10000) / 10000).toString(); return s === '-0' ? '0' : s; };
  const strBytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const concat = (parts) => {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  };
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const toHex = (rgb) => (rgb ? `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}` : null);
  const fromHex = (h) => (/^#[0-9a-f]{6}$/i.test(h || '') ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : null);

  /* ---------- lexer ---------- */
  function parseNum(b, i, j) {
    let k = i, neg = false, c = b[k];
    if (c === 43 || c === 45) { neg = c === 45; k++; while (k < j && (b[k] === 45 || b[k] === 43)) k++; }
    let v = 0, digits = 0;
    while (k < j && b[k] >= 48 && b[k] <= 57) { v = v * 10 + (b[k] - 48); k++; digits++; }
    if (k < j && b[k] === 46) {
      k++; let sc = 0.1;
      while (k < j && b[k] >= 48 && b[k] <= 57) { v += (b[k] - 48) * sc; sc /= 10; k++; digits++; }
    }
    if (k !== j || !digits) return null;
    return neg ? -v : v;
  }
  const ascii = (b, i, j) => { let s = ''; for (let k = i; k < j; k++) s += String.fromCharCode(b[k]); return s; };
  function decodeName(b, i, j, hash) {
    if (!hash) return ascii(b, i, j);
    let s = '';
    for (let k = i; k < j; k++) {
      if (b[k] === 35 && k + 2 < j + 0 + 1) { const h = parseInt(String.fromCharCode(b[k + 1], b[k + 2]), 16); if (!isNaN(h)) { s += String.fromCharCode(h); k += 2; continue; } }
      s += String.fromCharCode(b[k]);
    }
    return s;
  }
  function readLiteral(st, i) {
    const b = st.b, n = st.n, out = []; let depth = 1, j = i + 1;
    while (j < n && depth > 0) {
      const c = b[j];
      if (c === 92) {
        j++; const d = b[j];
        if (d === 110) out.push(10); else if (d === 114) out.push(13); else if (d === 116) out.push(9); else if (d === 98) out.push(8); else if (d === 102) out.push(12);
        else if (d === 40 || d === 41 || d === 92) out.push(d);
        else if (d >= 48 && d <= 55) {
          let v = d - 48, cnt = 1;
          while (cnt < 3 && b[j + 1] >= 48 && b[j + 1] <= 55) { v = v * 8 + (b[j + 1] - 48); j++; cnt++; }
          out.push(v & 255);
        } else if (d === 13) { if (b[j + 1] === 10) j++; } else if (d === 10) { /* line continuation */ } else if (d !== undefined) out.push(d);
        j++; continue;
      }
      if (c === 40) depth++;
      else if (c === 41) { depth--; if (!depth) { j++; break; } }
      out.push(c); j++;
    }
    st.v = Uint8Array.from(out); st.i = j; return T_STR;
  }
  function readHex(st, i) {
    const b = st.b, n = st.n, out = []; let j = i + 1, hi = -1;
    while (j < n && b[j] !== 62) {
      const c = b[j]; let v = -1;
      if (c >= 48 && c <= 57) v = c - 48; else if (c >= 65 && c <= 70) v = c - 55; else if (c >= 97 && c <= 102) v = c - 87;
      if (v >= 0) { if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; } }
      j++;
    }
    if (hi >= 0) out.push(hi * 16);
    st.v = Uint8Array.from(out); st.i = j + 1; return T_STR;
  }
  function next(st) {
    const b = st.b, n = st.n; let i = st.i;
    for (;;) {
      while (i < n && WS[b[i]]) i++;
      if (i < n && b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      break;
    }
    st.ts = i;
    if (i >= n) { st.i = i; return T_EOF; }
    const c = b[i];
    if (c === 47) {
      let j = i + 1, hash = false;
      while (j < n && !WS[b[j]] && !DL[b[j]]) { if (b[j] === 35) hash = true; j++; }
      st.v = decodeName(b, i + 1, j, hash); st.i = j; return T_NAME;
    }
    if (c === 40) return readLiteral(st, i);
    if (c === 60) { if (b[i + 1] === 60) { st.i = i + 2; return T_DO; } return readHex(st, i); }
    if (c === 62) { if (b[i + 1] === 62) { st.i = i + 2; return T_DC; } st.i = i + 1; st.v = '>'; return T_OP; }
    if (c === 91) { st.i = i + 1; return T_AO; }
    if (c === 93) { st.i = i + 1; return T_AC; }
    if (c === 123 || c === 125 || c === 41) { st.i = i + 1; st.v = String.fromCharCode(c); return T_OP; }
    let j = i; while (j < n && !WS[b[j]] && !DL[b[j]]) j++;
    const num = parseNum(b, i, j);
    if (num !== null) { st.v = num; st.i = j; return T_NUM; }
    st.v = ascii(b, i, j); st.i = j; return T_OP;
  }
  function readValue(st, t) {
    if (t === T_NUM || t === T_STR) return st.v;
    if (t === T_NAME) return new Nm(st.v);
    if (t === T_AO) {
      const arr = [];
      for (;;) { const u = next(st); if (u === T_EOF || u === T_AC) break; if (u === T_OP) { arr.push(st.v === 'true' ? true : st.v === 'false' ? false : null); continue; } arr.push(readValue(st, u)); }
      return arr;
    }
    if (t === T_DO) {
      const d = {};
      for (;;) {
        const k = next(st); if (k === T_EOF || k === T_DC) break;
        if (k !== T_NAME) continue;
        const key = st.v, u = next(st); if (u === T_EOF || u === T_DC) break;
        d[key] = u === T_OP ? (st.v === 'true') : readValue(st, u);
      }
      return d;
    }
    return null;
  }
  const nameOf = (v) => (v instanceof Nm ? v.v : typeof v === 'string' ? v : '');

  function readInline(st, startOfBI) {
    const dict = {};
    for (;;) {
      const k = next(st); if (k === T_EOF) return null;
      if (k === T_OP && st.v === 'ID') break;
      if (k !== T_NAME) continue;
      const key = st.v, u = next(st); if (u === T_EOF) return null;
      dict[key] = u === T_OP ? st.v : readValue(st, u);
    }
    const b = st.b, n = st.n; let p = st.i;
    if (p < n && WS[b[p]]) p++;                                // a single white-space byte follows ID
    const get = (a, c) => (dict[a] !== undefined ? dict[a] : dict[c]);
    const filter = get('F', 'Filter');
    let end = -1;
    const len = get('L', 'Length');
    if (typeof len === 'number' && b[p + len] !== undefined) {
      let q = p + len; while (q < n && WS[b[q]]) q++;
      if (b[q] === 69 && b[q + 1] === 73) end = q + 2;
    }
    if (end < 0 && !filter) {
      const w = get('W', 'Width'), h = get('H', 'Height'), bpc = get('BPC', 'BitsPerComponent') || 8, im = get('IM', 'ImageMask');
      const cs = nameOf(get('CS', 'ColorSpace')); const comps = im ? 1 : cs === 'G' || cs === 'DeviceGray' || cs === 'CalGray' ? 1 : cs === 'CMYK' || cs === 'DeviceCMYK' ? 4 : cs === 'RGB' || cs === 'DeviceRGB' ? 3 : 0;
      if (comps && typeof w === 'number' && typeof h === 'number') {
        const dlen = Math.ceil((w * (im ? 1 : bpc) * comps) / 8) * h;
        let q = p + dlen; while (q < n && WS[b[q]]) q++;
        if (b[q] === 69 && b[q + 1] === 73) end = q + 2;
      }
    }
    if (end < 0) {                                              // look for white space + EI + white space
      for (let q = p; q + 1 < n; q++) {
        if (b[q] === 69 && b[q + 1] === 73 && (q === p || WS[b[q - 1]]) && (q + 2 >= n || WS[b[q + 2]])) {
          let ok = true; for (let r = q + 2; r < Math.min(n, q + 14); r++) { const c = b[r]; if (c > 127 || (c < 32 && !WS[c])) { ok = false; break; } }
          if (ok) { end = q + 2; break; }
        }
      }
    }
    if (end < 0) end = n;
    st.i = end; return { dict, s: startOfBI, e: end };
  }

  /* ---------- fonts ---------- */
  const STD_NAMES = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
  const stdCache = new Map(); let scratch = null;
  async function stdTable(PL, name) {
    if (stdCache.has(name)) return stdCache.get(name);
    const t = new Array(256).fill(500);
    try {
      scratch ??= await PL.PDFDocument.create();
      const f = await scratch.embedFont(name);
      for (let c = 32; c < 256; c++) { try { t[c] = f.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch (_) { /* not in WinAnsi */ } }
    } catch (_) { /* keep defaults */ }
    stdCache.set(name, t); return t;
  }
  function stdFor(base) {
    const n = (base || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[\s_]/g, '');
    const bold = /bold|black|heavy|demi/.test(n), it = /italic|oblique/.test(n);
    if (/courier|mono|consol/.test(n)) return bold ? (it ? 'Courier-BoldOblique' : 'Courier-Bold') : (it ? 'Courier-Oblique' : 'Courier');
    if (/times|serif|georgia|garamond|palatino|book|roman/.test(n) && !/sans/.test(n)) return bold ? (it ? 'Times-BoldItalic' : 'Times-Bold') : (it ? 'Times-Italic' : 'Times-Roman');
    return bold ? (it ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (it ? 'Helvetica-Oblique' : 'Helvetica');
  }
  const DEFAULT_FONT = { two: false, vert: false, asc: 750, desc: -250, w: () => 500 };

  async function buildFont(PL, fdict) {
    const { PDFName, PDFArray, PDFNumber, PDFDict, PDFRef } = PL, N = (s) => PDFName.of(s);
    const numOf = (v, d) => (v instanceof PDFNumber ? v.asNumber() : d);
    const nm = (v) => (v instanceof PDFName ? v.decodeText() : '');
    const sub = nm(fdict.lookup(N('Subtype')));
    const baseFont = nm(fdict.lookup(N('BaseFont')));
    let desc = fdict.lookup(N('FontDescriptor'));
    let info = { two: false, vert: false, asc: 750, desc: -250, w: () => 500 };
    if (sub === 'Type0') {
      const dfa = fdict.lookup(N('DescendantFonts')); let cf = null;
      if (dfa instanceof PDFArray && dfa.size()) cf = dfa.lookup(0, PDFDict);
      let dw = 1000; const W = new Map();
      if (cf) {
        dw = numOf(cf.lookup(N('DW')), 1000);
        const wa = cf.lookup(N('W'));
        if (wa instanceof PDFArray) {
          for (let i = 0; i < wa.size();) {
            const c0 = wa.lookup(i); const c1 = wa.lookup(i + 1);
            if (!(c0 instanceof PDFNumber)) { i++; continue; }
            if (c1 instanceof PDFArray) { const c = c0.asNumber(); for (let k = 0; k < c1.size(); k++) W.set(c + k, numOf(c1.lookup(k), dw)); i += 2; }
            else if (c1 instanceof PDFNumber) { const w = numOf(wa.lookup(i + 2), dw), a = c0.asNumber(), z = Math.min(c1.asNumber(), a + 70000); for (let c = a; c <= z; c++) W.set(c, w); i += 3; }
            else i++;
          }
        }
        desc = cf.lookup(N('FontDescriptor')) || desc;
      }
      const enc = fdict.lookup(N('Encoding'));
      info.two = true; info.vert = enc instanceof PDFName && /-V$/.test(enc.decodeText());
      info.exotic = !(enc instanceof PDFName && /^Identity/.test(enc.decodeText()));       // other code maps (1- and 2-byte mixes) are not taken apart
      info.w = (c) => (W.has(c) ? W.get(c) : dw);
    } else {
      const first = numOf(fdict.lookup(N('FirstChar')), 0), wa = fdict.lookup(N('Widths'));
      let miss = 0;
      if (desc instanceof PDFDict) miss = numOf(desc.lookup(N('MissingWidth')), 0);
      if (wa instanceof PDFArray && wa.size()) {
        const arr = []; for (let k = 0; k < wa.size(); k++) arr.push(numOf(wa.lookup(k), miss));
        let k3 = 1;
        if (sub === 'Type3') { const fm = fdict.lookup(N('FontMatrix')); if (fm instanceof PDFArray) k3 = numOf(fm.lookup(0), 0.001) * 1000; else k3 = 1; }
        info.w = (c) => { const i = c - first; return (i >= 0 && i < arr.length ? arr[i] : miss) * k3; };
      } else {
        const tbl = await stdTable(PL, stdFor(baseFont));
        info.w = (c) => tbl[c] ?? 500;
      }
    }
    if (desc instanceof PDFDict) {
      const a = numOf(desc.lookup(N('Ascent')), 0), d = numOf(desc.lookup(N('Descent')), 0);
      if (a > 0) info.asc = Math.min(a, 950);
      if (d < 0) info.desc = Math.max(d, -300);
    }
    return info;
  }

  /* ---------- resources of a page or form ---------- */
  async function loadResources(PL, resDict) {
    const { PDFName, PDFDict, PDFRef, PDFArray, PDFNumber, PDFStream } = PL, N = (s) => PDFName.of(s);
    const fonts = new Map(), xobjs = new Map();
    if (!(resDict instanceof PDFDict)) return { fonts, xobjs };
    const fd = resDict.lookup(N('Font'));
    if (fd instanceof PDFDict) {
      for (const [k, v] of fd.entries()) {
        try { const d = fd.lookup(k, PDFDict); fonts.set(k.decodeText(), await buildFont(PL, d)); } catch (_) { /* unreadable font */ }
      }
    }
    const xd = resDict.lookup(N('XObject'));
    if (xd instanceof PDFDict) {
      for (const [k, v] of xd.entries()) {
        try {
          const st = xd.lookup(k); if (!(st instanceof PDFStream)) continue;
          const sub = st.dict.lookup(N('Subtype')); const sn = sub instanceof PDFName ? sub.decodeText() : '';
          const nums = (a) => { if (!(a instanceof PDFArray)) return null; const o = []; for (let i = 0; i < a.size(); i++) { const x = a.lookup(i); o.push(x instanceof PDFNumber ? x.asNumber() : 0); } return o; };
          xobjs.set(k.decodeText(), { subtype: sn, ref: v instanceof PDFRef ? v : null, stream: st, bbox: nums(st.dict.lookup(N('BBox'))), matrix: nums(st.dict.lookup(N('Matrix'))) });
        } catch (_) { /* unreadable xobject */ }
      }
    }
    return { fonts, xobjs };
  }

  /* ---------- colours ---------- */
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const rgbFromGray = (g) => { const v = Math.round(clamp01(g) * 255); return [v, v, v]; };
  const rgbFromRGB = (r, g, b) => [Math.round(clamp01(r) * 255), Math.round(clamp01(g) * 255), Math.round(clamp01(b) * 255)];
  const rgbFromCMYK = (c, m, y, k) => rgbFromRGB((1 - clamp01(c)) * (1 - clamp01(k)), (1 - clamp01(m)) * (1 - clamp01(k)), (1 - clamp01(y)) * (1 - clamp01(k)));

  /* ---------- analysis of one content stream ---------- */
  const num = (a, i, d = 0) => (typeof a[i] === 'number' ? a[i] : d);
  const MAX_POLY = 4000;

  function analyzeStream(bytes, res, ctm0, idPrefix, opts) {
    const objs = [], subs = new Map();        // subs: form object id -> {bytes, res, objs, subs}
    const idOf = (off) => (idPrefix ? `${idPrefix}>${off}` : `${off}`);
    const newGS = () => ({ ctm: ctm0.slice(), tc: 0, tw: 0, th: 1, tl: 0, font: null, fs: 0, tr: 0, ts: 0, fill: [0, 0, 0], stroke: [0, 0, 0], fcs: 'rgb', scs: 'rgb', lw: 1 });
    let gs = newGS(); const stack = [];
    let path = null, tm = I6(), tlm = I6(), lastRun = null, positioned = true;
    const runs = [];

    const ensure = (start) => { if (!path) path = { start, subs: [], cur: null, clip: false, n: 0, open: null }; if (path.start < 0) path.start = start; };
    const moveTo = (x, y, start) => { ensure(start); const p = ap(gs.ctm, x, y); path.open = { pts: [p], closed: false }; path.subs.push(path.open); path.cur = p; path.n++; };
    const lineTo = (x, y, start) => { ensure(start); const p = ap(gs.ctm, x, y); if (!path.open) { path.open = { pts: [p], closed: false }; path.subs.push(path.open); } else path.open.pts.push(p); path.cur = p; path.n++; };
    const curveTo = (x1, y1, x2, y2, x3, y3, start) => {
      ensure(start); const p0 = path.cur || ap(gs.ctm, x1, y1);
      const p1 = ap(gs.ctm, x1, y1), p2 = ap(gs.ctm, x2, y2), p3 = ap(gs.ctm, x3, y3);
      if (!path.open) { path.open = { pts: [p0], closed: false }; path.subs.push(path.open); }
      for (let i = 1; i <= 6; i++) {
        const t = i / 6, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        path.open.pts.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
      }
      path.cur = p3; path.n++;
    };
    const closeSub = () => { if (path && path.open) { path.open.closed = true; path.cur = path.open.pts[0]; } };

    function paint(op, s, e, argsStart) {
      if (!path) return;
      const p = path; path = null;
      if (op === 'n') return;
      const closing = op === 's' || op === 'b' || op === 'b*';
      if (closing && p.open) p.open.closed = true;
      const fill = op === 'f' || op === 'F' || op === 'f*' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*';
      const stroke = op === 'S' || op === 's' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*';
      if (p.start < 0) return;
      let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18, count = 0;
      for (const sp of p.subs) for (const q of sp.pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; count++; }
      if (!count) return;
      const half = stroke ? Math.max(gs.lw * scaleOf(gs.ctm), 0.5) / 2 : 0;
      objs.push({
        id: idOf(p.start), kind: 'path', bbox: [x0 - half, y0 - half, x1 + half, y1 + half], ranges: [[p.start, e]], opS: s, opE: e,
        ctm: gs.ctm.slice(), paint: { fill, stroke }, clip: p.clip, fill: fill ? toHex(gs.fill) : null, stroke: stroke ? toHex(gs.stroke) : null,
        lw: gs.lw, lwPage: gs.lw * scaleOf(gs.ctm), poly: count <= MAX_POLY ? p.subs.map((sp) => ({ pts: sp.pts, closed: sp.closed })) : null, z: objs.length
      });
    }

    function show(items, s, e, kind, dq) {
      const font = (gs.font && res.fonts.get(gs.font)) || DEFAULT_FONT;
      const fs = gs.fs, th = gs.th;
      const elems = [], glyphs = [];
      let x = 0, xmin = 1e18, xmax = -1e18;
      for (const it of items) {
        if (typeof it === 'number') { x -= (it / 1000) * fs * th; elems.push({ n: it }); continue; }
        if (!(it instanceof Uint8Array)) continue;
        const codes = [];
        if (font.two) { for (let k = 0; k + 1 < it.length; k += 2) codes.push(it[k] * 256 + it[k + 1]); if (it.length % 2) codes.push(it[it.length - 1] * 256); }
        else for (let k = 0; k < it.length; k++) codes.push(it[k]);
        const el = { c: codes, g0: glyphs.length }; elems.push(el);
        for (const code of codes) {
          const w = font.w(code), adv = ((w / 1000) * fs + gs.tc + (!font.two && code === 32 ? gs.tw : 0)) * th, gw = (w / 1000) * fs * th;
          glyphs.push({ x0: x, x1: x + gw, adv });
          if (x < xmin) xmin = x; if (x + gw > xmax) xmax = x + gw;
          x += adv;
        }
      }
      const F = mul(tm, gs.ctm);
      if (lastRun && !positioned) lastRun.chainedNext = true;
      positioned = false;
      let run = null;
      if (glyphs.length && fs !== 0 && gs.tr !== 3 && xmax > xmin - 1e-9) {
        const yb = gs.ts + (font.desc * fs) / 1000, yt = gs.ts + (font.asc * fs) / 1000;
        const ys = Math.min(yb, yt), yh = Math.max(yb, yt);
        const q = [ap(F, xmin, ys), ap(F, xmax, ys), ap(F, xmax, yh), ap(F, xmin, yh)];
        const bx = q.map((p) => p[0]), by = q.map((p) => p[1]);
        run = {
          id: idOf(s), kind: 'text', ranges: [[s, e]], bbox: [Math.min(...bx), Math.min(...by), Math.max(...bx), Math.max(...by)], quad: q, F, fs, th,
          ys, yh, xmin, xmax, elems, glyphs, two: font.two, exotic: !!font.exotic, op: kind, dq: dq || null, chainedNext: false, vert: font.vert, fill: toHex(gs.fill), pageSize: Math.abs(fs) * scaleOf(F), z: 0
        };
        runs.push(run);
      } else if (glyphs.length || elems.length) {
        run = { id: idOf(s), kind: 'hidden', chainedNext: false };
      }
      lastRun = run;
      tm = mul([1, 0, 0, 1, x, 0], tm);
    }

    const handler = (op, a, s, e, inline) => {
      switch (op) {
        case 'q': stack.push(gs); gs = { ...gs, ctm: gs.ctm.slice() }; return;
        case 'Q': if (stack.length) gs = stack.pop(); return;
        case 'cm': if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map((v) => (typeof v === 'number' ? v : 0)), gs.ctm); return;
        case 'w': gs.lw = num(a, 0, 1); return;
        case 'g': gs.fill = rgbFromGray(num(a, 0)); gs.fcs = 'gray'; return;
        case 'G': gs.stroke = rgbFromGray(num(a, 0)); gs.scs = 'gray'; return;
        case 'rg': gs.fill = rgbFromRGB(num(a, 0), num(a, 1), num(a, 2)); gs.fcs = 'rgb'; return;
        case 'RG': gs.stroke = rgbFromRGB(num(a, 0), num(a, 1), num(a, 2)); gs.scs = 'rgb'; return;
        case 'k': gs.fill = rgbFromCMYK(num(a, 0), num(a, 1), num(a, 2), num(a, 3)); gs.fcs = 'cmyk'; return;
        case 'K': gs.stroke = rgbFromCMYK(num(a, 0), num(a, 1), num(a, 2), num(a, 3)); gs.scs = 'cmyk'; return;
        case 'cs': { const n = nameOf(a[0]); gs.fcs = /gray/i.test(n) ? 'gray' : /cmyk/i.test(n) ? 'cmyk' : /rgb/i.test(n) ? 'rgb' : 'other'; if (gs.fcs === 'other') gs.fill = null; else if (gs.fcs === 'gray') gs.fill = [0, 0, 0]; else if (gs.fcs === 'rgb') gs.fill = [0, 0, 0]; else gs.fill = [0, 0, 0]; return; }
        case 'CS': { const n = nameOf(a[0]); gs.scs = /gray/i.test(n) ? 'gray' : /cmyk/i.test(n) ? 'cmyk' : /rgb/i.test(n) ? 'rgb' : 'other'; if (gs.scs === 'other') gs.stroke = null; else gs.stroke = [0, 0, 0]; return; }
        case 'sc': case 'scn': {
          const n = a.filter((v) => typeof v === 'number');
          if (a.length && typeof a[a.length - 1] !== 'number') { gs.fill = null; return; }          // pattern
          if (gs.fcs === 'gray' && n.length === 1) gs.fill = rgbFromGray(n[0]); else if (gs.fcs === 'rgb' && n.length === 3) gs.fill = rgbFromRGB(n[0], n[1], n[2]); else if (gs.fcs === 'cmyk' && n.length === 4) gs.fill = rgbFromCMYK(n[0], n[1], n[2], n[3]); else gs.fill = null;
          return;
        }
        case 'SC': case 'SCN': {
          const n = a.filter((v) => typeof v === 'number');
          if (a.length && typeof a[a.length - 1] !== 'number') { gs.stroke = null; return; }
          if (gs.scs === 'gray' && n.length === 1) gs.stroke = rgbFromGray(n[0]); else if (gs.scs === 'rgb' && n.length === 3) gs.stroke = rgbFromRGB(n[0], n[1], n[2]); else if (gs.scs === 'cmyk' && n.length === 4) gs.stroke = rgbFromCMYK(n[0], n[1], n[2], n[3]); else gs.stroke = null;
          return;
        }
        // paths
        case 'm': moveTo(num(a, 0), num(a, 1), s); return;
        case 'l': lineTo(num(a, 0), num(a, 1), s); return;
        case 'c': curveTo(num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5), s); return;
        case 'v': { ensure(s); const c0 = path.cur ? inv(gs.ctm) && ap(inv(gs.ctm), path.cur[0], path.cur[1]) : [num(a, 0), num(a, 1)]; curveTo(c0[0], c0[1], num(a, 0), num(a, 1), num(a, 2), num(a, 3), s); return; }
        case 'y': curveTo(num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 2), num(a, 3), s); return;
        case 'h': closeSub(); return;
        case 're': {
          const x = num(a, 0), y = num(a, 1), w = num(a, 2), h = num(a, 3);
          ensure(s); const pts = [ap(gs.ctm, x, y), ap(gs.ctm, x + w, y), ap(gs.ctm, x + w, y + h), ap(gs.ctm, x, y + h)];
          path.open = { pts, closed: true }; path.subs.push(path.open); path.cur = pts[0]; path.n++; return;
        }
        case 'W': case 'W*': if (path) path.clip = true; return;
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': paint(op, s, e); return;
        // text
        case 'BT': tm = I6(); tlm = I6(); positioned = true; lastRun = null; return;
        case 'ET': return;
        case 'Tc': gs.tc = num(a, 0); return;
        case 'Tw': gs.tw = num(a, 0); return;
        case 'Tz': gs.th = num(a, 0, 100) / 100; return;
        case 'TL': gs.tl = num(a, 0); return;
        case 'Tr': gs.tr = num(a, 0); return;
        case 'Ts': gs.ts = num(a, 0); return;
        case 'Tf': gs.font = nameOf(a[0]); gs.fs = num(a, 1); return;
        case 'Td': tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm.slice(); positioned = true; return;
        case 'TD': gs.tl = -num(a, 1); tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm.slice(); positioned = true; return;
        case 'Tm': if (a.length >= 6) { tlm = a.slice(0, 6).map((v) => (typeof v === 'number' ? v : 0)); tm = tlm.slice(); } positioned = true; return;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); positioned = true; return;
        case 'Tj': if (a[0] instanceof Uint8Array) show([a[0]], s, e, 'Tj'); return;
        case 'TJ': if (Array.isArray(a[0])) show(a[0], s, e, 'TJ'); return;
        case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); positioned = true; if (a[0] instanceof Uint8Array) show([a[0]], s, e, "'"); return;
        case '"': gs.tw = num(a, 0); gs.tc = num(a, 1); tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); positioned = true; if (a[2] instanceof Uint8Array) show([a[2]], s, e, '"', [num(a, 0), num(a, 1)]); return;
        // images and groups
        case 'BI': {
          if (!inline) return;
          const c = gs.ctm, q = [ap(c, 0, 0), ap(c, 1, 0), ap(c, 1, 1), ap(c, 0, 1)];
          const bx = q.map((p) => p[0]), by = q.map((p) => p[1]);
          objs.push({ id: idOf(inline.s), kind: 'image', inline: true, bbox: [Math.min(...bx), Math.min(...by), Math.max(...bx), Math.max(...by)], quad: q, ranges: [[inline.s, inline.e]], ctm: c.slice(), z: objs.length });
          return;
        }
        case 'Do': {
          const nm = nameOf(a[0]), x = res.xobjs.get(nm); if (!x) return;
          const id = idOf(s);
          if (x.subtype === 'Image') {
            const c = gs.ctm, q = [ap(c, 0, 0), ap(c, 1, 0), ap(c, 1, 1), ap(c, 0, 1)];
            const bx = q.map((p) => p[0]), by = q.map((p) => p[1]);
            objs.push({ id, kind: 'image', name: nm, bbox: [Math.min(...bx), Math.min(...by), Math.max(...bx), Math.max(...by)], quad: q, ranges: [[s, e]], ctm: c.slice(), z: objs.length });
          } else if (x.subtype === 'Form') {
            const M = mul(x.matrix && x.matrix.length >= 6 ? x.matrix : I6(), gs.ctm);
            let bbox = null, quad = null;
            if (x.bbox && x.bbox.length >= 4) {
              const [l, b0, r, t] = x.bbox; quad = [ap(M, l, b0), ap(M, r, b0), ap(M, r, t), ap(M, l, t)];
              const bx = quad.map((p) => p[0]), by = quad.map((p) => p[1]); bbox = [Math.min(...bx), Math.min(...by), Math.max(...bx), Math.max(...by)];
            }
            const o = { id, kind: 'form', name: nm, bbox, quad, ranges: [[s, e]], ctm: gs.ctm.slice(), formM: M, z: objs.length, ref: x.ref, nameStart: s };
            if (opts && opts.expand && opts.expand.has(id) && opts.sub) {
              const inner = opts.sub(x, M, id);
              if (inner) { o.expanded = true; subs.set(id, inner); }
            }
            objs.push(o);
          }
          return;
        }
        default: return;
      }
    };

    // the scanner
    const st = { b: bytes, i: 0, n: bytes.length, v: null, ts: 0 };
    const args = []; let argStart = -1;
    for (;;) {
      const t = next(st);
      if (t === T_EOF) break;
      if (t === T_OP) {
        const op = st.v, s = argStart >= 0 ? argStart : st.ts;
        if (op === 'BI') { const bs = st.ts; const img = readInline(st, bs); if (img) handler('BI', [], bs, st.i, img); args.length = 0; argStart = -1; continue; }
        handler(op, args, s, st.i);
        args.length = 0; argStart = -1; continue;
      }
      if (argStart < 0) argStart = st.ts;
      args.push(readValue(st, t));
    }

    // text runs -> lines
    const lines = [];
    let cur = null;
    for (const r of runs) {
      let merged = false;
      if (cur) {
        const q = cur.runs[cur.runs.length - 1];
        const ux = q.F[0], uy = q.F[1], ul = Math.hypot(ux, uy) || 1, vx = -uy / ul, vy = ux / ul;
        const rx = r.F[0], ry = r.F[1], rl = Math.hypot(rx, ry) || 1;
        const sameDir = Math.abs((ux * rx + uy * ry) / (ul * rl) - 1) < 0.02;
        const o1 = ap(q.F, 0, q.ys), o2 = ap(r.F, 0, r.ys);
        const dv = (o2[0] - o1[0]) * vx / 1 + (o2[1] - o1[1]) * vy;
        const endQ = ap(q.F, q.xmax, 0), startR = ap(r.F, r.xmin, 0);
        const du = ((startR[0] - endQ[0]) * ux + (startR[1] - endQ[1]) * uy) / ul;
        const sz = Math.max(q.pageSize, r.pageSize, 1);
        if (sameDir && Math.abs(dv) < 0.35 * sz && du > -0.6 * sz && du < 1.6 * sz) { cur.runs.push(r); merged = true; }
      }
      if (!merged) { cur = { runs: [r] }; lines.push(cur); }
    }
    for (const L of lines) {
      let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18, ranges = [];
      for (const r of L.runs) { x0 = Math.min(x0, r.bbox[0]); y0 = Math.min(y0, r.bbox[1]); x1 = Math.max(x1, r.bbox[2]); y1 = Math.max(y1, r.bbox[3]); ranges = ranges.concat(r.ranges); }
      objs.push({ id: L.runs[0].id, kind: 'text', bbox: [x0, y0, x1, y1], runs: L.runs, ranges, fs: L.runs[0].pageSize, fill: L.runs[0].fill, z: L.runs[0].ranges[0][0] });
    }
    objs.sort((p, q) => (p.kind === 'text' ? p.runs[0].ranges[0][0] : p.ranges[0][0]) - (q.kind === 'text' ? q.runs[0].ranges[0][0] : q.ranges[0][0]));
    objs.forEach((o, i) => { o.z = i; });
    return { bytes, objs, subs, res };
  }

  /* ---------- reading the page ---------- */
  function decodeStream(PL, st) {
    try { return st instanceof PL.PDFRawStream ? PL.decodePDFRawStream(st).decode() : st.getContents(); } catch (_) { return new Uint8Array(0); }
  }
  function pageContentBytes(PL, page) {
    const { PDFName, PDFArray, PDFStream } = PL, N = (s) => PDFName.of(s);
    const c = page.node.lookup(N('Contents')); const parts = [];
    if (c instanceof PDFStream) parts.push(decodeStream(PL, c));
    else if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) { const s = c.lookup(i); if (s instanceof PDFStream) { if (parts.length) parts.push(new Uint8Array([10])); parts.push(decodeStream(PL, s)); } }
    return concat(parts);
  }

  async function analyzePage(PL, doc, pageIdx, expand) {
    const page = doc.getPage(pageIdx), prefix = `p${pageIdx + 1}:`;
    const bytes = pageContentBytes(PL, page);
    const res = await loadResources(PL, page.node.Resources());
    expand = expand || new Set();
    // build the tree breadth-first as needed
    const wantDeep = expand.size > 0;
    const formRes = wantDeep ? await preloadAll(PL, res) : null;
    const opts = {
      expand,
      sub: (x, M, id) => {
        const r = formRes && formRes.get(x.stream);
        if (!r) return null;
        const inner = analyzeStream(decodeStream(PL, x.stream), { fonts: r.fonts.size || r.xobjs.size ? r.fonts : res.fonts, xobjs: r.fonts.size || r.xobjs.size ? r.xobjs : res.xobjs }, M, id, opts);
        inner.formStream = x.stream; inner.formRef = x.ref;
        return inner;
      }
    };
    const top = analyzeStream(bytes, res, I6(), '', opts);
    const flat = [];
    const idp = (o) => prefix + o.id;
    (function walk(level, parent) {
      for (const o of level.objs) {
        o.uid = idp(o); o.parentUid = parent; o.level = level;
        flat.push(o);
        const sub = level.subs.get(o.id); if (sub) { o.hidden = true; walk(sub, o.uid); }
      }
    })(top, null);
    return { page, top, objs: flat, pageIdx, prefix };
  }
  // loads the resources of every form reachable from these resources (so expanding a group is synchronous)
  async function preloadAll(PL, res, seen = new Map(), depth = 0) {
    for (const [, x] of res.xobjs) {
      if (x.subtype !== 'Form' || seen.has(x.stream) || depth > 6) continue;
      const r = await loadResources(PL, x.stream.dict.lookup(PL.PDFName.of('Resources')));
      seen.set(x.stream, r);
      await preloadAll(PL, r, seen, depth + 1);
    }
    return seen;
  }

  /* ---------- rewriting ---------- */
  const cmText = (X) => `${X.map(fmt).join(' ')} cm`;
  function styleOps(sty, paint) {
    let t = '';
    const f = fromHex(sty.f), s = fromHex(sty.s);
    if (f && paint.fill) t += `${f.map((v) => fmt(v / 255)).join(' ')} rg `;
    if (s && paint.stroke) t += `${s.map((v) => fmt(v / 255)).join(' ')} RG `;
    if (typeof sty.w === 'number' && paint.stroke) t += `${fmt(Math.max(0, sty.w))} w `;
    return t;
  }

  function buildRunText(run, cutSet) {
    const elems = run.elems, fs = run.fs, th = run.th;
    const parts = []; let pend = 0, cur = null, any = false;
    const flushStr = () => { if (cur && cur.length) { parts.push(`<${cur.join('')}>`); } cur = null; };
    const flushNum = () => { if (pend !== 0) { parts.push(fmt(pend)); pend = 0; } };
    for (const el of elems) {
      if (el.n !== undefined) { flushStr(); pend += el.n; continue; }
      for (let k = 0; k < el.c.length; k++) {
        const gi = el.g0 + k;
        if (cutSet.has(gi)) { flushStr(); pend += fs && th ? (-1000 * run.glyphs[gi].adv) / (fs * th) : 0; continue; }
        if (pend !== 0) { flushStr(); flushNum(); }
        cur ??= []; cur.push(run.two ? el.c[k].toString(16).padStart(4, '0') : hex2(el.c[k] & 255)); any = true;
      }
    }
    flushStr(); flushNum();
    let text = '';
    if (run.op === "'") text = 'T* ';
    else if (run.op === '"') text = `${fmt(run.dq[0])} Tw ${fmt(run.dq[1])} Tc T* `;
    if (any) text += `[${parts.join(' ')}] TJ`;
    else if (run.chainedNext && parts.length) text += `[${parts.join(' ')}] TJ`;
    return text.trim() ? text : ' ';
  }

  // Returns the replacements for one level of the document. `hook` rewrites a group's own stream when something inside it changed.
  function levelEdits(level, ed, hook) {
    const reps = [], names = new Set(), rewritten = new Set();
    const del = ed.delSet, cut = ed.cut;
    for (const o of level.objs) {
      const uid = o.uid;
      const sub = level.subs.get(o.id);
      if (o.kind === 'text') {
        const gd = del.has(uid);
        for (const r of o.runs) {
          const ruid = ed.prefix + r.id;
          let set = null;
          if (gd || del.has(ruid)) { set = new Set(r.glyphs.map((_, i) => i)); }
          else if (cut[ruid]) { set = new Set(); for (const [a, b] of cut[ruid]) for (let i = a; i < b; i++) set.add(i); }
          if (set && set.size) { reps.push({ s: r.ranges[0][0], e: r.ranges[0][1], run: r, cutSet: set }); }
        }
        continue;
      }
      if (del.has(uid)) {
        if ((o.kind === 'image' || o.kind === 'form') && o.name && !o.inline) names.add(o.name);
        if (o.kind === 'path' && o.clip) reps.push({ s: o.opS, e: o.opE, text: 'n' });
        else for (const [a, b] of o.ranges) reps.push({ s: a, e: b, text: ' ' });
        continue;
      }
      const xf = ed.xf[uid], sty = ed.sty[uid];
      let innerName = null;
      if (sub && hook) { innerName = hook(o, sub); if (innerName) { names.add(o.name); rewritten.add(uid); } }
      if (!xf && !sty && !innerName) continue;
      if (o.kind === 'path' && o.clip) continue;
      const [a, b] = o.ranges[0];
      let pre = 'q ', post = ' Q';
      if (xf) { const Ci = inv(o.ctm); if (Ci) pre += `${cmText(mul(mul(o.ctm, xf), Ci))} `; }
      if (sty && o.kind === 'path') pre += styleOps(sty, o.paint);
      reps.push({ s: a, e: b, wrap: { pre, post }, doName: innerName, obj: o });
    }
    reps.names = names; reps.rewritten = rewritten;
    return reps;
  }

  // a private copy of a resources dictionary (and of its XObject list), so changing it does not touch other pages that share it
  function privateRes(PL, ctx, resDict) {
    const { PDFDict, PDFName } = PL, N = (v) => PDFName.of(v);
    const nr = PDFDict.withContext(ctx), nx = PDFDict.withContext(ctx);
    if (resDict instanceof PDFDict) {
      for (const [k, v] of resDict.entries()) nr.set(k, v);
      const xo = resDict.lookup(N('XObject'));
      if (xo instanceof PDFDict) for (const [k, v] of xo.entries()) nx.set(k, v);
    }
    nr.set(N('XObject'), nx);
    return { nr, nx };
  }

  function applyReps(bytes, reps) {
    reps.sort((p, q) => p.s - q.s || p.e - q.e);
    const parts = []; let pos = 0;
    for (const r of reps) {
      if (r.s < pos) continue;
      parts.push(bytes.subarray(pos, r.s));
      if (r.run) parts.push(strBytes(buildRunText(r.run, r.cutSet)));
      else if (r.wrap) {
        parts.push(strBytes(r.wrap.pre));
        if (r.doName) parts.push(strBytes(`/${r.doName} Do`)); else parts.push(bytes.subarray(r.s, r.e));
        parts.push(strBytes(r.wrap.post));
      } else parts.push(strBytes(r.text));
      pos = r.e;
    }
    parts.push(bytes.subarray(pos));
    return concat(parts);
  }


  /* Delete every object that nothing refers to any more, so the old content (with the erased text) is not left inside the file */
  function sweep(PL, doc) {
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

  /* ---------- applying a set of edits to a document ---------- */
  const emptyEd = () => ({ del: [], cut: {}, xf: {}, sty: {}, add: [] });
  const isEmptyEd = (ed) => !ed || (!ed.del.length && !Object.keys(ed.cut).length && !Object.keys(ed.xf).length && !Object.keys(ed.sty).length && !ed.add.length);
  const pageOfId = (id) => { const m = /^p(\d+):/.exec(id); return m ? +m[1] : 0; };

  async function applyEdits(PL, doc, ed, assets, hooks = {}) {
    const { PDFName, PDFDict, PDFRawStream } = PL, N = (s) => PDFName.of(s), ctx = doc.context;
    const byPage = new Map(); const get = (n) => (byPage.get(n) || byPage.set(n, { del: new Set(), cut: {}, xf: {}, sty: {}, add: [], expand: new Set() }).get(n));
    const noteExpand = (n, id) => {                                  // groups that hold edited objects must be opened
      const chain = id.replace(/^p\d+:/, '').split('>'); let pref = '';
      for (let i = 0; i < chain.length - 1; i++) { pref = pref ? `${pref}>${chain[i]}` : chain[i]; get(n).expand.add(pref); }
    };
    for (const id of ed.del) { const n = pageOfId(id); if (n) { get(n).del.add(id); noteExpand(n, id); } }
    for (const id in ed.cut) { const n = pageOfId(id); if (n) { get(n).cut[id] = ed.cut[id]; noteExpand(n, id); } }
    for (const id in ed.xf) { const n = pageOfId(id); if (n) { get(n).xf[id] = ed.xf[id]; noteExpand(n, id); } }
    for (const id in ed.sty) { const n = pageOfId(id); if (n) { get(n).sty[id] = ed.sty[id]; noteExpand(n, id); } }
    for (const a of ed.add) get(a.page).add.push(a);
    let uniq = 0, changedAny = false;
    for (const [n, pe] of byPage) {
      const idx = n - 1; if (idx < 0 || idx >= doc.getPageCount()) continue;
      const A = await analyzePage(PL, doc, idx, pe.expand);
      const edIn = { delSet: pe.del, cut: pe.cut, xf: pe.xf, sty: pe.sty, prefix: A.prefix };
      let touched = false;
      const pp = privateRes(PL, ctx, A.page.node.normalizedEntries().Resources);
      A.page.node.set(N('Resources'), pp.nr);
      const prune = (nx, level, reps) => {                      // forget pictures and groups that are gone, so their data does not stay in the file
        if (!reps.names.size) return;
        const used = new Set();
        for (const o of level.objs) if ((o.kind === 'image' || o.kind === 'form') && o.name && !edIn.delSet.has(o.uid) && !reps.rewritten.has(o.uid)) used.add(o.name);
        for (const nm of reps.names) if (!used.has(nm)) nx.delete(N(nm));
      };
      // rewrite a level; groups with edits inside get a private copy of their stream
      const hook = (o, sub) => {
        const r2 = rewriteLevel(sub);
        if (!r2) return null;
        const base = sub.formStream, nd = ctx.flateStream(r2.bytes, {});
        for (const [k, v] of base.dict.entries()) { const kn = k.decodeText(); if (kn === 'Filter' || kn === 'DecodeParms' || kn === 'Length' || kn === 'DL') continue; nd.dict.set(k, v); }
        const own = base.dict.lookup(N('Resources')), fr = privateRes(PL, ctx, own instanceof PDFDict ? own : pp.nr);
        nd.dict.set(N('Resources'), fr.nr); prune(fr.nx, sub, r2.reps);
        const nref = ctx.register(nd), nm = `HxFm${Date.now().toString(36)}${++uniq}`;
        pp.nx.set(N(nm), nref);
        touched = true; return nm;
      };
      const rewriteLevel = (level) => {
        const reps = levelEdits(level, edIn, hook);
        if (!reps.length) return null;
        return { bytes: applyReps(level.bytes, reps), reps };
      };
      const topRes = rewriteLevel(A.top);
      let newBytes = topRes ? topRes.bytes : A.top.bytes;
      if (topRes) prune(pp.nx, A.top, topRes.reps);
      const wasChanged = newBytes !== A.top.bytes || touched;
      // additions
      let tail = '';
      if (pe.add.length) {
        for (const a of pe.add) {
          const asset = assets && assets.get(a.asset); if (!asset) continue;
          let img;
          try { img = asset.mime === 'image/jpeg' ? await doc.embedJpg(asset.bytes) : await doc.embedPng(asset.bytes); } catch (e) { continue; }
          const nm = `HxImg${Date.now().toString(36)}${++uniq}`;
          pp.nx.set(N(nm), img.ref);
          const r = (((a.rot || 0) % 360) + 360) % 360, dx = a.x1 - a.x0, dy = a.y1 - a.y0;
          const M = r === 90 ? [0, dy, -dx, 0, a.x1, a.y0] : r === 180 ? [-dx, 0, 0, -dy, a.x1, a.y1] : r === 270 ? [0, -dy, dx, 0, a.x0, a.y1] : [dx, 0, 0, dy, a.x0, a.y0];
          tail += `q ${M.map(fmt).join(' ')} cm /${nm} Do Q\n`;
        }
      }
      if (wasChanged || tail) {
        const full = concat([strBytes('q\n'), newBytes, strBytes('\nQ\n'), strBytes(tail)]);
        const s = ctx.flateStream(full, {});
        A.page.node.set(N('Contents'), ctx.register(s));
        A.page.node.delete(N('Thumb'));                      // an old preview picture would still show the erased content
        changedAny = true;
      }
    }
    if (changedAny) sweep(PL, doc);
  }



  // merge a cut map into another, joining overlapping ranges
  function mergeCut(dst, src) {
    for (const k in src) {
      const all = (dst[k] || []).concat(src[k]).map((r) => [r[0], r[1]]).sort((p, q) => p[0] - q[0]);
      const out = [];
      for (const r of all) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push(r); }
      dst[k] = out;
    }
    return dst;
  }

  /* ---------- picking helpers for the interface ---------- */
  const inRect = (p, r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  function rangeQuads(run, ranges) {
    const out = [];
    for (const [x, y] of ranges) {
      if (!run.glyphs[x] || !run.glyphs[y - 1]) continue;
      out.push([ap(run.F, run.glyphs[x].x0, run.ys), ap(run.F, run.glyphs[y - 1].x1, run.ys), ap(run.F, run.glyphs[y - 1].x1, run.yh), ap(run.F, run.glyphs[x].x0, run.yh)]);
    }
    return out;
  }
  // glyphs whose centre lies inside the page-space rectangle r=[x0,y0,x1,y1]; returns { cut: {runUid: [[a,b),...]}, count, boxes }
  function glyphsInRect(A, r) {
    const cut = {}, boxes = []; let count = 0;
    for (const o of A.objs) {
      if (o.kind !== 'text' || o.hidden) continue;
      if (o.bbox[2] < r[0] || o.bbox[0] > r[2] || o.bbox[3] < r[1] || o.bbox[1] > r[3]) continue;
      for (const run of o.runs) {
        if (run.exotic || run.vert) continue;                 // glyph positions of these fonts are not reliable, so they can only be deleted as a whole line
        const hit = [];
        run.glyphs.forEach((g, i) => { const c = ap(run.F, (g.x0 + g.x1) / 2, (run.ys + run.yh) / 2); if (inRect(c, r)) hit.push(i); });
        if (!hit.length) continue;
        const ranges = []; let a = hit[0], b = a + 1;
        for (let k = 1; k < hit.length; k++) { if (hit[k] === b) b++; else { ranges.push([a, b]); a = hit[k]; b = a + 1; } }
        ranges.push([a, b]);
        cut[A.prefix + run.id] = ranges; count += hit.length;
        for (const q of rangeQuads(run, ranges)) boxes.push(q);
      }
    }
    return { cut, count, boxes };
  }
  // does point (x,y) hit object o? (tolerance in page units)
  function hitTest(o, x, y, tol) {
    if (o.hidden && o.kind === 'form') return false;
    if (!o.bbox) return false;
    const b = o.bbox;
    if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return false;
    if (o.kind === 'path') {
      if (o.clip) return false;
      if (!o.poly) return true;
      const segDist = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy; let t = l2 ? ((x - p[0]) * dx + (y - p[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y); };
      const lw = Math.max(o.lwPage || 0, 0) / 2 + tol;
      for (const sp of o.poly) {
        const P = sp.pts; if (!P.length) continue;
        if (o.paint.fill) {                                   // even-odd crossing test
          let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside; }
          if (inside) return true;
        }
        const n = sp.closed ? P.length : P.length - 1;
        for (let i = 0; i < n; i++) if (segDist(P[i], P[(i + 1) % P.length]) <= (o.paint.stroke ? lw : tol)) return true;
        if (!o.paint.fill && !o.paint.stroke) continue;
      }
      return false;
    }
    if (o.quad) { const Q = o.quad; let inside = false; for (let i = 0, j = 3; i < 4; j = i++) { if ((Q[i][1] > y) !== (Q[j][1] > y) && x < ((Q[j][0] - Q[i][0]) * (y - Q[i][1])) / (Q[j][1] - Q[i][1]) + Q[i][0]) inside = !inside; } return inside || true; }
    return true;
  }

  return { rangeQuads, mergeCut, glyphsInRect, hitTest, analyzePage, applyEdits, emptyEd, isEmptyEd, mul, inv, ap, pageOfId, strBytes, toHex, fromHex, scaleOf };
})();
