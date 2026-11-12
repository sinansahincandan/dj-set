// OZGE DJ SET: app shell (owner: SHELL).
// Builds the rig into the grid cells of index.html, wires controls to the audio decks,
// runs the hand pipeline and the render loop, and owns start screen, settings and debug.

import { Engine } from './audio/engine.js';
import { DEMO_TRACKS, renderDemo } from './audio/demoTracks.js';
import { estimateBpm } from './audio/bpm.js';
import { computePeaks, WaveformView, renderOverview } from './ui/waveform.js';
import { Spectrum } from './ui/visualizer.js';
import { Pad, Knob, Fader, Platter, FxPad } from './ui/controls.js';
import { Interaction } from './ui/interaction.js';
import { GestureEngine, DEFAULT_GESTURE_SETTINGS } from './hands/gestures.js';
import { HandTracker } from './hands/tracker.js';
import { makeHand } from './hands/synthetic.js';
import { HandOverlay } from './ui/handOverlay.js';
import { SessionRecorder } from './recorder.js';

// ───────────── helpers ─────────────

const $ = (id) => document.getElementById(id);
const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
const DECK_IDS = ['A', 'B'];
const NO_HANDS = Object.freeze([]);
const WATCHDOG_MS = 300;
const INITIAL_DEMOS = { A: 0, B: 1 }; // indices into DEMO_TRACKS

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function nextPaint() {
  // let the browser paint a loading state before synchronous heavy work
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 120); // hidden tabs get no rAF
  });
}

const failed = new Set();
/** Run one per-frame subsystem; log its first error and keep the app alive. */
function safe(name, fn) {
  try {
    fn();
  } catch (err) {
    if (!failed.has(name)) {
      failed.add(name);
      console.error(`[dj] ${name} failed:`, err);
    }
  }
}

// ───────────── app state ─────────────

const app = {
  mode: 'idle', // 'idle' | 'starting' | 'mouse' | 'camera'
  engine: null,
  decks: null,
  controls: null, // structured, see buildRig()
  all: [], // flat array of every Control, as passed to Interaction
  names: new Map(), // Control → short name for the debug panel
  interaction: null,
  gestures: null,
  tracker: null,
  tracking: false, // tracker is delivering frames (enables the watchdog)
  cameraStarting: false,
  overlay: null,
  spectrum: null,
  view: {}, // per deck: dom refs, waveform view, cached readout strings
  colors: {},
  lastFrameT: 0, // time of the last hand frame (tracker or feed)
  handsFed: false, // any hand frame ever processed (tracker or __dj.feed)
  demoCache: new Map(), // demo id → Promise<track>
  loadToken: { A: 0, B: 0 },
  loading: { A: null, B: null }, // label while a deck is loading
  levels: { A: 0, B: 0 },
  pulse: 0,
  lastStatusT: 0,
  lastHandCount: -1,
  lastDebugT: 0,
  debugOn: false,
  menuDeck: 'A',
  recorder: null, // SessionRecorder, created on start
  recTimer: 0, // interval that ticks the REC timer while a take runs
  recTimeText: '',
  recHiddenStop: false, // the current take was ended because the tab was hidden
};

const gestureSettings = { ...DEFAULT_GESTURE_SETTINGS };

// ───────────── settings ─────────────

const SETTINGS_KEY = 'ozgeDjSet.settings.v1';
const DEFAULT_SETTINGS = { master: 0.8, pinchSens: 1, tapSens: 1, dim: 0.4, skeleton: true };
const settings = loadSettings();

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof saved?.[k] === typeof DEFAULT_SETTINGS[k]) s[k] = saved[k];
      }
    }
  } catch { /* storage blocked or corrupt: defaults */ }
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage blocked: settings just do not persist */ }
}

function applySettings() {
  gestureSettings.pinchSens = settings.pinchSens;
  gestureSettings.tapSens = settings.tapSens;
  $('dim').style.opacity = String(settings.dim);
  document.body.classList.toggle('no-skeleton', !settings.skeleton);
  if (app.engine?.ctx) app.engine.setMaster(settings.master);
  syncSettingsUI();
}

function syncSettingsUI() {
  $('setMaster').value = settings.master;
  $('setPinch').value = settings.pinchSens;
  $('setTap').value = settings.tapSens;
  $('setDim').value = settings.dim;
  $('setSkeleton').checked = settings.skeleton;
  $('outMaster').textContent = `${Math.round(settings.master * 100)}%`;
  $('outPinch').textContent = `${settings.pinchSens.toFixed(2)}×`;
  $('outTap').textContent = `${settings.tapSens.toFixed(2)}×`;
  $('outDim').textContent = `${Math.round(settings.dim * 100)}%`;
  const camBtn = $('camToggle');
  camBtn.textContent = app.tracker ? 'Turn camera off' : 'Turn camera on';
  camBtn.disabled = app.mode === 'idle' || app.mode === 'starting' || app.cameraStarting;
}

function bindSettings() {
  const bindRange = (id, key) => {
    $(id).addEventListener('input', (e) => {
      settings[key] = Number(e.target.value);
      applySettings();
      saveSettings();
    });
  };
  bindRange('setMaster', 'master');
  bindRange('setPinch', 'pinchSens');
  bindRange('setTap', 'tapSens');
  bindRange('setDim', 'dim');
  $('setSkeleton').addEventListener('change', (e) => {
    settings.skeleton = e.target.checked;
    applySettings();
    saveSettings();
  });
  $('settingsReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    applySettings();
    saveSettings();
  });
  $('camToggle').addEventListener('click', () => {
    if (app.tracker) stopCamera();
    else startCamera();
  });
  $('btnSettings').addEventListener('click', () => toggleSettings());
  $('settingsClose').addEventListener('click', () => toggleSettings(false));
}

