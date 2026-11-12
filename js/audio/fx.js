// Shared effects: DJ filter mapping, a BPM-synced echo and a generated-impulse reverb.

/**
 * One-knob DJ filter on a low-pass + high-pass pair.
 * v in -1..1: negative sweeps the low-pass down, positive sweeps the high-pass up, 0 is off.
 */
export function applyDjFilter(ctx, lp, hp, v, tc = 0.015) {
  const t = ctx.currentTime;
  const dz = 0.03;
  let lpF = 22000;
  let hpF = 10;
  if (v < -dz) {
    const k = (-v - dz) / (1 - dz);
    lpF = 22000 * Math.pow(2, -k * 7.6); // down to ~110 Hz
  } else if (v > dz) {
    const k = (v - dz) / (1 - dz);
    hpF = 10 * Math.pow(2, k * 9.6); // up to ~7.7 kHz
  }
  const res = 0.9 + 4 * Math.min(1, Math.abs(v) * 1.5);
  lp.frequency.setTargetAtTime(lpF, t, tc);
  hp.frequency.setTargetAtTime(hpF, t, tc);
  lp.Q.setTargetAtTime(v < -dz ? res : 0.7, t, tc * 2);
  hp.Q.setTargetAtTime(v > dz ? res : 0.7, t, tc * 2);
}

export function createEcho(ctx) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(4);
  const feedback = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  const lowcut = ctx.createBiquadFilter();
  const output = ctx.createGain();

  delay.delayTime.value = 0.36;
  feedback.gain.value = 0.5;
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  lowcut.type = 'highpass';
  lowcut.frequency.value = 180;
  output.gain.value = 0.9;

  input.connect(delay);
  delay.connect(tone);
  tone.connect(lowcut);
  lowcut.connect(feedback);
  feedback.connect(delay);
  lowcut.connect(output);

  return {
    input,
    output,
    setBpm(bpm) {
      if (!bpm) return;
      const t = (60 / bpm) * 0.75; // dotted eighth
      delay.delayTime.setTargetAtTime(Math.min(3.5, t), ctx.currentTime, 0.05);
    },
  };
}

export function createReverb(ctx) {
  const input = ctx.createGain();
  const pre = ctx.createBiquadFilter();
  const conv = ctx.createConvolver();
  const output = ctx.createGain();
  pre.type = 'highpass';
  pre.frequency.value = 250;
  conv.buffer = makeImpulse(ctx, 3.2, 2.6);
  output.gain.value = 0.85;
  input.connect(pre);
  pre.connect(conv);
  conv.connect(output);
  return { input, output };
}

function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // soften the highs over time for a darker tail
      const white = Math.random() * 2 - 1;
      const k = 0.2 + 0.75 * t;
      lp += (white - lp) * (1 - k);
      d[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}
