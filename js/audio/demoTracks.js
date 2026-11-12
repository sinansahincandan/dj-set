// Built-in demo tracks, synthesized in an OfflineAudioContext.
// Every instrument is a monophonic voice driven by parameter automation,
// which keeps the node count tiny and rendering fast.

const BARS = 64;

export const DEMO_TRACKS = [
  {
    id: 'demo-neon',
    name: 'Neon Drive',
    bpm: 124,
    root: 45, // A2
    chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],
    bassRoots: [0, -4, 3, -2],
    bass: 'offbeat',
    keys: 'stab',
    lead: 'arp',
    seed: 11,
  },
  {
    id: 'demo-midnight',
    name: 'Midnight Pulse',
    bpm: 128,
    root: 41, // F2
    chords: [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]],
    bassRoots: [0, 0, -4, -2],
    bass: 'rolling',
    keys: 'pad',
    lead: 'acid',
    seed: 23,
  },
  {
    id: 'demo-sunset',
    name: 'Sunset Groove',
    bpm: 120,
    root: 38, // D2
    chords: [[0, 3, 7, 10], [5, 8, 12, 15], [-2, 2, 5, 9], [7, 10, 14, 17]],
    bassRoots: [0, 5, -2, 7],
    bass: 'deep',
    keys: 'stab',
    lead: 'pluck',
    seed: 37,
  },
  {
    id: 'demo-bloom',
    name: 'Hyper Bloom',
    bpm: 126,
    root: 40, // E2
    chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],
    bassRoots: [0, -4, 3, -2],
    bass: 'offbeat',
    keys: 'pad',
    lead: 'arp',
    seed: 51,
  },
];

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function section(bar) {
  const s = { kick: true, hats: true, open: false, clap: false, bass: false, keys: false, lead: false };
  if (bar < 8) return s;
  if (bar < 16) return { ...s, open: true, clap: true, bass: true };
  if (bar < 32) return { ...s, open: true, clap: true, bass: true, keys: true };
  if (bar < 40) return { kick: false, hats: bar >= 36, open: false, clap: false, bass: false, keys: true, lead: false, brk: true };
  if (bar < 56) return { ...s, open: true, clap: true, bass: true, keys: true, lead: true };
  if (bar < 60) return { ...s, open: true, bass: true };
  return s;
}