function toggleSettings(open = $('settings').hidden) {
  $('settings').hidden = !open;
  $('btnSettings').setAttribute('aria-expanded', String(open));
  if (open) {
    closeLoadMenu();
    closeRecMenu();
    syncSettingsUI();
  }
}

// ───────────── status chip, notices, toasts ─────────────

function setStatus(state, text) {
  const chip = $('status');
  chip.dataset.state = state;
  $('statusText').textContent = text;
}

let noticeTimer = 0;
let noticeAction = null;
/** level: 'info' | 'ok' | 'warn' | 'error'. Errors stay until dismissed. */
function notify(text, level = 'info', { action, onAction, timeout } = {}) {
  const el = $('notice');
  clearTimeout(noticeTimer);
  el.dataset.level = level;
  $('noticeText').textContent = text;
  const btn = $('noticeAction');
  noticeAction = onAction || null;
  btn.hidden = !onAction;
  if (onAction) btn.textContent = action || 'Try again';
  el.hidden = false;
  const ms = timeout ?? (level === 'error' || level === 'warn' ? 0 : 7000);
  if (ms) noticeTimer = setTimeout(hideNotice, ms);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  $('notice').hidden = true;
  noticeAction = null;
}

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ───────────── start screen / help ─────────────

function openGuide(mode) {
  const g = $('guide');
  g.dataset.mode = mode;
  g.hidden = false;
  if (mode === 'help') {
    closeLoadMenu();
    closeRecMenu();
    toggleSettings(false);
    $('guideClose').focus();
  }
}

function closeGuide() {
  $('guide').hidden = true;
}

const guideOpen = () => !$('guide').hidden;

function showStartError(text) {
  const el = $('startError');
  el.textContent = text;
  el.hidden = !text;
}

async function startApp(withCamera) {
  if (app.mode !== 'idle') return;
  app.mode = 'starting';
  showStartError('');
  const camBtn = $('btnStartCam');
  const mouseBtn = $('btnStartMouse');
  camBtn.disabled = true;
  mouseBtn.disabled = true;
  $('guideFoot').textContent = 'Starting the audio engine…';

  try {
    if (!window.AudioContext && !window.webkitAudioContext) throw new Error('no-webaudio');
    app.engine = new Engine();
    await app.engine.init();
  } catch (err) {
    console.error('[dj] audio init failed', err);
    app.engine = null;
    app.mode = 'idle';
    camBtn.disabled = false;
    mouseBtn.disabled = false;
    $('guideFoot').textContent = '';
    showStartError('The audio engine could not start in this browser. Please open the page in a current Chrome or Edge, then try again.');
    return;
  }

  app.decks = app.engine.decks;
  try {
    buildRig();
  } catch (err) {
    console.error('[dj] building the rig failed', err);
    app.mode = 'idle';
    $('guideFoot').textContent = '';
    showStartError('Something went wrong while setting up the decks. Please reload the page.');
    return;
  }

  document.body.classList.remove('mode-idle');
  app.mode = 'mouse';
  applySettings();
  closeGuide();
  $('guideFoot').textContent = '';
  safe('recorder init', initRecorder);
  exposeDebugHook();
  requestAnimationFrame(renderLoop);
  // measure once the rig is visible and laid out
  requestAnimationFrame(() => requestAnimationFrame(onResize));

  for (const id of DECK_IDS) {
    const def = DEMO_TRACKS[INITIAL_DEMOS[id]] || DEMO_TRACKS[0];
    loadTrack(id, { demo: def });
  }

  if (withCamera) {
    startCamera();
  } else {
    setStatus('mouse', 'Mouse mode');
    toast('Mouse mode: drag knobs and faders, click pads, drag the records');
  }
  syncSettingsUI();
}

// ───────────── rig ─────────────

function buildRig() {
  app.colors = {
    A: cssVar('--a', '#2ee6ff'),
    B: cssVar('--b', '#ff4d9d'),
    cue: cssVar('--cue', '#ffd23f'),
    text: cssVar('--text', '#eef1f8'),
  };
  const A = buildDeck('A');
  const B = buildDeck('B');
  const mixer = buildMixer();
  Object.assign(A, mixer.A); // { knobs: { high, mid, low, filter }, volume }
  Object.assign(B, mixer.B);
  app.controls = { A, B, fx: mixer.fx, crossfader: mixer.crossfader, all: app.all };
  buildDock();

  app.gestures = new GestureEngine(gestureSettings);
  app.interaction = new Interaction(app.all);
  app.interaction.bindMouse();
  app.overlay = new HandOverlay($('hands'));
  try {
    app.spectrum = new Spectrum(app.fxPad.canvas, app.engine.analyser);
  } catch (err) {
    console.error('[dj] spectrum unavailable', err);
    app.spectrum = null;
  }
}

function register(control, name) {
  app.all.push(control);
  app.names.set(control, name);
  return control;
}

function mount(slotName, control) {
  const cell = slot(slotName);
  if (!cell) throw new Error(`missing grid cell ${slotName}`);
  cell.replaceChildren(control.el);
  return control;
}

