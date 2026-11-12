// AudioWorklet deck player: plays a buffer at any rate (including negative),
// which gives us tempo control, scratching, instant cue jumps and loops.

const SCRATCH_LAG = 0.035; // seconds the playhead takes to catch up with the hand
const MAX_VEL = 10;

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.srcRate = sampleRate;
    this.pos = 0; // position in source samples
    this.vel = 0; // source samples per output sample
    this.playing = false;
    this.rate = 1;
    this.scratch = false;
    this.target = 0;
    this.loop = null; // {start, end} in source samples
    this.blocks = 0;
    this.ended = false;
    // DC blocker state (a held record should be silent, not a DC offset)
    this.xl = 0; this.yl = 0; this.xr = 0; this.yr = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L;
        this.R = m.R || m.L;
        this.len = this.L.length;
        this.srcRate = m.srcRate || sampleRate;
        this.pos = 0;
        this.vel = 0;
        this.playing = false;
        this.scratch = false;
        this.loop = null;
        break;
      case 'play':
        this.playing = !!m.value;
        if (this.playing && this.pos >= this.len - 1) this.pos = 0;
        break;
      case 'rate':
        this.rate = m.value;
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.len - 1, m.value * this.srcRate));
        this.target = this.pos;
        break;
      case 'scratchStart':
        this.scratch = true;
        this.target = this.pos;
        break;
      case 'scratchMove':
        this.target = Math.max(0, Math.min(this.len - 1, this.target + m.delta * this.srcRate));
        break;
      case 'scratchEnd':
        this.scratch = false;
        break;
      case 'loop':
        this.loop = m.value ? { start: m.value.start * this.srcRate, end: m.value.end * this.srcRate } : null;
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const L = this.L;
    if (!L) {
      oL.fill(0); oR.fill(0);
      return true;
    }
    const R = this.R;
    const len = this.len;
    const ratio = this.srcRate / sampleRate;
    const lagSamples = SCRATCH_LAG * sampleRate;

    for (let i = 0; i < n; i++) {
      if (this.scratch) {
        let tv = (this.target - this.pos) / lagSamples;
        if (tv > MAX_VEL) tv = MAX_VEL; else if (tv < -MAX_VEL) tv = -MAX_VEL;
        this.vel += (tv - this.vel) * 0.02;
      } else {
        const tv = this.playing ? this.rate * ratio : 0;
        this.vel += (tv - this.vel) * 0.004;
      }

      const p = this.pos;
      let sl = 0, sr = 0;
      if (p >= 0 && p < len - 1) {
        const i0 = p | 0;
        const f = p - i0;
        const a = L[i0], b = R[i0];
        sl = a + (L[i0 + 1] - a) * f;
        sr = b + (R[i0 + 1] - b) * f;
      }
      // DC blocker
      const yl = sl - this.xl + 0.9995 * this.yl; this.xl = sl; this.yl = yl;
      const yr = sr - this.xr + 0.9995 * this.yr; this.xr = sr; this.yr = yr;
      oL[i] = yl;
      oR[i] = yr;

      this.pos += this.vel;
      const lp = this.loop;
      if (lp && this.vel > 0 && !this.scratch && this.pos >= lp.end) this.pos -= lp.end - lp.start;
      if (this.pos < 0) {
        this.pos = 0;
        if (!this.scratch) this.vel = 0;
      } else if (this.pos >= len - 1) {
        this.pos = len - 1;
        if (this.playing && !this.scratch) {
          this.playing = false;
          this.ended = true;
        }
      }
    }

    if (++this.blocks % 3 === 0 || this.ended) {
      this.port.postMessage({
        pos: this.pos / this.srcRate,
        vel: this.vel / ratio,
        playing: this.playing,
        ended: this.ended,
      });
      this.ended = false;
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
