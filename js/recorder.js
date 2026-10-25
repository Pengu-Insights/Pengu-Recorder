/* ============================================================
   recorder.js — the recording engine.

   Two pipelines, picked by mode:

   1. Screen only / camera only — the source track goes straight into
      MediaRecorder. No canvas, so no re-encode of the screen, no text
      blurring, and far less CPU:
        getDisplayMedia() (or camera) ---+
        mic + system audio -> AudioContext mix -+-> MediaRecorder -> mp4 / webm

   2. Screen + camera, and Studio (screen and camera side by side on a
      backdrop, see studio.js) — compositing is unavoidable, so we draw
      onto a hidden canvas at 30 fps and record its captureStream. The draw
      clock lives in a Web Worker because timers in a hidden tab get
      throttled to ~1 Hz, and a screen recorder's own tab is hidden most of
      the time.

   The container follows `format`: MP4 (H.264 + AAC) where the browser can
   encode it (Chrome and Edge 126+, Safari), WebM otherwise.

   Extra versions: one take can also be recorded in other shapes at the same
   time (a Reel next to the YouTube video, the bare screen, the bare camera).
   Each extra is its own MediaRecorder fed from the same sources and the same
   audio mix, so they stay in sync; the bare screen and camera skip the
   canvas entirely. See `extraSpecs` and the "extra versions" section.

   Chunks are flushed to IndexedDB while recording (see db.js `recovery`),
   which keeps long takes out of RAM and survives a crash or a closed tab.
   ============================================================ */

/* Worker source: an unthrottled clock. Inline so the app keeps its
   no-build-step, no-extra-files property. */
const CLOCK_WORKER_SRC = `
  let timer = null;
  onmessage = (e) => {
    if (e.data && e.data.type === 'start') {
      clearInterval(timer);
      timer = setInterval(() => postMessage('tick'), e.data.interval);
    } else {
      clearInterval(timer);
      timer = null;
    }
  };
`;

class PenguRecorder {
  constructor() {
    this.mode = null;              // 'screen-cam' | 'studio' | 'screen' | 'camera'
    this.screenStream = null;
    this.cameraStream = null;
    this.micStream = null;

    this.audioCtx = null;
    this.micGain = null;
    this.audioDest = null;
    this.hiFiAudio = false;        // when true: no AEC/NS/AGC on the mic
    this.deviceIds = { camera: null, mic: null };

    this.canvas = null;
    this.ctx = null;
    this.clock = null;             // Worker or interval id
    this.clockIsWorker = false;
    /* A video file standing in for the shared screen: play a take you already
       have and talk over it, camera and template included. */
    this.fileVideo = null;
    this.fileUrl = null;
    this.fileName = '';
    this.fileSource = null;        // MediaElementAudioSourceNode, built once per element

    this.screenVideo = null;       // hidden draw sources
    this.camVideo = null;

    this.recordedStream = null;
    this.mediaRecorder = null;
    this.mimeType = '';
    this.format = PenguRecorder.formatSupported('mp4') ? 'mp4' : 'webm';
    this.quality = 'auto';         // 'auto' | '2160p' | '1440p' | '1080p' | '720p'

    /* Studio layout options (see studio.js) and the backdrop, rendered once
       at the output size when the take starts. */
    this.studio = { ...PenguStudio.DEFAULTS, backgroundId: PenguBackgrounds.DEFAULT_ID };
    this.studioBackground = null;

    /* Extra versions recorded alongside the main one, set by the caller
       before start(): [{ id, label, kind: 'studio' | 'screen' | 'camera', opts }]. */
    this.extraSpecs = [];
    this.extras = [];              // live outputs built from extraSpecs

    this.state = 'idle';           // 'idle' | 'recording' | 'paused'
    this.startedAt = 0;
    this.elapsedBeforePause = 0;

    this.muted = false;

    /* Camera bubble geometry.
       x / y  : centre, as a fraction of the CAPTURED SURFACE (not of the
                browser viewport — see getBubbleSpace()).
       radius : fraction of the captured surface height. */
    this.bubble = { x: 0.13, y: 0.80, radius: 0.13 };

    /* Region crop: how much of each edge of the captured frame to throw away,
       as a fraction of the source. Used to keep the Windows taskbar, the
       browser tab strip, or any other edge furniture out of the video. */
    this.crop = { top: 0, right: 0, bottom: 0, left: 0 };

    // Crash-recovery bookkeeping.
    this.sessionId = null;
    this.pending = [];             // chunks not yet written to IndexedDB
    this.flushSeq = 0;
    this.flushTimer = null;
    this.flushChain = Promise.resolve();

    // Called when the user ends screen sharing via the browser's own UI.
    this.onAutoStop = null;
  }