export async function renderDemo(def, sampleRate) {
  const beat = 60 / def.bpm;
  const bar = beat * 4;
  const step = beat / 4;
  const duration = BARS * bar + 1.0;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const rand = rng(def.seed);

  // ---- buses
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 4;
  comp.attack.value = 0.005;
  comp.release.value = 0.15;
  master.connect(comp);
  comp.connect(ctx.destination);

  const pump = ctx.createGain(); // sidechain-ducked bus for keys
  pump.connect(master);
  const delay = ctx.createDelay(2);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.35;
  const wet = ctx.createGain();
  wet.gain.value = 0.28;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass';
  dlp.frequency.value = 4000;
  delay.connect(dlp);
  dlp.connect(fb);
  fb.connect(delay);
  dlp.connect(wet);
  wet.connect(master);

  const noiseBuf = ctx.createBuffer(1, sampleRate * 2, sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const noiseVoice = (type, freq, Q, dest, pan = 0) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (Q) f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f); f.connect(g); g.connect(p); p.connect(dest);
    src.start(0);
    return { g: g.gain, f: f.frequency };
  };

  const oscVoice = (type, dest, { cutoff = 20000, Q = 0.7, detune = 0, pan = 0 } = {}) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(f); f.connect(g); g.connect(p); p.connect(dest);
    o.start(0);
    return { o: o.frequency, g: g.gain, f: f.frequency };
  };

  const hit = (param, t, peak, att, dec) => {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + att);
    param.exponentialRampToValueAtTime(0.0001, t + att + dec);
  };

  // ---- instruments
  const kick = oscVoice('sine', master);
  const closedHat = noiseVoice('highpass', 8000, 0, master, 0.15);
  const openHat = noiseVoice('highpass', 6500, 0, master, -0.1);
  const clap = noiseVoice('bandpass', 1500, 1.1, master);
  const riser = noiseVoice('bandpass', 400, 2, master);
  const crash = noiseVoice('highpass', 4000, 0, master);
  const bassV = oscVoice(def.bass === 'deep' ? 'triangle' : 'sawtooth', master, { cutoff: 600, Q: def.bass === 'rolling' ? 4 : 6 });
  const subV = def.bass === 'deep' ? oscVoice('sine', master) : null;
  const keyType = def.lead === 'pluck' ? 'triangle' : 'sawtooth';
  const keyVoices = [];
  for (let i = 0; i < 4; i++) {
    const pan = (i - 1.5) * 0.35;
    keyVoices.push([
      oscVoice(keyType, pump, { cutoff: def.keys === 'pad' ? 1400 : 2600, detune: -8, pan }),
      oscVoice(keyType, pump, { cutoff: def.keys === 'pad' ? 1400 : 2600, detune: 8, pan: -pan }),
    ]);
  }
  const leadOut = ctx.createGain();
  leadOut.connect(master);
  leadOut.connect(delay);
  const leadV = oscVoice(def.lead === 'acid' ? 'sawtooth' : def.lead === 'pluck' ? 'triangle' : 'square', leadOut, {
    cutoff: 3000,
    Q: def.lead === 'acid' ? 14 : 1,
  });

  const fold = (m, lo) => {
    while (m < lo) m += 12;
    while (m >= lo + 12) m -= 12;
    return m;
  };

  for (let b = 0; b < BARS; b++) {
    const s = section(b);
    const t0 = b * bar;
    const ci = Math.floor(b / 2) % def.chords.length;
    const chord = def.chords[ci].map((n) => fold(def.root + n, 55));
    const bassNote = fold(def.root + def.bassRoots[ci], def.root - 5);

    // drums
    for (let q = 0; q < 4; q++) {
      const tb = t0 + q * beat;
      if (s.kick) {
        kick.o.setValueAtTime(155, tb);
        kick.o.exponentialRampToValueAtTime(46, tb + 0.12);
        hit(kick.g, tb, 0.95, 0.002, Math.min(0.4, beat - 0.03));
        // sidechain pump
        pump.gain.setValueAtTime(0.35, tb);
        pump.gain.linearRampToValueAtTime(1, tb + beat * 0.55);
      }
      if (s.clap && (q === 1 || q === 3)) hit(clap.g, tb, 0.32, 0.002, 0.17);
      if (s.open) hit(openHat.g, tb + beat / 2, 0.11, 0.002, 0.18);
      if (s.hats) {
        for (let k = 0; k < 4; k++) {
          if (k === 2 && s.open) continue;
          const v = (k % 2 ? 0.09 : 0.05) * (0.7 + rand() * 0.5);
          hit(closedHat.g, tb + k * step, v, 0.001, 0.035);
        }
      }
    }

    // bass
    if (s.bass) {
      if (def.bass === 'offbeat') {
        for (let q = 0; q < 4; q++) {
          const t = t0 + q * beat + beat / 2;
          bassV.o.setValueAtTime(hz(bassNote), t);
          bassV.f.setValueAtTime(1400, t);
          bassV.f.exponentialRampToValueAtTime(220, t + 0.2);
          hit(bassV.g, t, 0.33, 0.004, 0.22);
        }
      } else if (def.bass === 'rolling') {
        for (let q = 0; q < 4; q++) {
          for (let k = 1; k < 4; k++) {
            const t = t0 + q * beat + k * step;
            bassV.o.setValueAtTime(hz(bassNote + (k === 3 && rand() > 0.7 ? 12 : 0)), t);
            bassV.f.setValueAtTime(900 + rand() * 500, t);
            bassV.f.exponentialRampToValueAtTime(180, t + step * 0.9);
            hit(bassV.g, t, 0.3, 0.003, step * 0.85);
          }
        }
      } else {
        const pat = [0, 1.5, 2.5, 3];
        pat.forEach((p, i) => {
          const t = t0 + p * beat;
          const n = bassNote + (i === 3 ? 7 : 0);
          bassV.o.setValueAtTime(hz(n), t);
          subV.o.setValueAtTime(hz(n), t);
          bassV.f.setValueAtTime(900, t);
          bassV.f.exponentialRampToValueAtTime(250, t + 0.3);
          const len = i === 0 ? beat * 1.3 : beat * 0.4;
          hit(bassV.g, t, 0.2, 0.01, len);
          hit(subV.g, t, 0.35, 0.01, len);
        });
      }
    }

    // keys
    if (s.keys) {
      const pad = def.keys === 'pad' || s.brk;
      keyVoices.forEach((pair, i) => {
        const n = chord[i % chord.length] + (i >= chord.length ? 12 : 0);
        pair.forEach((v) => {
          v.o.setValueAtTime(hz(n), t0);
          if (pad) {
            v.g.setValueAtTime(0.0001, t0);
            v.g.linearRampToValueAtTime(0.045, t0 + 0.45);
            v.g.linearRampToValueAtTime(0.035, t0 + bar - 0.2);
            v.g.linearRampToValueAtTime(0.0001, t0 + bar - 0.01);
            v.f.setValueAtTime(s.brk ? 900 + (b - 32) * 250 : 1400, t0);
          } else {
            const stabs = [0.5, 1.5, 2.75, 3.5];
            stabs.forEach((sb, si) => {
              const nextGap = (si < stabs.length - 1 ? stabs[si + 1] : 4.5) - sb;
              hit(v.g, t0 + sb * beat, 0.06, 0.004, Math.min(0.22, nextGap * beat - 0.02));
            });
          }
        });
      });
    }

    // lead
    if (s.lead) {
      if (def.lead === 'arp') {
        const notes = [...chord, chord[0] + 12, chord[1] + 12, chord[2] + 12];
        for (let k = 0; k < 16; k++) {
          const t = t0 + k * step;
          const n = notes[k % notes.length] + 12;
          leadV.o.setValueAtTime(hz(n), t);
          leadV.f.setValueAtTime(2800, t);
          leadV.f.exponentialRampToValueAtTime(900, t + step);
          hit(leadV.g, t, 0.06, 0.002, step * 0.8);
        }
      } else if (def.lead === 'acid') {
        const scale = [0, 3, 5, 7, 10, 12];
        const sweep = 600 + 2400 * (0.5 + 0.5 * Math.sin((b - 40) / 16 * Math.PI * 2));
        for (let k = 0; k < 16; k++) {
          if (rand() < 0.22) continue;
          const t = t0 + k * step;
          const n = def.root + 12 + scale[Math.floor(rand() * scale.length)];
          const accent = rand() > 0.7;
          leadV.o.setValueAtTime(hz(n), t);
          leadV.f.setValueAtTime(sweep * (accent ? 1.8 : 1), t);
          leadV.f.exponentialRampToValueAtTime(200, t + step * 0.9);
          hit(leadV.g, t, accent ? 0.11 : 0.07, 0.002, step * 0.85);
        }
      } else {
        const scale = [0, 3, 5, 7, 10, 12, 15];
        for (let k = 0; k < 8; k++) {
          if (rand() < 0.35) continue;
          const t = t0 + k * beat * 0.5;
          const n = def.root + 24 + scale[Math.floor(rand() * scale.length)];
          leadV.o.setValueAtTime(hz(n), t);
          leadV.f.setValueAtTime(3500, t);
          hit(leadV.g, t, 0.1, 0.003, beat * 0.42);
        }
      }
    }
  }

  // break riser and drop crash
  const brkStart = 32 * bar;
  const dropT = 40 * bar;
  riser.f.setValueAtTime(300, brkStart);
  riser.f.exponentialRampToValueAtTime(7000, dropT);
  riser.g.setValueAtTime(0.0001, brkStart);
  riser.g.linearRampToValueAtTime(0.22, dropT - 0.02);
  riser.g.linearRampToValueAtTime(0.0001, dropT);
  hit(crash.g, dropT, 0.25, 0.002, 2.2);
  hit(crash.g, 16 * bar, 0.18, 0.002, 1.6);

  const buffer = await ctx.startRendering();
  normalize(buffer, 0.89);
  return buffer;
}

function normalize(buf, target) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak < 1e-6) return;
  const k = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}
