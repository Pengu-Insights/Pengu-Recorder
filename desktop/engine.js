/* ============================================================
   engine.js: the recorder, driven by the main process.

   Lives in a hidden window so it keeps running whatever is on screen. The
   Studio look (template, background, camera shape, name) comes from the
   same saved preferences the template editor writes; the rest (source,
   devices, taskbar) arrives with each take.

   Every chunk goes to the main process the moment MediaRecorder hands it
   over, and lands in a file there. Stopping only has to close the files.
   ============================================================ */

const api = window.penguDesktop;
const PREFS_KEY = 'pengu-recorder:prefs';

/* The Studio shapes that can ride along with the main take. Mirrors the
   studio entries of EXTRA_OUTPUTS in app.js, which is where they are picked. */
const STUDIO_VARIANTS = {
  reel: { label: 'Reel 9:16', opts: { aspect: 'reel', template: 'split', cameraSide: 'right' } },
  short: { label: 'Short 9:16', opts: { aspect: 'vertical', template: 'side', cameraSide: 'left' } },
  youtube: { label: 'YouTube 16:9', opts: { aspect: 'landscape', template: 'side', cameraSide: 'right' } },
};
const MAIN_LABELS = { screen: 'Screen', 'screen-cam': 'Screen and camera', camera: 'Camera', studio: 'Template' };

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function studioFromPrefs(prefs) {
  const studio = { ...PenguStudio.DEFAULTS, backgroundId: PenguBackgrounds.DEFAULT_ID };
  if (prefs.studio && typeof prefs.studio === 'object') {
    for (const [k, v] of Object.entries(prefs.studio)) {
      if (typeof v === 'string' && k in studio) studio[k] = v;
    }
  }
  if (!PenguStudio.TEMPLATES.includes(studio.template)) studio.template = 'side';
  return studio;
}

/* ---------- chunks to disk ---------- */

const sink = {
  gen: 0,
  chains: new Map(),
  write(key, blob) {
    const gen = this.gen;
    const prev = this.chains.get(key) || Promise.resolve();
    this.chains.set(key, prev.then(async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      api.send('take:chunk', key, gen, bytes);
    }));
  },
  reset() {
    this.gen += 1;
  },
  drained() {
    return Promise.all([...this.chains.values()]);
  },
  clear() {
    this.gen = 0;
    this.chains = new Map();
  },
};

/* ---------- sources ---------- */

/* Electron's own path to a screen or window: no picker, no user gesture,
   and the source was already chosen in the panel. */
async function captureSource(source, withAudio) {
  const video = { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 30 };
  if (source.display) {
    const { bounds, scaleFactor } = source.display;
    const w = Math.round(bounds.width * scaleFactor);
    const h = Math.round(bounds.height * scaleFactor);
    Object.assign(video, { minWidth: w, maxWidth: w, minHeight: h, maxHeight: h });
  } else {
    Object.assign(video, { maxWidth: 3840, maxHeight: 2160 });
  }
  const constraints = { video: { mandatory: video } };
  if (withAudio) constraints.audio = { mandatory: { chromeMediaSource: 'desktop' } };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (withAudio) return captureSource(source, false); // video without system sound beats nothing
    throw err;
  }
}

function captureCamera(deviceId) {
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

function captureMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: PenguRecorder.micConstraints(deviceId, recorder.hiFiAudio),
    video: false,
  });
}

/* ---------- taskbar ---------- */

/* The taskbar is whatever separates the display from its work area, on
   whichever edge it sits. 'fill' then trims the long axis evenly so what
   is left has the display's own shape, ready to scale back to full size. */
function taskbarCrop(display, mode) {
  const b = display.bounds;
  const a = display.workArea;
  const c = {
    top: (a.y - b.y) / b.height,
    left: (a.x - b.x) / b.width,
    bottom: (b.y + b.height - (a.y + a.height)) / b.height,
    right: (b.x + b.width - (a.x + a.width)) / b.width,
  };
  if (mode === 'fill') {
    const target = b.width / b.height;
    const keptW = b.width * (1 - c.left - c.right);
    const keptH = b.height * (1 - c.top - c.bottom);
    if (keptW / keptH > target) {
      const trim = (keptW - keptH * target) / b.width / 2;
      c.left += trim;
      c.right += trim;
    } else {
      const trim = (keptH - keptW / target) / b.height / 2;
      c.top += trim;
      c.bottom += trim;
    }
  }
  return c;
}

/* ---------- the take ---------- */

function studioSizeFor(source, studio) {
  const h = source && source.display
    ? Math.round(source.display.bounds.height * source.display.scaleFactor) : 1080;
  return PenguRecorder.studioSize(recorder.quality, h, studio.aspect);
}

