import { applyDjFilter } from './fx.js';

const TEMPO_RANGE = 0.08;
export const SEC_PER_REV = 1.8; // 33 1/3 rpm

export class Deck extends EventTarget {
  constructor(engine, id) {
    super();
    this.engine = engine;
    this.id = id;
    const ctx = (this.ctx = engine.ctx);

    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this.onReport(e.data);

    this.eqLow = biquad(ctx, 'lowshelf', 250);
    this.eqMid = biquad(ctx, 'peaking', 1000, 0.8);
    this.eqHigh = biquad(ctx, 'highshelf', 4000);
    this.lp = biquad(ctx, 'lowpass', 22000, 0.7);
    this.hp = biquad(ctx, 'highpass', 10, 0.7);
    this.channel = ctx.createGain();
    this.xfade = ctx.createGain();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;
    this.meterData = new Float32Array(this.meter.fftSize);

    this.node.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.lp);
    this.lp.connect(this.hp);
    this.hp.connect(this.channel);
    this.channel.connect(this.meter);
    this.channel.connect(this.xfade);
    this.xfade.connect(engine.masterIn);

    this.track = null;
    this.pos = 0;
    this.vel = 0;
    this.playing = false;
    this.scratching = false;
    this.rate = 1;
    this.tempo = 0; // -1..1 fader value
    this.cuePoint = 0;
    this.hotCues = [null, null, null, null];
    this.loop = null;
    this.filter = 0;
    this.volume = 0.8;
    this.eq = { low: 0.5, mid: 0.5, high: 0.5 };
    this.setVolume(this.volume);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  onReport(m) {
    this.pos = m.pos;
    this.vel = m.vel;
    if (m.ended) {
      this.playing = false;
      this.emit('state');
    }
  }

  get duration() {
    return this.track ? this.track.duration : 0;
  }

  get effectiveBpm() {
    return this.track?.bpm ? this.track.bpm * this.rate : 0;
  }

  /** Rotation of the platter in turns, for the jog wheel visual. */
  get turns() {
    return this.pos / SEC_PER_REV;
  }

  load(track) {
    const buf = track.buffer;
    const L = buf.getChannelData(0).slice();
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : null;
    const transfer = [L.buffer];
    if (R) transfer.push(R.buffer);
    this.node.port.postMessage({ type: 'load', L, R, srcRate: buf.sampleRate }, transfer);
    this.track = track;
    this.pos = 0;
    this.vel = 0;
    this.playing = false;
    this.scratching = false;
    this.cuePoint = 0;
    this.hotCues = [null, null, null, null];
    this.loop = null;
    this.setTempo(0);
    this.emit('load');
    this.emit('cues');
    this.emit('state');
  }

  send(msg) {
    this.node.port.postMessage(msg);
  }

  play(on = !this.playing) {
    if (!this.track) return;
    this.playing = on;
    this.send({ type: 'play', value: on });
    if (on) this.engine.updateEchoTempo(this);
    this.emit('state');
  }

  seek(sec) {
    if (!this.track) return;
    sec = Math.max(0, Math.min(this.duration, sec));
    this.pos = sec;
    this.send({ type: 'seek', value: sec });
  }

  /** Playing: stop and jump back to the cue point. Stopped: set the cue point here. */
  cue() {
    if (!this.track) return;
    if (this.playing) {
      this.play(false);
      this.seek(this.cuePoint);
    } else {
      this.cuePoint = this.snapToBeat(this.pos);
      this.seek(this.cuePoint);
    }
    this.emit('cues');
  }

  /** Empty slot: store the current position. Set slot: jump there and play. */
  hotCue(i, clear = false) {
    if (!this.track) return;
    if (clear) {
      this.hotCues[i] = null;
    } else if (this.hotCues[i] == null) {
      this.hotCues[i] = this.snapToBeat(this.pos);
    } else {
      this.seek(this.hotCues[i]);
      if (!this.playing) this.play(true);
    }
    this.emit('cues');
  }

  snapToBeat(sec) {
    const bpm = this.track?.bpm;
    if (!bpm) return sec;
    const beat = 60 / bpm;
    const off = this.track.beatOffset || 0;
    const snapped = off + Math.round((sec - off) / beat) * beat;
    return Math.abs(snapped - sec) < 0.07 ? Math.max(0, snapped) : sec;
  }

  toggleLoop(beats = 4) {
    if (!this.track) return;
    if (this.loop) {
      this.loop = null;
    } else {
      const beat = 60 / (this.track.bpm || 120);
      const off = this.track.beatOffset || 0;
      const start = Math.max(0, off + Math.floor((this.pos - off) / beat + 0.05) * beat);
      this.loop = { start, end: start + beats * beat };
    }
    this.send({ type: 'loop', value: this.loop });
    this.emit('state');
  }

  /** v in -1..1 → rate 1 ± 8% */
  setTempo(v) {
    this.tempo = Math.max(-1, Math.min(1, v));
    this.setRate(1 + this.tempo * TEMPO_RANGE);
  }

  setRate(r) {
    this.rate = r;
    this.send({ type: 'rate', value: r });
    if (this.playing) this.engine.updateEchoTempo(this);
    this.emit('tempo');
  }

  /** Match the other deck's tempo (and beat phase when both are playing). */
  sync() {
    const o = this.other;
    if (!this.track?.bpm || !o?.track?.bpm) return false;
    const target = o.effectiveBpm;
    // match double/half time if that is closer
    const rate = [0.5, 1, 2]
      .map((m) => (target * m) / this.track.bpm)
      .reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
    this.tempo = Math.max(-1, Math.min(1, (rate - 1) / TEMPO_RANGE));
    this.setRate(rate);
    if (this.playing && o.playing) {
      const phase = (d) => {
        const x = (d.pos - (d.track.beatOffset || 0)) / (60 / d.track.bpm);
        return x - Math.floor(x);
      };
      let diff = phase(o) - phase(this);
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      this.seek(this.pos + diff * (60 / this.track.bpm));
    }
    return true;
  }

  scratchStart() {
    if (!this.track || this.scratching) return;
    this.scratching = true;
    this.send({ type: 'scratchStart' });
  }

  /** delta in turns of the platter (positive = clockwise = forward) */
  scratchMove(turns) {
    if (!this.scratching) return;
    this.send({ type: 'scratchMove', delta: turns * SEC_PER_REV });
  }

  scratchEnd() {
    if (!this.scratching) return;
    this.scratching = false;
    this.send({ type: 'scratchEnd' });
  }

  /** 0..1, 0.5 = flat. Below centre cuts down to a full kill, above boosts up to +6 dB. */
  setEq(band, v) {
    this.eq[band] = v;
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    const db = v < 0.5 ? -40 * Math.pow((0.5 - v) / 0.5, 1.5) : 12 * (v - 0.5);
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.015);
  }

  /** -1..1: negative = low-pass, positive = high-pass, centre = off */
  setFilter(v) {
    this.filter = Math.max(-1, Math.min(1, v));
    applyDjFilter(this.ctx, this.lp, this.hp, this.filter);
  }

  setVolume(v) {
    this.volume = v;
    this.channel.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01);
  }

  /** Post-fader peak level, 0..1+ */
  level() {
    this.meter.getFloatTimeDomainData(this.meterData);
    let peak = 0;
    for (let i = 0; i < this.meterData.length; i++) {
      const a = Math.abs(this.meterData[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }
}

function biquad(ctx, type, freq, Q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (Q != null) f.Q.value = Q;
  return f;
}
