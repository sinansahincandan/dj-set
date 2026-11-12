// Gesture layer: turns raw hand landmarks (client px) into stable, semantic hand states.
// Pure: no clock reads, no DOM. Time `t` (ms) is passed in by the caller.

// ─── Tunables ──────────────────────────────────────────────────────────────────────────
// Starting estimates from hand geometry; tune against a real camera.
// Distances marked "scales" are relative to HandState.scale (≈ wrist→middle-MCP length).

// Slot tracking
export const LOST_MS = 150;              // grace period before a missing hand is dropped
export const MATCH_MAX_SCALES = 5;       // beyond this jump a detection counts as a new hand
export const DUP_SCALES = 0.6;           // two detections closer than this are one hand

// One Euro filter (per landmark; speed measured in scales/s so it is size-independent)
export const EURO_MIN_CUTOFF = 1.2;      // Hz at rest (divided by settings.smoothing)
export const EURO_BETA = 1.5;            // Hz added per scale/s of speed
export const EURO_D_CUTOFF = 1.5;        // Hz, derivative smoothing

// Palm speed
export const PALM_SPEED_TAU_MS = 50;     // EMA time constant for palmSpeed

// Pinch (ratios of |p4−p8| / scale; both multiplied by settings.pinchSens)
export const PINCH_ON = 0.26;
export const PINCH_OFF = 0.40;
export const PINCH_CONFIRM_FRAMES = 2;

// Finger extension (|tip−wrist| / |pip−wrist|)
export const EXT_ON = 1.18;
export const EXT_OFF = 1.08;

// Pose
export const POSE_CONFIRM_FRAMES = 2;

// Roll: weight of the knuckle line (5→17, rotated 90°) relative to wrist→middle MCP
export const ROLL_KNUCKLE_WEIGHT = 1.4;

// Tap (index flex = |p8−p5| / scale)
export const TAP_DROP = 0.22;            // relative drop below baseline (divided by tapSens)
export const TAP_QUICK_MS = 120;         // most of the drop must happen inside this window…
export const TAP_QUICK_SHARE = 0.75;     // …at least this share of the threshold
export const TAP_MIDDLE_WEIGHT = 1;      // how much of the middle finger's drop is subtracted
export const TAP_BASE_UP_MS = 50;        // baseline follows increases fast
export const TAP_BASE_DOWN_MS = 600;     // and decreases slowly
export const TAP_MIN_BASE_FLEX = 0.55;   // baseline must show an extended index
export const TAP_MAX_PALM_SPEED = 3.5;   // scales/s; hand must be fairly still
export const TAP_STILL_MS = 120;         // …and must have been still this long
export const TAP_MIN_INTERVAL_MS = 180;
export const TAP_REARM_SHARE = 0.35;     // re-arm once the drop is back under this share
export const TAP_REARM_MS = 600;         // or after this long
export const TAP_LOOKBACK_MS = 110;      // tapPt = index tip this long before the drop was seen
export const TAP_CONFIRM_MS = 20;        // wait this long (≈1 frame) after the drop is seen…
export const TAP_MIDDLE_VETO = 0.12;     // …and cancel if the middle finger's drop exceeds this
export const TAP_WARMUP_MS = 120;        // no taps until a fresh hand has a baseline

export const DEFAULT_GESTURE_SETTINGS = { pinchSens: 1, tapSens: 1, smoothing: 1 };

// ─── Internals ─────────────────────────────────────────────────────────────────────────

const N = 21;
const HIST = 32;          // ring buffer entries (≥ 500 ms at 60 fps)
const HF = 5;             // fields per entry: t, flex, midFlex, tipX, tipY
const TIPS = [8, 12, 16, 20];
const PIPS = [6, 10, 14, 18];

function euroAlpha(cutoff, dt) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

