// Waveform display: peak extraction, the scrolling deck waveform and the
// whole-track overview.

const DPR_CAP = 2;
const SPAN = 3.5; // seconds shown either side of the playhead
const LEVELS = 16; // colour steps from bright (highs) to bass-heavy
const CUE_COLOR = '#ffd23f';
const HOT_COLORS = ['#ff5a5a', '#5dffa0', '#9b7bff', '#ffa53f'];
const HOT_LABELS = ['1', '2', '3', '4'];
const FONT_FAMILY = "ui-rounded, 'SF Pro Rounded', 'Segoe UI', system-ui, sans-serif";

/**
 * Per-bucket peak amplitude (0..1) and bass share (energy below ~200 Hz over
 * total energy, 0..1) at `rate` buckets per second. One pass over the samples.
 */
export function computePeaks(buffer, rate = 150) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const spb = sr / rate;
  const len = Math.max(1, Math.ceil(n / spb));
  const max = new Float32Array(len);
  const bass = new Float32Array(len);
  const eb = new Float32Array(len);
  const et = new Float32Array(len);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  // two cascaded one-poles at 230 Hz ≈ "below ~200 Hz"
  const a = 1 - Math.exp((-2 * Math.PI * 230) / sr);
  let y1 = 0;
  let y2 = 0;
  let i = 0;
  for (let b = 0; b < len; b++) {
    const end = Math.min(n, Math.round((b + 1) * spb));
    let m = 0;
    let sb = 0;
    let st = 0;
    for (; i < end; i++) {
      const l = ch0[i];
      const r = ch1 ? ch1[i] : l;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > m) m = al;
      if (ar > m) m = ar;
      const x = (l + r) * 0.5;
      y1 += a * (x - y1);
      y2 += a * (y1 - y2);
      sb += y2 * y2;
      st += x * x;
    }
    max[b] = m > 1 ? 1 : m;
    eb[b] = sb;
    et[b] = st;
  }
  // a single bucket is shorter than one cycle of a bass note: smooth over 3
  for (let b = 0; b < len; b++) {
    const p = b > 0 ? b - 1 : b;
    const q = b < len - 1 ? b + 1 : b;
    const num = eb[p] + 2 * eb[b] + eb[q];
    const den = et[p] + 2 * et[b] + et[q];
    const s = den > 1e-12 ? num / den : 0;
    bass[b] = s > 1 ? 1 : s;
  }
  return { rate, length: len, max, bass };
}

/** Scrolling waveform under a fixed centre playhead. */
export class WaveformView {
  constructor(canvas, deck, color) {
    this.canvas = canvas;
    this.deck = deck;
    this.color = color;
    this.ctx = canvas.getContext('2d');
    const pal = buildPalette(color);
    this.palette = pal.live.concat(pal.played); // index k: live 0..15, played 16..31
    this.coreLive = 'rgba(255,255,255,0.30)';
    this.corePlayed = 'rgba(255,255,255,0.10)';
    const [r, g, b] = hexRgb(color);
    this.loopFill = `rgba(${r},${g},${b},0.16)`;
    this.loopEdge = `rgba(${r},${g},${b},0.75)`;
    this.glow = `rgba(${r},${g},${b},0.22)`;
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.colPx = 1;
    this.capCols = 0;
    this.colX = new Float32Array(0);
    this.colH = new Float32Array(0);
    this.colK = new Uint8Array(0);
    this.kCount = new Uint16Array(LEVELS * 2);
    this.peaksRef = null;
    this.norm = 1;
    this.dirty = true;
    // last drawn state, for skipping identical frames
    this.lTrack = undefined;
    this.lPos = NaN;
    this.lCue = NaN;
    this.lH0 = NaN;
    this.lH1 = NaN;
    this.lH2 = NaN;
    this.lH3 = NaN;
    this.lLs = NaN;
    this.lLe = NaN;
    this.lBpm = NaN;
    this.lOff = NaN;
    this.resize();
  }

