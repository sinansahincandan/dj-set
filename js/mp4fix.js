// OZGE DJ SET: turn Chrome's fragmented MP4 recordings into ordinary MP4 files (owner: SHELL).
// Chrome's MediaRecorder writes a fragmented MP4 (empty `moov` + `mvex`, then `moof`+`mdat`
// pairs, every duration 0, no index), which messaging apps and many players refuse. This
// rewrites the container without touching the media data: a new `ftyp`, a complete `moov`
// with real sample tables placed first ("fast start"), then one `mdat` holding the original
// sample bytes in order. Anything unexpected means "leave the file as it is".
//
//   planFlatMp4(buffer)     → { header: Uint8Array, ranges: [[start, end], …] } | null   (pure)
//   flattenMp4Blob(blob)    → Promise<Blob>   (the original blob when nothing can be done)

/** Thrown inside the planner for any input it will not rewrite; turned into `null`. */
class Refuse extends Error {}
function refuse(why) {
  throw new Refuse(why);
}

const MAX_SAFE_HI = 0x200000; // 2^21: high word limit for a 64-bit value to stay a safe integer
const U32 = 0x100000000;
const TFHD_KNOWN = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x20000; // duration-is-empty (0x10000) refused
const TRUN_KNOWN = 0x1 | 0x4 | 0x100 | 0x200 | 0x400 | 0x800;
const NON_SYNC = 0x10000;
const KEEP_DATA = new Set(['ftyp', 'moov', 'moof']);
const BLOB_WINDOW = 16384;

// ───────────── byte helpers ─────────────