function handScale(p) {
  const a = Math.hypot(p[0].x - p[9].x, p[0].y - p[9].y);
  const b = 1.25 * Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y);
  return Math.max(a, b, 1e-3);
}

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class HandState {
  constructor(id) {
    this.id = id;
    this.present = false;
    this.stale = false;
    this.lastSeen = -Infinity;
    this.pts = [];
    for (let i = 0; i < N; i++) this.pts.push({ x: 0, y: 0 });
    this.scale = 1;
    this.palm = { x: 0, y: 0 };
    this.palmSpeed = 0;
    this.indexTip = { x: 0, y: 0 };
    this.pinch = false;
    this.pinchStart = false;
    this.pinchEnd = false;
    this.pinchSince = 0;
    this.pinchRatio = 1;
    this.pinchPt = { x: 0, y: 0 };
    this.roll = 0;
    this.ext = [false, false, false, false];
    this.pose = 'free';
    this.tap = false;
    this.tapPt = { x: 0, y: 0 };
    this.tapAt = -Infinity;   // ms of the last tap (lets rAF-driven views catch one-frame taps)
    this.flex = 0;

    // filter state
    this._fx = new Float64Array(N);
    this._fy = new Float64Array(N);
    this._dx = new Float64Array(N);
    this._dy = new Float64Array(N);
    this._init = false;
    // internals
    this._appearedAt = 0;
    this._rawPinch = false;
    this._pinchCount = 0;
    this._poseCand = 'free';
    this._poseCount = 0;
    this._rollRaw = 0;
    this._lastFastT = -Infinity;
    this._base = 0;
    this._midBase = 0;
    this._armed = true;
    this._lastTapT = -Infinity;
    this._pendingT = -1;
    this._disarmT = -Infinity;
    this._pendX = 0;
    this._pendY = 0;
    this._hist = new Float64Array(HIST * HF);
    this._histN = 0;
    this._histHead = 0;
  }

  _clearEvents() {
    this.pinchStart = false;
    this.pinchEnd = false;
    this.tap = false;
  }

  _resetTracking() {
    this._init = false;
    this._histN = 0;
    this._histHead = 0;
    this._armed = true;
    this._pendingT = -1;
    this._rawPinch = false;
    this._pinchCount = 0;
    this._poseCount = 0;
    this._lastFastT = -Infinity;
    this.palmSpeed = 0;
    this.pinch = false;
    this.pinchRatio = 1;
    this.pose = 'free';
    this._poseCand = 'free';
    for (let i = 0; i < 4; i++) this.ext[i] = false;
  }

  // Not detected this frame.
  _miss(t) {
    if (!this.present) return;
    if (t - this.lastSeen <= LOST_MS) {
      this.stale = true;
      return;
    }
    this.present = false;
    this.stale = false;
    if (this.pinch) this.pinchEnd = true;
    this._resetTracking();
  }

  _update(raw, t, s) {
    const fresh = !this.present || !this._init;
    if (fresh) {
      this._resetTracking();
      this._appearedAt = t;
    }
    const dt = fresh ? 0 : Math.min(Math.max((t - this.lastSeen) / 1000, 0.001), 0.25);
    this.present = true;
    this.stale = false;
    this.lastSeen = t;

    // ── smoothing (One Euro, shared 2-D speed per landmark) ──
    const rawScale = handScale(raw);
    const smoothing = s.smoothing == null ? 1 : s.smoothing;
    const fx = this._fx, fy = this._fy, dx = this._dx, dy = this._dy, pts = this.pts;
    if (fresh || smoothing <= 0) {
      for (let i = 0; i < N; i++) {
        fx[i] = raw[i].x; fy[i] = raw[i].y; dx[i] = 0; dy[i] = 0;
      }
      this._init = true;
    } else {
      const minCut = EURO_MIN_CUTOFF / smoothing;
      const ad = euroAlpha(EURO_D_CUTOFF, dt);
      for (let i = 0; i < N; i++) {
        const rx = raw[i].x, ry = raw[i].y;
        dx[i] += ad * ((rx - fx[i]) / dt - dx[i]);
        dy[i] += ad * ((ry - fy[i]) / dt - dy[i]);
        const speed = Math.hypot(dx[i], dy[i]) / rawScale;
        const a = euroAlpha(minCut + EURO_BETA * speed, dt);
        fx[i] += a * (rx - fx[i]);
        fy[i] += a * (ry - fy[i]);
      }
    }
    for (let i = 0; i < N; i++) { pts[i].x = fx[i]; pts[i].y = fy[i]; }

    const scale = handScale(pts);
    this.scale = scale;

    // ── palm, speed, tips ── (fresh objects: consumers may keep the previous one)
    const px = (fx[0] + fx[5] + fx[9] + fx[13] + fx[17]) / 5;
    const py = (fy[0] + fy[5] + fy[9] + fy[13] + fy[17]) / 5;
    if (fresh) {
      this.palmSpeed = 0;
    } else {
      const inst = Math.hypot(px - this.palm.x, py - this.palm.y) / dt / scale;
      this.palmSpeed += (inst - this.palmSpeed) * (1 - Math.exp(-dt * 1000 / PALM_SPEED_TAU_MS));
      if (this.palmSpeed > TAP_MAX_PALM_SPEED || inst > 1.5 * TAP_MAX_PALM_SPEED) this._lastFastT = t;
    }
    this.palm = { x: px, y: py };
    this.indexTip = { x: fx[8], y: fy[8] };
    this.pinchPt = { x: (fx[4] + fx[8]) / 2, y: (fy[4] + fy[8]) / 2 };

    // ── pinch ──
    const sens = s.pinchSens || 1;
    const ratio = Math.hypot(fx[4] - fx[8], fy[4] - fy[8]) / scale;
    this.pinchRatio = ratio;
    this._rawPinch = this._rawPinch ? ratio < PINCH_OFF * sens : ratio < PINCH_ON * sens;
    if (this._rawPinch !== this.pinch) {
      if (++this._pinchCount >= PINCH_CONFIRM_FRAMES) {
        this.pinch = this._rawPinch;
        this._pinchCount = 0;
        if (this.pinch) { this.pinchStart = true; this.pinchSince = t; } else { this.pinchEnd = true; }
      }
    } else {
      this._pinchCount = 0;
    }

    // ── roll ── wrist→middle MCP plus the knuckle line turned to point the same way
    const wx = fx[9] - fx[0], wy = fy[9] - fy[0];
    const kx = fx[17] - fx[5], ky = fy[17] - fy[5];
    let qx = ky, qy = -kx;                       // one perpendicular of the knuckle line
    if (qx * wx + qy * wy < 0) { qx = -qx; qy = -qy; } // pick the one along the fingers
    const ang = Math.atan2(wy + ROLL_KNUCKLE_WEIGHT * qy, wx + ROLL_KNUCKLE_WEIGHT * qx);
    if (fresh) this.roll = ang;
    else this.roll += wrapPi(ang - this._rollRaw);
    this._rollRaw = ang;

    // ── finger extension ──
    let extCount = 0;
    for (let f = 0; f < 4; f++) {
      const tip = TIPS[f], pip = PIPS[f];
      const r = Math.hypot(fx[tip] - fx[0], fy[tip] - fy[0]) /
        Math.max(Math.hypot(fx[pip] - fx[0], fy[pip] - fy[0]), 1e-3);
      const e = fresh ? r > (EXT_ON + EXT_OFF) / 2 : (this.ext[f] ? r > EXT_OFF : r > EXT_ON);
      this.ext[f] = e;
      if (e) extCount++;
    }

    // ── pose ──
    let cand;
    if (this.pinch) cand = 'pinch';
    else if (extCount >= 3) cand = 'palm';
    else if (this.ext[0] && extCount === 1) cand = 'point';
    else cand = 'free';
    if (fresh || cand === 'pinch' || this.pose === 'pinch') {
      // pinch is already confirmed over PINCH_CONFIRM_FRAMES; do not delay it again
      this.pose = cand;
      this._poseCount = 0;
    } else if (cand !== this.pose) {
      if (cand !== this._poseCand) { this._poseCand = cand; this._poseCount = 0; }
      if (++this._poseCount >= POSE_CONFIRM_FRAMES) { this.pose = cand; this._poseCount = 0; }
    } else {
      this._poseCount = 0;
      this._poseCand = cand;
    }

    // ── tap ──
    const flex = Math.hypot(fx[8] - fx[5], fy[8] - fy[5]) / scale;
    const mflex = Math.hypot(fx[12] - fx[9], fy[12] - fy[9]) / scale;
    this.flex = flex;
    if (fresh) { this._base = flex; this._midBase = mflex; }
    const base = Math.max(this._base, 1e-3), mbase = Math.max(this._midBase, 1e-3);
    const drop = (base - flex) / base;
    const mdrop = (mbase - mflex) / mbase;
    const eff = drop - TAP_MIDDLE_WEIGHT * Math.max(0, mdrop);

    // recent maxima (quickness) and the tip position TAP_LOOKBACK_MS ago
    const h = this._hist;
    let maxF = flex, maxM = mflex;
    let lookX = fx[8], lookY = fy[8], lookFound = false;
    for (let k = 0; k < this._histN; k++) {
      const o = ((this._histHead - 1 - k + HIST) % HIST) * HF; // newest first
      const age = t - h[o];
      if (age <= TAP_QUICK_MS) {
        if (h[o + 1] > maxF) maxF = h[o + 1];
        if (h[o + 2] > maxM) maxM = h[o + 2];
      }
      if (!lookFound) {
        lookX = h[o + 3]; lookY = h[o + 4];       // oldest-so-far fallback
        if (age >= TAP_LOOKBACK_MS) lookFound = true;
      }
    }
    const qeff = (maxF - flex) / base - TAP_MIDDLE_WEIGHT * Math.max(0, (maxM - mflex) / mbase);

    const thr = TAP_DROP / (s.tapSens || 1);
    const pinchy = this.pinch || this._rawPinch || ratio < PINCH_ON * sens;
    const still = this.palmSpeed < TAP_MAX_PALM_SPEED && t - this._lastFastT >= TAP_STILL_MS;
    if (this._pendingT >= 0) {
      // a drop was seen: confirm that the middle finger did not follow (closing the hand)
      if (mdrop > TAP_MIDDLE_VETO || pinchy || !still) {
        this._pendingT = -1;
        this._disarmT = t;
      } else if (t - this._pendingT >= TAP_CONFIRM_MS) {
        this._pendingT = -1;
        this.tap = true;
        this.tapPt = { x: this._pendX, y: this._pendY };
        this.tapAt = t;
        this._lastTapT = t;
        this._disarmT = t;
      }
    }
    if (!this._armed && this._pendingT < 0 &&
        (eff < thr * TAP_REARM_SHARE || t - this._disarmT > TAP_REARM_MS)) {
      this._armed = true;
    }
    if (this._armed && !fresh &&
        eff > thr &&
        qeff > thr * TAP_QUICK_SHARE &&
        base >= TAP_MIN_BASE_FLEX &&
        still && !pinchy &&
        t - this._lastTapT >= TAP_MIN_INTERVAL_MS &&
        t - this._appearedAt >= TAP_WARMUP_MS) {
      this._armed = false;
      this._disarmT = t;
      this._pendingT = t;
      this._pendX = lookX;
      this._pendY = lookY;
      if (TAP_CONFIRM_MS <= 0) {
        this._pendingT = -1;
        this.tap = true;
        this.tapPt = { x: lookX, y: lookY };
        this.tapAt = t;
        this._lastTapT = t;
      }
    }

    // baselines (after the test, so this frame cannot mask its own drop)
    if (!fresh) {
      const up = 1 - Math.exp(-dt * 1000 / TAP_BASE_UP_MS);
      const down = 1 - Math.exp(-dt * 1000 / TAP_BASE_DOWN_MS);
      this._base += (flex - this._base) * (flex > this._base ? up : down);
      this._midBase += (mflex - this._midBase) * (mflex > this._midBase ? up : down);
    }

    // history push
    const o = this._histHead * HF;
    h[o] = t; h[o + 1] = flex; h[o + 2] = mflex; h[o + 3] = fx[8]; h[o + 4] = fy[8];
    this._histHead = (this._histHead + 1) % HIST;
    if (this._histN < HIST) this._histN++;
  }
}

