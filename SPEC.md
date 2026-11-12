# Hand-controlled DJ set — build spec

A static web app (no build step, no dependencies, vanilla ES modules) that shows the laptop
camera full-screen as a mirror, draws a translucent DJ rig on top of it, and lets the user work
the rig with real DJ hand motions tracked by MediaPipe. **There is no cursor.** The hand as seen
in the video *is* the pointer: landmarks are mapped 1:1 onto the screen with the same
cover-crop + mirror transform as the video.

This file is the contract between modules. Each module has one owner; do not edit files you do
not own. If the contract is wrong or incomplete for your module, implement the closest sensible
thing and say so in your final report rather than changing another module.

## Conventions

- ES modules, 2-space indent, semicolons, single quotes. No external imports except MediaPipe
  (dynamic import, `tracker.js` only). UI text in English.
- All positions are **client pixels** (the stage is `position: fixed; inset: 0`, so client
  coordinates, `getBoundingClientRect()` and hand points share one space).
- **Time is injected.** Every function in `js/hands/*` and `js/ui/interaction.js` that needs a
  clock takes `t` in milliseconds (the `performance.now()` clock) as an argument and never reads
  the clock itself. Tests replay synthetic hands with made-up timestamps.
- Target browsers: current Chrome and Edge on Windows and macOS. Safari is best effort.
- Keep per-frame work allocation-light (these run 60×/s next to an ML model).

## Files and owners

```
index.html, styles.css, js/main.js            owner: SHELL
js/ui/controls.js, js/ui/controls.css         owner: CONTROLS
js/ui/interaction.js                          owner: CONTROLS
js/hands/gestures.js, tracker.js, synthetic.js owner: HANDS
js/ui/handOverlay.js                          owner: HANDS
js/audio/bpm.js                               owner: VISUALS
js/ui/waveform.js, js/ui/visualizer.js        owner: VISUALS
js/audio/{engine,deck,deck-processor,fx,demoTracks}.js   already written — read, do not edit
```

## Audio API (already written)

`js/audio/engine.js` — `class Engine`
- `await engine.init()` creates the `AudioContext` (must be called from a user gesture), loads
  the worklet, builds the graph and `engine.decks.A` / `engine.decks.B`.
- `engine.ctx`, `engine.analyser` (master `AnalyserNode`, fftSize 2048).
- `engine.setCrossfade(x)` 0 = A … 1 = B. `engine.setMaster(v)` 0..1.
- `engine.getRecordStream()` → a `MediaStream` with one audio track carrying exactly what goes
  to the speakers (created on first call, stays connected).
- `engine.setFx({ x, y })` master FX: `x` −1..1 filter (negative low-pass, positive high-pass,
  0 off), `y` 0..1 echo/reverb amount. `engine.setFx(null)` releases it.

`js/audio/deck.js` — `class Deck extends EventTarget`
- State (read-only for UI): `id` ('A'|'B'), `track`, `pos` (seconds, updated ~125×/s),
  `vel` (playback rate right now, negative when scratching backwards), `playing`, `scratching`,
  `rate`, `tempo` (−1..1), `cuePoint`, `hotCues` (array of 4, seconds or null), `loop`
  (`{start,end}` or null), `duration`, `effectiveBpm`, `turns` (platter rotation in turns).
- Methods: `load(track)`, `play(on?)` (no arg toggles), `seek(sec)`, `cue()`,
  `hotCue(i, clear?)`, `toggleLoop(beats = 4)`, `setTempo(v)` −1..1 (±8 %), `sync()`,
  `scratchStart()`, `scratchMove(turns)` (delta, positive = clockwise = forward; one turn is
  1.8 s of audio), `scratchEnd()`, `setEq('low'|'mid'|'high', v)` 0..1 with 0.5 flat,
  `setFilter(v)` −1..1, `setVolume(v)` 0..1, `level()` → peak 0..1+.
- Events: `'load'`, `'state'` (playing / loop changed), `'cues'`, `'tempo'`.

`js/audio/demoTracks.js` — `DEMO_TRACKS` (array of `{ id, name, bpm, … }`) and
`await renderDemo(def, sampleRate)` → `AudioBuffer`. Demo tracks have `beatOffset` 0.