function buildDeck(id) {
  const deck = app.decks[id];
  const cueColor = app.colors.cue;

  /** Wrap a deck action so pads explain themselves when the deck has no track yet. */
  const act = (fn) => () => {
    if (!deck.track) {
      toast(app.loading[id] ? `Deck ${id} is still loading…` : `Load a track on deck ${id} first`);
      return;
    }
    fn();
  };

  const platter = register(new Platter({ deck, color: app.colors[id] }), `${id}·PLATTER`);
  mount(`${id}-platter`, platter);

  const tempo = register(new Fader({
    label: 'TEMPO',
    orientation: 'v',
    value: 0.5,
    def: 0.5,
    detent: true,
    // show the real tempo change (the fader spans ±8 %), not a 0–100 position
    format: (v) => `${v > 0.5 ? '+' : v < 0.5 ? '−' : '±'}${Math.abs((v * 2 - 1) * 8).toFixed(1)}%`,
    onChange: (v) => deck.setTempo(v * 2 - 1),
  }), `${id}·TEMPO`);
  mount(`${id}-tempo`, tempo);

  const play = new Pad({ label: 'PLAY', sub: '▶', onPress: act(() => deck.play()) });
  const cue = new Pad({ label: 'CUE', sub: 'set / back', color: cueColor, onPress: act(() => deck.cue()) });
  const sync = new Pad({
    label: 'SYNC',
    sub: 'match BPM',
    onPress: act(() => {
      if (deck.sync()) toast(`Deck ${id} synced to ${deck.effectiveBpm.toFixed(1)} BPM`);
      else toast('SYNC needs a track with a known BPM on both decks');
    }),
  });
  const loop = new Pad({ label: 'LOOP', sub: '4 beats', onPress: act(() => deck.toggleLoop(4)) });
  const hot = [0, 1, 2, 3].map((i) => new Pad({
    label: String(i + 1),
    sub: 'set',
    color: cueColor,
    onPress: act(() => deck.hotCue(i)),
    onAlt: () => { if (deck.track) deck.hotCue(i, true); },
  }));

  const pads = { play, cue, sync, loop, hot };
  register(play, `${id}·PLAY`); mount(`${id}-pad-play`, play);
  register(cue, `${id}·CUE`); mount(`${id}-pad-cue`, cue);
  register(sync, `${id}·SYNC`); mount(`${id}-pad-sync`, sync);
  register(loop, `${id}·LOOP`); mount(`${id}-pad-loop`, loop);
  hot.forEach((p, i) => { register(p, `${id}·HOT${i + 1}`); mount(`${id}-pad-hot-${i}`, p); });

  const parts = { deck, platter, tempo, pads };
  wireDeckEvents(id, parts);
  return parts;
}

function wireDeckEvents(id, parts) {
  const { deck, tempo, pads, platter } = parts;
  const onState = () => {
    pads.play.setLit(deck.playing);
    pads.play.setLabel(deck.playing ? 'PAUSE' : 'PLAY');
    pads.play.setSub(deck.playing ? '❚❚' : '▶');
    pads.loop.setLit(!!deck.loop);
  };
  const onCues = () => {
    deck.hotCues.forEach((c, i) => {
      pads.hot[i].setLit(c != null);
      pads.hot[i].setSub(c != null ? fmtTime(c) : 'set');
    });
    pads.cue.setSub(deck.track ? `at ${fmtTime(deck.cuePoint)}` : 'set / back');
  };
  const onTempo = () => tempo.set((deck.tempo + 1) / 2, false);
  const onLoad = () => {
    safe(`${id} platter title`, () => platter.setTitle(deck.track?.name || ''));
    onTrackLoaded(id);
  };
  deck.addEventListener('state', () => safe(`${id} state`, onState));
  deck.addEventListener('cues', () => safe(`${id} cues`, onCues));
  deck.addEventListener('tempo', () => safe(`${id} tempo`, onTempo));
  deck.addEventListener('load', onLoad);
  safe(`${id} init`, () => { onState(); onCues(); platter.setTitle(`DECK ${id}`); });
}

function buildMixer() {
  // FX pad (also the spectrum visualizer)
  const fx = register(new FxPad({ engine: app.engine }), 'FX');
  mount('fx', fx);
  app.fxPad = fx;
  const strips = {};

  for (const id of DECK_IDS) {
    const deck = app.decks[id];
    const knob = (band, label) => register(new Knob({
      label,
      value: 0.5,
      def: 0.5,
      detent: true,
      onChange: (v) => deck.setEq(band, v),
    }), `${id}·${label}`);
    const knobs = {
      high: knob('high', 'HI'),
      mid: knob('mid', 'MID'),
      low: knob('low', 'LOW'),
      filter: register(new Knob({
        label: 'FILTER',
        value: 0.5,
        def: 0.5,
        detent: true,
        onChange: (v) => deck.setFilter(v * 2 - 1),
      }), `${id}·FILTER`),
    };
    mount(`${id}-knob-high`, knobs.high);
    mount(`${id}-knob-mid`, knobs.mid);
    mount(`${id}-knob-low`, knobs.low);
    mount(`${id}-knob-filter`, knobs.filter);

    const volume = register(new Fader({
      label: 'VOL',
      orientation: 'v',
      value: deck.volume ?? 0.8,
      def: 0.8,
      detent: false,
      onChange: (v) => deck.setVolume(v),
    }), `${id}·VOL`);
    mount(`${id}-vol`, volume);
    strips[id] = { knobs, volume };
  }

  const crossfader = register(new Fader({
    label: 'CROSSFADER',
    orientation: 'h',
    value: 0.5,
    def: 0.5,
    detent: true,
    onChange: (v) => app.engine.setCrossfade(v),
  }), 'XFADE');
  mount('xfade', crossfader);

  return { fx, crossfader, A: strips.A, B: strips.B };
}