  resize() {
    const dpr = Math.min(DPR_CAP, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.colPx = Math.max(1, Math.round(dpr));
    const need = Math.ceil(w / this.colPx) + 4;
    if (need > this.capCols) {
      this.capCols = need;
      this.colX = new Float32Array(need);
      this.colH = new Float32Array(need);
      this.colK = new Uint8Array(need);
    }
    this.flagFont = `700 ${Math.round(9.5 * dpr)}px ${FONT_FAMILY}`;
    this.emptyFont = `600 ${Math.round(11 * dpr)}px ${FONT_FAMILY}`;
    this.dirty = true;
  }

  draw() {
    const d = this.deck;
    const tr = d.track;
    const hc = d.hotCues;
    const lp = d.loop;
    const pos = d.pos;
    const cue = d.cuePoint;
    const h0 = hc ? hc[0] : null;
    const h1 = hc ? hc[1] : null;
    const h2 = hc ? hc[2] : null;
    const h3 = hc ? hc[3] : null;
    const ls = lp ? lp.start : -1;
    const le = lp ? lp.end : -1;
    const bpm = tr ? tr.bpm || 0 : 0;
    const off = tr ? tr.beatOffset || 0 : 0;
    if (
      !this.dirty &&
      tr === this.lTrack &&
      pos === this.lPos &&
      cue === this.lCue &&
      h0 === this.lH0 &&
      h1 === this.lH1 &&
      h2 === this.lH2 &&
      h3 === this.lH3 &&
      ls === this.lLs &&
      le === this.lLe &&
      bpm === this.lBpm &&
      off === this.lOff
    ) {
      return;
    }
    this.dirty = false;
    this.lTrack = tr;
    this.lPos = pos;
    this.lCue = cue;
    this.lH0 = h0;
    this.lH1 = h1;
    this.lH2 = h2;
    this.lH3 = h3;
    this.lLs = ls;
    this.lLe = le;
    this.lBpm = bpm;
    this.lOff = off;

    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, W, H);
    const cx = Math.round(W / 2);
    const mid = H / 2;

    if (!tr) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, Math.round(mid), W, Math.max(1, Math.round(dpr * 0.75)));
      ctx.font = this.emptyFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(238,241,248,0.45)';
      ctx.fillText('No track loaded', cx, mid - 9 * dpr);
      this.drawPlayhead(cx, 0.35);
      return;
    }

    const pps = W / (2 * SPAN); // device px per second
    const tL = pos - cx / pps;
    const tR = pos + (W - cx) / pps;
    const dur = tr.duration || 0;
    const ampH = mid * 0.84;
    const lw = Math.max(1, Math.round(dpr));

    // loop region (behind everything)
    if (lp) {
      const x0 = Math.round(cx + (lp.start - pos) * pps);
      const x1 = Math.round(cx + (lp.end - pos) * pps);
      if (x1 > 0 && x0 < W) {
        const a0 = x0 < 0 ? 0 : x0;
        const a1 = x1 > W ? W : x1;
        ctx.fillStyle = this.loopFill;
        ctx.fillRect(a0, 0, a1 - a0, H);
        ctx.fillStyle = this.loopEdge;
        if (x0 >= 0) ctx.fillRect(x0, 0, lw, H);
        if (x1 <= W) ctx.fillRect(x1 - lw, 0, lw, H);
      }
    }

    // bar lines behind the waveform
    const beat = bpm > 0 ? 60 / bpm : 0;
    if (beat) {
      const i0 = Math.ceil((Math.max(0, tL) - off) / beat);
      const i1 = Math.floor((Math.min(dur, tR) - off) / beat);
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        if ((i & 3) !== 0) continue;
        const x = Math.round(cx + (off + i * beat - pos) * pps);
        ctx.rect(x, 0, lw, H);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
    }

    // track extent baseline
    {
      const x0 = Math.max(0, Math.round(cx + (0 - pos) * pps));
      const x1 = Math.min(W, Math.round(cx + (dur - pos) * pps));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(x0, Math.round(mid - lw / 2), x1 - x0, lw);
      }
    }

    // waveform columns
    const peaks = tr.peaks;
    if (peaks && peaks.length > 0) {
      if (peaks !== this.peaksRef) {
        this.peaksRef = peaks;
        let m = 0;
        const mx = peaks.max;
        for (let i = 0; i < peaks.length; i++) if (mx[i] > m) m = mx[i];
        this.norm = 1 / Math.max(0.1, m); // quiet tracks fill the height, silence stays flat
      }
      const rate = peaks.rate;
      const plen = peaks.length;
      const mx = peaks.max;
      const bs = peaks.bass;
      const colPx = this.colPx;
      const colDur = colPx / pps;
      const g0 = Math.floor(tL / colDur);
      const g1 = Math.ceil(tR / colDur);
      // columns sit on a fixed grid in track time (no shimmer while scrolling);
      // colPx is an integer, so column g is at round(x of time 0) + g·colPx
      const xZero = Math.round(cx - pos * pps);
      const colX = this.colX;
      const colH = this.colH;
      const colK = this.colK;
      const kc = this.kCount;
      kc.fill(0);
      const norm = this.norm;
      let count = 0;
      for (let g = g0; g <= g1 && count < this.capCols; g++) {
        const t = g * colDur;
        if (t + colDur <= 0 || t >= dur) continue;
        let b0 = Math.floor(t * rate);
        let b1 = Math.floor((t + colDur) * rate);
        if (b0 < 0) b0 = 0;
        if (b1 <= b0) b1 = b0 + 1;
        if (b1 > plen) b1 = plen;
        if (b0 >= b1) continue;
        let m = 0;
        let s = 0;
        for (let b = b0; b < b1; b++) {
          if (mx[b] > m) m = mx[b];
          s += bs[b];
        }
        s /= b1 - b0;
        const x = xZero + g * colPx;
        if (x + colPx <= 0 || x >= W) continue;
        let a = m * norm;
        if (a > 1) a = 1;
        let lv = (s - 0.15) / 0.75; // music sits mostly in 0.15..0.9
        lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
        const k = Math.round(lv * (LEVELS - 1)) + (x + colPx <= cx ? LEVELS : 0);
        colX[count] = x;
        colH[count] = Math.max(0.5, a * ampH);
        colK[count] = k;
        kc[k]++;
        count++;
      }
      const pal = this.palette;
      for (let k = 0; k < LEVELS * 2; k++) {
        if (!kc[k]) continue;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          if (colK[i] !== k) continue;
          const hh = colH[i];
          ctx.rect(colX[i], mid - hh, colPx, hh * 2);
        }
        ctx.fillStyle = pal[k];
        ctx.fill();
      }
      // bright core for depth: played and live
      for (let side = 0; side < 2; side++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < count; i++) {
          if ((colK[i] >= LEVELS) !== (side === 1)) continue;
          const hh = colH[i] * 0.42;
          if (hh < 0.5) continue;
          ctx.rect(colX[i], mid - hh, colPx, hh * 2);
          any = true;
        }
        if (!any) continue;
        ctx.fillStyle = side ? this.corePlayed : this.coreLive;
        ctx.fill();
      }
    }

    // beat ticks along top and bottom edges
    if (beat) {
      const i0 = Math.ceil((Math.max(0, tL) - off) / beat);
      const i1 = Math.floor((Math.min(dur, tR) - off) / beat);
      const tb = Math.round(4 * dpr);
      const td = Math.round(8 * dpr);
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const down = (i & 3) === 0;
          if (down !== (pass === 1)) continue;
          const x = Math.round(cx + (off + i * beat - pos) * pps);
          const th = down ? td : tb;
          ctx.rect(x, 0, lw, th);
          ctx.rect(x, H - th, lw, th);
        }
        ctx.fillStyle = pass ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.38)';
        ctx.fill();
      }
    }

    // cue point: line + triangles
    if (cue != null && cue >= tL - 0.5 && cue <= tR + 0.5) {
      const x = Math.round(cx + (cue - pos) * pps);
      const s = 5 * dpr;
      ctx.fillStyle = CUE_COLOR;
      ctx.fillRect(x, 0, lw, H);
      ctx.beginPath();
      ctx.moveTo(x - s, 0);
      ctx.lineTo(x + s + lw, 0);
      ctx.lineTo(x + lw / 2, s * 1.2);
      ctx.closePath();
      ctx.moveTo(x - s, H);
      ctx.lineTo(x + s + lw, H);
      ctx.lineTo(x + lw / 2, H - s * 1.2);
      ctx.closePath();
      ctx.fill();
    }

    // hot cues: line + numbered flag
    if (hc) {
      const fw = Math.round(11 * dpr);
      const fh = Math.round(12 * dpr);
      let fontSet = false;
      for (let i = 0; i < 4; i++) {
        const v = hc[i];
        if (v == null) continue;
        const x = Math.round(cx + (v - pos) * pps);
        if (x + fw < 0 || x > W) continue;
        ctx.fillStyle = HOT_COLORS[i];
        ctx.fillRect(x, 0, lw, H);
        ctx.fillRect(x, H - fh, fw, fh);
        if (!fontSet) {
          ctx.font = this.flagFont;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          fontSet = true;
        }
        ctx.fillStyle = '#0b0d16';
        ctx.fillText(HOT_LABELS[i], x + fw / 2, H - fh / 2 + 0.5 * dpr);
      }
    }

    this.drawPlayhead(cx, 1);
  }

  drawPlayhead(cx, alpha) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const H = this.H;
    const w = Math.max(2, Math.round(2 * dpr));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.glow;
    ctx.fillRect(cx - 3 * w, 0, 6 * w + (w & 1), H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - (w >> 1), 0, w, H);
    const s = 4 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - s, 0);
    ctx.lineTo(cx + s, 0);
    ctx.lineTo(cx, s);
    ctx.closePath();
    ctx.moveTo(cx - s, H);
    ctx.lineTo(cx + s, H);
    ctx.lineTo(cx, H - s);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** One-off whole-track mini waveform, sized to the canvas's layout box. */