**Track object** (built by SHELL, passed to `deck.load`):
`{ id, name, buffer: AudioBuffer, duration, bpm, beatOffset, peaks }` where `bpm` is 0 when
unknown and `peaks` comes from `computePeaks`.

## VISUALS

### `js/audio/bpm.js`
`export function estimateBpm(buffer)` → `{ bpm, offset } | null`
- Synchronous, pure, works on an `AudioBuffer`-like (`sampleRate`, `length`,
  `numberOfChannels`, `getChannelData(c)`), so it can be tested in Node with a fake buffer.
- Analyse up to ~60 s taken from a little way into the track. Onset envelope (weighted towards
  the kick band) → autocorrelation over 75–165 BPM with a mild preference around 120 → refine
  the tempo to ~0.02 BPM with a comb/phase-folding search → snap to an integer BPM when within
  ~0.1 → `offset` = time in seconds of a beat, reduced into `[0, 60/bpm)`.
- Return `null` when the track is too short or has no clear pulse. Budget: under ~300 ms for a
  6-minute track.

### `js/ui/waveform.js`
- `export function computePeaks(buffer, rate = 150)` → `{ rate, length, max: Float32Array,
  bass: Float32Array }`: per-bucket peak amplitude (0..1) and bass share (0..1, energy below
  ~200 Hz over total) for colouring. Single pass.
- `export class WaveformView { constructor(canvas, deck, color); resize(); draw(); }`
  Scrolling waveform centred on the playhead, showing about ±3.5 s. Reads `deck.track.peaks`,
  `deck.pos`, `deck.track.bpm` / `beatOffset` (beat ticks), `deck.cuePoint`, `deck.hotCues`
  (numbered markers), `deck.loop` (shaded region). Already-played half dimmer. Fixed playhead
  line in the centre. Handles devicePixelRatio. Draws an empty state when no track is loaded.
  `draw()` is called every animation frame; `resize()` when the layout changes.
- `export function renderOverview(canvas, peaks, color)` — one-off whole-track mini waveform.

### `js/ui/visualizer.js`
`export class Spectrum { constructor(canvas, analyser); resize(); draw() }` — log-spaced
frequency bars drawn from the bottom, low opacity (it is the background of the FX pad, text sits
on top), gradient from deck-A colour to deck-B colour. `draw()` returns `{ bass, level }`
(both 0..1, smoothed) so the shell can pulse the UI on the beat.

## HANDS

MediaPipe hand landmark indices: 0 wrist; thumb 1–4; index 5–8; middle 9–12; ring 13–16;
pinky 17–20 (MCP, PIP, DIP, TIP).

### `js/hands/tracker.js`
`export class HandTracker`
- `constructor(video)`.
- `await init(onStatus)` — `getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 },
  height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false })`, attach to the video and
  play it; then dynamic-import MediaPipe Tasks Vision
  (`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs`, wasm root
  `…@0.10.14/wasm`, model
  `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`)
  and create a `HandLandmarker` (`runningMode: 'VIDEO'`, `numHands: 2`, GPU delegate, retry
  with CPU if GPU creation throws). `onStatus(stage)` is called with `'camera'`, `'model'`,
  `'ready'`. Throw an `Error` whose `code` is `'camera-denied'`, `'camera-missing'` or
  `'model-failed'` so the shell can show a useful message.
- `start(onHands)` — per video frame (`requestVideoFrameCallback`, falling back to rAF and
  skipping repeated frames) run `detectForVideo(video, now)` and call
  `onHands(hands, now)` where `hands` is an array (0–2) of 21 `{x, y}` points **already mapped
  to client pixels**. `stop()` ends the loop and the camera stream.
- `updateTransform()` — recompute the mapping; call on resize and on `loadedmetadata`. The video
  is displayed `object-fit: cover`, mirrored: with `s = max(W/vw, H/vh)`, `dw = vw·s`,
  `dh = vh·s`, `ox = (W−dw)/2`, `oy = (H−dh)/2`:
  `x = ox + (1 − lm.x)·dw`, `y = oy + lm.y·dh`.
- `fps` — smoothed detection rate, for the debug panel.

