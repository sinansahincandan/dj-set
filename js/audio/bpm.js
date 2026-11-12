// Tempo and beat-phase estimation for decoded tracks.
//
// estimateBpm(buffer) → { bpm, offset } | null
// Pure and synchronous; works on any AudioBuffer-like object
// ({ sampleRate, length, numberOfChannels, getChannelData(c) }).
//
// Pipeline:
//   1. Up to 60 s from a little way into the track, mixed to mono.
//   2. Two bands per ~2.9 ms hop: kick band (< ~150 Hz) and the rest.
//      Log-compressed short-window energy, half-wave rectified difference,
//      kick band weighted higher → onset envelope.
//   3. Autocorrelation over 75–165 BPM (plus the 2-beat lag as support) with a
//      mild preference around 120 → coarse tempo, and a pulse-clarity check.
//   4. Multi-harmonic Fourier (comb) search around the coarse tempo in 0.02 BPM
//      steps with parabolic interpolation → fine tempo; snap to an integer BPM
//      when within 0.1.
//   5. Fold the kick-band onset over the beat period → beat phase, then locate the
//      kick attack on a folded fast peak envelope of the kick band.

const MIN_BPM = 75;
const MAX_BPM = 165;
const MIN_SECONDS = 10; // shorter than this: not enough beats to trust
const WINDOW_SECONDS = 60;
const FRAME_RATE = 344; // onset frames per second (hop ≈ 2.9 ms)
const LOW_CUT = 150; // Hz, kick band
const SNAP = 0.1; // BPM distance to an integer that gets snapped
const MIN_CLARITY = 0.08; // normalised autocorrelation at the beat lag (noise ≈ 0.02)