function fourcc(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

function u64(dv, p) {
  const hi = dv.getUint32(p);
  if (hi >= MAX_SAFE_HI) refuse('64-bit value too large');
  return hi * U32 + dv.getUint32(p + 4);
}

/**
 * Reads one box header at `p` of `u8` (whose first byte sits at absolute offset `abs`).
 * `limit` is the absolute end of the enclosing space (used for size 0 = "to the end").
 * Returns { type, start, hdr, end } in absolute offsets, or null when fewer than 8 bytes remain.
 */
function boxHeader(u8, dv, p, abs, limit) {
  if (p + 8 > u8.length) return null;
  let size = dv.getUint32(p);
  const type = fourcc(u8, p + 4);
  let hdr = 8;
  if (size === 1) {
    if (p + 16 > u8.length) return null;
    size = u64(dv, p + 8);
    hdr = 16;
  } else if (size === 0) {
    size = limit - (abs + p);
  }
  if (size < hdr) refuse(`bad size for box ${type}`);
  return { type, start: abs + p, hdr, end: abs + p + size };
}

/** Children of the box whose payload is u8[from, to) (relative offsets). Must tile exactly. */
function children(u8, dv, from, to) {
  const list = [];
  let p = from;
  while (p < to) {
    if (p + 8 > to) refuse('trailing bytes inside a box');
    const b = boxHeader(u8, dv, p, 0, to);
    if (!b || b.end > to) refuse(`child box ${b ? b.type : '?'} overruns its parent`);
    list.push({ type: b.type, s: p, hdr: b.hdr, e: b.end });
    p = b.end;
  }
  return list;
}

function only(list, type) {
  const found = list.filter((b) => b.type === type);
  if (found.length !== 1) refuse(`expected one ${type}, found ${found.length}`);
  return found[0];
}

/** Growable typed array; no per-sample objects. */
class Grow {
  constructor(T, n = 1024) {
    this.T = T;
    this.a = new T(n);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.T(this.n * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/** Byte writer with box helpers; grows as needed. */
class Writer {
  constructor(n = 65536) {
    this.b = new Uint8Array(n);
    this.dv = new DataView(this.b.buffer);
    this.n = 0;
  }
  need(k) {
    if (this.n + k <= this.b.length) return;
    let cap = this.b.length * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.need(1); this.b[this.n++] = v; }
  u16(v) { this.need(2); this.dv.setUint16(this.n, v); this.n += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v >>> 0); this.n += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.n, v); this.n += 4; }
  u64(v) {
    this.need(8);
    this.dv.setUint32(this.n, Math.floor(v / U32));
    this.dv.setUint32(this.n + 4, v % U32);
    this.n += 8;
  }
  str(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  bytes(u8) { this.need(u8.length); this.b.set(u8, this.n); this.n += u8.length; }
  open(type) { const at = this.n; this.u32(0); this.str(type); return at; }
  full(type, version, flags) { const at = this.open(type); this.u32(((version << 24) | flags) >>> 0); return at; }
  close(at) { this.dv.setUint32(at, this.n - at); }
  out() { return this.b.slice(0, this.n); }
}

// ───────────── top-level scans ─────────────

/** Top-level boxes of an in-memory file. `data` is kept for ftyp/moov/moof (a view, no copy). */
function scanBuffer(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = u8.length;
  const boxes = [];
  let p = 0;
  while (p + 8 <= n) {
    const b = boxHeader(u8, dv, p, 0, n);
    if (!b) break;
    b.data = KEEP_DATA.has(b.type) && b.end <= n ? u8.subarray(b.start, b.end) : null;
    boxes.push(b);
    if (b.end >= n) break; // last box (possibly cut short)
    p = b.end;
  }
  return boxes;
}

/** The same scan over a Blob, reading only box headers and the small boxes it needs. */
async function scanBlob(blob) {
  const n = blob.size;
  let win = new Uint8Array(0);
  let winAt = 0;
  async function bytes(start, end) {
    if (start < winAt || end > winAt + win.length) {
      const to = Math.min(n, Math.max(end, start + BLOB_WINDOW));
      win = new Uint8Array(await blob.slice(start, to).arrayBuffer());
      winAt = start;
    }
    return win.subarray(start - winAt, end - winAt);
  }
  const boxes = [];
  let p = 0;
  while (p + 8 <= n) {
    const head = await bytes(p, Math.min(n, p + 16));
    const b = boxHeader(head, new DataView(head.buffer, head.byteOffset, head.byteLength), 0, p, n);
    if (!b) break;
    b.data = null;
    if (KEEP_DATA.has(b.type) && b.end <= n) {
      if (b.end - b.start > 256 * 1048576) refuse(`${b.type} box too large`);
      b.data = (await bytes(b.start, b.end)).slice();
    }
    boxes.push(b);
    if (b.end >= n) break;
    p = b.end;
  }
  return boxes;
}

// ───────────── moov parsing ─────────────

function fullHeader(dv, s, hdr) {
  const vf = dv.getUint32(s + hdr);
  return { version: vf >>> 24, flags: vf & 0xffffff, p: s + hdr + 4 };
}

function parseTrak(u8, dv, t) {
  const kids = children(u8, dv, t.s + t.hdr, t.e);
  const tkhd = only(kids, 'tkhd');
  const th = fullHeader(dv, tkhd.s, tkhd.hdr);
  if (th.version > 1) refuse('tkhd version');
  const id = dv.getUint32(th.p + (th.version === 1 ? 16 : 8));
  const mdia = only(kids, 'mdia');
  const mdiaKids = children(u8, dv, mdia.s + mdia.hdr, mdia.e);
  const mdhd = only(mdiaKids, 'mdhd');
  const mh = fullHeader(dv, mdhd.s, mdhd.hdr);
  if (mh.version > 1) refuse('mdhd version');
  const timescale = dv.getUint32(mh.p + (mh.version === 1 ? 16 : 8));
  if (!timescale) refuse('track timescale 0');
  const hdlr = only(mdiaKids, 'hdlr');
  const handler = fourcc(u8, hdlr.s + hdlr.hdr + 8);
  const minf = only(mdiaKids, 'minf');
  const minfKids = children(u8, dv, minf.s + minf.hdr, minf.e);
  const stbl = only(minfKids, 'stbl');
  const stblKids = children(u8, dv, stbl.s + stbl.hdr, stbl.e);
  const stsd = only(stblKids, 'stsd');
  if (dv.getUint32(stsd.s + stsd.hdr + 4) !== 1) refuse('not exactly one sample description');
  // the moov of a fragmented file must not carry samples of its own
  for (const b of stblKids) {
    if (b.type === 'stsz' || b.type === 'stz2') {
      if (dv.getUint32(b.s + b.hdr + 8) !== 0) refuse('moov already has samples');
    } else if (b.type === 'stts' || b.type === 'stco' || b.type === 'co64') {
      if (dv.getUint32(b.s + b.hdr + 4) !== 0) refuse('moov already has samples');
    }
  }
  return {
    id, handler, timescale, box: t, kids, tkhd, th, mdia, mdiaKids, mdhd, mh, minf, minfKids, stbl, stsd,
    // fragment defaults (trex)
    dIdx: 0, dDur: 0, dSize: 0, dFlags: 0,
    // samples
    sizes: new Grow(Uint32Array), dursG: new Grow(Uint32Array),
    sync: new Grow(Uint8Array), cto: new Grow(Int32Array), anyCto: false, negCto: false, nonSync: 0,
    started: false, startDts: 0, dts: 0, cut: false, totalDur: 0, bytes: 0,
    chunkFirst: [], chunkCount: [], chunkPos: [],
  };
}

// ───────────── the planner ─────────────

function planFromBoxes(boxes, fileLength) {
  const moovs = boxes.filter((b) => b.type === 'moov');
  if (moovs.length !== 1 || !moovs[0].data) refuse('need exactly one complete moov');
  const moofs = boxes.filter((b) => b.type === 'moof' && b.data); // a cut-short last moof is dropped
  if (!moofs.length) refuse('not fragmented');
  const mdats = boxes.filter((b) => b.type === 'mdat')
    .map((b) => ({ s: b.start + b.hdr, e: Math.min(b.end, fileLength), cut: b.end > fileLength, declEnd: b.end }));
  if (!mdats.length) refuse('no mdat');

  // moov
  const moov = moovs[0];
  const mu8 = moov.data;
  const mdv = new DataView(mu8.buffer, mu8.byteOffset, mu8.byteLength);
  const moovKids = children(mu8, mdv, moov.hdr, mu8.length);
  const mvhd = only(moovKids, 'mvhd');
  const mvh = fullHeader(mdv, mvhd.s, mvhd.hdr);
  if (mvh.version > 1) refuse('mvhd version');
  const movieTs = mdv.getUint32(mvh.p + (mvh.version === 1 ? 16 : 8)) || 1000;
  const tracks = new Map();
  const order = [];
  for (const k of moovKids) {
    if (k.type !== 'trak') continue;
    const t = parseTrak(mu8, mdv, k);
    if (tracks.has(t.id)) refuse('duplicate track id');
    tracks.set(t.id, t);
    order.push(t);
  }
  if (order.length < 1 || order.length > 2) refuse('expected one or two tracks');
  const mvex = moovKids.find((k) => k.type === 'mvex');
  if (mvex) {
    for (const k of children(mu8, mdv, mvex.s + mvex.hdr, mvex.e)) {
      if (k.type !== 'trex') continue;
      const p = k.s + k.hdr + 4;
      const t = tracks.get(mdv.getUint32(p));
      if (!t) continue;
      t.dIdx = mdv.getUint32(p + 4);
      t.dDur = mdv.getUint32(p + 8);
      t.dSize = mdv.getUint32(p + 12);
      t.dFlags = mdv.getUint32(p + 16);
    }
  }

  // output layout, built while walking
  const ranges = [];
  let outPos = 0;
  let lastTrack = null;

  function findMdat(pos) {
    let lo = 0;
    let hi = mdats.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < mdats[mid].s) hi = mid - 1;
      else if (pos > mdats[mid].declEnd) lo = mid + 1;
      else return mdats[mid];
    }
    return null;
  }

  for (const moof of moofs) {
    const u8 = moof.data;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const A = moof.start; // absolute offset of u8[0]
    let prevTrafEnd = A; // implicit base for a traf without base offset / default-base-is-moof
    for (const traf of children(u8, dv, moof.hdr, u8.length)) {
      if (traf.type !== 'traf') continue;
      let t = null;
      let base = 0;
      let next = 0; // where a trun without data offset starts
      let dur = 0;
      let size = 0;
      let flags = 0;
      let sawTrun = false;
      let trafEnd = -1;
      for (const b of children(u8, dv, traf.s + traf.hdr, traf.e)) {
        if (b.type === 'tfhd') {
          if (t) refuse('two tfhd');
          const h = fullHeader(dv, b.s, b.hdr);
          if (h.flags & ~TFHD_KNOWN) refuse(`tfhd flags 0x${h.flags.toString(16)}`);
          t = tracks.get(dv.getUint32(h.p));
          if (!t) refuse('fragment for an unknown track');
          let p = h.p + 4;
          if (h.flags & 0x1) { base = u64(dv, p); p += 8; } else base = h.flags & 0x20000 ? A : prevTrafEnd;
          let idx = t.dIdx;
          if (h.flags & 0x2) { idx = dv.getUint32(p); p += 4; }
          if (idx > 1) refuse('more than one sample description');
          dur = t.dDur;
          size = t.dSize;
          flags = t.dFlags;
          if (h.flags & 0x8) { dur = dv.getUint32(p); p += 4; }
          if (h.flags & 0x10) { size = dv.getUint32(p); p += 4; }
          if (h.flags & 0x20) { flags = dv.getUint32(p); p += 4; }
          if (p > b.e) refuse('tfhd too short');
          next = base;
        } else if (b.type === 'tfdt') {
          if (!t || sawTrun) refuse('tfdt out of order');
          const h = fullHeader(dv, b.s, b.hdr);
          if (h.version > 1) refuse('tfdt version');
          const when = h.version === 1 ? u64(dv, h.p) : dv.getUint32(h.p);
          if (t.cut) continue;
          if (!t.started) {
            t.started = true;
            t.startDts = when;
            t.dts = when;
          } else if (when !== t.dts) {
            // a gap or overlap between fragments: absorb it in the previous sample's duration
            const last = t.dursG.n - 1;
            const fixed = last >= 0 ? t.dursG.a[last] + (when - t.dts) : -1;
            if (fixed > 0 && fixed < U32) {
              t.dursG.a[last] = fixed;
              t.totalDur += when - t.dts;
              t.dts = when;
            }
          }
        } else if (b.type === 'trun') {
          if (!t) refuse('trun before tfhd');
          sawTrun = true;
          const h = fullHeader(dv, b.s, b.hdr);
          if (h.version > 1) refuse('trun version');
          if (h.flags & ~TRUN_KNOWN) refuse(`trun flags 0x${h.flags.toString(16)}`);
          const count = dv.getUint32(h.p);
          let p = h.p + 4;
          let start = next;
          if (h.flags & 0x1) { start = base + dv.getInt32(p); p += 4; }
          let first = flags;
          const hasFirst = (h.flags & 0x4) !== 0;
          if (hasFirst) { first = dv.getUint32(p); p += 4; }
          const fDur = h.flags & 0x100;
          const fSize = h.flags & 0x200;
          const fFlags = h.flags & 0x400;
          const fCto = h.flags & 0x800;
          const per = (fDur ? 4 : 0) + (fSize ? 4 : 0) + (fFlags ? 4 : 0) + (fCto ? 4 : 0);
          if (p + per * count > b.e) refuse('trun too short');
          if (!Number.isSafeInteger(start) || start < 0) refuse('sample data before the file start');
          if (!t.started) { t.started = true; t.startDts = 0; t.dts = 0; }
          if (!count) continue;

          // where do this run's bytes live?
          const md = findMdat(start);
          if (!md) refuse('sample data outside every mdat');
          if (count > 10_000_000) refuse('implausible sample count');
          let pos = start; // end of the kept samples
          let end = start; // end of all samples of this run
          let kept = 0;
          const k0 = t.sizes.n;
          for (let i = 0; i < count; i++) {
            const d = fDur ? dv.getUint32(p) : dur;
            if (fDur) p += 4;
            const sz = fSize ? dv.getUint32(p) : size;
            if (fSize) p += 4;
            let f = i === 0 && hasFirst ? first : flags;
            if (fFlags) { f = dv.getUint32(p); p += 4; }
            let c = 0;
            if (fCto) {
              c = h.version === 1 ? dv.getInt32(p) : dv.getUint32(p);
              p += 4;
              if (c > 0x7fffffff) refuse('composition offset too large');
            }
            end += sz;
            if (t.cut) continue;
            if (pos + sz > md.e) {
              // past the end of this mdat: only acceptable when the file itself was cut short
              if (md.cut && pos + sz <= md.declEnd) { t.cut = true; continue; }
              refuse('sample data outside its mdat');
            }
            t.sizes.push(sz);
            t.dursG.push(d);
            const sync = (f & NON_SYNC) === 0 ? 1 : 0;
            t.sync.push(sync);
            if (!sync) t.nonSync++;
            t.cto.push(c);
            if (c !== 0) { t.anyCto = true; if (c < 0) t.negCto = true; }
            t.dts += d;
            t.totalDur += d;
            pos += sz;
            kept++;
          }
          next = end;
          trafEnd = Math.max(trafEnd, end);
          if (!kept) continue;

          // output: one chunk per contiguous run of this track's samples
          if (lastTrack === t) {
            t.chunkCount[t.chunkCount.length - 1] += kept;
          } else {
            t.chunkFirst.push(k0);
            t.chunkCount.push(kept);
            t.chunkPos.push(outPos);
            lastTrack = t;
          }
          const bytes = pos - start;
          t.bytes += bytes;
          const r = ranges[ranges.length - 1];
          if (r && r[1] === start) r[1] = pos;
          else ranges.push([start, pos]);
          outPos += bytes;
        }
      }
      if (trafEnd >= 0) prevTrafEnd = trafEnd;
    }
  }

  for (const t of order) {
    if (!t.sizes.n) refuse(`track ${t.id} has no samples`);
    if (!t.totalDur) refuse(`track ${t.id} has no duration`);
    if (!t.bytes) refuse(`track ${t.id} has no data`);
  }

  // timing in the movie timescale; the earliest track starts at 0
  for (const t of order) t.startMovie = Math.round((t.startDts * movieTs) / t.timescale);
  const minStart = Math.min(...order.map((t) => t.startMovie));
  let movieDur = 0;
  for (const t of order) {
    t.startMovie -= minStart;
    t.durMovie = Math.round((t.totalDur * movieTs) / t.timescale);
    t.tkhdDur = t.startMovie + t.durMovie;
    movieDur = Math.max(movieDur, t.tkhdDur);
  }

  const hasVideo = order.some((t) => t.handler === 'vide');
  const payload = outPos;
  const mdatHdr = payload + 8 <= 0xffffffff ? 8 : 16;
  const ftyp = buildFtyp(hasVideo);
  const ctx = { mu8, moovKids, mvhd, mvh, movieTs, movieDur, byStart: new Map(order.map((t) => [t.box.s, t])) };

  let co64 = false;
  let moovLen = buildMoov(ctx, 0, co64).length;
  const lastChunk = Math.max(...order.map((t) => t.chunkPos[t.chunkPos.length - 1]));
  if (ftyp.length + moovLen + mdatHdr + lastChunk > 0xffffffff) {
    co64 = true;
    moovLen = buildMoov(ctx, 0, co64).length;
  }
  const base = ftyp.length + moovLen + mdatHdr;
  const moovBytes = buildMoov(ctx, base, co64);
  if (moovBytes.length !== moovLen) refuse('internal: moov size changed');

  const header = new Uint8Array(base);
  header.set(ftyp, 0);
  header.set(moovBytes, ftyp.length);
  const hv = new DataView(header.buffer);
  const m = ftyp.length + moovLen;
  if (mdatHdr === 8) {
    hv.setUint32(m, payload + 8);
    header.set([0x6d, 0x64, 0x61, 0x74], m + 4);
  } else {
    hv.setUint32(m, 1);
    header.set([0x6d, 0x64, 0x61, 0x74], m + 4);
    hv.setUint32(m + 8, Math.floor((payload + 16) / U32));
    hv.setUint32(m + 12, (payload + 16) % U32);
  }
  return { header, ranges };
}

// ───────────── writing ─────────────

function buildFtyp(hasVideo) {
  const w = new Writer(64);
  const at = w.open('ftyp');
  if (hasVideo) {
    w.str('isom');
    w.u32(0x200);
    for (const b of ['isom', 'iso2', 'avc1', 'mp41']) w.str(b);
  } else {
    w.str('M4A ');
    w.u32(0x200);
    for (const b of ['M4A ', 'mp42', 'isom']) w.str(b);
  }
  w.close(at);
  return w.out();
}

const fits32 = (...v) => v.every((x) => x <= 0xffffffff);

/** mvhd / mdhd: times, timescale and duration rewritten, the rest copied. */
function writeTimed(w, u8, box, h, type, timescale, duration) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const v1 = h.version === 1;
  const created = v1 ? u64(dv, h.p) : dv.getUint32(h.p);
  const modified = v1 ? u64(dv, h.p + 8) : dv.getUint32(h.p + 4);
  const rest = u8.subarray(h.p + (v1 ? 28 : 16), box.e);
  const ver = fits32(created, modified, duration) ? 0 : 1;
  const at = w.full(type, ver, h.flags);
  if (ver) { w.u64(created); w.u64(modified); w.u32(timescale); w.u64(duration); } else {
    w.u32(created); w.u32(modified); w.u32(timescale); w.u32(duration);
  }
  w.bytes(rest);
  w.close(at);
}