export class GestureEngine {
  constructor(settings) {
    this.settings = settings || DEFAULT_GESTURE_SETTINGS;
    this.states = [new HandState(0), new HandState(1)];
    this._dets = [null, null];
    this._dpx = new Float64Array(2);
    this._dpy = new Float64Array(2);
    this._assign = new Int8Array(2);
  }

  process(hands, t, viewportWidth) {
    const states = this.states;
    const s0 = states[0], s1 = states[1];
    s0._clearEvents();
    s1._clearEvents();

    // collect up to two valid detections, dropping duplicates of the same hand
    const dets = this._dets, dpx = this._dpx, dpy = this._dpy;
    let n = 0;
    const count = hands ? hands.length : 0;
    for (let i = 0; i < count && n < 2; i++) {
      const h = hands[i];
      if (!h || h.length < N) continue;
      const x = (h[0].x + h[5].x + h[9].x + h[13].x + h[17].x) / 5;
      const y = (h[0].y + h[5].y + h[9].y + h[13].y + h[17].y) / 5;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (n === 1 && Math.hypot(x - dpx[0], y - dpy[0]) < DUP_SCALES * handScale(h)) continue;
      dets[n] = h; dpx[n] = x; dpy[n] = y; n++;
    }

    // assign detections to slots
    const as = this._assign;
    as[0] = -1; as[1] = -1;
    const occ0 = s0.present, occ1 = s1.present;
    const d = (s, i) => Math.hypot(dpx[i] - s.palm.x, dpy[i] - s.palm.y);
    const near = (s, i) => d(s, i) <= MATCH_MAX_SCALES * s.scale;
    const leftHalf = (i) => (viewportWidth > 0 ? dpx[i] < viewportWidth / 2 : true);
    if (n === 1) {
      if (occ0 && occ1) as[d(s0, 0) <= d(s1, 0) ? 0 : 1] = 0;
      else if (occ0) as[near(s0, 0) ? 0 : 1] = 0;
      else if (occ1) as[near(s1, 0) ? 1 : 0] = 0;
      else as[leftHalf(0) ? 0 : 1] = 0;
    } else if (n === 2) {
      if (occ0 && occ1) {
        if (d(s0, 0) + d(s1, 1) <= d(s0, 1) + d(s1, 0)) { as[0] = 0; as[1] = 1; } else { as[0] = 1; as[1] = 0; }
      } else if (occ0) {
        as[0] = d(s0, 0) <= d(s0, 1) ? 0 : 1; as[1] = 1 - as[0];
      } else if (occ1) {
        as[1] = d(s1, 0) <= d(s1, 1) ? 0 : 1; as[0] = 1 - as[1];
      } else {
        as[0] = dpx[0] <= dpx[1] ? 0 : 1; as[1] = 1 - as[0];
      }
    }

    const settings = this.settings || DEFAULT_GESTURE_SETTINGS;
    for (let k = 0; k < 2; k++) {
      if (as[k] >= 0) states[k]._update(dets[as[k]], t, settings);
      else states[k]._miss(t);
    }
    dets[0] = null; dets[1] = null;
    return states;
  }
}