  static get RADII() {
    return { small: 0.09, medium: 0.13, large: 0.18 };
  }

  /* ---------- capability helpers ---------- */

  /* Most specific first. avc1.640033 is H.264 High at level 5.1, enough for
     4K at 30 fps; the shorter strings catch browsers that reject a profile.
     There is deliberately no bare 'video/mp4': Chromium builds without an
     H.264 encoder accept it and write VP9 into the MP4, which QuickTime,
     iPhones and many editors refuse. MP4 here always means H.264.
     AAC first; plain Chromium has no AAC encoder, so Opus audio follows. */
  static get MIME_CANDIDATES() {
    return {
      mp4: [
        'video/mp4;codecs=avc1.640033,mp4a.40.2',
        'video/mp4;codecs=avc1.4d0033,mp4a.40.2',
        'video/mp4;codecs=avc1.42e01f,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc3,mp4a.40.2',
        'video/mp4;codecs=avc1.640033,opus',
        'video/mp4;codecs=avc1,opus',
        'video/mp4;codecs=avc1',
      ],
      webm: [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ],
    };
  }

  /** The best MIME type this browser can record for `format`, or ''. */
  static mimeFor(format) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const list = PenguRecorder.MIME_CANDIDATES[format] || [];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  static formatSupported(format) {
    return !!PenguRecorder.mimeFor(format);
  }

  /** `format` when possible, WebM as the fallback, '' for the browser default. */
  static pickMimeType(format = 'webm') {
    return PenguRecorder.mimeFor(format) || PenguRecorder.mimeFor('webm') || '';
  }

  /** 'mp4' | 'webm' for a MIME type or a blob type. */
  static formatOf(type) {
    return /mp4/i.test(type || '') ? 'mp4' : 'webm';
  }

  /** Bitrate scaled to the frame size: 5 Mbps is wasteful at 720p and thin at 4K. */
  static bitrateFor(width, height, fps = 30) {
    const bits = Math.round((width || 1280) * (height || 720) * fps * 0.15);
    return Math.min(40_000_000, Math.max(2_500_000, bits));
  }

  /* Studio output size: 16:9 for a YouTube video, 9:16 for a Short or a Reel,
     whatever the shape of the shared surface, because the backdrop is what
     fills the frame. 'auto' goes up to 1440p when the screen is big enough
     to fill it, and stays at 1080 x 1920 for Shorts, YouTube's own target. */
  static studioSize(quality, sourceHeight, aspect = 'landscape') {
    const sizes = {
      '2160p': { w: 3840, h: 2160 },
      '1440p': { w: 2560, h: 1440 },
      '1080p': { w: 1920, h: 1080 },
      '720p': { w: 1280, h: 720 },
    };
    const vertical = aspect === 'vertical' || aspect === 'reel';
    let size = sizes[quality];
    if (!size) size = !vertical && (sourceHeight || 0) >= 1400 ? sizes['1440p'] : sizes['1080p'];
    return vertical ? { w: size.h, h: size.w } : size;
  }

  static micConstraints(deviceId, hiFi) {
    const audio = hiFi
      // System audio picked up through the mix reads as "echo" to the AEC,
      // which then ducks it. Off for music/video demos.
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return audio;
  }

