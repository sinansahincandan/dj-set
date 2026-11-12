// Camera + MediaPipe HandLandmarker. The only module in js/hands that reads the clock:
// every frame is stamped with performance.now() and handed on.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_BUNDLE = `${MP_BASE}/vision_bundle.mjs`;
const MP_WASM = `${MP_BASE}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.fps = 0;
    this.running = false;
    this._onHands = null;
    this._vfcId = 0;
    this._rafId = 0;
    this._lastVideoTime = -1;
    this._lastTs = -1;
    this._lastFrameT = 0;
    this._errLogged = false;
    // mapping (client px): x = ox + (1 − lm.x)·dw, y = oy + lm.y·dh
    this._ox = 0; this._oy = 0; this._dw = 0; this._dh = 0;
    // reused output buffers: valid only during the onHands callback
    this._bufs = [[], []];
    for (const b of this._bufs) for (let i = 0; i < 21; i++) b.push({ x: 0, y: 0 });
    this._out = [];
    this._tick = this._tick.bind(this);
    this.updateTransform = this.updateTransform.bind(this);
  }

  async init(onStatus) {
    const status = (s) => { try { if (onStatus) onStatus(s); } catch (e) { /* ignore */ } };
    status('camera');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw fail('camera-missing', 'Camera access is not available in this browser.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        throw fail('camera-denied', 'Camera permission was denied.', e);
      }
      throw fail('camera-missing', 'No usable camera was found.', e);
    }

    const video = this.video;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.srcObject = this.stream;
    video.addEventListener('loadedmetadata', this.updateTransform);
    try {
      await video.play();
    } catch (e) {
      // autoplay can still resolve later; the stream is attached either way
    }
    if (video.readyState < 1) {
      await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    this.updateTransform();

    status('model');
    let vision;
    try {
      vision = await import(MP_BUNDLE);
    } catch (e) {
      throw fail('model-failed', 'Could not load the hand-tracking library.', e);
    }
    let fileset;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
    } catch (e) {
      throw fail('model-failed', 'Could not load the hand-tracking runtime.', e);
    }
    const make = (delegate) => vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await make('GPU');
    } catch (eGpu) {
      try {
        this.landmarker = await make('CPU');
      } catch (eCpu) {
        throw fail('model-failed', 'Could not start the hand-tracking model.', eCpu);
      }
    }
    // The first detection compiles the model's GPU programs and can block for a second or
    // more, so pay that cost here, while the status still says "loading", not mid-performance.
    try {
      if (video.readyState >= 2) {
        const ts = performance.now();
        this.landmarker.detectForVideo(video, ts);
        this._lastTs = ts;
      }
    } catch (e) {
      // a real failure will show up again in the frame loop, where it is logged
    }
    status('ready');
  }

  updateTransform() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const r = v.getBoundingClientRect();
    const W = r.width || window.innerWidth;
    const H = r.height || window.innerHeight;
    if (!vw || !vh) {
      this._ox = r.left; this._oy = r.top; this._dw = W; this._dh = H;
      return;
    }
    const s = Math.max(W / vw, H / vh);
    this._dw = vw * s;
    this._dh = vh * s;
    this._ox = r.left + (W - this._dw) / 2;
    this._oy = r.top + (H - this._dh) / 2;
  }

  start(onHands) {
    if (!this.landmarker) throw new Error('HandTracker.start() called before init()');
    this._onHands = onHands;
    if (this.running) return;
    this.running = true;
    this._lastVideoTime = -1;
    this._lastFrameT = 0;
    this._schedule();
  }

  stop() {
    this.running = false;
    const v = this.video;
    if (this._vfcId && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this._vfcId);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._vfcId = 0;
    this._rafId = 0;
    if (this.stream) {
      for (const tr of this.stream.getTracks()) tr.stop();
      this.stream = null;
    }
    v.removeEventListener('loadedmetadata', this.updateTransform);
    v.srcObject = null;
    this.fps = 0;
  }

  _schedule() {
    if (!this.running) return;
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this._vfcId = v.requestVideoFrameCallback(this._tick);
    } else {
      this._rafId = requestAnimationFrame(this._tick);
    }
  }

  _tick(_now, metadata) {
    if (!this.running) return;
    const v = this.video;
    try {
      // requestVideoFrameCallback only fires for new frames; the rAF fallback must skip repeats
      const frameTime = metadata ? metadata.mediaTime : v.currentTime;
      if (v.readyState >= 2 && (metadata || frameTime !== this._lastVideoTime)) {
        this._lastVideoTime = frameTime;
        this._detect();
      }
    } finally {
      this._schedule();
    }
  }

  _detect() {
    let now = performance.now();
    // detectForVideo needs strictly increasing timestamps
    const ts = now > this._lastTs ? now : this._lastTs + 0.001;
    this._lastTs = ts;
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, ts);
    } catch (e) {
      if (!this._errLogged) { console.warn('Hand detection failed:', e); this._errLogged = true; }
      return;
    }
    now = ts;

    if (this._lastFrameT) {
      const dt = now - this._lastFrameT;
      if (dt > 0) {
        const inst = 1000 / dt;
        this.fps = this.fps ? this.fps + (inst - this.fps) * 0.1 : inst;
      }
    }
    this._lastFrameT = now;

    const out = this._out;
    out.length = 0;
    const lms = (result && result.landmarks) || [];
    const n = Math.min(lms.length, 2);
    const ox = this._ox, oy = this._oy, dw = this._dw, dh = this._dh;
    for (let h = 0; h < n; h++) {
      const src = lms[h];
      if (!src || src.length < 21) continue;
      const buf = this._bufs[out.length];
      for (let i = 0; i < 21; i++) {
        buf[i].x = ox + (1 - src[i].x) * dw;
        buf[i].y = oy + src[i].y * dh;
      }
      out.push(buf);
    }
    if (this._onHands) this._onHands(out, now);
  }
}