// ───────────── dock ─────────────

function buildDock() {
  for (const id of DECK_IDS) {
    const deck = app.decks[id];
    const v = {
      row: $(`dock${id}`),
      title: $(`title${id}`),
      bpm: $(`bpm${id}`),
      tempo: $(`tempo${id}`),
      time: $(`time${id}`),
      remain: $(`remain${id}`),
      wave: $(`wave${id}`),
      ov: $(`ov${id}`),
      ovCanvas: $(`ovCanvas${id}`),
      ovFill: $(`ovFill${id}`),
      waveView: null,
      cache: { bpm: '', tempo: '', time: '', remain: '', fill: -1 },
    };
    try {
      v.waveView = new WaveformView(v.wave, deck, app.colors[id]);
    } catch (err) {
      console.error('[dj] waveform unavailable', err);
    }
    app.view[id] = v;
    setDeckTitle(id);

    v.ov.addEventListener('click', (e) => {
      if (!deck.track) return;
      const r = v.ov.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      deck.seek(frac * deck.duration);
    });
    $(`load${id}`).addEventListener('click', (e) => {
      e.stopPropagation();
      if (!$('loadMenu').hidden && app.menuDeck === id) closeLoadMenu();
      else openLoadMenu(id, e.currentTarget);
    });
  }
}

function setDeckTitle(id) {
  const v = app.view[id];
  if (!v) return;
  const deck = app.decks[id];
  const busy = app.loading[id];
  v.row.classList.toggle('is-loading', !!busy);
  v.row.classList.toggle('is-empty', !busy && !deck.track);
  v.title.textContent = busy || deck.track?.name || 'No track · press LOAD or drop a file here';
  v.title.title = v.title.textContent;
}

function renderDeckOverview(id) {
  const v = app.view[id];
  const deck = app.decks[id];
  if (!v) return;
  const c = v.ovCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  if (!deck.track?.peaks) {
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    return;
  }
  safe(`${id} overview`, () => renderOverview(c, deck.track.peaks, app.colors[id]));
}

// ───────────── loading tracks ─────────────

/**
 * Load into deck A/B from `{ demo: def }` or `{ file: File }`. Loading into a playing deck
 * is allowed (the deck stops). A newer request for the same deck supersedes an older one.
 */
async function loadTrack(id, src) {
  if (!app.engine) return;
  const deck = app.decks[id];
  const token = ++app.loadToken[id];
  const stale = () => token !== app.loadToken[id];
  const setBusy = (label) => {
    if (stale()) return;
    app.loading[id] = label;
    setDeckTitle(id);
  };

  try {
    let track;
    if (src.demo) {
      const cached = app.demoCache.has(src.demo.id);
      setBusy(cached ? `Loading ${src.demo.name}…` : `Rendering ${src.demo.name}…`);
      track = await getDemoTrack(src.demo);
    } else if (src.file) {
      track = await decodeFileTrack(src.file, setBusy);
    } else {
      return;
    }
    if (stale()) return;
    app.loading[id] = null;
    deck.load(track); // fires 'load' → onTrackLoaded
  } catch (err) {
    if (stale()) return;
    console.error(`[dj] loading into deck ${id} failed`, err);
    app.loading[id] = null;
    setDeckTitle(id);
    const what = src.file ? `"${src.file.name}"` : (src.demo?.name || 'the track');
    const why = err?.code === 'not-audio'
      ? 'it does not look like an audio file'
      : src.file ? 'the browser could not decode it' : 'rendering failed';
    notify(`Could not load ${what} on deck ${id}: ${why}. MP3, WAV, M4A or OGG files work best.`, 'warn', { timeout: 9000 });
  }
}

function onTrackLoaded(id) {
  setDeckTitle(id);
  renderDeckOverview(id);
  const c = app.view[id]?.cache;
  if (c) { c.bpm = ''; c.tempo = ''; c.time = ''; c.remain = ''; c.fill = -1; }
}

function getDemoTrack(def) {
  let p = app.demoCache.get(def.id);
  if (!p) {
    p = (async () => {
      const buffer = await renderDemo(def, app.engine.ctx.sampleRate);
      await nextPaint();
      return {
        id: def.id,
        name: def.name,
        buffer,
        duration: buffer.duration,
        bpm: def.bpm || 0,
        beatOffset: def.beatOffset || 0,
        peaks: computePeaksSafe(buffer),
      };
    })();
    app.demoCache.set(def.id, p);
    p.catch(() => app.demoCache.delete(def.id)); // allow a retry
  }
  return p;
}

