// Hand → control routing. One slot per hand; each slot can hold one control.
// All time comes from the `t` argument (ms, performance.now() clock), so frames can be replayed.

const MAGNET_FRAC = 0.028; // magnet radius as a fraction of the viewport width
const MAGNET_MIN = 28; // px
const GRAB_WINDOW = 250; // ms after a pinch starts during which it may still grab
const DWELL = 100; // ms a palm must rest on a hand control before it engages
export const DISENGAGE = 220; // ms without palm/pinch before a hand control lets go
export const PINCH_GRACE = 160; // ms a held pinch control survives a pinch drop-out (held, not moved)
const PAD_SLACK = 18; // px around pads for taps / pinch-presses

function newSlot(id) {
  return {
    id,
    ctl: null, // held control
    pinchUsed: false,
    prevPinch: false,
    lastEngaged: 0,
    pinchLostAt: -1, // t when the held pinch control's pinch dropped out, -1 while pinching
    dwellCtl: null,
    dwellSince: 0,
    // hover targets
    hPinch: null,
    hPad: null,
    hHand: null,
  };
}

export class Interaction {
  constructor(controls) {
    this.controls = controls.slice();
    this.pinchCtls = this.controls.filter((c) => c.gesture === 'pinch');
    this.tapCtls = this.controls.filter((c) => c.gesture === 'tap');
    this.handCtls = this.controls.filter((c) => c.gesture === 'hand');
    this.slots = [newSlot(0), newSlot(1)];
    this.viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    this.magnet = Math.max(MAGNET_MIN, MAGNET_FRAC * this.viewportWidth);
    this.pointers = new Map(); // pointerId → control held by mouse/touch
    this.grab = { x: 0, y: 0, roll: 0, mouse: false }; // reused per frame
  }

  /** Measure all controls and recompute the magnet radius. */
  measure(viewportWidth) {
    if (viewportWidth > 0) this.viewportWidth = viewportWidth;
    else if (typeof window !== 'undefined') this.viewportWidth = window.innerWidth;
    this.magnet = Math.max(MAGNET_MIN, MAGNET_FRAC * this.viewportWidth);
    for (const c of this.controls) c.measure();
  }

  /** Control held by hand slot i (0|1), or null. For the debug panel. */
  heldBy(i) {
    return this.slots[i] ? this.slots[i].ctl : null;
  }

  update(states, t) {
    for (let i = 0; i < 2; i++) {
      const h = states ? states[i] : null;
      const s = this.slots[i];
      if (!h || !h.present) {
        this.release(s);
        s.pinchUsed = false;
        s.prevPinch = false;
        s.dwellCtl = null;
        s.hPinch = s.hPad = s.hHand = null;
        continue;
      }
      if (h.stale) continue; // hold everything, including hover
      this.step(h, s, t);
      s.prevPinch = !!h.pinch;
      this.computeHover(h, s);
    }
    this.applyHover();
  }

  step(h, s, t) {
    if (!h.pinch) s.pinchUsed = false;
    const c = s.ctl;

    // ── holding something ──
    if (c) {
      if (c.gesture === 'pinch') {
        if (h.pinch) {
          // also after a grace gap: the knob kept its last roll/point, so motion made during
          // the gap counts now
          s.pinchLostAt = -1;
          const g = this.grab;
          g.x = h.pinchPt.x;
          g.y = h.pinchPt.y;
          g.roll = h.roll;
          c.grabMove(g);
        } else if (s.pinchLostAt < 0) {
          s.pinchLostAt = t; // hold without moving; still captured
        } else if (t - s.pinchLostAt > PINCH_GRACE) {
          this.release(s);
        }
      } else {
        if (h.pose === 'palm' || h.pinch) s.lastEngaged = t;
        const p = h.palm;
        if (!c.inside(p.x, p.y, c.leaveGrow) || t - s.lastEngaged > DISENGAGE) this.release(s);
        else c.handMove(p, t, h);
      }
      return;
    }

    // ── holding nothing ──
    if (h.pinch) {
      s.dwellCtl = null;
      const fresh = !!h.pinchStart || !s.prevPinch;
      if (!s.pinchUsed && (fresh || t - h.pinchSince < GRAB_WINDOW)) {
        const pp = h.pinchPt;
        const k = this.nearestFree(this.pinchCtls, pp.x, pp.y, this.magnet);
        if (k) {
          const g = this.grab;
          g.x = pp.x;
          g.y = pp.y;
          g.roll = h.roll;
          k.grabStart(g);
          this.capture(s, k, t);
          s.pinchUsed = true;
        } else if (fresh) {
          const hc = this.nearestFree(this.handCtls, pp.x, pp.y, 0);
          if (hc) {
            hc.handStart(h.palm, t, h);
            this.capture(s, hc, t);
            s.pinchUsed = true;
          } else {
            const pad = this.nearestFree(this.tapCtls, pp.x, pp.y, PAD_SLACK);
            if (pad) {
              pad.press(t);
              s.pinchUsed = true;
            }
          }
        }
      }
    } else if (h.pose === 'palm') {
      const p = h.palm;
      const hc = this.nearestFree(this.handCtls, p.x, p.y, 0);
      if (!hc) {
        s.dwellCtl = null;
      } else if (hc !== s.dwellCtl) {
        s.dwellCtl = hc;
        s.dwellSince = t;
      } else if (t - s.dwellSince >= DWELL) {
        s.dwellCtl = null;
        hc.handStart(p, t, h);
        this.capture(s, hc, t);
      }
    } else {
      s.dwellCtl = null;
    }

    if (h.tap && !s.ctl && h.tapPt) {
      const pad = this.nearestFree(this.tapCtls, h.tapPt.x, h.tapPt.y, PAD_SLACK);
      if (pad) pad.press(t);
    }
  }