function writeTkhd(w, u8, t, duration) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const h = t.th;
  const v1 = h.version === 1;
  const created = v1 ? u64(dv, h.p) : dv.getUint32(h.p);
  const modified = v1 ? u64(dv, h.p + 8) : dv.getUint32(h.p + 4);
  const rest = u8.subarray(h.p + (v1 ? 32 : 20), t.tkhd.e);
  const ver = fits32(created, modified, duration) ? 0 : 1;
  const at = w.full('tkhd', ver, h.flags);
  if (ver) { w.u64(created); w.u64(modified); w.u32(t.id); w.u32(0); w.u64(duration); } else {
    w.u32(created); w.u32(modified); w.u32(t.id); w.u32(0); w.u32(duration);
  }
  w.bytes(rest);
  w.close(at);
}

function writeEdts(w, t) {
  const v1 = !fits32(t.startMovie, t.durMovie);
  const edts = w.open('edts');
  const elst = w.full('elst', v1 ? 1 : 0, 0);
  w.u32(2);
  const entry = (segment, media) => {
    if (v1) { w.u64(segment); w.u32(Math.floor(media / U32) >>> 0); w.u32(media >>> 0); } else {
      w.u32(segment); w.i32(media);
    }
    w.u16(1); w.u16(0); // rate 1.0
  };
  entry(t.startMovie, -1); // empty edit: nothing of this track before it starts
  entry(t.durMovie, 0);
  w.close(elst);
  w.close(edts);
}