async function decodeFileTrack(file, setBusy) {
  const looksAudio = /^audio\//.test(file.type) || /^video\/(mp4|webm|ogg)/.test(file.type)
    || /\.(mp3|wav|wave|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff|caf)$/i.test(file.name);
  if (!looksAudio) {
    const err = new Error('not audio');
    err.code = 'not-audio';
    throw err;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || file.name;
  setBusy(`Reading ${name}…`);
  const bytes = await file.arrayBuffer();
  setBusy(`Decoding ${name}…`);
  const buffer = await app.engine.ctx.decodeAudioData(bytes);
  setBusy(`Finding the beat in ${name}…`);
  await nextPaint();
  let est = null;
  try {
    est = estimateBpm(buffer);
  } catch (err) {
    console.error('[dj] BPM detection failed', err);
  }
  setBusy(`Drawing ${name}…`);
  await nextPaint();
  return {
    id: `file:${file.name}:${file.size}`,
    name,
    buffer,
    duration: buffer.duration,
    bpm: est?.bpm || 0,
    beatOffset: est?.offset || 0,
    peaks: computePeaksSafe(buffer),
  };
}

function computePeaksSafe(buffer) {
  try {
    return computePeaks(buffer);
  } catch (err) {
    console.error('[dj] computePeaks failed', err);
    return null;
  }
}

// ───────────── load menu, file input, drag & drop ─────────────

function openLoadMenu(id, anchor) {
  toggleSettings(false);
  closeRecMenu();
  app.menuDeck = id;
  const menu = $('loadMenu');
  menu.classList.toggle('tone-a', id === 'A');
  menu.classList.toggle('tone-b', id === 'B');
  $('loadMenuHead').textContent = `Load into deck ${id}`;
  const items = $('loadMenuItems');
  items.replaceChildren();
  const current = app.decks[id].track?.id;
  for (const def of DEMO_TRACKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (def.id === current ? ' current' : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = def.name;
    const small = document.createElement('small');
    small.textContent = `${def.bpm} BPM · demo`;
    b.append(small);
    b.addEventListener('click', () => {
      closeLoadMenu();
      loadTrack(id, { demo: def });
    });
    items.append(b);
  }
  menu.hidden = false;
  // open upwards from the button (the dock is at the bottom of the window)
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - mr.width - 8, Math.max(8, r.right - mr.width));
  const top = Math.max(8, r.top - mr.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  items.firstElementChild?.focus({ preventScroll: true });
}

function closeLoadMenu() {
  $('loadMenu').hidden = true;
}

function bindLoadUI() {
  $('loadMenuFile').addEventListener('click', () => {
    closeLoadMenu();
    $('fileInput').click();
  });
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadTrack(app.menuDeck, { file });
  });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('loadMenu');
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest?.('[data-load]')) closeLoadMenu();
    const recMenu = $('recMenu');
    if (!recMenu.hidden && !recMenu.contains(e.target) && !e.target.closest?.('#btnRec')) closeRecMenu();
    const panel = $('settings');
    if (!panel.hidden && !panel.contains(e.target) && e.target !== $('btnSettings')) toggleSettings(false);
  });
}

function bindDrop() {
  let hideTimer = 0;
  const halves = document.querySelectorAll('.drop-half');
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const hide = () => {
    document.body.classList.remove('dragging');
    halves.forEach((h) => h.classList.remove('over'));
  };
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser navigate to a dropped file
    if (app.mode === 'idle' || app.mode === 'starting') {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
    const side = e.clientX < window.innerWidth / 2 ? 'A' : 'B';
    halves.forEach((h) => h.classList.toggle('over', h.dataset.deck === side));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 180);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    clearTimeout(hideTimer);
    hide();
    if (app.mode === 'idle' || app.mode === 'starting') return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    loadTrack(e.clientX < window.innerWidth / 2 ? 'A' : 'B', { file });
  });
}

// ───────────── camera / hand pipeline ─────────────

const CAMERA_ERRORS = {
  'camera-denied': {
    chip: 'Camera blocked · mouse mode',
    text: 'Camera access was blocked, so the decks work with the mouse for now. To use your hands, allow the camera (camera icon in the address bar) and press Try again.',
  },
  'camera-missing': {
    chip: 'No camera · mouse mode',
    text: 'No camera was found, or another app is using it. The decks work with the mouse. Close other apps that use the camera and press Try again.',
  },
  'camera-insecure': {
    chip: 'Camera unavailable · mouse mode',
    text: 'The browser only allows the camera on a secure (https) page. The decks work with the mouse.',
  },
  'model-failed': {
    chip: 'Hand tracking unavailable · mouse mode',
    text: 'The hand-tracking model could not be loaded (it needs an internet connection). The decks work with the mouse; press Try again when you are online.',
  },
};

async function startCamera() {
  if (app.tracker || app.cameraStarting || !app.interaction) return;
  hideNotice();
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraFailed({ code: window.isSecureContext ? 'camera-missing' : 'camera-insecure' });
    return;
  }
  app.cameraStarting = true;
  syncSettingsUI();
  setStatus('busy', 'Starting camera…');
  const video = $('cam');
  const tracker = new HandTracker(video);
  try {
    await tracker.init((stage) => {
      if (stage === 'camera') {
        setStatus('busy', 'Waiting for camera permission…');
      } else if (stage === 'model') {
        document.body.classList.add('cam-on');
        setStatus('busy', 'Loading hand tracking…');
      } else if (stage === 'ready') {
        document.body.classList.add('cam-on');
        setStatus('ok', 'Hands ready');
      }
    });
  } catch (err) {
    app.cameraStarting = false;
    try { tracker.stop(); } catch { /* already stopped */ }
    cameraFailed(err);
    return;
  }
  app.cameraStarting = false;
  app.tracker = tracker;
  app.mode = 'camera';
  document.body.classList.add('cam-on');
  safe('tracker transform', () => tracker.updateTransform());
  app.lastFrameT = performance.now();
  app.tracking = true;
  app.lastHandCount = -1;
  tracker.start(onTrackerFrame);
  setStatus('ok', 'Hands ready · show your hands');
  notify('Hands ready. Raise your hands into the picture: open palm on a record, pinch a knob or fader, flick a finger at a pad.', 'ok', { timeout: 8000 });
  syncSettingsUI();
}

