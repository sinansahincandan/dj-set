// DJ rig controls. Each control builds its own DOM (`control.el`) and caches its hit geometry in
// measure(). Hand input arrives through js/ui/interaction.js; the look lives in controls.css.

const TAU = Math.PI * 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '−';

// Knob, hand input: twist (wrist roll) and crank (pinch point circling the dial) add up.
export const KNOB_TWIST_GAIN = 2.4; // 270° of knob per 270°/2.4 ≈ 112° of wrist (centre → max ≈ 56°)
export const KNOB_CRANK_IN = 0.6; // crank weight 0 at this many dial radii from the centre …
export const KNOB_CRANK_OUT = 1.4; // … rising smoothly to 1 at this many
const KNOB_SWEEP = 1.5 * Math.PI; // 270°
const SPOKE_MIN_W = 0.02; // show the crank spoke above this weight
const KNOB_MOUSE_PX = 160; // px of vertical drag for the full range
const DETENT = 0.03;
const PAD_REPEAT_MS = 280;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

function make(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null && text !== '') e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function signedPct(v, def) {
  const n = Math.round((v - def) * 200);
  return n > 0 ? '+' + n : n < 0 ? MINUS + -n : '0';
}

function defaultFormat(v, def, detent) {
  return detent && def > 0 && def < 1 ? signedPct(v, def) : String(Math.round(v * 100));
}

// ─── Base ────────────────────────────────────────────────────────────────────

export class Control {
  constructor(kind, gesture, cls, color) {
    this.kind = kind;
    this.gesture = gesture;
    this.captured = false;
    this.hover = false;
    this.el = make('div', 'ctl ' + cls);
    this.el.dataset.kind = kind;
    if (color) this.el.style.setProperty('--c', color);
    this.hitEl = this.el; // element whose box is the hit shape
    this.round = false; // circle hit shape (inscribed in hitEl's box)
    this.left = this.top = this.right = this.bottom = 0;
    this.cx = this.cy = this.r = 0;
    this.leaveGrow = 0;
  }

  measure() {
    const b = this.hitEl.getBoundingClientRect();
    this.left = b.left;
    this.top = b.top;
    this.right = b.right;
    this.bottom = b.bottom;
    this.cx = (b.left + b.right) / 2;
    this.cy = (b.top + b.bottom) / 2;
    this.r = Math.min(b.width, b.height) / 2;
  }

  /** Distance in px from the hit shape, 0 inside. */
  dist(x, y) {
    if (this.round) {
      const d = Math.hypot(x - this.cx, y - this.cy) - this.r;
      return d > 0 ? d : 0;
    }
    const dx = x < this.left ? this.left - x : x > this.right ? x - this.right : 0;
    const dy = y < this.top ? this.top - y : y > this.bottom ? y - this.bottom : 0;
    return dx === 0 && dy === 0 ? 0 : Math.hypot(dx, dy);
  }

  inside(x, y, grow = 0) {
    return this.dist(x, y) <= grow;
  }

  setHover(on) {
    on = !!on;
    if (on === this.hover) return;
    this.hover = on;
    this.el.classList.toggle('hover', on);
  }

  setCaptured(on) {
    on = !!on;
    this.captured = on;
    this.el.classList.toggle('held', on);
  }
}

// ─── Pad ─────────────────────────────────────────────────────────────────────