export function estimateBpm(buffer) {
  if (!buffer || !(buffer.sampleRate > 0) || !(buffer.length > 0)) return null;
  const sr = buffer.sampleRate;
  const dur = buffer.length / sr;
  if (dur < MIN_SECONDS) return null;

  // ---- analysis window: skip a bit of intro, at most 60 s
  const winSec = Math.min(WINDOW_SECONDS, dur);
  const startSec = Math.max(0, Math.min(dur * 0.1, 20, dur - winSec));
  const hop = Math.max(1, Math.round(sr / FRAME_RATE));
  const fps = sr / hop;
  const startSample = Math.round(startSec * sr);
  const nFrames = Math.floor(Math.min(buffer.length - startSample, Math.round(winSec * sr)) / hop);
  if (nFrames < MIN_SECONDS * fps * 0.9) return null;

  const nch = Math.max(1, buffer.numberOfChannels | 0);
  const ch0 = buffer.getChannelData(0);
  const ch1 = nch > 1 ? buffer.getChannelData(1) : null;
  const mixK = ch1 ? 0.5 : 1;

  // ---- band energies per hop + fast peak envelope of the kick band
  const eLow = new Float64Array(nFrames);
  const eRest = new Float64Array(nFrames);
  const pkLow = new Float32Array(nFrames); // max of peak-follower within the hop
  const a = 1 - Math.exp((-2 * Math.PI * LOW_CUT) / sr);
  const pkDecay = Math.exp(-1 / (0.012 * sr));
  let y1 = 0;
  let y2 = 0;
  let pk = 0;
  // warm the filters up on the samples just before the window
  const warm = Math.min(startSample, Math.round(0.05 * sr));
  for (let i = startSample - warm; i < startSample; i++) {
    const x = ch1 ? (ch0[i] + ch1[i]) * mixK : ch0[i];
    y1 += a * (x - y1);
    y2 += a * (y1 - y2);
    const ay = y2 < 0 ? -y2 : y2;
    pk = ay > pk ? ay : pk * pkDecay;
  }
  let sumAll = 0;
  for (let f = 0, i = startSample; f < nFrames; f++) {
    let sl = 0;
    let sh = 0;
    let mp = 0;
    for (const end = i + hop; i < end; i++) {
      const x = ch1 ? (ch0[i] + ch1[i]) * mixK : ch0[i];
      y1 += a * (x - y1);
      y2 += a * (y1 - y2);
      const r = x - y2;
      sl += y2 * y2;
      sh += r * r;
      const ay = y2 < 0 ? -y2 : y2;
      pk = ay > pk ? ay : pk * pkDecay;
      if (pk > mp) mp = pk;
    }
    eLow[f] = sl;
    eRest[f] = sh;
    pkLow[f] = mp;
    sumAll += sl + sh;
  }
  const meanPower = sumAll / (nFrames * hop);
  if (!(meanPower > 1e-9)) return null; // silence (below about -90 dBFS)

  // ---- onset envelope
  const onLow = new Float32Array(nFrames);
  const onset = new Float32Array(nFrames);
  bandOnset(eLow, 7, onLow, sumAll / nFrames);
  const onRest = new Float32Array(nFrames);
  bandOnset(eRest, 3, onRest, sumAll / nFrames);
  let mean = 0;
  for (let n = 0; n < nFrames; n++) {
    onset[n] = onLow[n] + 0.5 * onRest[n];
    mean += onset[n];
  }
  mean /= nFrames;
  const d = new Float32Array(nFrames);
  for (let n = 0; n < nFrames; n++) d[n] = onset[n] - mean;

  // ---- autocorrelation, coarse tempo
  const lagMin = Math.floor((60 * fps) / MAX_BPM);
  const lagMax = Math.ceil((60 * fps) / MIN_BPM);
  const lagTop = Math.min(nFrames - 1, 2 * lagMax + 2);
  const r = new Float64Array(lagTop + 1);
  let r0 = 0;
  for (let n = 0; n < nFrames; n++) r0 += d[n] * d[n];
  if (!(r0 > 0)) return null;
  for (let L = lagMin - 1; L <= lagTop; L++) {
    let s = 0;
    for (let n = 0, m = nFrames - L; n < m; n++) s += d[n] * d[n + L];
    r[L] = (s / r0) * (nFrames / (nFrames - L)); // unbiased, normalised
  }
  const near = (L) => {
    if (L + 1 > lagTop) return 0;
    return Math.max(r[L - 1], r[L], r[L + 1]);
  };
  const score = (L) => {
    const bpm = (60 * fps) / L;
    const oct = Math.log2(bpm / 120);
    const w = 1 - 0.15 * oct * oct; // mild preference around 120
    return w * (r[L] + 0.5 * near(2 * L));
  };
  let bestL = -1;
  let best = -Infinity;
  for (let L = lagMin; L <= lagMax; L++) {
    const s = score(L);
    if (s > best) {
      best = s;
      bestL = L;
    }
  }
  if (bestL < 0) return null;
  const clarity = Math.max(r[bestL - 1], r[bestL], r[bestL + 1]);
  if (!(clarity > MIN_CLARITY)) return null;
  let lagF = bestL;
  if (bestL > lagMin && bestL < lagMax) {
    lagF += parabola(r[bestL - 1], r[bestL], r[bestL + 1]);
  }
  const coarse = (60 * fps) / lagF;

  // ---- fine tempo: multi-harmonic comb (Fourier) search, Hann-windowed
  const wd = new Float32Array(nFrames);
  for (let n = 0; n < nFrames; n++) {
    wd[n] = d[n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 0.5)) / nFrames));
  }
  const STEP = 0.02;
  const SPAN = Math.max(1.5, coarse * 0.012);
  const nCand = Math.round((2 * SPAN) / STEP) + 1;
  const sc = new Float64Array(nCand);
  let bi = 0;
  for (let k = 0; k < nCand; k++) {
    const bpm = coarse - SPAN + k * STEP;
    sc[k] = combScore(wd, bpm / 60 / fps);
    if (sc[k] > sc[bi]) bi = k;
  }
  let fine = coarse - SPAN + bi * STEP;
  if (bi > 0 && bi < nCand - 1) fine += STEP * parabola(sc[bi - 1], sc[bi], sc[bi + 1]);
  if (fine < MIN_BPM - 1 || fine > MAX_BPM + 1) return null;

  const rounded = Math.round(fine);
  const bpm = Math.abs(fine - rounded) < SNAP ? rounded : Math.round(fine * 100) / 100;

  // ---- beat phase
  const beat = 60 / bpm;
  const period = beat * fps; // frames
  const B = Math.max(16, Math.round(period));
  const fold = new Float64Array(B);
  const t0 = startSample / hop; // absolute frame index of frame 0
  // kick-band onset, with a little of the rest so kick-less tracks still get a phase
  for (let n = 0; n < nFrames; n++) {
    const v = onLow[n] + 0.25 * onRest[n];
    if (v <= 0) continue;
    foldAdd(fold, B, ((t0 + n + 0.5) / period) % 1, v);
  }
  let pb = 0;
  for (let b = 1; b < B; b++) if (fold[b] > fold[pb]) pb = b;
  const coarsePhase =
    (pb + parabola(fold[(pb - 1 + B) % B], fold[pb], fold[(pb + 1) % B])) / B;

  // locate the attack on the folded kick-band peak envelope near that phase
  const env = new Float64Array(B);
  for (let n = 0; n < nFrames; n++) {
    foldAdd(env, B, ((t0 + n + 0.5) / period) % 1, pkLow[n]);
  }
  let phase = attackPhase(env, B, coarsePhase, period / B / fps);
  if (phase == null) phase = coarsePhase;
  let offset = phase * beat;
  offset = ((offset % beat) + beat) % beat;
  return { bpm, offset: Math.round(offset * 10000) / 10000 };
}