  /** { cameras, mics } — labels are only populated once permission is granted. */
  static async listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        cameras: devices.filter((d) => d.kind === 'videoinput'),
        mics: devices.filter((d) => d.kind === 'audioinput'),
      };
    } catch {
      return { cameras: [], mics: [] };
    }
  }

  /* ---------- setup-phase acquisition (camera + mic for preview) ---------- */
  async acquireSetupStreams(mode, opts = {}) {
    this.mode = mode;
    if (opts.cameraId !== undefined) this.deviceIds.camera = opts.cameraId || null;
    if (opts.micId !== undefined) this.deviceIds.mic = opts.micId || null;
    if (opts.hiFiAudio !== undefined) this.hiFiAudio = !!opts.hiFiAudio;

    if (mode !== 'screen') {
      // 1080p: the camera fills a large part of the frame in camera-only and
      // Studio takes. Cameras that cannot do it hand over their best.
      const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
      if (this.deviceIds.camera) video.deviceId = { exact: this.deviceIds.camera };
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err) {
        this.cameraStream = null;
        // The caller decides whether this is fatal (camera-only mode) or not.
      }
    }

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: PenguRecorder.micConstraints(this.deviceIds.mic, this.hiFiAudio),
        video: false,
      });
    } catch (err) {
      this.micStream = null;
    }

    return { camera: !!this.cameraStream, mic: !!this.micStream };
  }

  /** True when the take is built over a video file instead of a live screen. */
  get hasFileSource() {
    return !!this.fileVideo;
  }

  /**
   * Use `file` as the screen source. Resolves { width, height, duration }.
   * The element is kept muted here: the setup preview should be silent, and
   * the sound is routed through the audio graph once recording starts.
   */
  setVideoFile(file) {
    this.clearVideoFile();
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const fail = () => {
        URL.revokeObjectURL(url);
        reject(new Error('this file cannot be played here'));
      };
      v.onerror = fail;
      v.onloadedmetadata = () => {
        if (!v.videoWidth) { fail(); return; }
        this.fileVideo = v;
        this.fileUrl = url;
        this.fileName = file.name || '';
        resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
      };
    });
  }

  clearVideoFile() {
    if (this.fileSource) { try { this.fileSource.disconnect(); } catch { /* already gone */ } }
    this.fileSource = null;
    if (this.fileVideo) { this.fileVideo.pause(); this.fileVideo.removeAttribute('src'); }
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileVideo = null;
    this.fileUrl = null;
    this.fileName = '';
  }

  /* ---------- screen acquisition (must be called from a user gesture) ---------- */
  async acquireScreen() {
    // Capture size follows the setup-screen quality picker; 'auto' lets the
    // browser hand over the surface at its native size.
    const video = { frameRate: { ideal: 30 }, cursor: 'always' };
    const sizes = { '2160p': [3840, 2160], '1440p': [2560, 1440], '1080p': [1920, 1080], '720p': [1280, 720] };
    if (sizes[this.quality]) {
      video.width = { ideal: sizes[this.quality][0] };
      video.height = { ideal: sizes[this.quality][1] };
    }
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: true,
      systemAudio: 'include',       // offer "share system audio" where supported
      selfBrowserSurface: 'exclude', // stops the user recording this very tab (mirror loop)
      surfaceSwitching: 'include',   // let them switch the shared window mid-take
    });

    // If the user stops sharing via the browser UI, finish gracefully.
    const track = this.screenStream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (this.state !== 'idle' && typeof this.onAutoStop === 'function') {
          this.onAutoStop();
        }
      });
    }
    return this.screenStream;
  }

  /** True when any edge is being cropped away. */
  get hasCrop() {
    const c = this.crop;
    const sum = ['top', 'right', 'bottom', 'left']
      .reduce((acc, k) => acc + (Number.isFinite(c[k]) ? c[k] : 0), 0);
    return sum > 0.001;
  }

  /** Visible fraction of the source frame left after cropping. */
  get cropScale() {
    return {
      w: Math.max(0.05, 1 - this.crop.left - this.crop.right),
      h: Math.max(0.05, 1 - this.crop.top - this.crop.bottom),
    };
  }

  /* True when the take has to be composited. Three reasons: the Studio
     layout, a camera bubble to bake in, or a crop to apply — cropping means
     re-encoding through the canvas, which the uncropped screen path
     deliberately avoids. */
  get usesCanvas() {
    if (this.hasFileSource) return true;   // a file always has to be composited
    if (this.mode === 'studio') return true;
    if (this.mode === 'screen-cam' && this.cameraStream) return true;
    return this.mode !== 'camera' && this.hasCrop;
  }

  /* ----------------------------------------------------------
     Bubble coordinate space.

     The DOM bubble floats over the browser window, but the recording covers
     the shared surface — a whole monitor, a window, or this tab. Storing the
     bubble position as a fraction of the *viewport* while drawing it as a
     fraction of the *canvas* is what made it land somewhere else in the video.
     This returns the space both sides must agree on.
     ---------------------------------------------------------- */
  getBubbleSpace() {
    const surface = this._trackSettings(this.screenStream).displaySurface;
    if (surface === 'monitor') {
      return { kind: 'monitor', w: window.screen.width, h: window.screen.height };
    }
    if (surface === 'window') {
      return { kind: 'window', w: window.outerWidth, h: window.outerHeight };
    }
    // 'browser' (a tab) — the captured frame is exactly this viewport.
    return { kind: 'browser', w: window.innerWidth, h: window.innerHeight };
  }

  /* ---------- start recording ---------- */
  async start() {
    this._setupAudio();

    let vw;
    let vh;
    if (this.usesCanvas) {
      this._setupCanvas();
      if (this.mode === 'studio') {
        this.studioBackground = await PenguBackgrounds
          .render(this.studio.backgroundId, this.canvas.width, this.canvas.height)
          .catch(() => null);
      }
      this.recordedStream = this.canvas.captureStream(30);
      vw = this.canvas.width;
      vh = this.canvas.height;
    } else {
      // Direct path: reuse the source track untouched.
      const source = this.mode === 'camera' ? this.cameraStream : this.screenStream;
      const track = source.getVideoTracks()[0];
      const s = track.getSettings();
      vw = s.width || 1280;
      vh = s.height || 720;
      this.recordedStream = new MediaStream([track]);
    }

    const audioTracks = this.audioDest ? this.audioDest.stream.getAudioTracks() : [];
    for (const t of audioTracks) this.recordedStream.addTrack(t);

    this._createRecorder(vw, vh);

    this.pending = [];
    this.flushSeq = 0;
    this.sessionId = PenguRecorder.newSessionId();
    await PenguDB.startSession(this.sessionId, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.mode,
      mimeType: this.mimeType,
      durationMs: 0,
    }).catch(() => {});

    this.extras = [];
    for (const spec of this.extraSpecs) {
      const out = await this._buildExtra(spec, audioTracks);
      if (out) this.extras.push(out);
    }
    await Promise.all(this.extras.map((out) => this._armExtra(out)));

    // Start everything back to back, so every version begins on the same frame.
    this.mediaRecorder.start(1000); // gather chunks every second
    for (const out of this.extras) out.mediaRecorder.start(1000);

    this.elapsedBeforePause = 0;
    this.startedAt = Date.now();
    this.state = 'recording';

    if (this.hasFileSource) {
      this.fileVideo.currentTime = 0;
      this.fileVideo.onended = () => {
        if (this.state !== 'idle' && typeof this.onAutoStop === 'function') this.onAutoStop();
      };
      this.fileVideo.play().catch(() => {});
    }

    if (this.usesCanvas || this.extras.some((o) => o.ctx)) this._startClock();
    this.flushTimer = setInterval(() => {
      this._flush();
      this.extras.forEach((o) => this._flushExtra(o));
    }, 5000);
  }

  static newSessionId() {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /* ---------- extra versions ---------- */

  /* Build the video side of one extra version. Resolves null when the take
     lacks what it needs (no camera for a camera version, say). */
  async _buildExtra(spec, audioTracks) {
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const out = { spec, canvas: null, ctx: null, background: null, pending: [], flushSeq: 0, flushChain: Promise.resolve() };
    let track = null;

    if (spec.kind === 'camera') {
      if (!this.cameraStream) return null;
      track = this.cameraStream.getVideoTracks()[0];
    } else if (spec.kind === 'screen') {
      if (!this.screenStream) return null;
      if (this.hasCrop) {
        // A crop has to be applied on a canvas; without one the source track
        // goes straight in, untouched.
        const s = this._trackSettings(this.screenStream);
        out.canvas = document.createElement('canvas');
        out.canvas.width = even((s.width || 1920) * this.cropScale.w);
        out.canvas.height = even((s.height || 1080) * this.cropScale.h);
      } else {
        track = this.screenStream.getVideoTracks()[0];
      }
    } else {
      const s = this._trackSettings(this.screenStream);
      const size = PenguRecorder.studioSize(this.quality, s.height, spec.opts.aspect);
      out.canvas = document.createElement('canvas');
      out.canvas.width = size.w;
      out.canvas.height = size.h;
      out.background = await PenguBackgrounds
        .render(spec.opts.backgroundId, size.w, size.h)
        .catch(() => null);
    }

    if (out.canvas) {
      out.ctx = out.canvas.getContext('2d');
      track = out.canvas.captureStream(30).getVideoTracks()[0];
    }
    if (!track) return null;
    const settings = track.getSettings ? track.getSettings() : {};
    out.width = (out.canvas && out.canvas.width) || settings.width || 1280;
    out.height = (out.canvas && out.canvas.height) || settings.height || 720;
    out.stream = new MediaStream([track, ...audioTracks]);
    return out;
  }

  /* Fresh MediaRecorder and recovery session for an extra. The session points
     at the main one, so a crash brings every version back together. */
  async _armExtra(out) {
    out.mimeType = PenguRecorder.pickMimeType(this.format);
    const options = { videoBitsPerSecond: PenguRecorder.bitrateFor(out.width, out.height) };
    if (out.mimeType) options.mimeType = out.mimeType;
    out.mediaRecorder = new MediaRecorder(out.stream, options);
    out.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) out.pending.push(e.data);
    };
    out.pending = [];
    out.flushSeq = 0;
    out.sessionId = PenguRecorder.newSessionId();
    await PenguDB.startSession(out.sessionId, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.mode,
      mimeType: out.mimeType,
      durationMs: 0,
      extraOf: this.sessionId,
      label: out.spec.label,
    }).catch(() => {});
  }

  _flushExtra(out) {
    if (!out.sessionId || !out.pending.length) return out.flushChain;
    const parts = out.pending;
    out.pending = [];
    const seq = out.flushSeq++;
    const blob = new Blob(parts, { type: (out.mimeType || 'video/webm').split(';')[0] });
    out.flushChain = out.flushChain.then(async () => {
      try {
        await PenguDB.appendChunk(out.sessionId, seq, blob);
        await PenguDB.touchSession(out.sessionId, { updatedAt: Date.now(), durationMs: this.getElapsedMs() });
      } catch {
        out.flushSeq -= 1;
        out.pending.unshift(blob);
      }
    });
    return out.flushChain;
  }

  _drawExtras() {
    for (const out of this.extras) {
      if (!out.ctx) continue;
      const W = out.canvas.width;
      const H = out.canvas.height;
      if (out.spec.kind === 'studio') {
        PenguStudio.draw(out.ctx, W, H, {
          background: out.background,
          screen: this.screenVideo,
          crop: this.crop,
          camera: this.camVideo,
          opts: out.spec.opts,
        });
      } else {
        out.ctx.fillStyle = '#000';
        out.ctx.fillRect(0, 0, W, H);
        const ctx = this.ctx;
        this.ctx = out.ctx; // _drawCropped draws on this.ctx
        this._drawCropped(this.screenVideo, W, H);
        this.ctx = ctx;
      }
    }
  }

  _stopRecorder(mr) {
    return new Promise((resolve) => {
      if (!mr || mr.state === 'inactive') { resolve(); return; }
      mr.onstop = resolve;
      mr.stop();
    });
  }

  /** Stop every extra and resolve [{ id, label, blob, sessionId }]. */
  async _finishExtras() {
    const results = [];
    for (const out of this.extras) {
      await this._stopRecorder(out.mediaRecorder);
      await this._flushExtra(out);
      await out.flushChain;
      let parts = [];
      try {
        parts = await PenguDB.getChunks(out.sessionId);
      } catch {
        parts = [];
      }
      const type = (out.mimeType || 'video/webm').split(';')[0];
      const blob = new Blob([...parts, ...out.pending], { type });
      if (blob.size) results.push({ id: out.spec.id, label: out.spec.label, blob, sessionId: out.sessionId });
    }
    return results;
  }

  _createRecorder(width, height) {
    this.mimeType = PenguRecorder.pickMimeType(this.format);
    const options = { videoBitsPerSecond: PenguRecorder.bitrateFor(width, height) };
    if (this.mimeType) options.mimeType = this.mimeType;
    this.mediaRecorder = new MediaRecorder(this.recordedStream, options);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.pending.push(e.data);
    };
  }

  /* ---------- draw clock (worker-backed, survives a hidden tab) ---------- */

  _startClock() {
    const interval = 1000 / 30;
    try {
      const url = URL.createObjectURL(new Blob([CLOCK_WORKER_SRC], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => this._drawFrame();
      worker.postMessage({ type: 'start', interval });
      this.clock = worker;
      this.clockIsWorker = true;
    } catch {
      // No workers (very old browser): fall back, accepting background throttling.
      this.clock = setInterval(() => this._drawFrame(), interval);
      this.clockIsWorker = false;
    }
  }

  _stopClock() {
    if (!this.clock) return;
    if (this.clockIsWorker) {
      this.clock.postMessage({ type: 'stop' });
      this.clock.terminate();
    } else {
      clearInterval(this.clock);
    }
    this.clock = null;
  }

  /* ---------- chunk flushing / crash recovery ---------- */

  async _flush() {
    if (!this.sessionId || !this.pending.length) return;
    const parts = this.pending;
    this.pending = [];
    const seq = this.flushSeq++;
    const blob = new Blob(parts, { type: (this.mimeType || 'video/webm').split(';')[0] });

    this.flushChain = this.flushChain.then(async () => {
      try {
        await PenguDB.appendChunk(this.sessionId, seq, blob);
        await PenguDB.touchSession(this.sessionId, {
          updatedAt: Date.now(),
          durationMs: this.getElapsedMs(),
        });
      } catch {
        // Disk write failed (quota?). Keep the data in RAM rather than losing it.
        this.flushSeq -= 1;
        this.pending.unshift(blob);
      }
    });
    return this.flushChain;
  }

  _setupCanvas() {
    this.canvas = document.createElement('canvas'); // intentionally never appended: hidden

    /* The screen slot is fed by the live capture, by a video file, or by
       nothing at all (the Studio "just you" template). */
    if (this.hasFileSource) {
      this.screenVideo = this.fileVideo;
    } else {
      this.screenVideo = this.screenStream ? this._makeSourceVideo(this.screenStream) : null;
    }
    const s = this.hasFileSource
      ? { width: this.fileVideo.videoWidth, height: this.fileVideo.videoHeight }
      : this._trackSettings(this.screenStream);
    const scale = this.cropScale;
    // Even dimensions: odd ones make some encoders pad or refuse the frame.
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    if (this.mode === 'studio') {
      const size = PenguRecorder.studioSize(this.quality, s.height, this.studio.aspect);
      this.canvas.width = size.w;
      this.canvas.height = size.h;
    } else {
      this.canvas.width = even((s.width || 1920) * scale.w);
      this.canvas.height = even((s.height || 1080) * scale.h);
    }
    if (this.cameraStream) this.camVideo = this._makeSourceVideo(this.cameraStream);

    this.ctx = this.canvas.getContext('2d');
  }

  _makeSourceVideo(stream) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    v.play().catch(() => {});
    return v;
  }

  _trackSettings(stream) {
    try {
      const track = stream && stream.getVideoTracks()[0];
      return track ? track.getSettings() : {};
    } catch {
      return {};
    }
  }

  _setupAudio() {
    const hasMic = !!(this.micStream && this.micStream.getAudioTracks().length);
    const hasSys = !!(this.screenStream && this.screenStream.getAudioTracks().length);
    const hasFile = this.hasFileSource;
    if (!hasMic && !hasSys && !hasFile) { this.audioDest = null; return; }

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx.resume().catch(() => {});
    this.audioDest = this.audioCtx.createMediaStreamDestination();

    if (hasMic) {
      const src = this.audioCtx.createMediaStreamSource(this.micStream);
      this.micGain = this.audioCtx.createGain();
      this.micGain.gain.value = this.muted ? 0 : 1;
      src.connect(this.micGain).connect(this.audioDest);
    }
    if (hasSys) {
      const src = this.audioCtx.createMediaStreamSource(this.screenStream);
      src.connect(this.audioDest);
    }
    if (hasFile) {
      /* Routing an element through the graph takes its sound off the speakers,
         so connect it to both: the recording and the room. An element can only
         ever have one source node, hence the cache. */
      this.fileVideo.muted = false;
      this.fileSource = this.fileSource || this.audioCtx.createMediaElementSource(this.fileVideo);
      this.fileSource.connect(this.audioDest);
      this.fileSource.connect(this.audioCtx.destination);
    }
  }

  /* ---------- per-frame compositing (screen + camera, Studio, crops) ---------- */
  _drawFrame() {
    this._drawExtras();
    const { ctx, canvas } = this;
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    if (this.mode === 'studio') {
      PenguStudio.draw(ctx, W, H, {
        background: this.studioBackground,
        screen: this.screenVideo,
        crop: this.crop,
        camera: this.camVideo,
        opts: this.studio,
      });
      return;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    /* The canvas size is fixed for the whole take: resizing it mid-capture
       makes players choke on the resolution switch. So when the shared
       surface changes size (window switch, display resize) we letterbox
       instead of cropping — losing the edge of someone's screen is worse
       than a black bar. */
    this._drawCropped(this.screenVideo, W, H);
    if (this.camVideo) this._drawCameraBubble(W, H);
  }

  /* Draw the kept region of the source across the whole canvas. With no crop
     this is the old contain behaviour; with a crop the discarded edges never
     reach the canvas, so they cannot reach the file either. */
  _drawCropped(video, W, H) {
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sx = this.crop.left * vw;
    const sy = this.crop.top * vh;
    const sw = Math.max(2, vw - sx - this.crop.right * vw);
    const sh = Math.max(2, vh - sy - this.crop.bottom * vh);

    // Letterbox if the source aspect drifts from the canvas (surface switch,
    // display resize) rather than cropping more off the user's screen.
    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    this.ctx.drawImage(video, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  /** object-fit: contain — whole frame visible, black bars if aspect differs. */
  _drawContain(video, x, y, w, h) {
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    this.ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /** object-fit: cover — fills the rect, crops the overflow (right for the bubble). */
  _drawCover(video, x, y, w, h) {
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale;
    const sh = h / scale;
    this.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
  }

  _drawCameraBubble(W, H) {
    const ctx = this.ctx;
    /* bubble.x/y/radius are fractions of the FULL captured surface, so a crop
       has to be divided out: the kept region now fills the whole canvas. */
    const scale = this.cropScale;
    const r = Math.round((this.bubble.radius / scale.h) * H);
    const cx = Math.round(((this.bubble.x - this.crop.left) / scale.w) * W);
    const cy = Math.round(((this.bubble.y - this.crop.top) / scale.h) * H);

    // White ring behind the camera circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(3, r * 0.05), 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();

    // Circular clip with cover-fit camera frame. Not mirrored: the recording
    // shows the real orientation (readable text), and #cam-bubble in the DOM
    // matches it so the overlay is a true preview of the baked frame.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    this._drawCover(this.camVideo, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  /* ---------- transport controls ---------- */
  pause() {
    if (this.state !== 'recording') return;
    for (const mr of [this.mediaRecorder, ...this.extras.map((o) => o.mediaRecorder)]) {
      if (mr && mr.state === 'recording') mr.pause();
    }
    this._stopClock(); // nothing is being captured; stop burning CPU
    if (this.hasFileSource) this.fileVideo.pause();
    this.elapsedBeforePause += Date.now() - this.startedAt;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    for (const mr of [this.mediaRecorder, ...this.extras.map((o) => o.mediaRecorder)]) {
      if (mr && mr.state === 'paused') mr.resume();
    }
    if (this.usesCanvas || this.extras.some((o) => o.ctx)) this._startClock();
    if (this.hasFileSource) this.fileVideo.play().catch(() => {});
    this.startedAt = Date.now();
    this.state = 'recording';
  }

  /**
   * Stop and produce the final blob.
   * Resolves { blob, duration, sessionId, hasAudio, extras }. The recovery
   * sessions are kept on disk on purpose — the caller clears them once the
   * take is saved or discarded.
   */
  stop() {
    return new Promise((resolve) => {
      if (this.state === 'idle' || !this.mediaRecorder) { resolve(null); return; }
      const duration = this.getElapsedMs() / 1000;
      const sessionId = this.sessionId;
      // Stopped together with the main recorder, so every version ends on the same frame.
      const extrasDone = this._finishExtras();

      const finalize = async () => {
        await this._flush();
        await this.flushChain;
        const type = (this.mimeType || 'video/webm').split(';')[0];
        let parts = [];
        try {
          parts = await PenguDB.getChunks(sessionId);
        } catch {
          parts = [];
        }
        // Anything a failed flush left in RAM still belongs at the end.
        const blob = new Blob([...parts, ...this.pending], { type });
        const hasAudio = !!(this.recordedStream && this.recordedStream.getAudioTracks().length);
        const extras = await extrasDone;
        this._teardown();
        resolve({ blob, duration, sessionId, hasAudio, extras });
      };

      this.mediaRecorder.onstop = finalize;
      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      } else {
        finalize();
      }
    });
  }

  /** Discard everything recorded so far and start over on the same streams. */
  async restart() {
    if (this.state === 'idle' || !this.mediaRecorder) return;
    const oldSession = this.sessionId;
    await new Promise((resolve) => {
      this.mediaRecorder.onstop = resolve;
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      else resolve();
    });

    await this.flushChain;
    PenguDB.clearSession(oldSession).catch(() => {});
    for (const out of this.extras) {
      await this._stopRecorder(out.mediaRecorder);
      await out.flushChain;
      PenguDB.clearSession(out.sessionId).catch(() => {});
    }

    this.pending = [];
    this.flushSeq = 0;
    this.sessionId = PenguRecorder.newSessionId();
    await PenguDB.startSession(this.sessionId, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.mode,
      mimeType: this.mimeType,
      durationMs: 0,
    }).catch(() => {});

    // A fresh take means the file plays again from the top.
    if (this.hasFileSource) {
      this.fileVideo.currentTime = 0;
      this.fileVideo.play().catch(() => {});
    }

    const vw = this.usesCanvas ? this.canvas.width : undefined;
    const vh = this.usesCanvas ? this.canvas.height : undefined;
    this._createRecorder(vw || 1920, vh || 1080);
    await Promise.all(this.extras.map((out) => this._armExtra(out)));
    this.mediaRecorder.start(1000);
    for (const out of this.extras) out.mediaRecorder.start(1000);

    this.elapsedBeforePause = 0;
    this.startedAt = Date.now();
    this.state = 'recording';
    if ((this.usesCanvas || this.extras.some((o) => o.ctx)) && !this.clock) this._startClock();
  }

  /** Abort recording and throw the result away, recovery data included. */
  async cancel() {
    const sessionId = this.sessionId;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        this.mediaRecorder.onstop = resolve;
        this.mediaRecorder.stop();
      });
    }
    await this.flushChain;
    if (sessionId) PenguDB.clearSession(sessionId).catch(() => {});
    for (const out of this.extras) {
      await this._stopRecorder(out.mediaRecorder);
      await out.flushChain;
      PenguDB.clearSession(out.sessionId).catch(() => {});
    }
    this._teardown();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.micGain) this.micGain.gain.value = muted ? 0 : 1;
    if (this.micStream) {
      for (const t of this.micStream.getAudioTracks()) t.enabled = !muted;
    }
  }

  getElapsedMs() {
    if (this.state === 'recording') {
      return this.elapsedBeforePause + (Date.now() - this.startedAt);
    }
    return this.elapsedBeforePause;
  }

  /* ---------- cleanup ---------- */
  _teardown() {
    this._stopClock();
    if (this.fileVideo) { this.fileVideo.pause(); this.fileVideo.onended = null; }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this._stopTracks();
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.audioDest = null;
    this.micGain = null;
    this.mediaRecorder = null;
    this.recordedStream = null;
    this.screenVideo = null;
    this.camVideo = null;
    this.canvas = null;
    this.ctx = null;
    this.studioBackground = null;
    this.extras = [];
    this.sessionId = null;
    this.pending = [];
    this.state = 'idle';
    this.elapsedBeforePause = 0;
  }

  _stopTracks() {
    for (const stream of [this.screenStream, this.cameraStream, this.micStream]) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
    this.screenStream = null;
    this.cameraStream = null;
    this.micStream = null;
  }

  /** Release setup-phase streams (e.g. leaving the setup screen without recording). */
  cleanup() {
    if (this.state !== 'idle') return; // never tear down mid-recording
    this._stopTracks();
    this.mode = null;
  }
}

// Single shared instance used by app.js.
const recorder = new PenguRecorder();