function cameraFailed(err) {
  console.warn('[dj] camera / hand tracking unavailable', err);
  document.body.classList.remove('cam-on');
  app.tracking = false;
  app.mode = 'mouse';
  const info = CAMERA_ERRORS[err?.code] || {
    chip: 'Camera unavailable · mouse mode',
    text: `The camera could not be started${err?.message ? ` (${err.message})` : ''}. The decks work with the mouse.`,
  };
  setStatus(err?.code === 'model-failed' ? 'warn' : 'error', info.chip);
  const retry = err?.code !== 'camera-insecure';
  notify(info.text, 'error', retry ? { action: 'Try again', onAction: startCamera } : {});
  syncSettingsUI();
}

function stopCamera() {
  if (!app.tracker) return;
  safe('tracker stop', () => app.tracker.stop());
  app.tracker = null;
  app.tracking = false;
  app.mode = 'mouse';
  document.body.classList.remove('cam-on');
  feedFrame(NO_HANDS, performance.now()); // release anything a hand was holding
  setStatus('mouse', 'Mouse mode · camera off');
  syncSettingsUI();
}

function onTrackerFrame(hands, t) {
  feedFrame(hands, t);
}

/** One hand frame: the same path for the tracker, the watchdog and __dj.feed. */
function feedFrame(hands, t) {
  if (!app.gestures) return;
  app.lastFrameT = t;
  app.handsFed = true;
  // while the guide covers the rig, hands must not operate it
  const input = guideOpen() ? NO_HANDS : hands;
  safe('gestures', () => app.gestures.process(input, t, window.innerWidth));
  safe('interaction', () => app.interaction.update(app.gestures.states, t));
}

// ───────────── render loop ─────────────

function renderLoop(t) {
  requestAnimationFrame(renderLoop);
  const now = performance.now();

  // watchdog: tracking stalled → feed an empty frame so held controls are released
  if (app.tracking && now - app.lastFrameT > WATCHDOG_MS) feedFrame(NO_HANDS, now);

  for (const id of DECK_IDS) renderDeck(id);

  if (app.spectrum) safe('spectrum', () => applyPulse(app.spectrum.draw()));

  if (app.handsFed && settings.skeleton) {
    const ht = app.tracking ? now : app.lastFrameT;
    safe('hand overlay', () => app.overlay.draw(app.gestures.states, ht));
  }

  if (now - app.lastStatusT > 250) {
    app.lastStatusT = now;
    updateHandStatus();
  }
  if (app.debugOn && now - app.lastDebugT > 120) {
    app.lastDebugT = now;
    safe('debug', updateDebug);
  }
}

function renderDeck(id) {
  const parts = app.controls[id];
  const v = app.view[id];
  const deck = app.decks[id];
  safe(`${id} platter`, () => parts.platter.update());
  if (v.waveView) safe(`${id} waveform`, () => v.waveView.draw());

  // volume meter: fast attack, smooth release
  safe(`${id} meter`, () => {
    const peak = Math.min(1, deck.level());
    const lv = Math.max(peak, app.levels[id] * 0.9);
    app.levels[id] = lv;
    parts.volume.setLevel(lv);
  });

  updateReadouts(id, deck, v);
}

function updateReadouts(id, deck, v) {
  const c = v.cache;
  const has = !!deck.track;
  const bpm = has && deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '—';
  const pct = (deck.rate - 1) * 100;
  const tempo = Math.abs(pct) < 0.05 ? '±0.0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
  const time = fmtTime(has ? deck.pos : 0);
  const remain = `-${fmtTime(has ? (deck.duration - deck.pos) / Math.max(0.01, Math.abs(deck.rate)) : 0)}`;
  if (bpm !== c.bpm) { c.bpm = bpm; v.bpm.textContent = bpm; }
  if (tempo !== c.tempo) { c.tempo = tempo; v.tempo.textContent = tempo; }
  if (time !== c.time) { c.time = time; v.time.textContent = time; }
  if (remain !== c.remain) { c.remain = remain; v.remain.textContent = remain; }
  const fill = has && deck.duration ? Math.round((deck.pos / deck.duration) * 2000) / 2000 : 0;
  if (fill !== c.fill) { c.fill = fill; v.ovFill.style.transform = `scaleX(${fill})`; }
}

function applyPulse(res) {
  const bass = res && Number.isFinite(res.bass) ? res.bass : 0;
  if (Math.abs(bass - app.pulse) < 0.03) return;
  app.pulse = bass;
  const p = bass.toFixed(2);
  $('fxCell').style.setProperty('--pulse', p);
  $('topbar').style.setProperty('--pulse', p);
}

function updateHandStatus() {
  if (!app.tracking || !app.gestures) return;
  let n = 0;
  for (const s of app.gestures.states) if (s.present) n++;
  if (n === app.lastHandCount) return;
  app.lastHandCount = n;
  setStatus('ok', n ? `Hands ready · ${n} hand${n > 1 ? 's' : ''}` : 'Hands ready · show your hands');
}

