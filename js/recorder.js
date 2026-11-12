// OZGE DJ SET: session recorder (owner: SHELL).
// Records the performance as a video of this tab with the master output as sound, or the
// sound alone. Sound always comes from engine.getRecordStream() (the clean master output),
// never from the microphone or from tab/system audio capture.

import { flattenMp4Blob } from './mp4fix.js';

const VIDEO_TYPES = [
  // MP4 first: it is what phones and messaging apps play
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const AUDIO_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];
const VIDEO_BPS = 5_000_000; // 8 Mbit/s made a 76 s take 72 MB
const AUDIO_BPS = 192_000;
const TIMESLICE_MS = 1000;
/** A take shorter than this holds nothing worth saving. */
const MIN_TAKE_MS = 250;
/** Largest picture we record; the tab's aspect ratio is kept inside it. */
const MAX_W = 1920;
const MAX_H = 1080;
/** How long the browser gets to accept the picture size before we record without it. */
const PIN_TIMEOUT_MS = 2000;
/** How long rewriting the finished MP4 may take before the take is saved as recorded. */
const FLATTEN_TIMEOUT_MS = 30_000;

function recError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function pickType(list) {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const t of list) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* treat as unsupported */ }
  }
  return '';
}

/**
 * Even width and height no larger than MAX_W x MAX_H with the aspect ratio of `w` x `h`
 * (never enlarged), or null when the size is unknown.
 */
