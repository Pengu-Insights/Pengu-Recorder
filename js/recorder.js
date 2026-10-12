/* ============================================================
   recorder.js — the recording engine.

   Two pipelines, picked by mode:

   1. Screen only / camera only — the source track goes straight into
      MediaRecorder. No canvas, so no re-encode of the screen, no text
      blurring, and far less CPU:
        getDisplayMedia() (or camera) ---+
        mic + system audio -> AudioContext mix -+-> MediaRecorder -> webm

   2. Screen + camera — compositing is unavoidable, so we draw both onto a
      hidden canvas at 30 fps and record its captureStream. The draw clock
      lives in a Web Worker because timers in a hidden tab get throttled to
      ~1 Hz, and a screen recorder's own tab is hidden most of the time.

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
    this.mode = null;              // 'screen-cam' | 'screen' | 'camera'
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
    this.screenVideo = null;       // hidden draw sources
    this.camVideo = null;

    this.recordedStream = null;
    this.mediaRecorder = null;
    this.mimeType = '';

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

  static pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return ''; // let the browser pick its default
  }

  /** Bitrate scaled to the frame size: 5 Mbps is wasteful at 720p and thin at 4K. */
  static bitrateFor(width, height, fps = 30) {
    const bits = Math.round((width || 1280) * (height || 720) * fps * 0.12);
    return Math.min(16_000_000, Math.max(2_000_000, bits));
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
      const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
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

  /* ---------- screen acquisition (must be called from a user gesture) ---------- */
  async acquireScreen() {
    // Capture size follows the setup-screen quality picker; 'auto' lets the
    // browser hand over the surface at its native size.
    const video = { frameRate: { ideal: 30 }, cursor: 'always' };
    if (this.quality === '1080p') { video.width = { ideal: 1920 }; video.height = { ideal: 1080 }; }
    if (this.quality === '720p') { video.width = { ideal: 1280 }; video.height = { ideal: 720 }; }
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

  /* True when the take has to be composited. Two reasons: a camera bubble to
     bake in, or a crop to apply — cropping means re-encoding through the
     canvas, which the uncropped screen path deliberately avoids. */
  get usesCanvas() {
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
    this.sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await PenguDB.startSession(this.sessionId, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.mode,
      mimeType: this.mimeType,
      durationMs: 0,
    }).catch(() => {});

    this.mediaRecorder.start(1000); // gather chunks every second

    this.elapsedBeforePause = 0;
    this.startedAt = Date.now();
    this.state = 'recording';

    if (this.usesCanvas) this._startClock();
    this.flushTimer = setInterval(() => this._flush(), 5000);
  }

  _createRecorder(width, height) {
    this.mimeType = PenguRecorder.pickMimeType();
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

    this.screenVideo = this._makeSourceVideo(this.screenStream);
    const s = this._trackSettings(this.screenStream);
    const scale = this.cropScale;
    // Even dimensions: odd ones make some encoders pad or refuse the frame.
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    this.canvas.width = even((s.width || 1920) * scale.w);
    this.canvas.height = even((s.height || 1080) * scale.h);
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
    if (!hasMic && !hasSys) { this.audioDest = null; return; }

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
  }

  /* ---------- per-frame compositing (screen + camera only) ---------- */
  _drawFrame() {
    const { ctx, canvas } = this;
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

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
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
    this._stopClock(); // nothing is being captured; stop burning CPU
    this.elapsedBeforePause += Date.now() - this.startedAt;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
    if (this.usesCanvas) this._startClock();
    this.startedAt = Date.now();
    this.state = 'recording';
  }

  /**
   * Stop and produce the final blob.
   * Resolves { blob, duration, sessionId }. The recovery session is kept on
   * disk on purpose — the caller clears it once the take is saved or discarded.
   */
  stop() {
    return new Promise((resolve) => {
      if (this.state === 'idle' || !this.mediaRecorder) { resolve(null); return; }
      const duration = this.getElapsedMs() / 1000;
      const sessionId = this.sessionId;

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
        this._teardown();
        resolve({ blob, duration, sessionId, hasAudio });
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

    this.pending = [];
    this.flushSeq = 0;
    this.sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await PenguDB.startSession(this.sessionId, {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.mode,
      mimeType: this.mimeType,
      durationMs: 0,
    }).catch(() => {});

    const vw = this.usesCanvas ? this.canvas.width : undefined;
    const vh = this.usesCanvas ? this.canvas.height : undefined;
    this._createRecorder(vw || 1920, vh || 1080);
    this.mediaRecorder.start(1000);

    this.elapsedBeforePause = 0;
    this.startedAt = Date.now();
    this.state = 'recording';
    if (this.usesCanvas && !this.clock) this._startClock();
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