// ───────────── resize ─────────────

let resizeQueued = false;
function scheduleResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    onResize();
  });
}

function onResize() {
  if (!app.interaction) return;
  safe('measure', () => app.interaction.measure(window.innerWidth));
  for (const id of DECK_IDS) {
    const v = app.view[id];
    if (v?.waveView) safe(`${id} waveform resize`, () => v.waveView.resize());
    renderDeckOverview(id);
  }
  if (app.spectrum) safe('spectrum resize', () => app.spectrum.resize());
  safe('overlay resize', () => app.overlay.resize());
  if (app.tracker) safe('tracker transform', () => app.tracker.updateTransform());
  if (!$('loadMenu').hidden) closeLoadMenu();
  // the browser's "sharing this tab" bar changes the window size when a take starts
  if (!$('recMenu').hidden) closeRecMenu();
}

// ───────────── recording ─────────────

function initRecorder() {
  const rec = new SessionRecorder(app.engine);
  rec.onchange = syncRecUI;
  rec.onfinish = saveTake;
  app.recorder = rec;
  $('recScreen').hidden = !SessionRecorder.support().screen;
  syncRecUI();
}

function bindRecUI() {
  $('btnRec').addEventListener('click', () => {
    const rec = app.recorder;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.stop(); // saving happens in saveTake (onfinish), the same for every way a take ends
      return;
    }
    if (rec.state !== 'idle') return;
    if ($('recMenu').hidden) openRecMenu();
    else closeRecMenu();
  });
  // start straight from the click: getDisplayMedia needs the user gesture
  $('recScreen').addEventListener('click', () => startRecording('screen'));
  $('recAudio').addEventListener('click', () => startRecording('audio'));
}

function openRecMenu() {
  closeLoadMenu();
  toggleSettings(false);
  const btn = $('btnRec');
  const menu = $('recMenu');
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  // open downwards from the button, right-aligned with it
  const r = btn.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - mr.width - 8, Math.max(8, r.right - mr.width));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  const first = menu.querySelector('.menu-item:not([hidden])');
  first?.focus({ preventScroll: true });
}

function closeRecMenu() {
  $('recMenu').hidden = true;
  $('btnRec').setAttribute('aria-expanded', 'false');
}

function startRecording(mode) {
  closeRecMenu();
  const rec = app.recorder;
  if (!rec || rec.state !== 'idle') return;
  app.recHiddenStop = false;
  // no await before this call: it opens the browser's share dialog
  rec.start(mode).then(() => {
    toast('Recording · press REC to stop and save');
  }, (err) => {
    if (err?.code === 'cancelled') {
      // Share dialog closed, or the browser refused without showing one: not an error, but say
      // so, otherwise a click on "Screen + sound" can look like it did nothing at all.
      if (mode === 'screen') toast('Screen recording was not started · "Sound only" needs no permission');
      return;
    }
    console.warn('[dj] recording could not start', err);
    const text = err?.code === 'unsupported'
      ? (mode === 'screen'
        ? 'This browser cannot record the screen. "Sound only" still works, or use a current Chrome or Edge.'
        : 'This browser cannot record. Please use a current Chrome or Edge.')
      : `The recording could not start${err?.message ? ` (${err.message})` : ''}.`;
    notify(text, 'warn', { timeout: 9000 });
  });
}

function syncRecUI() {
  const btn = $('btnRec');
  const rec = app.recorder;
  const state = rec?.state || 'idle';
  const live = state === 'recording' || state === 'stopping';
  btn.disabled = !rec || !SessionRecorder.support().audio || state === 'starting' || state === 'stopping';
  btn.classList.toggle('is-recording', live);
  btn.setAttribute('aria-haspopup', live ? 'false' : 'menu');
  const label = live ? 'Stop recording and save' : 'Record your set';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  $('recTime').hidden = !live;
  if (live) {
    if (!app.recTimer) app.recTimer = setInterval(updateRecTime, 250);
    updateRecTime();
  } else {
    clearInterval(app.recTimer);
    app.recTimer = 0;
    app.recTimeText = '';
  }
}

function updateRecTime() {
  const text = fmtTime((app.recorder?.elapsedMs || 0) / 1000);
  if (text === app.recTimeText) return;
  app.recTimeText = text;
  $('recTime').textContent = text;
}

function takeFileName(res) {
  const d = new Date(Date.now() - (res.durationMs || 0)); // when the take started
  const p = (n) => String(n).padStart(2, '0');
  return `ozge-dj-set-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${res.ext}`;
}

/** Called exactly once per finished take, however it ended. */
function saveTake(res) {
  const hidden = app.recHiddenStop;
  app.recHiddenStop = false;
  if (!res) return;
  if (res.empty || !res.blob?.size) {
    toast('Nothing was recorded');
    return;
  }
  const name = takeFileName(res);
  try {
    const url = URL.createObjectURL(res.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000); // revoking at once can cancel the download
  } catch (err) {
    console.error('[dj] saving the recording failed', err);
    notify('The recording could not be saved.', 'warn', { timeout: 9000 });
    return;
  }
  const mb = res.blob.size / 1048576;
  const size = mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const what = res.mode === 'audio' ? 'sound recording' : 'video';
  const why = hidden ? 'Recording stopped when the tab was hidden. ' : '';
  notify(`${why}Saved your ${what} (${fmtTime(res.durationMs / 1000)}, ${size}) as "${name}" in your Downloads folder.`, 'ok', { timeout: 10000 });
}