  capture(s, c, t) {
    s.ctl = c;
    s.lastEngaged = t;
    s.pinchLostAt = -1;
    c.setCaptured(true);
  }

  release(s) {
    const c = s.ctl;
    s.pinchLostAt = -1;
    if (!c) return;
    s.ctl = null;
    if (c.gesture === 'pinch') c.grabEnd();
    else c.handEnd();
    c.setCaptured(false);
  }

  /** Nearest control in list that nobody holds, within maxDist px of (x, y). */
  nearestFree(list, x, y, maxDist) {
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.captured) continue;
      const d = c.dist(x, y);
      if (d <= maxDist && d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  computeHover(h, s) {
    if (s.ctl) {
      s.hPinch = s.hPad = s.hHand = null;
      return;
    }
    const pp = h.pinchPt;
    const it = h.indexTip;
    const p = h.palm;
    s.hPinch = pp ? this.nearestFree(this.pinchCtls, pp.x, pp.y, this.magnet) : null;
    s.hPad = it ? this.nearestFree(this.tapCtls, it.x, it.y, PAD_SLACK) : null;
    s.hHand = p ? this.nearestFree(this.handCtls, p.x, p.y, 0) : null;
  }

  applyHover() {
    const [a, b] = this.slots;
    for (const c of this.controls) {
      const on =
        c === a.ctl || c === a.hPinch || c === a.hPad || c === a.hHand ||
        c === b.ctl || c === b.hPinch || c === b.hPad || c === b.hHand;
      c.setHover(on);
    }
  }

  releaseAll() {
    for (const s of this.slots) {
      this.release(s);
      s.dwellCtl = null;
      s.hPinch = s.hPad = s.hHand = null;
    }
    for (const [id, c] of this.pointers) {
      this.pointers.delete(id);
      this.endMouse(c, null);
    }
    this.applyHover();
  }

  // ── mouse / touch fallback ──────────────────────────────────────────────────

  bindMouse() {
    if (this.mouseBound) return;
    this.mouseBound = true;
    for (const c of this.controls) {
      const el = c.el;
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('pointerdown', (e) => this.onDown(c, e));
      el.addEventListener('pointermove', (e) => {
        if (this.pointers.get(e.pointerId) !== c) return;
        this.moveMouse(c, e);
      });
      const end = (e) => {
        if (this.pointers.get(e.pointerId) !== c) return;
        this.pointers.delete(e.pointerId);
        this.endMouse(c, e);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    }
  }

  onDown(c, e) {
    if (c.captured) return; // a hand (or another pointer) holds it
    if (c.gesture === 'tap') {
      e.preventDefault();
      if (e.button === 2) {
        if (c.alt) c.alt();
        else if (c.onAlt) c.onAlt(c);
      } else if (e.button === 0) {
        c.press(performance.now());
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      c.el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    this.pointers.set(e.pointerId, c);
    c.setCaptured(true);
    if (c.gesture === 'pinch') c.grabStart({ x: e.clientX, y: e.clientY, mouse: true });
    else c.handStart({ x: e.clientX, y: e.clientY }, performance.now());
  }

  moveMouse(c, e) {
    if (c.gesture === 'pinch') c.grabMove({ x: e.clientX, y: e.clientY, mouse: true });
    else c.handMove({ x: e.clientX, y: e.clientY }, performance.now());
  }

  endMouse(c, e) {
    if (c.gesture === 'pinch') c.grabEnd();
    else c.handEnd();
    c.setCaptured(false);
    if (e) {
      try {
        if (c.el.hasPointerCapture(e.pointerId)) c.el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }
}