export class Pad extends Control {
  constructor({ label = '', sub = '', color, onPress, onAlt } = {}) {
    super('pad', 'tap', 'pad', color);
    this.el.setAttribute('role', 'button');
    this.labelEl = make('span', 'pad-label', this.el, label);
    this.subEl = make('span', 'pad-sub', this.el, sub);
    this.el.classList.toggle('no-sub', !sub);
    this.onPress = onPress;
    this.onAlt = onAlt;
    this.lit = false;
    this.lastPress = -Infinity;
    this.el.addEventListener('animationend', (e) => {
      if (e.animationName === 'ctl-pad-hit') this.el.classList.remove('hit');
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Returns whether it fired (presses closer than 280 ms are ignored). */
  press(t) {
    if (t - this.lastPress < PAD_REPEAT_MS) return false;
    this.lastPress = t;
    this.flash();
    if (this.onPress) this.onPress(this);
    return true;
  }

  /** Secondary action (right-click). */
  alt() {
    if (!this.onAlt) return;
    this.flash();
    this.onAlt(this);
  }

  flash() {
    const cl = this.el.classList;
    cl.remove('hit');
    void this.el.offsetWidth; // restart the animation
    cl.add('hit');
  }

  setLit(on) {
    on = !!on;
    if (on === this.lit) return;
    this.lit = on;
    this.el.classList.toggle('lit', on);
  }

  setLabel(text) {
    this.labelEl.textContent = text;
  }

  setSub(text) {
    this.subEl.textContent = text || '';
    this.el.classList.toggle('no-sub', !text);
  }
}

// ─── Knob ────────────────────────────────────────────────────────────────────

// 270° arc on a 100×100 viewBox, r = 42, from -135° (bottom left) clockwise to +135°.
const KNOB_R = 42;
const arcPt = (deg, r = KNOB_R) => {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
};
const [AX0, AY0] = arcPt(-135);
const [AX1, AY1] = arcPt(135);
const KNOB_ARC = `M ${AX0.toFixed(2)} ${AY0.toFixed(2)} A ${KNOB_R} ${KNOB_R} 0 1 1 ${AX1.toFixed(2)} ${AY1.toFixed(2)}`;

export class Knob extends Control {
  constructor({ label = '', value = 0.5, def = 0.5, detent = true, color, onChange, format } = {}) {
    super('knob', 'pinch', 'knob', color);
    this.def = clamp01(def);
    this.detent = detent;
    this.onChange = onChange;
    this.format = format || ((v) => defaultFormat(v, this.def, this.detent));

    const well = make('div', 'knob-well', this.el);
    // crank spoke: absolutely positioned from the dial centre, no layout or hit-shape effect
    this.spoke = make('div', 'knob-spoke', well);
    this.spokeOn = false;
    this.dial = make('div', 'knob-dial', well);
    const s = svg('svg', { class: 'knob-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, this.dial);
    svg('path', { class: 'knob-track', d: KNOB_ARC }, s);
    this.glowPath = svg('path', { class: 'knob-glow', d: KNOB_ARC, pathLength: '100' }, s);
    this.fillPath = svg('path', { class: 'knob-fill', d: KNOB_ARC, pathLength: '100' }, s);
    if (detent) {
      const [tx, ty] = arcPt(-135 + this.def * 270, 49.5);
      svg('circle', { class: 'knob-tick', cx: tx.toFixed(2), cy: ty.toFixed(2), r: '2.2' }, s);
    }
    const cap = make('div', 'knob-cap', this.dial);
    make('div', 'knob-pointer', cap);
    this.valueEl = make('div', 'knob-value', this.dial);
    this.labelEl = make('div', 'knob-label', this.el, label);

    this.hitEl = this.dial;
    this.round = true;
    this.value = NaN;
    this.raw = 0;
    this.grabbing = false;
    this.lastRoll = 0;
    this.lastY = 0;
    this.lastPhi = NaN; // angle of the pinch point around the dial centre
    this.lastW = 0; // crank weight at the previous point
    this.set(value, false);
    this.raw = this.value;

    this.el.addEventListener('dblclick', () => {
      this.raw = this.def;
      this.set(this.def);
    });
  }

  set(v, fire = true) {
    v = clamp01(+v);
    if (Number.isNaN(v) || v === this.value) return;
    this.value = v;
    if (!this.grabbing) this.raw = v;
    this.render();
    if (fire && this.onChange) this.onChange(v);
  }

  render() {
    const v = this.value;
    this.el.style.setProperty('--v', v.toFixed(4));
    const a = Math.min(v, this.def) * 100;
    const b = Math.max(v, this.def) * 100;
    const dash = `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 200`;
    this.fillPath.setAttribute('stroke-dasharray', dash);
    this.glowPath.setAttribute('stroke-dasharray', dash);
    this.valueEl.textContent = this.format(v);
    this.el.classList.toggle('at-def', v === this.def);
  }

  /** Crank weight for a point at distance d from the dial centre: 0 at 0.6 R → 1 at 1.4 R. */
  crankWeight(d) {
    const r = this.r;
    if (!(r > 0)) return 0;
    const u = (d / r - KNOB_CRANK_IN) / (KNOB_CRANK_OUT - KNOB_CRANK_IN);
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    return u * u * (3 - 2 * u); // smoothstep
  }

  grabStart(g) {
    this.grabbing = true;
    this.raw = this.value;
    this.lastY = g.y;
    this.lastRoll = g.roll;
    this.lastPhi = NaN;
    this.lastW = 0;
    if (!g.mouse && Number.isFinite(g.x) && Number.isFinite(g.y)) {
      const dx = g.x - this.cx;
      const dy = g.y - this.cy;
      this.lastPhi = Math.atan2(dy, dx);
      this.lastW = this.crankWeight(Math.hypot(dx, dy));
    }
  }

  grabMove(g) {
    if (!this.grabbing) this.grabStart(g);
    let d = 0;
    if (g.mouse) {
      d = (this.lastY - g.y) / KNOB_MOUSE_PX; // drag up = increase
      this.lastY = g.y;
    } else {
      // twist: clockwise on screen (roll increasing) = increase
      if (Number.isFinite(g.roll)) {
        if (Number.isFinite(this.lastRoll)) d += (wrapPi(g.roll - this.lastRoll) * KNOB_TWIST_GAIN) / KNOB_SWEEP;
        this.lastRoll = g.roll;
      }
      // crank: the pinch point circling the centre (clockwise = increase). The weight of a step
      // is the smaller of its two ends, so it fades in/out smoothly and a step through the
      // noisy middle counts for nothing.
      if (Number.isFinite(g.x) && Number.isFinite(g.y)) {
        const dx = g.x - this.cx;
        const dy = g.y - this.cy;
        const dist = Math.hypot(dx, dy);
        const phi = Math.atan2(dy, dx);
        const w = this.crankWeight(dist);
        if (Number.isFinite(this.lastPhi)) {
          const wm = w < this.lastW ? w : this.lastW;
          if (wm > 0) d += (wrapPi(phi - this.lastPhi) * wm) / KNOB_SWEEP;
        }
        this.lastPhi = phi;
        this.lastW = w;
        this.showSpoke(w, dist, phi);
      }
    }
    if (d === 0) return;
    this.raw = clamp01(this.raw + d);
    this.set(this.detent && Math.abs(this.raw - this.def) < DETENT ? this.def : this.raw);
  }

  showSpoke(w, len, phi) {
    const st = this.spoke.style;
    if (w > SPOKE_MIN_W) {
      st.setProperty('--sl', len.toFixed(1) + 'px');
      st.setProperty('--sa', phi.toFixed(4) + 'rad');
      st.setProperty('--sw', w.toFixed(2));
      if (!this.spokeOn) {
        this.spokeOn = true;
        this.el.classList.add('cranking');
      }
    } else if (this.spokeOn) {
      this.spokeOn = false;
      this.el.classList.remove('cranking');
    }
  }

  grabEnd() {
    this.grabbing = false;
    this.raw = this.value;
    this.lastPhi = NaN;
    this.lastW = 0;
    if (this.spokeOn) {
      this.spokeOn = false;
      this.el.classList.remove('cranking');
    }
  }
}

// ─── Fader ───────────────────────────────────────────────────────────────────

export class Fader extends Control {
  constructor({ label = '', orientation = 'v', value = 0.5, def, detent = false, color, onChange, format } = {}) {
    const v = orientation !== 'h';
    super('fader', 'pinch', 'fader ' + (v ? 'fader-v' : 'fader-h'), color);
    this.orientation = v ? 'v' : 'h';
    this.def = clamp01(def ?? value);
    this.detent = detent;
    this.onChange = onChange;
    this.format = format || ((x) => defaultFormat(x, this.def, this.detent));
    if (!detent) this.el.classList.add('unipolar');

    this.track = make('div', 'fader-track', this.el);
    if (v) {
      this.meter = make('div', 'fader-meter', this.track);
    }
    make('div', 'fader-ticks', this.track);
    const groove = make('div', 'fader-groove', this.track);
    make('div', 'fader-fill', groove);
    if (detent) {
      const m = make('div', 'fader-detent', this.track);
      m.style.setProperty('--d', this.def.toFixed(4));
    }
    this.cap = make('div', 'fader-cap', this.track);
    const row = make('div', 'fader-text', this.el);
    this.labelEl = make('span', 'fader-label', row, label);
    this.valueEl = make('span', 'fader-value', row);

    this.travel = 0;
    this.value = NaN;
    this.raw = 0;
    this.grabbing = false;
    this.lastX = this.lastY = 0;
    this.level = 0;
    this.shownLevel = -1;
    this.set(value, false);
    this.raw = this.value;

    this.el.addEventListener('dblclick', () => {
      this.raw = this.def;
      this.set(this.def);
    });
  }

  measure() {
    super.measure();
    const tr = this.track.getBoundingClientRect();
    const cr = this.cap.getBoundingClientRect();
    this.travel = this.orientation === 'v' ? tr.height - cr.height : tr.width - cr.width;
  }

  set(v, fire = true) {
    v = clamp01(+v);
    if (Number.isNaN(v) || v === this.value) return;
    this.value = v;
    if (!this.grabbing) this.raw = v;
    this.el.style.setProperty('--v', v.toFixed(4));
    this.valueEl.textContent = this.format(v);
    this.el.classList.toggle('at-def', v === this.def);
    if (fire && this.onChange) this.onChange(v);
  }

  /** Peak level 0..1+ for the meter behind vertical faders (call every frame). */
  setLevel(x) {
    if (!this.meter) return;
    x = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
    this.level = x > this.level ? x : this.level * 0.88 + x * 0.12; // fast attack, soft fall
    const shown = Math.round(this.level * 200) / 200;
    if (shown === this.shownLevel) return;
    this.shownLevel = shown;
    this.el.style.setProperty('--level', shown.toFixed(3));
    this.el.classList.toggle('clip', x >= 0.98);
  }

  grabStart(g) {
    this.grabbing = true;
    this.raw = this.value;
    this.lastX = g.x;
    this.lastY = g.y;
    if (!(this.travel > 0)) this.measure();
  }

  grabMove(g) {
    if (!this.grabbing) this.grabStart(g);
    const travel = this.travel > 1 ? this.travel : 1;
    // relative: the cap moves exactly as far as the hand moves along the track
    const d = this.orientation === 'v' ? (this.lastY - g.y) / travel : (g.x - this.lastX) / travel;
    this.lastX = g.x;
    this.lastY = g.y;
    this.raw = clamp01(this.raw + d);
    this.set(this.detent && Math.abs(this.raw - this.def) < DETENT ? this.def : this.raw);
  }

  grabEnd() {
    this.grabbing = false;
    this.raw = this.value;
  }
}

// ─── Platter ─────────────────────────────────────────────────────────────────

export class Platter extends Control {
  constructor({ deck = null, color } = {}) {
    super('platter', 'hand', 'platter', color);
    this.deck = deck;
    this.wrap = make('div', 'platter-wrap', this.el);
    make('div', 'platter-ring', this.wrap);
    this.disc = make('div', 'platter-disc', this.wrap);
    make('div', 'platter-grooves', this.disc);
    make('div', 'platter-marker', this.disc);
    const label = make('div', 'platter-label', this.disc);
    this.titleEl = make('div', 'platter-title', label);
    this.idEl = make('div', 'platter-id', label, deck ? deck.id : '');
    make('div', 'platter-notch', label);
    make('div', 'platter-sheen', this.wrap);
    make('div', 'platter-spindle', this.wrap);
    make('div', 'platter-badge', this.wrap, 'SCRATCH');

    this.hitEl = this.wrap;
    this.round = true;
    this.px = this.py = 0;
    this.qx = this.qy = 0;
    this.angle = NaN;
    this.isPlaying = false;
    this.isScratching = false;
  }

  measure() {
    super.measure();
    this.leaveGrow = 0.35 * this.r; // released beyond ~1.35 R
  }

  setTitle(text) {
    this.titleEl.textContent = text || '';
  }

  /** Contact point: mean of the index, middle and ring fingertips when a hand state is given,
   *  else the pointer. Writes into this.qx / this.qy. */
  contact(p, h) {
    const pts = h && h.pts;
    if (pts && pts.length > 16 && pts[8] && pts[12] && pts[16]) {
      const x = (pts[8].x + pts[12].x + pts[16].x) / 3;
      const y = (pts[8].y + pts[12].y + pts[16].y) / 3;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.qx = x;
        this.qy = y;
        return;
      }
    }
    this.qx = p.x;
    this.qy = p.y;
  }

  handStart(p, t, h) {
    this.contact(p, h); // first frame only sets the previous contact point: no delta
    this.px = this.qx;
    this.py = this.qy;
    if (this.deck) this.deck.scratchStart();
  }

  handMove(p, t, h) {
    // angular change of the contact point around the centre; screen y points down, so a
    // positive cross product is clockwise on screen = forward
    this.contact(p, h);
    const ax = this.px - this.cx;
    const ay = this.py - this.cy;
    const bx = this.qx - this.px;
    const by = this.qy - this.py;
    this.px = this.qx;
    this.py = this.qy;
    const r0 = 0.3 * this.r;
    const den = Math.max(ax * ax + ay * ay, r0 * r0);
    if (!(den > 0)) return;
    const dTheta = (ax * by - ay * bx) / den;
    if (dTheta !== 0 && this.deck) this.deck.scratchMove(dTheta / TAU);
  }

  handEnd() {
    if (this.deck) this.deck.scratchEnd();
  }

  /** Call every animation frame. */
  update() {
    const d = this.deck;
    if (!d) return;
    const turns = d.turns || 0;
    const deg = Math.round((turns - Math.floor(turns)) * 36000) / 100;
    if (deg !== this.angle) {
      this.angle = deg;
      this.disc.style.transform = `rotate(${deg}deg)`;
    }
    if (this.idEl.textContent !== d.id) this.idEl.textContent = d.id;
    const playing = !!d.playing;
    if (playing !== this.isPlaying) {
      this.isPlaying = playing;
      this.el.classList.toggle('playing', playing);
    }
    const scr = !!d.scratching;
    if (scr !== this.isScratching) {
      this.isScratching = scr;
      this.el.classList.toggle('scratching', scr);
    }
  }
}

// ─── FX pad ──────────────────────────────────────────────────────────────────

const FX_DEAD = 0.12; // dead zone on x (in -1..1 units) around the centre
const FX_FLOOR = 0.15; // bottom 15 % = no echo

export class FxPad extends Control {
  constructor({ engine = null } = {}) {
    super('fxpad', 'hand', 'fxpad');
    this.engine = engine;
    this.canvas = make('canvas', 'fxpad-canvas', this.el);
    const zone = make('div', 'fxpad-zone', this.el);
    zone.style.setProperty('--dead', String(FX_DEAD / 2));
    zone.style.setProperty('--floor', String(FX_FLOOR));
    make('div', 'fxpad-title', this.el, 'FX');
    make('div', 'fxpad-hint fxpad-hint-x', this.el, 'LOW-PASS ◄  FILTER  ► HIGH-PASS');
    make('div', 'fxpad-hint fxpad-hint-y', this.el, 'ECHO ▲');
    const cross = make('div', 'fxpad-cross', this.el);
    make('div', 'fxpad-cross-v', cross);
    make('div', 'fxpad-cross-h', cross);
    make('div', 'fxpad-dot', cross);
    this.readout = make('div', 'fxpad-readout', this.el);
    this.fx = { x: 0, y: 0 };
    this.readText = '';
  }

  measure() {
    super.measure();
    this.leaveGrow = 0.25 * (this.bottom - this.top);
  }

  apply(p) {
    const w = this.right - this.left;
    const h = this.bottom - this.top;
    const u = w > 0 ? clamp01((p.x - this.left) / w) : 0.5;
    const v = h > 0 ? clamp01((this.bottom - p.y) / h) : 0;
    const c = 2 * u - 1;
    const ac = Math.abs(c);
    const x = ac <= FX_DEAD ? 0 : (Math.sign(c) * (ac - FX_DEAD)) / (1 - FX_DEAD);
    const y = v <= FX_FLOOR ? 0 : (v - FX_FLOOR) / (1 - FX_FLOOR);
    this.fx.x = x;
    this.fx.y = y;
    const st = this.el.style;
    st.setProperty('--px', u.toFixed(4));
    st.setProperty('--py', v.toFixed(4));
    if (this.engine) this.engine.setFx(this.fx);
    const fx = Math.round(Math.abs(x) * 100);
    const txt =
      (x < 0 ? `LOW-PASS ${fx}%` : x > 0 ? `HIGH-PASS ${fx}%` : 'FILTER OFF') +
      `  ·  ECHO ${Math.round(y * 100)}%`;
    if (txt !== this.readText) {
      this.readText = txt;
      this.readout.textContent = txt;
    }
  }

  handStart(p) {
    this.apply(p);
  }

  handMove(p) {
    this.apply(p);
  }

  handEnd() {
    if (this.engine) this.engine.setFx(null);
  }
}