function writeStbl(w, u8, t, base, co64) {
  const n = t.sizes.n;
  const at = w.open('stbl');
  w.bytes(u8.subarray(t.stsd.s, t.stsd.e));

  // stts
  const durs = t.dursG.a;
  let box = w.full('stts', 0, 0);
  let countAt = w.n;
  w.u32(0);
  let entries = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && durs[j] === durs[i]) j++;
    w.u32(j - i); w.u32(durs[i]); entries++;
    i = j;
  }
  w.dv.setUint32(countAt, entries);
  w.close(box);

  // stss, only when some samples are not sync samples
  if (t.nonSync) {
    box = w.full('stss', 0, 0);
    w.u32(n - t.nonSync);
    const sync = t.sync.a;
    for (let i = 0; i < n; i++) if (sync[i]) w.u32(i + 1);
    w.close(box);
  }

  // ctts, only when some composition offset is non-zero
  if (t.anyCto) {
    const cto = t.cto.a;
    box = w.full('ctts', t.negCto ? 1 : 0, 0);
    countAt = w.n;
    w.u32(0);
    entries = 0;
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && cto[j] === cto[i]) j++;
      w.u32(j - i); w.i32(cto[i]); entries++;
      i = j;
    }
    w.dv.setUint32(countAt, entries);
    w.close(box);
  }

  // stsc
  const chunks = t.chunkCount.length;
  box = w.full('stsc', 0, 0);
  countAt = w.n;
  w.u32(0);
  entries = 0;
  for (let c = 0; c < chunks; c++) {
    if (c && t.chunkCount[c] === t.chunkCount[c - 1]) continue;
    w.u32(c + 1); w.u32(t.chunkCount[c]); w.u32(1); entries++;
  }
  w.dv.setUint32(countAt, entries);
  w.close(box);

  // stsz
  const sizes = t.sizes.a;
  let same = true;
  for (let i = 1; i < n && same; i++) same = sizes[i] === sizes[0];
  box = w.full('stsz', 0, 0);
  if (same) { w.u32(sizes[0]); w.u32(n); } else {
    w.u32(0); w.u32(n);
    w.need(4 * n);
    for (let i = 0; i < n; i++) { w.dv.setUint32(w.n, sizes[i]); w.n += 4; }
  }
  w.close(box);

  // stco / co64
  box = w.full(co64 ? 'co64' : 'stco', 0, 0);
  w.u32(chunks);
  for (let c = 0; c < chunks; c++) {
    if (co64) w.u64(base + t.chunkPos[c]); else w.u32(base + t.chunkPos[c]);
  }
  w.close(box);

  w.close(at);
}

