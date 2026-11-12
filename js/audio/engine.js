import { applyDjFilter, createEcho, createReverb } from './fx.js';
import { Deck } from './deck.js';

// decks ─► masterIn ─► FX filter (LP+HP) ─┬─► limiter ─► master ─► analyser ─► out
//                                         ├─► echo ───► limiter
//                                         └─► reverb ─► limiter
export class Engine {
  constructor() {
    this.ctx = null;
    this.decks = {};
    this.crossfade = 0.5;
    this.fx = null; // {x, y} while the FX pad is held
  }

  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    await ctx.audioWorklet.addModule(new URL('./deck-processor.js', import.meta.url));

    this.masterIn = ctx.createGain();
    this.fxLp = ctx.createBiquadFilter();
    this.fxLp.type = 'lowpass';
    this.fxLp.frequency.value = 22000;
    this.fxHp = ctx.createBiquadFilter();
    this.fxHp.type = 'highpass';
    this.fxHp.frequency.value = 10;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;

    this.masterIn.connect(this.fxLp);
    this.fxLp.connect(this.fxHp);
    this.fxHp.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.echo = createEcho(ctx);
    this.reverb = createReverb(ctx);
    this.echoSend = ctx.createGain();
    this.reverbSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.reverbSend.gain.value = 0;
    this.fxHp.connect(this.echoSend);
    this.fxHp.connect(this.reverbSend);
    this.echoSend.connect(this.echo.input);
    this.reverbSend.connect(this.reverb.input);
    this.echo.output.connect(this.limiter);
    this.reverb.output.connect(this.limiter);

    this.decks.A = new Deck(this, 'A');
    this.decks.B = new Deck(this, 'B');
    this.decks.A.other = this.decks.B;
    this.decks.B.other = this.decks.A;
    this.setCrossfade(0.5);
    this.setMaster(0.8);
    if (ctx.state !== 'running') await ctx.resume();
  }

  /** 0 = deck A only, 1 = deck B only. Both decks are at full level in the centre. */
  setCrossfade(x) {
    this.crossfade = Math.max(0, Math.min(1, x));
    const a = Math.cos(this.crossfade * Math.PI * 0.5) * Math.SQRT2;
    const b = Math.sin(this.crossfade * Math.PI * 0.5) * Math.SQRT2;
    const t = this.ctx.currentTime;
    this.decks.A.xfade.gain.setTargetAtTime(Math.min(1, a), t, 0.008);
    this.decks.B.xfade.gain.setTargetAtTime(Math.min(1, b), t, 0.008);
  }

  setMaster(v) {
    this.masterLevel = v;
    this.master.gain.setTargetAtTime(v * v * 1.3, this.ctx.currentTime, 0.02);
  }

  /** A MediaStream carrying exactly what goes to the speakers, for recording a set. */
  getRecordStream() {
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.recordDest);
    }
    return this.recordDest.stream;
  }

  /**
   * Master FX pad. x in -1..1 sweeps the filter, y in 0..1 is the echo/reverb amount.
   * Pass null to release: the filter opens back up and the tails ring out.
   */
  setFx(fx) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.fx = fx;
    if (!fx) {
      applyDjFilter(ctx, this.fxLp, this.fxHp, 0, 0.09);
      this.echoSend.gain.setTargetAtTime(0, t, 0.03);
      this.reverbSend.gain.setTargetAtTime(0, t, 0.03);
      return;
    }
    applyDjFilter(ctx, this.fxLp, this.fxHp, fx.x, 0.02);
    this.echoSend.gain.setTargetAtTime(fx.y * 0.85, t, 0.03);
    this.reverbSend.gain.setTargetAtTime(fx.y * fx.y * 0.9, t, 0.03);
  }

  updateEchoTempo(deck) {
    const bpm = deck?.effectiveBpm;
    if (bpm) this.echo.setBpm(bpm);
  }
}
