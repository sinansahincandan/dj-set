// Full-screen canvas above the rig that confirms what the hand tracker sees.
// Subtle by design: a thin glowing skeleton coloured by pose, a dot while pinching,
// a ring in palm pose and a short ripple on taps. Time `t` is passed in.

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
const TIPS = [4, 8, 12, 16, 20];
const STALE_MS = 150;
const RIPPLE_MS = 380;

const FALLBACK = {
  pinch: '#ffd23f',  // --cue
  palm: '#5dffa0',   // --ok
  point: '#2ee6ff',  // --a
  free: '#eef1f8',   // --text
};

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

export class HandOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.enabled = true;          // shell can turn the skeleton off (settings)
    this.colors = { ...FALLBACK };
    this._dpr = 1;
    this._w = 0;
    this._h = 0;
    this._dirty = true;
    this._ripples = [];           // { x, y, t0, color }
    this._lastTapAt = [-Infinity, -Infinity];
    this.resize();
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    this._dpr = dpr;
    this._w = w;
    this._h = h;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.colors.pinch = cssVar('--cue', FALLBACK.pinch);
    this.colors.palm = cssVar('--ok', FALLBACK.palm);
    this.colors.point = cssVar('--a', FALLBACK.point);
    this.colors.free = cssVar('--text', FALLBACK.free);
    this._dirty = true;
  }

  _clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(states, t) {
    const ctx = this.ctx;
    if (!this.enabled || !states) {
      if (this._dirty) { this._clear(); this._dirty = false; }
      this._ripples.length = 0;
      return;
    }

    // collect new taps (tapAt survives between tracker frames, so rAF cannot miss them)
    for (let k = 0; k < states.length && k < 2; k++) {
      const s = states[k];
      const at = s.tapAt != null ? s.tapAt : (s.tap ? t : -Infinity);
      if (at > this._lastTapAt[k]) {
        this._lastTapAt[k] = at;
        if (s.present && t - at < RIPPLE_MS) {
          this._ripples.push({ x: s.tapPt.x, y: s.tapPt.y, t0: at, color: this.colors.point });
        }
      }
    }
    for (let i = this._ripples.length - 1; i >= 0; i--) {
      if (t - this._ripples[i].t0 >= RIPPLE_MS) this._ripples.splice(i, 1);
    }

    let any = this._ripples.length > 0;
    for (let k = 0; k < states.length; k++) if (states[k].present) any = true;
    if (!any) {
      if (this._dirty) { this._clear(); this._dirty = false; }
      return;
    }

    this._clear();
    this._dirty = true;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let k = 0; k < states.length; k++) {
      const s = states[k];
      if (!s.present) continue;
      let alpha = 1;
      if (s.stale) alpha = Math.max(0, 1 - (t - s.lastSeen) / STALE_MS) * 0.7;
      if (alpha <= 0.01) continue;
      this._drawHand(s, alpha);
    }

    for (const r of this._ripples) {
      const u = Math.min(Math.max((t - r.t0) / RIPPLE_MS, 0), 1);
      const ease = 1 - (1 - u) * (1 - u);
      ctx.globalAlpha = 0.85 * (1 - u);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2.5 * (1 - u) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + 34 * ease, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawHand(s, alpha) {
    const ctx = this.ctx;
    const p = s.pts;
    const color = this.colors[s.pose] || this.colors.free;
    const sc = s.scale || 100;
    const lw = Math.max(1.2, Math.min(2.5, sc / 60));

    ctx.beginPath();
    for (let i = 0; i < BONES.length; i++) {
      const a = p[BONES[i][0]], b = p[BONES[i][1]];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    // soft glow: a wide faint pass under the thin line (cheaper than shadowBlur)
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.14 * alpha;
    ctx.lineWidth = lw * 5;
    ctx.stroke();
    ctx.globalAlpha = 0.6 * alpha;
    ctx.lineWidth = lw;
    ctx.stroke();

    // fingertips
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75 * alpha;
    ctx.beginPath();
    for (let i = 0; i < TIPS.length; i++) {
      const q = p[TIPS[i]];
      ctx.moveTo(q.x + lw * 1.6, q.y);
      ctx.arc(q.x, q.y, lw * 1.6, 0, Math.PI * 2);
    }
    ctx.fill();

    if (s.pinch) {
      const r = Math.max(5, sc * 0.07);
      ctx.globalAlpha = 0.25 * alpha;
      ctx.beginPath();
      ctx.arc(s.pinchPt.x, s.pinchPt.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95 * alpha;
      ctx.beginPath();
      ctx.arc(s.pinchPt.x, s.pinchPt.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.pose === 'palm') {
      ctx.globalAlpha = 0.5 * alpha;
      ctx.lineWidth = lw * 1.2;
      ctx.beginPath();
      ctx.arc(s.palm.x, s.palm.y, sc * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