function buildMoov(ctx, base, co64) {
  const { mu8, moovKids, mvhd, mvh, movieTs, movieDur, byStart } = ctx;
  const w = new Writer(mu8.length * 2 + 65536);
  const copy = (b) => w.bytes(mu8.subarray(b.s, b.e));
  const moov = w.open('moov');
  for (const k of moovKids) {
    if (k.type === 'mvhd') {
      writeTimed(w, mu8, mvhd, mvh, 'mvhd', movieTs, movieDur);
    } else if (k.type === 'mvex') {
      // dropped: the file is no longer fragmented
    } else if (k.type === 'trak') {
      const t = byStart.get(k.s);
      const trak = w.open('trak');
      for (const c of t.kids) {
        if (c.type === 'tkhd') {
          writeTkhd(w, mu8, t, t.tkhdDur);
          if (t.startMovie > 0) writeEdts(w, t);
        } else if (c.type === 'edts') {
          // replaced (written after tkhd when needed)
        } else if (c.type === 'mdia') {
          const mdia = w.open('mdia');
          for (const d of t.mdiaKids) {
            if (d.type === 'mdhd') {
              writeTimed(w, mu8, t.mdhd, t.mh, 'mdhd', t.timescale, t.totalDur);
            } else if (d.type === 'minf') {
              const minf = w.open('minf');
              for (const e of t.minfKids) {
                if (e.type === 'stbl') writeStbl(w, mu8, t, base, co64);
                else copy(e);
              }
              w.close(minf);
            } else copy(d);
          }
          w.close(mdia);
        } else copy(c);
      }
      w.close(trak);
    } else copy(k);
  }
  w.close(moov);
  return w.out();
}

