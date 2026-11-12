// Master spectrum, drawn as the low-contrast background of the FX pad.

const DPR_CAP = 2;
const BARS = 40;
const F_LO = 35;
const F_HI = 16000;
const BASS_HZ = 120;
const ALPHA = 0.26;
const CAP_ALPHA = 0.42;

export class Spectrum {
  constructor(canvas, analyser) {
    this.canvas = canvas;
    this.analyser = analyser || null;
    this.ctx = canvas.getContext('2d');
    this.freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    this.time = analyser ? new Float32Array(analyser.fftSize) : null;
    this.lo = new Uint16Array(BARS);
    this.hi = new Uint16Array(BARS);
    this.val = new Float32Array(BARS);
    this.cap = new Float32Array(BARS);
    this.bassHi = 1;
    this.out = { bass: 0, level: 0 }; // reused every frame
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.grad = null;
    this.cleared = false;
    this.mapBins();
    this.resize();
  }

  mapBins() {
    const an = this.analyser;
    if (!an) return;
    const sr = (an.context && an.context.sampleRate) || 48000;
    const n = an.frequencyBinCount;
    const binHz = sr / an.fftSize;
    const ratio = F_HI / F_LO;
    for (let i = 0; i < BARS; i++) {
      const f0 = F_LO * Math.pow(ratio, i / BARS);
      const f1 = F_LO * Math.pow(ratio, (i + 1) / BARS);
      let a = Math.floor(f0 / binHz);
      let b = Math.floor(f1 / binHz);
      if (a < 1) a = 1; // skip DC
      if (a > n - 1) a = n - 1;
      if (b <= a) b = a + 1;
      if (b > n) b = n;
      this.lo[i] = a;
      this.hi[i] = b;
    }
    this.bassHi = Math.max(2, Math.min(n, Math.round(BASS_HZ / binHz) + 1));
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
    const g = this.ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#2ee6ff');
    g.addColorStop(1, '#ff4d9d');
    this.grad = g;
    this.cleared = false;
  }

  /** Draw one frame; returns { bass, level } (0..1, smoothed; the same object every call). */
  draw() {
    const out = this.out;
    const an = this.analyser;
    if (!an) return out;
    const fd = this.freq;
    an.getByteFrequencyData(fd);
    an.getFloatTimeDomainData(this.time);

    // level: RMS of the master
    const td = this.time;
    let sq = 0;
    for (let i = 0; i < td.length; i++) sq += td[i] * td[i];
    let lv = Math.sqrt(sq / td.length) * 3.2;
    lv = lv > 1 ? 1 : lv;
    out.level += (lv - out.level) * (lv > out.level ? 0.5 : 0.1);

    // bass: mean of the bins below ~120 Hz, expanded so the kick pulses
    let bsum = 0;
    for (let i = 1; i < this.bassHi; i++) bsum += fd[i];
    let bv = (bsum / (this.bassHi - 1) / 255 - 0.5) / 0.45;
    bv = bv < 0 ? 0 : bv > 1 ? 1 : bv;
    out.bass += (bv - out.bass) * (bv > out.bass ? 0.55 : 0.2);

    // bars
    const val = this.val;
    const cap = this.cap;
    let active = false;
    for (let i = 0; i < BARS; i++) {
      let m = 0;
      for (let k = this.lo[i], e = this.hi[i]; k < e; k++) if (fd[k] > m) m = fd[k];
      let v = (m / 255) * (0.88 + (0.3 * i) / (BARS - 1)); // lift the highs a little
      v = (v - 0.32) / 0.68;
      v = v < 0 ? 0 : v > 1 ? 1 : v * Math.sqrt(v); // more contrast between loud and quiet
      val[i] += (v - val[i]) * (v > val[i] ? 0.6 : 0.16);
      const c = cap[i] - 0.01;
      cap[i] = c > val[i] ? c : val[i];
      if (cap[i] > 0.003) active = true;
    }

    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    if (!active) {
      if (!this.cleared) {
        ctx.clearRect(0, 0, W, H);
        this.cleared = true;
      }
      return out;
    }
    this.cleared = false;
    ctx.clearRect(0, 0, W, H);
    const bw = W / BARS;
    const gap = Math.max(1, Math.round(bw * 0.28));
    const inner = Math.max(1, bw - gap);
    const top = H * 0.94;
    const capH = Math.max(1, Math.round(1.5 * this.dpr));
    ctx.fillStyle = this.grad;

    ctx.globalAlpha = ALPHA;
    ctx.beginPath();
    for (let i = 0; i < BARS; i++) {
      const h = val[i] * top;
      if (h < 0.5) continue;
      const x = Math.round(i * bw + gap / 2);
      ctx.rect(x, H - h, inner, h);
    }
    ctx.fill();

    ctx.globalAlpha = CAP_ALPHA;
    ctx.beginPath();
    for (let i = 0; i < BARS; i++) {
      if (cap[i] < 0.01) continue;
      const x = Math.round(i * bw + gap / 2);
      ctx.rect(x, Math.round(H - cap[i] * top - capH), inner, capH);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    return out;
  }
}