export function renderOverview(canvas, peaks, color) {
  const dpr = Math.min(DPR_CAP, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!peaks || !peaks.length) return;
  const pal = buildPalette(color).live;
  const colPx = Math.max(1, Math.round(dpr));
  const cols = Math.max(1, Math.floor(W / colPx));
  const len = peaks.length;
  let norm = 0;
  for (let i = 0; i < len; i++) if (peaks.max[i] > norm) norm = peaks.max[i];
  norm = 1 / Math.max(0.1, norm);
  const mid = H / 2;
  const amp = mid * 0.92;
  const hs = new Float32Array(cols);
  const ks = new Uint8Array(cols);
  for (let c = 0; c < cols; c++) {
    const b0 = Math.min(len - 1, Math.floor((c * len) / cols));
    const b1 = Math.min(len, Math.max(b0 + 1, Math.floor(((c + 1) * len) / cols)));
    let m = 0;
    let s = 0;
    for (let b = b0; b < b1; b++) {
      if (peaks.max[b] > m) m = peaks.max[b];
      s += peaks.bass[b];
    }
    s /= b1 - b0;
    let lv = (s - 0.15) / 0.75;
    lv = lv < 0 ? 0 : lv > 1 ? 1 : lv;
    hs[c] = Math.max(0.5, Math.min(1, m * norm) * amp);
    ks[c] = Math.round(lv * (LEVELS - 1));
  }
  for (let k = 0; k < LEVELS; k++) {
    ctx.beginPath();
    let any = false;
    for (let c = 0; c < cols; c++) {
      if (ks[c] !== k) continue;
      ctx.rect(c * colPx, mid - hs[c], colPx, hs[c] * 2);
      any = true;
    }
    if (!any) continue;
    ctx.fillStyle = pal[k];
    ctx.fill();
  }
}

// ---- colours

function hexRgb(hex) {
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s, 16);
  if (s.length !== 6 || Number.isNaN(v)) return [46, 230, 255];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * LEVELS colours from "bright" (highs: deck colour washed towards white) through the
 * deck colour to "bass" (deck colour pulled towards deep violet), live and played.
 */
function buildPalette(color) {
  const base = hexRgb(color);
  const hi = mix(base, [255, 255, 255], 0.6);
  const lo = mix(base, [74, 38, 255], 0.55).map((v) => v * 0.92);
  const live = [];
  const played = [];
  for (let k = 0; k < LEVELS; k++) {
    const s = k / (LEVELS - 1);
    const c = s < 0.5 ? mix(hi, base, s * 2) : mix(base, lo, (s - 0.5) * 2);
    const r = Math.round(c[0]);
    const g = Math.round(c[1]);
    const b = Math.round(c[2]);
    live.push(`rgba(${r},${g},${b},0.92)`);
    played.push(`rgba(${r},${g},${b},0.34)`);
  }
  return { live, played };
}