// ───────────── public API ─────────────

/**
 * Plans the rewrite of a fragmented MP4 held in memory. `buffer` is an ArrayBuffer or a typed
 * array view. Returns { header, ranges }: write `header`, then the bytes of each [start, end)
 * range of the input in order, and the result is an ordinary MP4. Returns null for anything that
 * is not a fragmented MP4 this understands (already flat, WebM, damaged, unusual layout).
 */
export function planFlatMp4(buffer) {
  try {
    let u8;
    if (buffer instanceof ArrayBuffer) u8 = new Uint8Array(buffer);
    else if (ArrayBuffer.isView(buffer)) u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else return null;
    if (u8.length < 16) return null;
    return planFromBoxes(scanBuffer(u8), u8.length);
  } catch (err) {
    if (!(err instanceof Refuse) && !(err instanceof RangeError)) {
      console.warn('[dj] mp4fix: unexpected error, keeping the file as recorded', err);
    }
    return null;
  }
}

/**
 * Returns an ordinary-MP4 version of a fragmented MP4 recording, built from a new header plus
 * slices of the original blob (the media data is not copied). Returns the original blob for
 * anything else, and never throws.
 */
export async function flattenMp4Blob(blob) {
  try {
    if (!blob || typeof blob.slice !== 'function' || !(blob.size >= 16)) return blob;
    const plan = planFromBoxes(await scanBlob(blob), blob.size);
    if (!plan) return blob;
    const parts = [plan.header];
    for (const [s, e] of plan.ranges) parts.push(blob.slice(s, e));
    return new Blob(parts, { type: blob.type || 'video/mp4' });
  } catch (err) {
    if (!(err instanceof Refuse) && !(err instanceof RangeError)) {
      console.warn('[dj] mp4fix: unexpected error, keeping the file as recorded', err);
    }
    return blob;
  }
}