const methods = {
  /* Warm the backdrop while the panel is open, so starting a Studio take
     does not wait for a 1440p gradient to paint. */
  async prepare({ layout, source }) {
    if (layout !== 'studio') return;
    const prefs = readPrefs();
    if (typeof prefs.quality === 'string') recorder.quality = prefs.quality;
    const studio = studioFromPrefs(prefs);
    const size = studioSizeFor(source, studio);
    await PenguBackgrounds.render(studio.backgroundId, size.w, size.h).catch(() => null);
  },

  async acquire(cfg) {
    recorder.cleanup();
    sink.clear();
    const prefs = readPrefs();
    recorder.quality = typeof prefs.quality === 'string' ? prefs.quality : 'auto';
    recorder.format = prefs.format === 'webm' || !PenguRecorder.formatSupported('mp4') ? 'webm' : 'mp4';
    recorder.studio = studioFromPrefs(prefs);
    if (prefs.cameraFrame && typeof prefs.cameraFrame.zoom === 'number') recorder.cameraFrame = prefs.cameraFrame;
    recorder.bubble.radius = PenguRecorder.RADII.medium;

    let mode = cfg.layout;
    const needScreen = mode !== 'camera' && !(mode === 'studio' && recorder.studio.template === 'camera');
    const wantCamera = mode !== 'screen' && (cfg.cameraOn || mode === 'camera');

    if (needScreen && !cfg.source) throw new Error('screen: no source');
    const [screenStream, cameraStream, micStream] = await Promise.all([
      needScreen ? captureSource(cfg.source, cfg.systemAudio).catch((e) => { throw new Error(`screen: ${e.message}`); }) : null,
      wantCamera ? captureCamera(cfg.cameraId).catch(() => null) : null,
      cfg.micOn ? captureMic(cfg.micId).catch(() => null) : null,
    ]);

    if (mode === 'camera' && !cameraStream) {
      if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      throw new Error('camera: not available');
    }
    if (mode === 'screen-cam' && !cameraStream) mode = 'screen';

    recorder.mode = mode;
    recorder.screenStream = screenStream;
    recorder.cameraStream = cameraStream;
    recorder.micStream = micStream;
    recorder.muted = false;

    const cropTaskbar = screenStream && cfg.source.kind === 'screen' && cfg.taskbar !== 'show';
    recorder.crop = cropTaskbar ? taskbarCrop(cfg.source.display, cfg.taskbar)
      : { top: 0, right: 0, bottom: 0, left: 0 };
    recorder.cropFill = cropTaskbar && cfg.taskbar === 'fill';

    const specs = [];
    if (mode === 'studio' && screenStream) {
      const picked = prefs.studio && Array.isArray(prefs.studio.extras) ? prefs.studio.extras : [];
      for (const id of picked) {
        const v = STUDIO_VARIANTS[id];
        if (!v) continue;
        if (v.opts.aspect === recorder.studio.aspect && v.opts.template === recorder.studio.template) continue;
        specs.push({ id, label: v.label, kind: 'studio', opts: { ...recorder.studio, ...v.opts } });
      }
    }
    const composite = mode === 'studio' || mode === 'screen-cam';
    if (composite && cameraStream && cfg.saveCamera) specs.push({ id: 'camera', label: 'Camera only', kind: 'camera' });
    if (composite && screenStream && cfg.saveScreen) specs.push({ id: 'screen', label: 'Screen only', kind: 'screen' });
    recorder.extraSpecs = specs;
    recorder.chunkSink = sink;

    if (screenStream) {
      const track = screenStream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => api.send('engine:autostop'));
    }

    return {
      ext: PenguRecorder.formatOf(PenguRecorder.pickMimeType(recorder.format)),
      keys: [{ key: 'main', label: MAIN_LABELS[mode] }, ...specs.map((s) => ({ key: s.id, label: s.label }))],
      mode,
      camera: !!cameraStream,
      mic: !!micStream,
    };
  },

  async go() {
    await recorder.start();
    return { startedAt: Date.now() };
  },

  async stop() {
    const result = await recorder.stop();
    await sink.drained();
    return result ? { duration: result.duration, hasAudio: result.hasAudio } : null;
  },

  pause() { recorder.pause(); },
  resume() { recorder.resume(); },
  mute(on) { recorder.setMuted(!!on); },

  async restart() {
    await recorder.restart();
  },

  async cancel() {
    if (recorder.state !== 'idle') await recorder.cancel();
    else recorder.cleanup();
    await sink.drained();
    sink.clear();
  },
};

api.on('engine:call', async ({ id, method, args }) => {
  try {
    if (!methods[method]) throw new Error(`unknown method ${method}`);
    const result = await methods[method](...(args || []));
    api.send('engine:reply', { id, ok: true, result: result ?? null });
  } catch (err) {
    api.send('engine:reply', { id, ok: false, error: String((err && err.message) || err) });
  }
});
