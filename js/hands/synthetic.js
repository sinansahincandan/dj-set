// Synthetic hands for tests and the debug hook. Pure.
// Produces 21 MediaPipe-ordered landmarks in client px, as the tracker would after the
// mirror/cover mapping: by default a right hand, palm towards the camera, which on the
// mirrored screen has its thumb on the left.

// Hand-local layout in units of `size` (wrist→middle MCP = 1), wrist at the origin,
// fingers pointing up (−y). `ang` tilts a finger towards the pinky side (radians).
const FINGERS = [
  { mcp: [-0.30, -0.94], ang: -0.10, len: [0.42, 0.25, 0.20] }, // index
  { mcp: [0.00, -1.00], ang: 0.00, len: [0.47, 0.29, 0.21] },   // middle
  { mcp: [0.22, -0.95], ang: 0.09, len: [0.43, 0.27, 0.20] },   // ring
  { mcp: [0.40, -0.83], ang: 0.20, len: [0.34, 0.21, 0.18] },   // pinky
];
// Joint flexion at curl = 1 (MCP, PIP, DIP), radians. Fingers fold towards the camera, so
// in 2-D a segment projects to cos(cumulative angle) of its length along the finger.
const FLEX = [1.57, 1.75, 1.2];
const THUMB_OPEN = [[-0.22, -0.24], [-0.44, -0.42], [-0.60, -0.58], [-0.74, -0.72]];
const PINCH_INDEX_CURL = 0.3;            // the index bends a little to meet the thumb
const PINCH_TIP_OFFSET = [-0.025, 0.02]; // thumb tip ends just beside the index tip

function finger(f, curl, out) {
  const { mcp, ang, len } = FINGERS[f];
  const ux = Math.sin(ang), uy = -Math.cos(ang);
  let x = mcp[0], y = mcp[1], phi = 0;
  const base = 5 + f * 4;
  out[base] = [x, y];
  for (let j = 0; j < 3; j++) {
    phi += FLEX[j] * curl;
    const l = len[j] * Math.cos(phi);
    x += ux * l; y += uy * l;
    out[base + 1 + j] = [x, y];
  }
}

export function makeHand({ x, y, size = 110, rot = 0, curl = [0, 0, 0, 0], pinch = false,
  anchor = 'palm', side = 'right' } = {}) {
  const p = Math.min(Math.max(pinch === true ? 1 : pinch === false ? 0 : +pinch || 0, 0), 1);
  const c = (i) => Math.min(Math.max(curl[i] || 0, 0), 1);
  const L = new Array(21);
  L[0] = [0, 0];

  const ci = c(0) + (Math.max(c(0), PINCH_INDEX_CURL) - c(0)) * p;
  finger(0, ci, L);
  for (let f = 1; f < 4; f++) finger(f, c(f), L);

  // thumb: open pose, blended towards a pinch that meets the index tip
  const m = L[8];
  const t1 = THUMB_OPEN[0];
  const tip = [m[0] + PINCH_TIP_OFFSET[0], m[1] + PINCH_TIP_OFFSET[1]];
  const ex = tip[0] - t1[0], ey = tip[1] - t1[1];
  const el = Math.hypot(ex, ey) || 1;
  const nx = ey / el, ny = -ex / el;      // perpendicular, bulging away from the palm (left)
  const pinched = [
    t1,
    [t1[0] + ex * 0.4 + nx * 0.10, t1[1] + ey * 0.4 + ny * 0.10],
    [t1[0] + ex * 0.72 + nx * 0.07, t1[1] + ey * 0.72 + ny * 0.07],
    tip,
  ];
  for (let j = 0; j < 4; j++) {
    const o = THUMB_OPEN[j], q = pinched[j];
    L[1 + j] = [o[0] + (q[0] - o[0]) * p, o[1] + (q[1] - o[1]) * p];
  }

  // to screen: mirror for a left hand, rotate (positive = clockwise on screen), scale
  const mir = side === 'left' ? -1 : 1;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const pts = new Array(21);
  for (let i = 0; i < 21; i++) {
    const lx = L[i][0] * mir, ly = L[i][1];
    pts[i] = { x: size * (lx * cs - ly * sn), y: size * (lx * sn + ly * cs) };
  }

  let ax, ay;
  if (anchor === 'pinch') {
    ax = (pts[4].x + pts[8].x) / 2; ay = (pts[4].y + pts[8].y) / 2;
  } else if (anchor === 'index') {
    ax = pts[8].x; ay = pts[8].y;
  } else {
    ax = (pts[0].x + pts[5].x + pts[9].x + pts[13].x + pts[17].x) / 5;
    ay = (pts[0].y + pts[5].y + pts[9].y + pts[13].y + pts[17].y) / 5;
  }
  const tx = (x || 0) - ax, ty = (y || 0) - ay;
  for (let i = 0; i < 21; i++) { pts[i].x += tx; pts[i].y += ty; }
  return pts;
}