// ───────────── debug ─────────────

function toggleDebug(on = !app.debugOn) {
  app.debugOn = on;
  $('debug').hidden = !on;
  if (on) safe('debug', updateDebug);
}

function holdingOf(i) {
  const it = app.interaction;
  const c = typeof it?.heldBy === 'function' ? it.heldBy(i) : null;
  return c ? (app.names.get(c) || c.kind || '?') : '—';
}

function updateDebug() {
  const lines = [];
  const fps = app.tracker && Number.isFinite(app.tracker.fps) ? app.tracker.fps.toFixed(1) : '—';
  lines.push(`mode ${app.mode}   tracker ${fps} fps   frame ${Math.round(performance.now() - app.lastFrameT)} ms ago`);
  if (app.gestures) {
    for (const s of app.gestures.states) {
      if (!s.present) {
        lines.push(`hand ${s.id}: —`);
        continue;
      }
      const ext = Array.isArray(s.ext) ? s.ext.map((e) => (e ? '1' : '0')).join('') : '?';
      const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
      lines.push(
        `hand ${s.id}${s.stale ? ' (stale)' : ''}: ${String(s.pose).padEnd(5)}` +
        ` pinch ${num(s.pinchRatio)}${s.pinch ? '*' : ' '} flex ${num(s.flex)} ext ${ext}` +
        ` speed ${num(s.palmSpeed, 1)} scale ${num(s.scale, 0)}px hold ${holdingOf(s.id)}`,
      );
    }
  }
  const held = app.all.filter((c) => c.captured).map((c) => app.names.get(c)).join(', ');
  lines.push(`captured: ${held || '—'}`);
  if (app.engine?.ctx) {
    const ctx = app.engine.ctx;
    const lat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    lines.push(`audio ${ctx.state} ${ctx.sampleRate} Hz  latency ${lat.toFixed(0)} ms`);
  }
  for (const id of DECK_IDS) {
    const d = app.decks?.[id];
    if (!d) continue;
    lines.push(`deck ${id}: ${d.playing ? 'play' : 'stop'} pos ${d.pos.toFixed(2)} vel ${d.vel.toFixed(2)} rate ${d.rate.toFixed(3)}${d.scratching ? ' scratch' : ''}${d.loop ? ' loop' : ''}`);
  }
  $('debug').textContent = lines.join('\n');
}

function exposeDebugHook() {
  Object.assign(window.__dj, {
    engine: app.engine,
    decks: app.decks,
    controls: app.controls,
    gestures: app.gestures,
    interaction: app.interaction,
    recorder: app.recorder,
    makeHand,
    feed(hands, t = performance.now()) {
      feedFrame(hands, t);
      return app.gestures.states;
    },
    loadTrack,
    startCamera,
    stopCamera,
    settings,
    app,
  });
}

// ───────────── boot ─────────────

function bindChrome() {
  $('btnStartCam').addEventListener('click', () => startApp(true));
  $('btnStartMouse').addEventListener('click', () => startApp(false));
  $('btnHelp').addEventListener('click', () => openGuide('help'));
  $('guideClose').addEventListener('click', closeGuide);
  $('noticeClose').addEventListener('click', hideNotice);
  $('noticeAction').addEventListener('click', () => {
    const fn = noticeAction;
    hideNotice();
    if (fn) fn();
  });

  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (e.key === 'Escape') {
      if (!$('recMenu').hidden) closeRecMenu();
      else if (!$('loadMenu').hidden) closeLoadMenu();
      else if (!$('settings').hidden) toggleSettings(false);
      else if (guideOpen() && $('guide').dataset.mode === 'help') closeGuide();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'd' || e.key === 'D') && app.mode !== 'idle') toggleDebug();
  });

  window.addEventListener('resize', scheduleResize);
  $('cam').addEventListener('loadedmetadata', () => {
    if (app.tracker) safe('tracker transform', () => app.tracker.updateTransform());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.interaction) safe('release', () => app.interaction.releaseAll());
    // a hidden tab records nothing worth keeping: end the take and save what we have
    if (document.hidden && app.recorder && app.recorder.state !== 'idle') {
      if (app.recorder.state === 'recording') app.recHiddenStop = true;
      safe('recorder stop', () => app.recorder.stop());
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!app.recorder || app.recorder.state === 'idle') return;
    e.preventDefault();
    e.returnValue = ''; // older Chrome needs this to show the "Leave site?" prompt
  });
  bindRecUI();
}

function boot() {
  bindChrome();
  bindSettings();
  bindLoadUI();
  bindDrop();
  syncSettingsUI();
  $('dim').style.opacity = String(settings.dim);

  window.__dj = { start: (withCamera = false) => startApp(withCamera) };
  window.__djReady = true;

  const cam = $('btnStartCam');
  const mouse = $('btnStartMouse');
  cam.disabled = false;
  mouse.disabled = false;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('guideFoot').textContent = 'The camera is only available on a secure (https) page; mouse mode works everywhere.';
  } else {
    $('guideFoot').textContent = 'The camera picture stays on this computer; nothing is uploaded.';
  }
  cam.focus({ preventScroll: true });
}

boot();