/** Log-compressed short-window energy → half-wave rectified difference. */
function bandOnset(e, win, out, meanAllPerFrame) {
  const n = e.length;
  let bandMean = 0;
  for (let i = 0; i < n; i++) bandMean += e[i];
  bandMean = (bandMean / n) * win;
  const floor = Math.max(0.02 * bandMean, 0.002 * meanAllPerFrame * win, 1e-12);
  let s = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    s += e[i];
    if (i >= win) s -= e[i - win];
    const l = Math.log(Math.max(0, s) + floor);
    const dl = i === 0 ? 0 : l - prev;
    out[i] = dl > 0 ? dl : 0;
    prev = l;
  }
}

/** Sum of |X(h·f)| for h = 1..4, f in cycles per frame, by complex rotation. */
function combScore(w, f) {
  const H = 4;
  let s = 0;
  // run all four harmonics in one pass
  const c1 = Math.cos(2 * Math.PI * f);
  const s1 = Math.sin(2 * Math.PI * f);
  const c2 = Math.cos(4 * Math.PI * f);
  const s2 = Math.sin(4 * Math.PI * f);
  const c3 = Math.cos(6 * Math.PI * f);
  const s3 = Math.sin(6 * Math.PI * f);
  const c4 = Math.cos(8 * Math.PI * f);
  const s4 = Math.sin(8 * Math.PI * f);
  let ar = 1, ai = 0, br = 1, bi = 0, cr = 1, ci = 0, dr = 1, di = 0;
  let xr1 = 0, xi1 = 0, xr2 = 0, xi2 = 0, xr3 = 0, xi3 = 0, xr4 = 0, xi4 = 0;
  for (let n = 0, len = w.length; n < len; n++) {
    const v = w[n];
    xr1 += v * ar; xi1 += v * ai;
    xr2 += v * br; xi2 += v * bi;
    xr3 += v * cr; xi3 += v * ci;
    xr4 += v * dr; xi4 += v * di;
    let t = ar * c1 - ai * s1; ai = ar * s1 + ai * c1; ar = t;
    t = br * c2 - bi * s2; bi = br * s2 + bi * c2; br = t;
    t = cr * c3 - ci * s3; ci = cr * s3 + ci * c3; cr = t;
    t = dr * c4 - di * s4; di = dr * s4 + di * c4; dr = t;
  }
  s += Math.hypot(xr1, xi1) + Math.hypot(xr2, xi2) + Math.hypot(xr3, xi3) + Math.hypot(xr4, xi4);
  return s / H;
}

function foldAdd(fold, B, ph, v) {
  const x = ph * B;
  const i = Math.floor(x);
  const fr = x - i;
  fold[i % B] += v * (1 - fr);
  fold[(i + 1) % B] += v * fr;
}

/**
 * Attack = where the folded peak envelope, rising into its maximum near the
 * onset phase, crosses 25 % of the way from the pre-attack floor to the peak.
 * Returns a phase in [0, 1) or null when there is no clear rise.
 */
function attackPhase(env, B, phase, binSec) {
  const ahead = Math.max(2, Math.round(0.03 / binSec)); // search the peak up to 30 ms after
  const behind = Math.max(3, Math.round(0.06 / binSec)); // and the floor up to 60 ms before
  const c = Math.round(phase * B);
  const at = (k) => env[((k % B) + B) % B];
  let peakK = c;
  for (let k = c - 3; k <= c + ahead; k++) if (at(k) > at(peakK)) peakK = k;
  let floorV = Infinity;
  for (let k = peakK - behind; k < peakK; k++) floorV = Math.min(floorV, at(k));
  const peakV = at(peakK);
  if (!(peakV > floorV * 1.25)) return null;
  const thr = floorV + 0.25 * (peakV - floorV);
  for (let k = peakK; k > peakK - behind; k--) {
    const hi = at(k);
    const lo = at(k - 1);
    if (lo < thr && hi >= thr) {
      // folded bin k represents the hop centred on (k + 0.5)/B; the peak follower
      // reaches the threshold within the hop, so interpolate between hop centres.
      const fr = (thr - lo) / (hi - lo || 1);
      const p = (k - 1 + fr) / B;
      return ((p % 1) + 1) % 1;
    }
  }
  return null;
}

function parabola(a, b, c) {
  const den = a - 2 * b + c;
  if (!(den < 0)) return 0;
  const p = (0.5 * (a - c)) / den;
  return p > 0.5 ? 0.5 : p < -0.5 ? -0.5 : p;
}