### `js/hands/gestures.js`
```js
export const DEFAULT_GESTURE_SETTINGS = { pinchSens: 1, tapSens: 1, smoothing: 1 };
export class GestureEngine {
  constructor(settings)            // keeps the reference; settings may change live
  process(hands, t, viewportWidth) // hands: array of 21-point arrays in client px → states
  states                           // [HandState, HandState] — always two slots, stable ids 0/1
}
```
`process` assigns detections to the two slots so that a hand keeps its slot while it is visible
(nearest-previous-position matching; when both slots are free, the hand on the left half of the
screen takes slot 0), updates each `HandState`, and returns `states`.

`HandState` fields (all read by other modules):
- `id` 0|1, `present` (bool), `stale` (bool: not detected this frame but within the 150 ms
  grace period — other fields hold their last values), `lastSeen` (ms).
- `pts` — 21 smoothed `{x,y}` (One Euro filter per coordinate; adaptive, so fast moves are not
  lagged). `scale` — hand size in px: `max(|p0−p9|, 1.25·|p5−p17|)`.
- `palm` `{x,y}` — mean of points 0, 5, 9, 13, 17. `palmSpeed` — smoothed palm speed in hand
  scales per second. `indexTip` `{x,y}`.
- `pinch` (bool, with hysteresis: on when `|p4−p8|/scale` < ~0.26, off above ~0.40, both scaled
  by `pinchSens`; 2-frame confirmation each way), `pinchStart` / `pinchEnd` (true for the one
  frame it changes), `pinchSince` (ms), `pinchRatio`, `pinchPt` (midpoint of 4 and 8).
- `roll` — in-plane rotation of the hand in radians (screen space, y down, so increasing =
  clockwise on screen). Based on the long stable segments (wrist→middle MCP, and the knuckle
  line 5→17 rotated to match), **not** the thumb→index vector, which is a few pixels long while
  pinching and far too noisy. Only differences of `roll` are used, so any constant offset is
  fine, but it must be continuous-ish (consumers unwrap ±π).
- `ext` — 4 booleans, index…pinky extended (`|tip−wrist| / |pip−wrist|`, on above ~1.18, off
  below ~1.08).
- `pose` — `'pinch'` if pinching; else `'palm'` if at least 3 of the 4 fingers are extended;
  else `'point'` if only the index is; else `'free'`. Debounced (a new pose must hold 2 frames).
- `tap` (true for one frame), `tapPt` `{x,y}`, `flex` (debug value). A tap is the index finger
  quickly curling and coming back, like pressing a pad in the air: watch
  `flex = |p8−p5|/scale` against a baseline that follows increases fast and decreases slowly
  (~0.6 s). Fire **on the way down** when the relative drop exceeds ~0.22/`tapSens`, the middle
  finger did not drop with it (subtract the middle finger's relative drop, so closing or tilting
  the whole hand does not fire), the baseline shows the index was extended, the hand is fairly
  still (`palmSpeed` below ~3.5), and at least 180 ms have passed since the last tap. Re-arm
  when the finger comes back or after 600 ms. `tapPt` is where the index tip was ~110 ms before
  the tap fired (keep a short position history), because the tip moves while curling.
- When a hand is lost for more than 150 ms: `present = false`, release everything, reset the
  filters so a re-appearing hand does not glide in from the old position.

### `js/hands/synthetic.js`
`export function makeHand({ x, y, size = 110, rot = 0, curl = [0,0,0,0], pinch = false,
anchor = 'palm' })` → 21 `{x,y}` client-px points of a plausible hand: fingers up at `rot` 0,
`size` = wrist→middle-MCP length in px, `curl` 0..1 per finger (index…pinky; a curled tip ends
up closer to the wrist than its PIP joint), `pinch` brings thumb and index tips together,
`anchor` chooses which point lands on `(x, y)`: `'palm'` (the palm centre as defined above),
`'pinch'` (thumb/index midpoint) or `'index'` (index tip). Used by tests and the debug hook, so
it must agree with the gesture definitions above (an open synthetic hand must classify as
`'palm'`, a pinched one as `'pinch'`, curling only the index quickly must fire a tap).

### `js/ui/handOverlay.js`
`export class HandOverlay { constructor(canvas); resize(); draw(states, t) }` — full-screen
canvas above the rig, `pointer-events: none`. For each present hand: a thin skeleton with soft
glow, coloured by pose; when pinching, a solid dot at `pinchPt`; in palm pose, a ring at `palm`;
on a tap, a short expanding ripple at `tapPt`. Stale hands fade. Subtle — it confirms what the
system sees without hiding the hand in the video. Clears the canvas when there is nothing to draw.