function pinnedSize(w, h) {
  if (!(w > 0 && h > 0)) return null;
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  const even = (x) => Math.max(2, Math.floor((x * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/**
 * Best effort: fix the captured picture to one even size, so it cannot change mid-take (e.g.
 * when the browser's "sharing this tab" bar appears) and no player meets an odd dimension.
 * Never throws; when the browser refuses or does not answer in time we record as it delivers.
 */
async function pinPictureSize(video) {
  try {
    const s = video.getSettings?.() || {};
    const size = pinnedSize(s.width, s.height);
    if (!size) return null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), PIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        video.applyConstraints({
          width: { exact: size.width },
          height: { exact: size.height },
          frameRate: 30,
          resizeMode: 'crop-and-scale',
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return size;
  } catch (err) {
    console.warn('[dj] could not fix the recording size; recording at the size the browser gives', err);
    return null;
  }
}

function extFor(mime, mode) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4')) return mode === 'audio' ? 'm4a' : 'mp4';
  if (m.includes('matroska')) return 'mkv';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

export class SessionRecorder {
  constructor(engine) {
    this.engine = engine;
    /** 'idle' | 'starting' | 'recording' | 'stopping' */
    this.state = 'idle';
    this.mode = null; // 'screen' | 'audio' while a take is running
    /** Called with the state after every change. */
    this.onchange = null;
    /** Called once per finished take with { blob, mime, ext, durationMs, mode }, however it ended. */
    this.onfinish = null;
    this._take = null;
  }

  /** What this browser can do: { audio, screen }. */
  static support() {
    const rec = typeof MediaRecorder !== 'undefined';
    return {
      audio: rec,
      screen: rec && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia,
    };
  }

  get elapsedMs() {
    const take = this._take;
    if (!take || !take.t0) return 0;
    return (take.t1 || performance.now()) - take.t0;
  }

  get recording() {
    return this.state === 'recording';
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    try {
      this.onchange?.(state);
    } catch (err) {
      console.error('[dj] recorder onchange failed', err);
    }
  }

  /**
   * Start a take. For 'screen' the share dialog opens synchronously inside this call, so it
   * must be called directly from a click handler (nothing may be awaited before it).
   * Rejects with err.code 'cancelled' | 'unsupported' | 'failed'.
   */
  async start(mode = 'screen') {
    if (this.state !== 'idle') throw recError('failed', 'A recording is already running.');
    if (mode !== 'screen' && mode !== 'audio') throw recError('failed', `Unknown recording mode "${mode}".`);
    const support = SessionRecorder.support();
    if (!support.audio) throw recError('unsupported', 'This browser cannot record.');
    if (mode === 'screen' && !support.screen) throw recError('unsupported', 'This browser cannot record the screen.');

    let audioSrc;
    try {
      audioSrc = this.engine?.getRecordStream?.().getAudioTracks()[0];
    } catch (err) {
      throw recError('failed', 'The sound output is not available.', err);
    }
    if (!audioSrc) throw recError('failed', 'The sound output is not available.');

    const take = {
      mode,
      tracks: [], // our own tracks, all stopped at the end (never the engine's own track)
      chunks: [],
      bytes: 0,
      rec: null,
      mime: '',
      t0: 0,
      t1: 0,
      abort: false,
      finished: false,
      size: null, // { width, height } the picture was fixed to, if the browser accepted it
      done: null,
      resolve: null,
    };
    take.done = new Promise((resolve) => { take.resolve = resolve; });
    this._take = take;
    this.mode = mode;
    this._set('starting');

    let video = null;
    try {
      if (mode === 'screen') {
        // first await of this function: still inside the user gesture
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
          systemAudio: 'exclude',
        });
        for (const t of display.getTracks()) take.tracks.push(t);
        // never record anything but the picture from the share
        for (const t of display.getAudioTracks()) t.stop();
        video = display.getVideoTracks()[0];
        if (!video) throw recError('failed', 'The browser shared no picture.');
        try { video.contentHint = 'motion'; } catch { /* optional */ }
        take.size = await pinPictureSize(video); // never throws
        if (take.abort || video.readyState === 'ended') throw recError('cancelled', 'Recording was stopped before it started.');
      }

      // a clone, so stopping it never silences the engine's own record stream
      const audio = audioSrc.clone();
      take.tracks.push(audio);
      const stream = new MediaStream(video ? [video, audio] : [audio]);

      const wanted = pickType(video ? VIDEO_TYPES : AUDIO_TYPES);
      const opts = { audioBitsPerSecond: AUDIO_BPS };
      if (video) opts.videoBitsPerSecond = VIDEO_BPS;
      let rec;
      try {
        rec = new MediaRecorder(stream, wanted ? { ...opts, mimeType: wanted } : opts);
      } catch (err) {
        // the mime type passed isTypeSupported but the constructor refused it: let the browser choose
        rec = new MediaRecorder(stream, opts);
      }
      take.rec = rec;
      take.mime = wanted;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          take.chunks.push(e.data);
          take.bytes += e.data.size;
        }
      };
      rec.onerror = (e) => {
        console.error('[dj] MediaRecorder error', e.error || e);
        // the recorder stops itself after an error; make sure we finish even if it does not
        setTimeout(() => this._finish(take), 1500);
      };
      rec.onstop = () => this._finish(take);
      // the browser's own "Stop sharing" button ends the take like REC does
      if (video) video.addEventListener('ended', () => { if (this._take === take) this.stop(); }, { once: true });

      rec.start(TIMESLICE_MS);
      take.mime = rec.mimeType || wanted;
      take.t0 = performance.now();
    } catch (err) {
      for (const t of take.tracks) { try { t.stop(); } catch { /* already stopped */ } }
      take.finished = true;
      take.resolve(null);
      if (this._take === take) {
        this._take = null;
        this.mode = null;
        this._set('idle');
      }
      if (err?.code) throw err;
      const name = err?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        // the share dialog was closed (or the share was refused): not an error to shout about
        throw recError('cancelled', 'Screen sharing was cancelled.', err);
      }
      if (name === 'NotSupportedError' || name === 'TypeError') {
        throw recError('unsupported', 'This browser cannot record this way.', err);
      }
      throw recError('failed', err?.message || 'The recording could not start.', err);
    }

    this._set('recording');
    if (take.abort) this.stop(); // stop() came in while we were starting
    return { mode, mime: take.mime };
  }

  /**
   * Stop the running take. Resolves with { blob, mime, ext, durationMs, mode }, or null when
   * nothing was recording. Safe to call any number of times: every call gets the same take.
   */
  stop() {
    const take = this._take;
    if (!take) return Promise.resolve(null);
    if (this.state === 'starting') {
      take.abort = true; // start() cleans up once the share dialog answers
      return take.done;
    }
    if (this.state === 'recording') {
      this._set('stopping');
      take.t1 = performance.now();
      const rec = take.rec;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop(); // → final dataavailable → onstop → _finish
        } catch {
          this._finish(take);
        }
      } else {
        this._finish(take);
      }
      // never hang if the browser drops the stop event
      setTimeout(() => this._finish(take), 4000);
    }
    return take.done;
  }

  _finish(take) {
    if (take.finished) return;
    take.finished = true;
    if (!take.t1) take.t1 = performance.now();
    for (const t of take.tracks) { try { t.stop(); } catch { /* already stopped */ } }
    if (take.rec) {
      take.rec.ondataavailable = null;
      take.rec.onstop = null;
      take.rec.onerror = null;
    }
    const mime = take.mime || take.chunks[0]?.type || (take.mode === 'audio' ? 'audio/webm' : 'video/webm');
    const type = mime.split(';')[0];
    const raw = new Blob(take.chunks, { type });
    take.chunks = [];
    const durationMs = Math.max(0, take.t1 - take.t0);
    // the take stays 'stopping' (REC disabled, stop() returns the same promise) until it is handed out
    if (this._take === take) this._set('stopping');

    let handed = false;
    const handOut = (blob) => {
      if (handed) return;
      handed = true;
      const result = {
        blob,
        mime,
        ext: extFor(mime, take.mode),
        durationMs,
        mode: take.mode,
        empty: blob.size === 0 || durationMs < MIN_TAKE_MS,
      };
      if (this._take === take) {
        this._take = null;
        this.mode = null;
        this._set('idle');
      }
      take.resolve(result);
      try {
        this.onfinish?.(result);
      } catch (err) {
        console.error('[dj] recorder onfinish failed', err);
      }
    };

    if (raw.size && type.toLowerCase().includes('mp4')) {
      // Chrome writes fragmented MP4, which messaging apps refuse: rewrite it as an ordinary MP4
      // (no re-encoding; the original is kept when anything about it is unexpected)
      const timer = setTimeout(() => {
        console.warn('[dj] rewriting the recording took too long; saving it as recorded');
        handOut(raw);
      }, FLATTEN_TIMEOUT_MS);
      flattenMp4Blob(raw)
        .then((blob) => (blob && blob.size ? blob : raw), () => raw)
        .then((blob) => {
          clearTimeout(timer);
          handOut(blob);
        });
    } else {
      handOut(raw);
    }
  }
}