## CONTROLS

### `js/ui/controls.js` + `js/ui/controls.css`
Each control builds its own DOM (`control.el`), and owns its look in `controls.css` using the
design tokens below. Sizes come from the container: controls fill the grid cell the shell puts
them in (the shell sets widths/heights; a knob dial is a square that fits its cell).

Common base, `class Control`:
- `el`, `kind` (`'pad' | 'knob' | 'fader' | 'platter' | 'fxpad'`), `gesture`
  (`'tap' | 'pinch' | 'hand'`), `captured` (bool).
- `measure()` — cache the hit geometry from `getBoundingClientRect()` (call after layout and on
  resize). `dist(x, y)` — distance in px from the hit shape (0 inside; the knob's shape is its
  dial, the platter's is its circle). `inside(x, y, grow = 0)`.
- `setHover(on)` toggles class `hover`; `setCaptured(on)` sets `captured` and class `held`.

Controls:
- `new Pad({ label, sub, color, onPress, onAlt })` — gesture `'tap'`.
  `press(t)` → fires `onPress` unless pressed less than 280 ms ago (returns whether it fired),
  flashes (class `hit`, restartable animation). `setLit(on)` (class `lit`), `setLabel(text)`,
  `setSub(text)`. `onAlt` is for right-click (mouse only).
- `new Knob({ label, value = 0.5, def = 0.5, detent = true, color, onChange })` — gesture
  `'pinch'`. `value` 0..1 over a 270° sweep. `grabStart(g)`, `grabMove(g)`, `grabEnd()` with
  `g = { x, y, roll, mouse }`. Hand: two ways to turn, added together each frame, because
  twisting a pinched hand in mid-air turned out to be hard on a real camera:
  - **Twist**: `Δroll · KNOB_TWIST_GAIN / (1.5π)` with gain 2.4 (unwrap Δroll into ±π), so
    centre → max is about 55° of wrist.
  - **Crank**: the pinch point circling the knob centre, like turning a big dial with your
    arm. `Δφ · w / (1.5π)` where φ is the angle of `(g − centre)` and the weight `w` rises
    smoothly from 0 at 0.6 R to 1 at 1.4 R (R = dial radius; inside that the angle is noise).
    Moving straight out from the centre changes nothing; circling clockwise increases.
    While cranking, draw a faint spoke from the knob centre to the pinch point so the user
    sees the lever they are holding.
  Mouse (`g.mouse`): vertical drag, ~160 px for the full range. Keep the un-snapped running value separately so the centre detent
  (snap to `def` within ±0.03) never traps the knob. `set(v, fire = true)`. Double-click resets.
- `new Fader({ label, orientation: 'v' | 'h', value, def, detent, color, onChange })` — gesture
  `'pinch'`. Same grab API. Relative drag: the cap moves by the distance the hand moves along
  the track (grabbing anywhere on the fader works, no jump). `'v'`: up increases. `set(v, fire)`.
  `setLevel(x)` 0..1 drives an optional meter (CSS variable) behind vertical faders.
- `new Platter({ deck, color })` — gesture `'hand'`. `handStart(p, t, h)` →
  `deck.scratchStart()`; `handMove(p, t, h)` → angular change of the **contact point** around
  the platter centre,
  `dθ = cross(prev − c, q − prev) / max(|prev − c|², (0.3R)²)` (the clamp stops the angle
  exploding near the centre), `deck.scratchMove(dθ / 2π)`; `handEnd()` → `deck.scratchEnd()`.
  The contact point `q` is where the fingers touch the record: the mean of the index, middle
  and ring fingertips (`h.pts[8]`, `[12]`, `[16]`) when the hand state `h` is given, else `p`
  (mouse). Using the palm centre made the most natural placement, a palm laid on the middle
  of the record, a dead spot: the palm sat on the pivot, so neither sliding nor turning the
  hand moved the record. With the fingertips, sliding the hand drags the record like its top
  edge, and turning the hand in place turns it too. Whether the hand is still on the platter
  is still judged by the palm (`p`).
  `update()` (every frame) rotates the disc to `deck.turns`. Looks like a record: grooves, a
  label in the deck colour with a clear rotation marker, an outer ring that glows on hover /
  when held. `setTitle(text)` for the label.
- `new FxPad({ engine })` — gesture `'hand'`. While held, the hand's position inside the pad
  drives `engine.setFx({ x, y })`: x from the horizontal position with a ±12 % dead zone around
  the centre (rescaled so the edges are ±1), y from the height (bottom 15 % = 0, top = 1);
  `handEnd()` → `engine.setFx(null)`. Shows a crosshair/dot while held and axis hints
  ("LOW-PASS ◄  FILTER  ► HIGH-PASS", "ECHO ▲"). Contains a `<canvas>` (exposed as
  `fxPad.canvas`) that the shell hands to `Spectrum`.

For hand-gesture controls, `inside(x, y, grow)` with a generous `grow` is used to decide when
the hand has left: platter leaves beyond ~1.35 R, FX pad beyond ~25 % of its height outside.
Expose that as `leaveGrow` (px, computed in `measure()`).

### `js/ui/interaction.js`
```js
export class Interaction {
  constructor(controls)        // array of Control
  measure()                    // measure all controls; also recompute the magnet radius
  update(states, t)            // call once per tracker frame with GestureEngine.states
  releaseAll()
  bindMouse()                  // mouse/touch fallback via pointer events
}
```
One slot per hand. A control can be captured by one hand at a time; two hands can hold two
different controls at once. Per hand, per frame:

1. Not `present` → release its capture (`grabEnd` / `handEnd`). `stale` → do nothing (hold).
2. Holding a **pinch** control: still pinching → `grabMove({ x: pinchPt.x, y: pinchPt.y,
   roll })`. Not pinching: keep holding without moving for up to 160 ms (`PINCH_GRACE`), and
   only then `grabEnd()` and release. A twisting hand hides its own fingertips from the
   camera for a moment and the pinch reading drops out; without the grace the knob was let go
   mid-turn. If the pinch comes back inside the grace, carry on with `grabMove` (the motion
   made during the gap counts).
3. Holding a **hand** control (platter, FX pad): engaged while the pose is `'palm'` or the hand
   is pinching, tracked point = `palm`. Release when the palm leaves (`inside(…, leaveGrow)`
   false) or the hand has not been engaged for 220 ms (fast scratching blurs the hand and the
   pose flickers); otherwise `handMove(palm, t, h)` with the hand state as third argument.
   `handStart` gets it too.
4. Holding nothing:
   - Pinching, and either this is the `pinchStart` frame or the pinch began under 250 ms ago and
     has not been used yet: grab the **nearest** free pinch control whose `dist(pinchPt)` is
     within the magnet radius (~2.8 % of the viewport width, min 28 px). If there is none and
     this is the `pinchStart` frame: start a hand control that contains `pinchPt`, else press a
     pad under `pinchPt`. A pinch is "used" once it did any of these; it resets when the pinch
     ends.
   - Pose `'palm'`: when the palm has rested inside the same free hand control for 100 ms,
     `handStart(palm, t)` and capture it (the dwell stops a passing hand from scratching).
   - `tap`: press the pad under `tapPt` (allow ~18 px of slack; nearest wins).
5. Hover: mark every control a hand is on or about to act on (nearest pinch control near
   `pinchPt`, pad under `indexTip`, hand control under `palm`) with `setHover(true)`, everything
   else `false`.

Mouse fallback (`bindMouse`): `pointerdown` on a control element → pad: `press(performance.now())`
(right button → `onAlt`); pinch controls: `grabStart/Move/End` with `{ x, y, mouse: true }`;
hand controls: `handStart/Move/End` with the pointer position. Use pointer capture. The mouse
must not steal a control a hand is holding.

## SHELL

### Layout
Full-window stage, layers bottom to top: mirrored `<video id="cam">` (`object-fit: cover`), a
dimming layer (opacity from a setting), the rig, the dock, the hand overlay canvas, then modal
overlays. No `backdrop-filter` over the live video (too costly next to the ML model): use
semi-opaque panel backgrounds instead. In mouse-only mode there is no video; the stage has its
own dark background.

Hands can only be tracked when most of the hand is inside the camera frame, and arms come up
from below, so **everything hand-operated lives in the top ~73 % of the screen**; the bottom
strip is display-only.

- Top bar (≈0–5.5 vh): app name on the left ("OZGE DJ SET"), a status chip in the middle
  (camera / hand-tracking state, e.g. "Hands ready · 2 hands"), mouse-operated buttons on the
  right: Help, Settings.
- Rig (≈6.5–72.5 vh, 3 vw side margins): three columns — deck A | mixer (≈27 vw) | deck B.
  - Deck: a large platter (diameter ≈ `min(38vh, 25vw)`), a vertical tempo fader on the outer
    edge (left of A, right of B; up = faster, centre detent), and below them 2 rows × 4 big
    pads (≈10 vh tall): `PLAY`, `CUE`, `SYNC`, `LOOP` and hot cues `1`–`4`.
  - Mixer, top to bottom: FX pad (≈15 vh, also the spectrum visualizer); a strip row with four
    columns — volume fader A | knobs A (HI, MID, LOW, FILTER) | knobs B | volume fader B; the
    crossfader (≈9 vh) at the bottom.
  - Keep centre-to-centre spacing between neighbouring knobs/faders at ≥ ~4 % of the viewport
    width: a pinch is only accurate to a couple of centimetres of screen.
- Dock (≈75.5–98.5 vh, display-only, mouse-operable): per deck a row with a deck badge, track
  title, BPM (effective, one decimal), tempo %, elapsed / remaining time and a `LOAD` button;
  the scrolling waveform; a thin whole-track overview with a progress marker (click to seek).
- `LOAD` opens a small menu: the four demo tracks and "Open audio file…". Dropping an audio file
  on the left / right half of the window loads it into deck A / B.

### Design tokens (define on `:root` in `styles.css`; `controls.css` uses them)
```
--a: #2ee6ff;      /* deck A */          --b: #ff4d9d;      /* deck B */
--cue: #ffd23f;    /* cues, accents */   --ok: #5dffa0;
--bg: #07080d;     --panel: rgba(12,14,24,.52);   --panel-strong: rgba(12,14,24,.78);
--line: rgba(255,255,255,.16);  --text: #eef1f8;  --muted: rgba(238,241,248,.62);
--radius: 14px;
--font: ui-rounded, 'SF Pro Rounded', 'Segoe UI', system-ui, sans-serif;
```
A deck section sets `--c` to its deck colour (`--a` or `--b`); controls inside use `var(--c)`
unless given an explicit `color`. Numbers use `font-variant-numeric: tabular-nums`. Dark,
neon-on-glass look; everything must stay legible over a dimmed live video.

### Behaviour (`js/main.js`)
- Start screen: title, a short guide to the five gestures (palm on the record = scratch; pinch
  and twist a knob; pinch and slide a fader; tap a pad with your index finger; open hand in the
  FX pad), a seating hint (sit back ~60 cm, light on your hands), and two buttons: "Start with
  camera" and "Use mouse only". The click is the user gesture for audio and camera.
- On start: `engine.init()`, build the rig, render two demo tracks and load them on A and B
  (others render on demand, cached), then start the tracker if requested. Camera/model errors
  fall back to mouse mode with a clear message in the status chip. Nothing auto-plays.
- Wiring: pads ↔ deck methods and `'state'` / `'cues'` events (PLAY lit while playing, LOOP lit
  while looping, hot-cue pads lit when set, right-click clears a hot cue); tempo fader ↔
  `setTempo` (and follows `'tempo'` events, e.g. after SYNC); knobs ↔ `setEq` / `setFilter`;
  volume faders ↔ `setVolume` plus `setLevel(deck.level())` meters; crossfader ↔
  `setCrossfade`.
- Hand pipeline: `tracker.start((hands, t) => { gestures.process(hands, t, innerWidth);
  interaction.update(gestures.states, t); })`. A watchdog in the render loop feeds an empty
  frame if no tracker frame arrived for 300 ms, so held controls are released when tracking
  stalls. Render loop (rAF): platters, waveforms, readouts, meters, spectrum, hand overlay.
- Loading a file: `decodeAudioData`, `estimateBpm`, `computePeaks`, then `deck.load`. Show a
  loading state in the deck title; show a readable error for undecodable files.
- Settings panel (persisted in `localStorage`, guarded with try/catch): master volume, pinch
  sensitivity, tap sensitivity, camera dimming, show hand skeleton. Help reopens the gesture
  guide. Key `D` toggles a debug panel: tracker fps and per hand pose, `pinchRatio`, `flex`,
  `ext`, what it is holding.
- Debug hook for tests: `window.__dj = { engine, decks, controls, gestures, interaction,
  makeHand, feed(hands, t) }` where `feed` runs the same path as a tracker frame.
- Re-`measure()` controls and resize canvases on window resize.

### Recording (`js/recorder.js`, owner: SHELL)
The user wants to capture a performance as a video with sound, to share it.

- `export class SessionRecorder { constructor(engine); static support(); async start(mode);
  async stop(); state; elapsedMs; onchange }`.
- Sound always comes straight from `engine.getRecordStream()`, never from the microphone or
  from system/tab audio capture: it is the clean master output, it works the same on Windows
  and macOS, and it needs no extra permission.
- `mode: 'screen'` — picture from `navigator.mediaDevices.getDisplayMedia` asking for **this
  tab** (`preferCurrentTab: true`, `selfBrowserSurface: 'include'`, `video: { frameRate: 30 }`,
  `audio: false`), so the recording shows the rig, the camera picture behind it and the hand
  overlay. Combine that video track with the engine's audio track in one `MediaStream` and
  record it with `MediaRecorder`. `mode: 'audio'` — the audio track only.
- Container: take the first that `MediaRecorder.isTypeSupported` accepts, MP4 (H.264 + AAC)
  before WebM (VP9/VP8 + Opus), because MP4 is what phones and messaging apps play. Audio
  only: MP4/AAC (`.m4a`) before WebM/Opus (`.webm`). Around 8 Mbit/s video, 192 kbit/s audio.
  Record in chunks (timeslice) so a long take does not sit in one buffer.
- **The saved file must be an ordinary MP4** (`js/mp4fix.js`). Chrome's `MediaRecorder` writes
  *fragmented* MP4: brand `iso5`, an empty `moov` with `mvex`, every duration 0, then one
  `moof`+`mdat` pair per second, and no index. The first real recording (76 s, 1728×1117,
  H.264 Baseline + AAC, 72 MB) was refused by WhatsApp and could not be sent anywhere, although
  the streams in it are intact. So before saving, rewrite the container in the browser, without
  re-encoding:
  `export function planFlatMp4(buffer)` → `{ header: Uint8Array, ranges: [[start, end], …] } | null`
  (pure, runs in Node: `header` is the new `ftyp` + complete `moov` + the `mdat` box header,
  `ranges` are byte ranges of the original file to append after it, in order) and
  `export async function flattenMp4Blob(blob)` → a new `Blob` built from the header and
  `blob.slice()` of those ranges (no second copy of the media data), or the original blob
  untouched if the input is not a fragmented MP4 or anything about it is unexpected.
  The new `moov` comes first ("fast start") and carries real sample tables built from every
  `moof` (`stts`, `stss` for video, `ctts` when any composition offset is non-zero, `stsc`,
  `stsz`, `co64` or `stco`), the original `stsd` unchanged, correct `mvhd` / `tkhd` / `mdhd`
  durations, no `mvex`, and an edit list when a track does not start at time 0 so sound and
  picture stay in sync. Works for the sound-only `.m4a` too (one track).
- Picture size: once sharing has started, pin the capture to a fixed size with **even** width
  and height no larger than 1920×1080 (derived from the tab's own aspect ratio), so the size
  cannot change mid-take when Chrome's "sharing this tab" bar appears and no player meets an
  odd dimension. This is best effort: if the browser refuses the constraint, record anyway.
  Video bitrate 5 Mbit/s (8 made a 76 s take 72 MB).
- `stop()` (also triggered when the user ends sharing from the browser's own bar, i.e. the
  video track's `ended` event) resolves with `{ blob, mime, ext, durationMs }`. The shell then
  saves it through a temporary `<a download>` as `ozge-dj-set-YYYY-MM-DD-HHMM.<ext>` and says
  where it went. Stop all capture tracks; do not stop the engine's audio track.
- Errors carry a `code`: `'cancelled'` (the user closed the share dialog — not an error to
  shout about), `'unsupported'`, `'failed'`.
- UI: a `REC` button in the top bar with the other mouse-operated buttons. Idle: clicking it
  opens a two-item menu, "Screen + sound" and "Sound only" (the first is hidden when
  `getDisplayMedia` is missing). Recording: the button turns red with a blinking dot and a
  running `m:ss` timer; clicking it stops and saves. Leaving the page while recording asks
  for confirmation (`beforeunload`).
