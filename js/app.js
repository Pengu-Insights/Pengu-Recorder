/* ============================================================
   app.js — UI wiring, hash router, toasts.
   Routes:
     #/            library
     #/record      recording setup (mode kept in AppState)
     #/preview     post-recording review / trim / save
     #/v/:id       watch a saved video
   ============================================================ */

const AppState = {
  setupMode: 'screen-cam',
  current: null,        // post-recording working copy (not yet saved)
  timerInterval: null,
  meterFrame: null,
  meterCtx: null,
  lastHash: '#/',
  notes: '',            // presenter notes, in-memory for the session
  notesOpen: false,     // notes panel visibility while recording
  notesPos: null,       // { left, top } in px once the user drags the panel
  notesFont: 16,
  notesTipShown: false, // one-time "entire screen" caveat toast per session
  notesPipWin: null,    // Document Picture-in-Picture window holding the notes, when open
  barHidden: false,     // user hid the in-tab control bar (Alt+H) to keep it out of the video
  cameraId: null,       // selected devices ('' / null = browser default)
  micId: null,
  hiFiAudio: false,
  recovery: null,       // pending recovery session meta, if any
  format: 'webm',       // 'mp4' | 'webm', settled by loadPrefs()
  quality: 'auto',
  studio: { ...PenguStudio.DEFAULTS, backgroundId: PenguBackgrounds.DEFAULT_ID },
  studioPreview: null,  // { raf, video, background } while the setup preview runs
  exportAbort: null,    // AbortController of the export in progress
};

/* ---------------- helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtBytes(bytes) {
  if (!bytes) return '0 MB';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function toast(message, type = 'info') {
  const box = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = '<span class="toast-dot"></span><span></span>';
  el.lastElementChild.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, 3000);
}

/** Resolve `promise`, or `fallback` if it takes longer than `ms`. */
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/* ---------------- preferences ----------------
   Per-browser conveniences only: format, quality and the Studio look.
   Storage throws in some private windows and when site data is blocked;
   the app then starts from the defaults every time, which is fine. */

const PREFS_KEY = 'pengu-recorder:prefs';
const STUDIO_KEYS = ['template', 'aspect', 'cameraSide', 'cameraCorner', 'cameraShape', 'cameraSize', 'name', 'backgroundId'];

const STUDIO_TEMPLATES = [
  { id: 'side', label: 'Side by side' },
  { id: 'corner', label: 'Full screen, camera in a corner' },
  { id: 'framed-corner', label: 'Framed screen, camera in a corner' },
  { id: 'camera', label: 'Just you, for intros and outros' },
];

function loadPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  if (typeof saved.quality === 'string') AppState.quality = saved.quality;
  if (saved.studio && typeof saved.studio === 'object') {
    for (const k of STUDIO_KEYS) {
      if (typeof saved.studio[k] === 'string') AppState.studio[k] = saved.studio[k];
    }
  }
  if (!PenguStudio.TEMPLATES.includes(AppState.studio.template)) AppState.studio.template = 'side';
  const wanted = saved.format === 'webm' || saved.format === 'mp4' ? saved.format : 'mp4';
  AppState.format = PenguRecorder.formatSupported(wanted) ? wanted
    : (PenguRecorder.formatSupported('mp4') ? 'mp4' : 'webm');
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      format: AppState.format,
      quality: AppState.quality,
      studio: AppState.studio,
    }));
  } catch { /* storage unavailable: keep the choice for this visit only */ }
}

/* ---------------- router ---------------- */

function parseRoute() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/v/')) return { name: 'watch', id: hash.slice(4) };
  if (hash.startsWith('#/record')) return { name: 'record' };
  if (hash.startsWith('#/preview')) return { name: 'preview' };
  return { name: 'library' };
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', name === 'library' && n.dataset.nav !== 'notifications');
  });
}

async function router() {
  const route = parseRoute();

  // Guard: while recording, block navigation away from the setup screen.
  if (recorder.state !== 'idle' && route.name !== 'record') {
    toast('Finish or cancel your recording before navigating', 'error');
    location.hash = AppState.lastHash;
    return;
  }

  // Leaving the setup screen without ever recording -> release preview streams.
  if (AppState.lastHash.startsWith('#/record') && route.name !== 'record' && recorder.state === 'idle') {
    stopMicMeter();
    stopStudioPreview();
    recorder.cleanup();
  }

  // Leaving the watch view -> release its object URL.
  if (AppState.lastHash.startsWith('#/v/') && route.name !== 'watch') releaseWatchUrl();

  AppState.lastHash = location.hash || '#/';

  switch (route.name) {
    case 'library': showView('library'); await renderLibrary(); break;
    case 'record':  showView('record');  await enterSetup(); break;
    case 'preview':
      if (!AppState.current) { location.hash = '#/'; return; }
      showView('preview'); enterPreview(); break;
    case 'watch':   showView('watch');   await enterWatch(route.id); break;
  }
}

/* ---------------- library ---------------- */

async function renderLibrary() {
  const grid = $('#library-grid');
  const empty = $('#library-empty');
  const videos = await PenguDB.getAll();

  grid.innerHTML = '';
  empty.classList.toggle('hidden', videos.length > 0);

  for (const v of videos) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');

    const thumb = document.createElement('div');
    thumb.className = 'thumb-wrap';
    if (v.thumbnail) {
      const img = document.createElement('img');
      img.src = v.thumbnail;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<div class="thumb-placeholder"><svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></div>';
    }
    const badge = document.createElement('span');
    badge.className = 'duration-badge';
    badge.textContent = fmtTime((v.trimEnd ?? v.duration) - (v.trimStart ?? 0));
    thumb.appendChild(badge);

    const title = document.createElement('p');
    title.className = 'card-title';
    title.textContent = v.title;

    const meta = document.createElement('p');
    meta.className = 'card-meta';
    const views = v.views ?? 0; // records saved before the real counter may lack the field
    // Older records predate the field; they were always WebM.
    const format = PenguRecorder.formatOf(v.mimeType).toUpperCase();
    meta.textContent = `${fmtDate(v.createdAt)} · ${views} view${views === 1 ? '' : 's'} · ${format}`;

    card.append(thumb, title, meta);
    card.setAttribute('aria-label', `${v.title}, ${meta.textContent}`);
    const open = () => { location.hash = `#/v/${v.id}`; };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    grid.appendChild(card);
  }

  renderStorageNote();
}

async function renderStorageNote() {
  const note = $('#storage-note');
  if (!note) return;
  const est = await PenguDB.estimate();
  if (!est || !est.quota) { note.textContent = ''; return; }
  note.textContent = `${fmtBytes(est.usage)} used · ${fmtBytes(est.freeBytes)} free`;
  note.classList.toggle('low', est.freeBytes < 500e6);
}

/* ---------------- recording setup ---------------- */

async function enterSetup() {
  applySetupControls();
  selectModeButton(AppState.setupMode);
  $('#notes-input').value = AppState.notes; // notes persist for the session
  $('#hifi-audio').checked = AppState.hiFiAudio;
  await acquireForMode(AppState.setupMode);
}

/** Put the saved choices back into the setup form. */
function applySetupControls() {
  const mp4 = $('#format option[value="mp4"]');
  if (!PenguRecorder.formatSupported('mp4')) {
    mp4.disabled = true;
    mp4.textContent = 'MP4 (needs Chrome or Edge 126+)';
  }
  $('#format').value = AppState.format;
  $('#quality').value = AppState.quality;
  if (!$('#quality').value) $('#quality').value = 'auto';
  $('#cam-size').value = AppState.studio.cameraSize;
  $('#studio-side').value = AppState.studio.cameraSide;
  $('#studio-shape').value = AppState.studio.cameraShape;
  $('#studio-name').value = AppState.studio.name;
  $('#studio-corner').value = AppState.studio.cameraCorner;
  applyStudioAspect();
  applyStudioTemplate();
}

/** True when the take needs a screen share: every mode but camera only and
    the Studio "just you" template. */
function needsScreen(mode) {
  if (mode === 'camera') return false;
  return !(mode === 'studio' && AppState.studio.template === 'camera');
}

/* Show the controls that matter for the chosen template. */
function applyStudioTemplate() {
  const t = AppState.studio.template;
  const studio = AppState.setupMode === 'studio';
  $('#studio-side-field').classList.toggle('hidden', t !== 'side');
  $('#studio-corner-field').classList.toggle('hidden', t !== 'corner' && t !== 'framed-corner');
  $('#crop-field').classList.toggle('hidden', !needsScreen(AppState.setupMode));
  document.querySelectorAll('#template-picker .template-tile').forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.template === t ? 'true' : 'false');
  });
  if (studio) {
    $('#setup-hint').textContent = t === 'camera'
      ? 'Your browser will ask for camera and microphone access. No screen is shared in this layout.'
      : 'Your browser will ask which screen, window, or tab to share. It goes in the layout, with your camera.';
  }
}

/* Thumbnails of every template, drawn by the real compositor with the
   current background and camera options, so each tile shows what you get. */
let templateThumbsJob = 0;
async function renderTemplatePicker() {
  const job = ++templateThumbsJob;
  const picker = $('#template-picker');
  const vertical = AppState.studio.aspect === 'vertical';
  const [w, h] = vertical ? [108, 192] : [192, 108];
  const background = await PenguBackgrounds.render(AppState.studio.backgroundId, w, h).catch(() => null);
  if (job !== templateThumbsJob) return; // a newer render superseded this one

  picker.classList.toggle('vertical', vertical);
  picker.innerHTML = '';
  for (const t of STUDIO_TEMPLATES) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'template-tile';
    tile.dataset.template = t.id;
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', t.id === AppState.studio.template ? 'true' : 'false');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    PenguStudio.draw(canvas.getContext('2d'), w, h, {
      background, screen: null, camera: null, placeholder: true,
      opts: { ...AppState.studio, template: t.id, name: '' },
    });
    const label = document.createElement('span');
    label.textContent = t.label;
    tile.append(canvas, label);
    tile.addEventListener('click', () => {
      AppState.studio.template = t.id;
      savePrefs();
      applyStudioTemplate();
    });
    picker.appendChild(tile);
  }
}

/* YouTube (16:9) or Shorts (9:16): the preview canvas takes the shape of
   the video, and "left/right of the screen" becomes "above/below". */
function applyStudioAspect() {
  const vertical = AppState.studio.aspect === 'vertical';
  document.querySelectorAll('.aspect-btn').forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.aspect === AppState.studio.aspect ? 'true' : 'false');
  });
  const canvas = $('#studio-preview');
  const [w, h] = vertical ? [540, 960] : [960, 540];
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.classList.toggle('vertical', vertical);
  $('#studio-side option[value="left"]').textContent = vertical ? 'Above the screen' : 'Left of the screen';
  $('#studio-side option[value="right"]').textContent = vertical ? 'Below the screen' : 'Right of the screen';
  refreshPreviewBackground();
  renderTemplatePicker();
}

function selectModeButton(mode) {
  document.querySelectorAll('#setup-modes .mode-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('#cam-size-field').classList.toggle('hidden', mode === 'screen');
  $('#cam-device-field').classList.toggle('hidden', mode === 'screen');

  const studio = mode === 'studio';
  $('#studio-panel').classList.toggle('hidden', !studio);
  $('#studio-preview').classList.toggle('hidden', !studio);
  $('#cam-preview-wrap').classList.toggle('hidden', studio);
  $('#cam-size-label').textContent = studio ? 'Camera size' : 'Camera bubble size';
  if (studio) renderBackgroundGallery();

  $('#setup-hint').textContent = mode === 'camera'
    ? 'Your browser will ask for camera and microphone access.'
    : 'Your browser will ask which screen, window, or tab to share.';
  applyStudioTemplate();
}

async function acquireForMode(mode) {
  stopMicMeter();
  stopStudioPreview();
  recorder.cleanup();

  const { camera, mic } = await recorder.acquireSetupStreams(mode, {
    cameraId: AppState.cameraId,
    micId: AppState.micId,
    hiFiAudio: AppState.hiFiAudio,
  });

  // Camera preview circle.
  const preview = $('#cam-preview');
  const off = $('#cam-preview-off');
  if (camera) {
    preview.srcObject = recorder.cameraStream;
    off.classList.add('hidden');
  } else {
    preview.srcObject = null;
    off.classList.remove('hidden');
    if (mode === 'camera') {
      toast('Camera access denied — camera-only recording needs a camera', 'error');
    } else if (mode === 'screen-cam') {
      toast('Camera unavailable — you can still record screen only', 'error');
    }
  }
  if (!mic) toast('Microphone unavailable — recording will be silent', 'error');
  $('#mic-label').textContent = mic ? 'Mic' : 'No mic';

  if (mic) startMicMeter(recorder.micStream);
  if (mode === 'studio' && AppState.setupMode === 'studio') startStudioPreview();

  await populateDeviceSelects();
}

/* ---------------- Studio setup: live preview + background gallery ---------------- */

/* Runs the real compositor (studio.js) on a small canvas, with a stand-in
   where the screen will go, so what the user arranges is what gets recorded. */
function startStudioPreview() {
  stopStudioPreview();
  const canvas = $('#studio-preview');
  const ctx = canvas.getContext('2d');
  const state = { raf: 0, video: null, background: null };
  if (recorder.cameraStream) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = recorder.cameraStream;
    v.play().catch(() => {});
    state.video = v;
  }
  AppState.studioPreview = state;
  refreshPreviewBackground();

  const tick = () => {
    PenguStudio.draw(ctx, canvas.width, canvas.height, {
      background: state.background,
      screen: null,
      camera: state.video,
      opts: AppState.studio,
      placeholder: true,
    });
    state.raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopStudioPreview() {
  const state = AppState.studioPreview;
  if (!state) return;
  cancelAnimationFrame(state.raf);
  if (state.video) state.video.srcObject = null;
  AppState.studioPreview = null;
}

async function refreshPreviewBackground() {
  const state = AppState.studioPreview;
  if (!state) return;
  const canvas = $('#studio-preview');
  const bg = await PenguBackgrounds
    .render(AppState.studio.backgroundId, canvas.width, canvas.height)
    .catch(() => null);
  if (AppState.studioPreview === state) state.background = bg;
}

async function renderBackgroundGallery() {
  const gallery = $('#bg-gallery');
  const items = await PenguBackgrounds.list();
  if (!items.some((i) => i.id === AppState.studio.backgroundId)) {
    AppState.studio.backgroundId = PenguBackgrounds.DEFAULT_ID;
    refreshPreviewBackground();
  }

  gallery.innerHTML = '';
  const add = document.createElement('label');
  add.className = 'bg-tile bg-add';
  add.title = 'Add your own image';
  add.innerHTML = '<input type="file" accept="image/*" class="sr-only-input" aria-label="Add your own background image">'
    + '<span class="bg-add-plus" aria-hidden="true">+</span><span>Add image</span>';
  add.querySelector('input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) addBackgroundFile(file);
  });
  gallery.appendChild(add);

  for (const item of items) {
    const wrap = document.createElement('div');
    wrap.className = 'bg-tile-wrap';

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'bg-tile';
    tile.dataset.id = item.id;
    tile.title = item.label;
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-label', item.label);
    tile.setAttribute('aria-checked', item.id === AppState.studio.backgroundId ? 'true' : 'false');
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    tile.appendChild(img);
    tile.addEventListener('click', () => selectBackground(item.id));
    wrap.appendChild(tile);

    if (item.removable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bg-remove';
      del.textContent = '×';
      del.setAttribute('aria-label', `Remove ${item.label}`);
      del.addEventListener('click', () => removeBackgroundImage(item.id));
      wrap.appendChild(del);
    }
    gallery.appendChild(wrap);
  }
}

function selectBackground(id) {
  AppState.studio.backgroundId = id;
  savePrefs();
  document.querySelectorAll('#bg-gallery .bg-tile[data-id]').forEach((t) => {
    t.setAttribute('aria-checked', t.dataset.id === id ? 'true' : 'false');
  });
  refreshPreviewBackground();
  renderTemplatePicker();
}

async function addBackgroundFile(file) {
  try {
    const id = await PenguBackgrounds.add(file);
    AppState.studio.backgroundId = id;
    savePrefs();
    await renderBackgroundGallery();
    refreshPreviewBackground();
    renderTemplatePicker();
    toast('Background added', 'success');
  } catch (err) {
    toast(err && err.message === 'too-large'
      ? 'That image is over 25 MB. Try a smaller one.'
      : 'Could not read that image. Try a JPG, PNG or WebP.', 'error');
  }
}

async function removeBackgroundImage(id) {
  await PenguBackgrounds.remove(id).catch(() => {});
  if (AppState.studio.backgroundId === id) AppState.studio.backgroundId = PenguBackgrounds.DEFAULT_ID;
  savePrefs();
  await renderBackgroundGallery();
  refreshPreviewBackground();
  renderTemplatePicker();
  toast('Background removed');
}

/* Device pickers. Labels only exist once permission has been granted, which is
   why this runs after acquireSetupStreams. */
async function populateDeviceSelects() {
  const { cameras, mics } = await PenguRecorder.listDevices();
  const activeCam = trackDeviceId(recorder.cameraStream);
  const activeMic = trackDeviceId(recorder.micStream);

  fillSelect($('#cam-device'), cameras, AppState.cameraId || activeCam, 'Camera');
  fillSelect($('#mic-device'), mics, AppState.micId || activeMic, 'Microphone');
  $('#mic-device-field').classList.toggle('hidden', mics.length === 0);
}

function trackDeviceId(stream) {
  try {
    const track = stream && stream.getTracks()[0];
    return track ? (track.getSettings().deviceId || '') : '';
  } catch {
    return '';
  }
}

function fillSelect(select, devices, selectedId, kind) {
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = devices.length ? 'System default' : `No ${kind.toLowerCase()} found`;
  select.appendChild(auto);
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${kind} ${i + 1}`;
    select.appendChild(opt);
  });
  select.value = devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
  select.disabled = devices.length === 0;
}

/* Mic level meter via AnalyserNode (setup preview only). */
function startMicMeter(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  AppState.meterCtx = new AC();
  const ctx = AppState.meterCtx;
  ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const fill = $('#mic-meter-fill');

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
    }
    fill.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    AppState.meterFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopMicMeter() {
  if (AppState.meterFrame) cancelAnimationFrame(AppState.meterFrame);
  AppState.meterFrame = null;
  if (AppState.meterCtx) { AppState.meterCtx.close().catch(() => {}); AppState.meterCtx = null; }
  const fill = $('#mic-meter-fill');
  if (fill) fill.style.width = '0%';
}

/* ---------------- countdown + recording session ---------------- */

function runCountdown() {
  return new Promise((resolve) => {
    const overlay = $('#countdown-overlay');
    const number = $('#countdown-number');
    overlay.classList.remove('hidden');
    let n = 3;
    const step = () => {
      number.textContent = n;
      number.style.animation = 'none';
      void number.offsetWidth;           // restart the CSS animation
      number.style.animation = '';
      if (n === 0) {
        overlay.classList.add('hidden');
        resolve();
        return;
      }
      n -= 1;
      setTimeout(step, 900);
    };
    step();
  });
}

async function startRecording() {
  const mode = AppState.setupMode;
  recorder.quality = AppState.quality;
  recorder.format = AppState.format;
  recorder.studio = { ...AppState.studio };

  if (needsScreen(mode)) {
    try {
      await recorder.acquireScreen();
    } catch (err) {
      toast('Screen sharing was cancelled — pick a screen to start', 'error');
      return;
    }
    // Chrome only yields an audio track for tab shares, and for full-screen
    // shares on Windows when "Share system audio" is ticked. Say so up front
    // instead of letting the user discover a silent take afterwards.
    const sharedAudio = recorder.screenStream && recorder.screenStream.getAudioTracks().length > 0;
    if (!sharedAudio) {
      toast('No shared audio captured. Chrome records system sound only from a tab, or from the whole screen when you tick "Share system audio" (Windows). The microphone still records if it is on.');
    }
  }
  if (!needsScreen(mode) && !recorder.cameraStream) {
    toast('No camera available — this recording needs a camera', 'error');
    return;
  }

  stopMicMeter();
  stopStudioPreview();

  /* Region crop. Confirming it is also a fresh user gesture, which is exactly
     what the Picture-in-Picture request below needs. */
  if (needsScreen(mode) && $('#crop-step') && $('#crop-step').checked) {
    const confirmed = await openCropEditor();
    if (!confirmed) {
      recorder.cleanup();
      toast('Recording cancelled');
      await acquireForMode(mode); // bring the camera preview and mic meter back
      return;
    }
  } else {
    recorder.crop = { top: 0, right: 0, bottom: 0, left: 0 };
  }

  /* Document PiP needs transient user activation, and the 3-2-1 countdown
     outlives it — so ask for the floating window NOW, while the click on
     "Start recording" still counts. Asking after the countdown is what left
     the bar sitting in the page (and therefore in the video). */
  if ($('#pip-bar') && $('#pip-bar').checked) await openControlPip();

  await runCountdown();

  // Caveat: notes live in a separate Picture-in-Picture window, so they are
  // never part of a tab or window share. Sharing the ENTIRE screen captures
  // whatever is on that monitor, the notes window included.
  if (needsScreen(mode) && AppState.notes.trim() && !AppState.notesTipShown) {
    AppState.notesTipShown = true;
    toast('Notes open in a separate window. If you share your entire screen, drag that window to another monitor or it will be recorded.');
  }

  recorder.bubble.radius = PenguRecorder.RADII[$('#cam-size').value] || PenguRecorder.RADII.medium;
  recorder.onAutoStop = () => {
    toast('Screen sharing ended — finishing your recording');
    finishRecording();
  };

  await recorder.start();
  showRecordingChrome(true);
  startTimerUi();

  /* Sharing a whole monitor (or the browser window this tab sits in) captures
     the in-tab bar along with everything else. Say so once, with the way out. */
  const surface = recorder.getBubbleSpace().kind;
  if (recorder.screenStream && surface !== 'browser' && !$('#control-bar').classList.contains('hidden')) {
    toast('This control bar is inside what you are sharing, so it will be in the video. Alt+H hides it — Alt+S still finishes.');
  }
}

/* The in-tab bar is real DOM: anything that captures this page captures it
   too. So it is shown only while recording, only when the floating PiP copy
   is not up, and only when the user has not hidden it with Alt+H. */
function updateBarVisibility() {
  const pipOpen = !!(AppState.ctrlPipWin && !AppState.ctrlPipWin.closed);
  const show = recorder.state !== 'idle' && !pipOpen && !AppState.barHidden;
  $('#control-bar').classList.toggle('hidden', !show);
}

function setBarHidden(hidden) {
  AppState.barHidden = hidden;
  updateBarVisibility();
  toast(hidden
    ? 'Control bar hidden — Alt+H shows it, Alt+S finishes the recording'
    : 'Control bar shown');
}

/* Recording chrome = control bar + draggable bubble. */
function showRecordingChrome(on) {
  if (!on) AppState.barHidden = false;
  updateBarVisibility();

  // The bubble overlay only makes sense when it is actually baked into the
  // video, i.e. in the composited screen+camera pipeline. Studio places the
  // camera itself, and a crop alone has no camera at all.
  const hasBubble = on && recorder.mode === 'screen-cam' && !!recorder.cameraStream;
  const bubble = $('#cam-bubble');
  bubble.classList.toggle('hidden', !hasBubble);
  if (hasBubble) {
    $('#bubble-video').srcObject = recorder.cameraStream;
    syncBubbleGeometry();
  } else if (!on) {
    $('#bubble-video').srcObject = null;
  }

  const audioWarn = $('#audio-warning');
  if (on) {
    // Retry in case the pre-countdown attempt was refused.
    if ($('#pip-bar') && $('#pip-bar').checked && !AppState.ctrlPipWin) {
      openControlPip().then(updateBarVisibility);
    }
    updateBarVisibility();
  } else {
    closeControlPip();
  }
  if (!on) {
    stopTimerUi();
    $('#control-bar').classList.remove('paused');
    closeNotesPip();
    $('#notes-panel').classList.add('hidden');
    $('#cb-notes').classList.remove('active');
    $('#cb-notes').setAttribute('aria-pressed', 'false');
    if (audioWarn) audioWarn.classList.add('hidden');
  } else {
    // Persistent in-bar signal when the take is collecting no sound at all.
    if (audioWarn) {
      const silent = !recorder.recordedStream || recorder.recordedStream.getAudioTracks().length === 0;
      audioWarn.classList.toggle('hidden', !silent);
    }
    if (AppState.notesOpen && AppState.notes.trim()) {
      // Reopen the notes window if it was open during a previous take.
      setNotesOpen(true);
    }
  }
}

/* ----------------------------------------------------------
   Bubble geometry.

   `recorder.bubble` is expressed in fractions of the CAPTURED SURFACE. The DOM
   overlay lives in viewport coordinates, so every read and write goes through
   these two converters — that is what keeps the bubble in the video where the
   user dropped it on screen.
   ---------------------------------------------------------- */

function viewportOriginOnScreen() {
  const chromeW = Math.max(0, window.outerWidth - window.innerWidth) / 2;
  const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
  return { x: window.screenX + chromeW, y: window.screenY + chromeH };
}

function clientToSurfaceFraction(cx, cy) {
  const space = recorder.getBubbleSpace();
  if (space.kind === 'monitor') {
    const o = viewportOriginOnScreen();
    return { x: (cx + o.x) / space.w, y: (cy + o.y) / space.h };
  }
  if (space.kind === 'window') {
    const chromeW = Math.max(0, window.outerWidth - window.innerWidth) / 2;
    const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    return { x: (cx + chromeW) / space.w, y: (cy + chromeH) / space.h };
  }
  return { x: cx / space.w, y: cy / space.h }; // tab capture == this viewport
}

function surfaceFractionToClient(fx, fy) {
  const space = recorder.getBubbleSpace();
  if (space.kind === 'monitor') {
    const o = viewportOriginOnScreen();
    return { x: fx * space.w - o.x, y: fy * space.h - o.y };
  }
  if (space.kind === 'window') {
    const chromeW = Math.max(0, window.outerWidth - window.innerWidth) / 2;
    const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    return { x: fx * space.w - chromeW, y: fy * space.h - chromeH };
  }
  return { x: fx * space.w, y: fy * space.h };
}

/** Size the overlay so it covers the same share of the surface as in the video. */
function syncBubbleGeometry() {
  const bubble = $('#cam-bubble');
  const space = recorder.getBubbleSpace();
  const size = Math.round(2 * recorder.bubble.radius * space.h);
  bubble.style.width = `${size}px`;
  bubble.style.height = `${size}px`;
  placeBubble();
}

function placeBubble() {
  const bubble = $('#cam-bubble');
  const size = bubble.offsetWidth || 180;
  const target = surfaceFractionToClient(recorder.bubble.x, recorder.bubble.y);

  // Keep it grabbable inside the window, then write any clamping back into the
  // recorded position so overlay and video never disagree.
  const cx = Math.min(Math.max(target.x, size / 2), window.innerWidth - size / 2);
  const cy = Math.min(Math.max(target.y, size / 2), window.innerHeight - size / 2);
  if (Math.abs(cx - target.x) > 0.5 || Math.abs(cy - target.y) > 0.5) {
    const f = clientToSurfaceFraction(cx, cy);
    recorder.bubble.x = Math.min(Math.max(f.x, 0), 1);
    recorder.bubble.y = Math.min(Math.max(f.y, 0), 1);
  }
  bubble.style.left = `${cx - size / 2}px`;
  bubble.style.top = `${cy - size / 2}px`;
}

function startTimerUi() {
  stopTimerUi();
  AppState.timerInterval = setInterval(() => {
    $('#cb-timer').textContent = fmtTime(recorder.getElapsedMs() / 1000);
    syncControlPip();
  }, 250);
}

function stopTimerUi() {
  if (AppState.timerInterval) clearInterval(AppState.timerInterval);
  AppState.timerInterval = null;
  $('#cb-timer').textContent = '0:00';
}

async function finishRecording() {
  const result = await recorder.stop();
  showRecordingChrome(false);

  if (!result || result.blob.size === 0) {
    if (result && result.sessionId) PenguDB.clearSession(result.sessionId).catch(() => {});
    toast('Nothing was recorded', 'error');
    location.hash = '#/';
    return;
  }

  const duration = Math.max(0.1, result.duration);
  AppState.current = {
    id: uuid(),
    blob: result.blob,
    url: URL.createObjectURL(result.blob),
    duration,
    mode: AppState.setupMode,
    title: `Untitled video - ${fmtDate(Date.now())}`,
    trimStart: 0,
    trimEnd: duration,
    notes: AppState.notes,
    hasAudio: !!result.hasAudio,
    mimeType: result.blob.type,
    sessionId: result.sessionId, // recovery data, cleared on save or discard
  };
  location.hash = '#/preview';
}

async function cancelRecording() {
  await recorder.cancel();
  showRecordingChrome(false);
  toast('Recording cancelled');
  location.hash = '#/';
}

/* Draggable bubble: pointer events, position stored as surface fractions. */
(function initBubbleDrag() {
  const bubble = $('#cam-bubble');
  let dragging = false;

  bubble.addEventListener('pointerdown', (e) => {
    dragging = true;
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const size = bubble.offsetWidth;
    const cx = Math.min(Math.max(e.clientX, size / 2), window.innerWidth - size / 2);
    const cy = Math.min(Math.max(e.clientY, size / 2), window.innerHeight - size / 2);
    const f = clientToSurfaceFraction(cx, cy);
    recorder.bubble.x = Math.min(Math.max(f.x, 0), 1);
    recorder.bubble.y = Math.min(Math.max(f.y, 0), 1);
    bubble.style.left = `${cx - size / 2}px`;
    bubble.style.top = `${cy - size / 2}px`;
  });
  bubble.addEventListener('pointerup', () => { dragging = false; });
  bubble.addEventListener('pointercancel', () => { dragging = false; });

  window.addEventListener('resize', () => {
    if (recorder.state !== 'idle' && recorder.mode === 'screen-cam' && recorder.cameraStream) syncBubbleGeometry();
  });
})();

/* ---------------- presenter notes ----------------
   Rendered in a Document Picture-in-Picture window whenever the browser
   supports it (Chrome/Edge 116+): a real native window the presenter can
   drag to ANY monitor, always on top, and — because it is a separate
   window rather than part of this tab — never captured when sharing a
   tab or a window. The one exception is sharing the ENTIRE screen: then
   anything visible on that monitor is recorded, notes window included,
   so the caveat toast in startRecording tells the user to park it on a
   different monitor. Browsers without PiP fall back to the in-tab
   overlay, which only stays invisible if a tab or window is shared. */

function renderNotesPanel() {
  const text = AppState.notes || '(no notes)';
  const fontSize = `${AppState.notesFont}px`;
  const bodies = [$('#notes-panel-body')];
  if (AppState.notesPipWin && !AppState.notesPipWin.closed) {
    bodies.push(AppState.notesPipWin.document.querySelector('#notes-panel-body'));
  }
  for (const body of bodies) {
    if (!body) continue;
    body.textContent = text;
    body.style.fontSize = fontSize;
  }
  if (AppState.notesPos) {
    const panel = $('#notes-panel');
    panel.style.right = 'auto';
    panel.style.left = `${AppState.notesPos.left}px`;
    panel.style.top = `${AppState.notesPos.top}px`;
  }
}

function closeNotesPip() {
  const pip = AppState.notesPipWin;
  if (!pip) return;
  AppState.notesPipWin = null;
  try { pip.close(); } catch { /* already gone */ }
}

/* ---------------- floating control bar (Document Picture-in-Picture) ---------------- */

/* A native always-on-top window with a live copy of the control bar, so the
   controls survive alt-tabbing to whatever is being recorded. Buttons drive
   the same handlers as the in-tab bar; state is mirrored 4x per second. */
async function openControlPip() {
  if (!('documentPictureInPicture' in window)) return false;
  try {
    if (AppState.ctrlPipWin && !AppState.ctrlPipWin.closed) return true;
    const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 72 });
    AppState.ctrlPipWin = pip;
    pip.document.title = 'Recording — Pengu Recorder';

    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          const link = pip.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pip.document.head.appendChild(link);
        } else {
          const style = pip.document.createElement('style');
          style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
          pip.document.head.appendChild(style);
        }
      } catch { /* cross-origin sheet: skip */ }
    }
    const extra = pip.document.createElement('style');
    extra.textContent = `
      body { margin: 0; height: 100vh; display: flex; align-items: center;
             justify-content: center; background: #14132b; overflow: hidden; }
      .control-bar--pip { position: static !important; transform: none !important;
             box-shadow: none !important; }`;
    pip.document.head.appendChild(extra);

    const bar = $('#control-bar').cloneNode(true);
    bar.removeAttribute('id');
    const hideBtn = bar.querySelector('#cb-hide');
    if (hideBtn) hideBtn.remove(); // nothing to hide: this copy is out of the capture
    bar.classList.remove('hidden');
    bar.classList.add('control-bar--pip');
    pip.document.body.appendChild(bar);

    const wire = (sel, fn) => {
      const el = bar.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    };
    wire('#cb-pause', togglePause);
    wire('#cb-restart', async () => {
      await recorder.restart();
      $('#control-bar').classList.remove('paused');
      setPauseIcon(false);
      toast('Recording restarted');
    });
    wire('#cb-cancel', cancelRecording);
    wire('#cb-finish', finishRecording);
    wire('#cb-mute', toggleMute);
    wire('#cb-notes', () => setNotesOpen(!AppState.notesOpen));

    pip.addEventListener('pagehide', () => {
      if (AppState.ctrlPipWin === pip) AppState.ctrlPipWin = null;
      updateBarVisibility(); // controls must not vanish with the window
    });
    syncControlPip();
    updateBarVisibility();
    return true;
  } catch (err) {
    console.warn('Control bar PiP unavailable', err);
    AppState.ctrlPipWin = null;
    return false;
  }
}

function closeControlPip() {
  const pip = AppState.ctrlPipWin;
  if (!pip) return;
  AppState.ctrlPipWin = null;
  try { pip.close(); } catch { /* already gone */ }
}

/* Mirror the in-tab bar into the floating copy: timer, paused/muted state,
   the icons that swap, and the audio warning chip. */
function syncControlPip() {
  const pip = AppState.ctrlPipWin;
  if (!pip || pip.closed) return;
  const src = $('#control-bar');
  const dst = pip.document.querySelector('.control-bar--pip');
  if (!dst) return;
  dst.classList.toggle('paused', src.classList.contains('paused'));
  const copyText = (sel) => {
    const a = src.querySelector(sel); const b = dst.querySelector(sel);
    if (a && b && b.textContent !== a.textContent) b.textContent = a.textContent;
  };
  copyText('#cb-timer');
  const copyState = (sel) => {
    const a = src.querySelector(sel); const b = dst.querySelector(sel);
    if (!a || !b) return;
    if (b.innerHTML !== a.innerHTML) b.innerHTML = a.innerHTML;
    b.className = a.className;
    b.setAttribute('aria-pressed', a.getAttribute('aria-pressed') || 'false');
  };
  copyState('#cb-pause');
  copyState('#cb-mute');
  copyState('#cb-notes');
  const warnA = src.querySelector('#audio-warning'); const warnB = dst.querySelector('#audio-warning');
  if (warnA && warnB) warnB.classList.toggle('hidden', warnA.classList.contains('hidden'));
}

async function openNotesPip() {
  if (!('documentPictureInPicture' in window)) return false;
  try {
    if (AppState.notesPipWin && !AppState.notesPipWin.closed) {
      AppState.notesPipWin.focus();
      return true;
    }
    const pip = await window.documentPictureInPicture.requestWindow({ width: 440, height: 560 });
    // The user may have toggled notes off while the window was opening.
    if (!AppState.notesOpen) { try { pip.close(); } catch { /* already gone */ } return true; }
    AppState.notesPipWin = pip;
    pip.document.title = 'Presenter notes — Pengu Recorder';

    // Re-apply the theme inside the PiP document: linked sheets by href,
    // same-origin inline sheets by rule text. Cross-origin sheets are skipped.
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href) {
          const link = pip.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pip.document.head.appendChild(link);
        } else {
          const style = pip.document.createElement('style');
          style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
          pip.document.head.appendChild(style);
        }
      } catch { /* cross-origin sheet: skip */ }
    }

    // Clone the in-tab panel markup into the PiP window and wire its buttons.
    // Fresh clone on every open, so listeners never stack.
    const panel = $('#notes-panel').cloneNode(true);
    panel.removeAttribute('id');
    panel.classList.remove('hidden');
    panel.classList.add('notes-panel--pip');
    panel.style.cssText = '';
    pip.document.body.appendChild(panel);
    Object.assign(pip.document.body.style, {
      margin: '0', height: '100vh', overflow: 'hidden', background: '#14132b',
    });

    const pipBody = panel.querySelector('#notes-panel-body');
    pipBody.textContent = AppState.notes || '(no notes)';
    pipBody.style.fontSize = `${AppState.notesFont}px`;
    panel.querySelector('#notes-close').addEventListener('click', () => setNotesOpen(false));
    panel.querySelector('#notes-font-up').addEventListener('click', () => {
      AppState.notesFont = Math.min(28, AppState.notesFont + 2);
      renderNotesPanel();
    });
    panel.querySelector('#notes-font-down').addEventListener('click', () => {
      AppState.notesFont = Math.max(12, AppState.notesFont - 2);
      renderNotesPanel();
    });

    // Native window close (X) or navigation must release the toggle state.
    pip.addEventListener('pagehide', () => {
      if (AppState.notesPipWin !== pip) return;
      AppState.notesPipWin = null;
      AppState.notesOpen = false;
      $('#cb-notes').classList.remove('active');
      $('#cb-notes').setAttribute('aria-pressed', 'false');
    });
    return true;
  } catch {
    return false;
  }
}

async function setNotesOpen(open) {
  AppState.notesOpen = open;
  const show = open && recorder.state !== 'idle';
  $('#cb-notes').classList.toggle('active', show);
  $('#cb-notes').setAttribute('aria-pressed', show ? 'true' : 'false');
  if (!show) {
    closeNotesPip();
    $('#notes-panel').classList.add('hidden');
    return;
  }
  const inPip = await openNotesPip();
  // The in-tab overlay only shows when the browser has no PiP support.
  $('#notes-panel').classList.toggle('hidden', inPip);
  if (!inPip) renderNotesPanel();
}

function initNotesPanel() {
  $('#cb-notes').addEventListener('click', () => setNotesOpen(!AppState.notesOpen));
  $('#notes-close').addEventListener('click', () => setNotesOpen(false));
  $('#notes-font-up').addEventListener('click', () => {
    AppState.notesFont = Math.min(28, AppState.notesFont + 2);
    renderNotesPanel();
  });
  $('#notes-font-down').addEventListener('click', () => {
    AppState.notesFont = Math.max(12, AppState.notesFont - 2);
    renderNotesPanel();
  });

  // Draggable by its header (same pointer pattern as the camera bubble).
  const panel = $('#notes-panel');
  const header = $('#notes-panel-header');
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.notes-btn')) return; // let the buttons work
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const left = Math.min(Math.max(e.clientX - offsetX, 0), window.innerWidth - panel.offsetWidth);
    const top = Math.min(Math.max(e.clientY - offsetY, 0), window.innerHeight - 60);
    AppState.notesPos = { left, top };
    panel.style.right = 'auto';
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  header.addEventListener('pointerup', () => { dragging = false; });
  header.addEventListener('pointercancel', () => { dragging = false; });
}

/* ---------------- region crop editor ----------------
   Trims edges off the captured frame before it is encoded, so the Windows
   taskbar, the browser tab strip, or anything else sitting at the border never
   reaches the file. A crop routes the take through the compositing canvas,
   which costs a re-encode, so the uncropped screen path stays direct. */

const CROP_MIN_VISIBLE = 0.15;   // never leave less than this much of an axis

const clampNum = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** Share of the captured frame taken by the Windows taskbar, or null when it
    is not inside the shared surface at all. */
function taskbarCropFraction() {
  if (recorder.getBubbleSpace().kind !== 'monitor') return null;
  /* availHeight reports the work area, so the difference is the taskbar. It
     reads zero when the taskbar auto-hides, where 48px at 100% scaling is the
     Windows default and the user can still drag from there. */
  const taskbarPx = Math.max(0, window.screen.height - window.screen.availHeight) || 48;
  return taskbarPx / window.screen.height;
}

/** Same for the browser's own tab strip and address bar. */
function browserBarCropFraction() {
  const space = recorder.getBubbleSpace();
  const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
  if (!chromeH) return null;
  if (space.kind === 'window') return chromeH / window.outerHeight;
  if (space.kind === 'monitor') {
    return clampNum((window.screenY + chromeH) / window.screen.height, 0, 0.5);
  }
  return null;   // sharing a tab: the browser chrome is outside the capture
}

/** Resolves true when the user confirms the region, false when they back out. */
function openCropEditor() {
  return new Promise((resolve) => {
    const overlay = $('#crop-overlay');
    const video = $('#crop-video');
    const stage = $('#crop-stage');
    const box = $('#crop-box');
    const readout = $('#crop-readout');
    const crop = { ...recorder.crop };
    const ac = new AbortController();
    const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

    const render = () => {
      box.style.left = (crop.left * 100) + '%';
      box.style.top = (crop.top * 100) + '%';
      box.style.width = ((1 - crop.left - crop.right) * 100) + '%';
      box.style.height = ((1 - crop.top - crop.bottom) * 100) + '%';

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) { readout.textContent = 'Reading the shared screen...'; return; }
      const outW = Math.round(vw * (1 - crop.left - crop.right));
      const outH = Math.round(vh * (1 - crop.top - crop.bottom));
      const dropped = [];
      if (crop.top > 0.001) dropped.push(Math.round(vh * crop.top) + 'px off the top');
      if (crop.bottom > 0.001) dropped.push(Math.round(vh * crop.bottom) + 'px off the bottom');
      if (crop.left > 0.001) dropped.push(Math.round(vw * crop.left) + 'px off the left');
      if (crop.right > 0.001) dropped.push(Math.round(vw * crop.right) + 'px off the right');
      readout.textContent = dropped.length
        ? 'Video will be ' + outW + ' x ' + outH + ', dropping ' + dropped.join(', ') + '.'
        : 'Video will be the full ' + vw + ' x ' + vh + ' frame.';
    };

    const setEdge = (edge, value) => {
      // A zero-sized stage (hidden tab, mid-layout) would hand us NaN and
      // poison the crop for the rest of the session.
      if (!Number.isFinite(value)) return;
      crop[edge] = clampNum(value, 0, 1 - crop[opposite[edge]] - CROP_MIN_VISIBLE);
      render();
    };

    document.querySelectorAll('.crop-handle').forEach((handle) => {
      const edge = handle.dataset.edge;
      let dragging = false;
      on(handle, 'pointerdown', (e) => {
        dragging = true;
        // Throws when the pointer is already gone, which must not break the drag.
        try { handle.setPointerCapture(e.pointerId); } catch { /* keep going */ }
        e.preventDefault();
      });
      on(handle, 'pointermove', (e) => {
        if (!dragging) return;
        const r = stage.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;
        const fy = (e.clientY - r.top) / r.height;
        if (edge === 'left') setEdge('left', fx);
        else if (edge === 'right') setEdge('right', 1 - fx);
        else if (edge === 'top') setEdge('top', fy);
        else setEdge('bottom', 1 - fy);
      });
      on(handle, 'pointerup', () => { dragging = false; });
      on(handle, 'pointercancel', () => { dragging = false; });

      // Keyboard equivalent: each handle is focusable, arrows move the edge.
      on(handle, 'keydown', (e) => {
        const dir = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
        if (dir === undefined) return;
        e.preventDefault();
        const step = (e.shiftKey ? 0.02 : 0.005) * dir;
        // Top and left grow with the pointer, bottom and right grow against it.
        const delta = (edge === 'bottom' || edge === 'right') ? -step : step;
        setEdge(edge, crop[edge] + delta);
      });
    });

    document.querySelectorAll('.crop-presets [data-preset]').forEach((btn) => {
      on(btn, 'click', () => {
        const preset = btn.dataset.preset;
        if (preset === 'reset') {
          crop.top = 0; crop.right = 0; crop.bottom = 0; crop.left = 0;
          render();
          return;
        }
        const fraction = preset === 'taskbar' ? taskbarCropFraction() : browserBarCropFraction();
        if (fraction === null) {
          toast(preset === 'taskbar'
            ? 'The taskbar is not inside what you are sharing.'
            : 'The browser bars are not inside what you are sharing.');
          return;
        }
        setEdge(preset === 'taskbar' ? 'bottom' : 'top', fraction);
      });
    });

    const close = (result) => {
      ac.abort();
      overlay.classList.add('hidden');
      video.srcObject = null;
      resolve(result);
    };

    on($('#crop-confirm'), 'click', () => {
      recorder.crop = { ...crop };
      if (recorder.hasCrop && recorder.mode === 'screen') {
        toast('Cropping re-encodes the screen through a canvas, so expect a little more CPU use.');
      }
      close(true);
    });
    on($('#crop-cancel'), 'click', () => close(false));
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });

    on(video, 'loadedmetadata', render);
    video.srcObject = recorder.screenStream;
    overlay.classList.remove('hidden');
    render();
    $('#crop-confirm').focus();
  });
}

/* ---------------- playback trimming ---------------- */

/* Property assignment (not addEventListener) so re-entering a view never
   stacks duplicate listeners on the reused <video> elements. */
function attachTrimPlayback(video, getStart, getEnd) {
  video.onplay = () => {
    if (video.currentTime < getStart() || video.currentTime >= getEnd() - 0.05) {
      video.currentTime = getStart();
    }
  };
  video.ontimeupdate = () => {
    if (video.currentTime < getStart()) {
      video.currentTime = getStart();
    } else if (video.currentTime >= getEnd()) {
      video.pause();
      video.currentTime = getEnd();
    }
  };
}

/* MediaRecorder webm files often report Infinity duration; nudge the
   element to the end once so metadata resolves to the real length. */
function fixWebmDuration(video) {
  video.onloadedmetadata = () => {
    if (video.duration === Infinity) {
      video.currentTime = Number.MAX_SAFE_INTEGER;
      video.ondurationchange = () => {
        if (video.duration !== Infinity) {
          video.ondurationchange = null;
          video.currentTime = 0;
        }
      };
    }
  };
  video.onerror = () => {
    toast('Could not load this recording', 'error');
  };
}

/** Read the real duration of a blob URL. Resolves null if the file is unreadable. */
function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.onerror = () => resolve(null);
    v.onloadedmetadata = () => {
      if (v.duration !== Infinity) { resolve(v.duration); return; }
      v.currentTime = Number.MAX_SAFE_INTEGER;
      v.ondurationchange = () => {
        if (v.duration !== Infinity) {
          v.ondurationchange = null;
          resolve(v.duration);
        }
      };
    };
    v.src = url;
  });
}

/* ---------------- preview view ---------------- */

function enterPreview() {
  const c = AppState.current;
  const video = $('#preview-video');

  video.src = c.url;
  $('#preview-audio-note').classList.toggle('hidden', c.hasAudio !== false);
  fixWebmDuration(video);
  attachTrimPlayback(video, () => c.trimStart, () => c.trimEnd);

  $('#preview-title').value = c.title;

  const startSlider = $('#trim-start');
  const endSlider = $('#trim-end');
  startSlider.max = c.duration;
  endSlider.max = c.duration;
  startSlider.value = c.trimStart;
  endSlider.value = c.trimEnd;

  const updateLabels = () => {
    $('#trim-start-val').textContent = fmtTime(c.trimStart);
    $('#trim-end-val').textContent = fmtTime(c.trimEnd);
    $('#trim-label').textContent = `Keeping ${fmtTime(c.trimStart)} – ${fmtTime(c.trimEnd)} of ${fmtTime(c.duration)}`;
  };
  updateLabels();

  startSlider.oninput = () => {
    c.trimStart = Math.min(parseFloat(startSlider.value), c.trimEnd - 0.1);
    startSlider.value = c.trimStart;
    video.currentTime = c.trimStart;
    updateLabels();
  };
  endSlider.oninput = () => {
    c.trimEnd = Math.max(parseFloat(endSlider.value), c.trimStart + 0.1);
    endSlider.value = c.trimEnd;
    video.currentTime = c.trimEnd;
    updateLabels();
  };
}

/* Seek to `at` seconds and capture a 320x180 JPEG thumbnail.
   Always settles: a webm whose duration never resolves must not hang the save. */
function makeThumbnail(url, at) {
  const capture = new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const fail = () => resolve(null);
    v.addEventListener('error', fail);
    v.addEventListener('loadedmetadata', () => {
      if (v.duration === Infinity) v.currentTime = Number.MAX_SAFE_INTEGER;
      else v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1));
    });
    v.addEventListener('durationchange', () => {
      if (v.duration !== Infinity) v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1));
    });
    v.addEventListener('seeked', () => {
      try {
        if (!v.videoWidth || v.duration === Infinity) return; // wait for the real duration
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        canvas.getContext('2d').drawImage(v, 0, 0, 320, 180);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        fail();
      }
    });
    v.src = url;
  });
  return withTimeout(capture, 4000, null);
}

async function saveCurrent() {
  const c = AppState.current;
  if (!c) return;
  c.title = $('#preview-title').value.trim() || `Untitled video - ${fmtDate(Date.now())}`;

  const saveBtn = $('#save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const thumbnail = await makeThumbnail(c.url, c.trimStart + 0.5);
  try {
    await PenguDB.save({
      id: c.id,
      title: c.title,
      createdAt: Date.now(),
      duration: c.duration,
      mode: c.mode,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      thumbnail,
      notes: c.notes || '',
      views: 0, // real counter; incremented on each watch-view open
      size: c.blob.size,
      mimeType: c.blob.type,
    }, c.blob);

    if (c.sessionId) PenguDB.clearSession(c.sessionId).catch(() => {});
    toast('Saved to library', 'success');
    AppState.current = null;
    location.hash = '#/';
  } catch (err) {
    const est = await PenguDB.estimate();
    const hint = est && est.freeBytes < c.blob.size
      ? 'not enough browser storage left — delete a video and retry'
      : 'storage error';
    toast(`Could not save: ${hint}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to library';
  }
}

function discardCurrent() {
  const c = AppState.current;
  if (c) {
    URL.revokeObjectURL(c.url);
    if (c.sessionId) PenguDB.clearSession(c.sessionId).catch(() => {});
  }
  AppState.current = null;
  toast('Recording discarded');
  location.hash = '#/';
}

/* ---------------- thumbnails ---------------- */

/* The frame on screen, as a JPEG at YouTube's thumbnail size: 1280 x 720
   for a video, 1080 x 1920 for a Short. Cover-fit, so an odd-shaped take
   is cropped rather than letterboxed. */
function saveThumbnail(video, title) {
  if (!video || video.readyState < 2 || !video.videoWidth) {
    toast('The video is still loading. Try again in a moment.', 'error');
    return;
  }
  const vertical = video.videoHeight > video.videoWidth;
  const [W, H] = vertical ? [1080, 1920] : [1280, 720];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(W / video.videoWidth, H / video.videoHeight);
  const sw = W / scale;
  const sh = H / scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, W, H);
  canvas.toBlob((blob) => {
    if (!blob) { toast('Could not capture this frame', 'error'); return; }
    triggerDownload(blob, `${safeFileName(title)} - thumbnail.jpg`);
    toast(`Thumbnail saved (${W} x ${H}). Pause on another frame to pick a different one.`, 'success');
  }, 'image/jpeg', 0.92);
}

/* ---------------- downloads: MP4 / WebM, trimmed ---------------- */

function safeFileName(title) {
  return (title || '').replace(/[^\w\- ]+/g, '').trim() || 'pengu-recording';
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoking straight away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Download `v` ({ blob, title, duration, trimStart, trimEnd }) as `format`.
 * The original file goes out untouched when it already is that format and
 * nothing was trimmed; anything else is re-encoded by converter.js.
 */
async function downloadVideo(v, format) {
  if (AppState.exportAbort) return; // one export at a time
  const native = PenguRecorder.formatOf(v.blob.type);
  const start = v.trimStart || 0;
  const end = v.trimEnd ?? v.duration;
  const trimmed = start > 0.05 || end < v.duration - 0.05;
  const name = `${safeFileName(v.title)}.${format}`;

  if (format === native && !trimmed) {
    triggerDownload(v.blob, name);
    return;
  }
  if (!PenguRecorder.formatSupported(format)) {
    toast(format === 'mp4'
      ? 'This browser cannot encode MP4. Use Chrome or Edge 126 or newer, or download WebM.'
      : 'This browser cannot encode WebM. Download MP4 instead.', 'error');
    return;
  }

  const ac = new AbortController();
  AppState.exportAbort = ac;
  openExportDialog(format, { convert: format !== native, trimmed, seconds: end - start });
  try {
    const out = await PenguConverter.exportVideo(v.blob, {
      format,
      start,
      // Untrimmed: play to the real end, which can run a little past the
      // timer-based duration we stored.
      end: trimmed ? end : Infinity,
      duration: v.duration,
      signal: ac.signal,
      onProgress: setExportProgress,
    });
    triggerDownload(out, name);
    toast(`${format.toUpperCase()} ready`, 'success');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      toast('Export cancelled');
    } else {
      console.warn('Export failed', err);
      toast('Export failed. Try the other format, or download the original.', 'error');
    }
  } finally {
    AppState.exportAbort = null;
    $('#export-overlay').classList.add('hidden');
  }
}

function openExportDialog(format, { convert, trimmed, seconds }) {
  const label = format.toUpperCase();
  $('#export-title').textContent = `Preparing your ${label}`;
  const what = convert && trimmed ? `Converting to ${label} and cutting it to your trim.`
    : convert ? `Converting to ${label}.`
      : 'Cutting the video to your trim.';
  $('#export-sub').textContent =
    `${what} The video plays once in the background, so this takes about ${fmtTime(seconds)}. Keep this tab open.`;
  setExportProgress(0);
  $('#export-overlay').classList.remove('hidden');
  $('#export-cancel').focus();
}

function setExportProgress(fraction) {
  const pct = Math.round(fraction * 100);
  $('#export-fill').style.width = `${pct}%`;
  $('#export-readout').textContent = `${pct}%`;
  $('#export-overlay .export-bar').setAttribute('aria-valuenow', String(pct));
}

/* ---------------- watch view ---------------- */

function releaseWatchUrl() {
  const video = $('#watch-video');
  if (video.dataset.objectUrl) {
    URL.revokeObjectURL(video.dataset.objectUrl);
    delete video.dataset.objectUrl;
  }
  video.removeAttribute('src');
}

async function enterWatch(id) {
  const record = await PenguDB.get(id);
  const blob = record ? await PenguDB.getBlob(id) : null;
  if (!record || !blob) {
    toast('Video not found', 'error');
    location.hash = '#/';
    return;
  }

  /* Real view counter. `patch` only rewrites the metadata record — the old code
     put the blob back on every open, copying the whole file each time. Repeat
     opens in the same tab session do not re-count. */
  const seenKey = `pengu-seen-${id}`;
  if (!sessionStorage.getItem(seenKey)) {
    sessionStorage.setItem(seenKey, '1');
    record.views = (record.views ?? 0) + 1;
    await PenguDB.patch(id, { views: record.views });
  } else {
    record.views = record.views ?? 0;
  }

  const video = $('#watch-video');
  releaseWatchUrl();
  const url = URL.createObjectURL(blob);
  video.dataset.objectUrl = url;
  video.src = url;

  const start = record.trimStart ?? 0;
  const end = record.trimEnd ?? record.duration;
  fixWebmDuration(video);
  attachTrimPlayback(video, () => start, () => end);
  video.addEventListener('loadedmetadata', () => { video.currentTime = start; }, { once: true });

  $('#watch-title').textContent = record.title;
  $('#watch-meta').textContent =
    `${fmtDate(record.createdAt)} · ${fmtTime(end - start)} · ${record.views} view${record.views === 1 ? '' : 's'}`;

  // Presenter notes saved with the video (absent on older records).
  const hasNotes = !!(record.notes && record.notes.trim());
  $('#watch-notes').classList.toggle('hidden', !hasNotes);
  if (hasNotes) $('#watch-notes-text').textContent = record.notes;

  const asDownload = () => ({
    blob, title: record.title, duration: record.duration, trimStart: start, trimEnd: end,
  });
  $('#watch-download-mp4').onclick = () => downloadVideo(asDownload(), 'mp4');
  $('#watch-download-webm').onclick = () => downloadVideo(asDownload(), 'webm');
  $('#watch-thumb').onclick = () => saveThumbnail(video, record.title);

  $('#watch-delete').onclick = async () => {
    await PenguDB.remove(record.id);
    releaseWatchUrl();
    toast('Video deleted');
    location.hash = '#/';
  };
}

/* ---------------- crash recovery ---------------- */

async function checkRecovery() {
  let sessions = [];
  try {
    sessions = await PenguDB.listSessions();
  } catch {
    return;
  }
  // A session written to in the last 15 s is probably a take running in
  // another tab, not an orphan — leave it alone.
  sessions = sessions.filter((s) => Date.now() - (s.updatedAt || 0) > 15000);
  if (!sessions.length) return;

  // Newest orphaned session wins; older leftovers are dropped.
  const [session, ...stale] = sessions;
  stale.forEach((s) => PenguDB.clearSession(s.sessionId).catch(() => {}));

  AppState.recovery = session;
  const banner = $('#recovery-banner');
  const secs = Math.round((session.durationMs || 0) / 1000);
  $('#recovery-detail').textContent =
    ` — about ${fmtTime(secs)} recorded on ${fmtDate(session.startedAt)}, saved before the tab closed.`;
  banner.classList.remove('hidden');
}

async function restoreRecovery() {
  const session = AppState.recovery;
  if (!session) return;
  $('#recovery-banner').classList.add('hidden');

  const parts = await PenguDB.getChunks(session.sessionId);
  if (!parts.length) {
    toast('Nothing left to recover', 'error');
    return;
  }
  const type = (session.mimeType || 'video/webm').split(';')[0];
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const probed = await withTimeout(probeDuration(url), 4000, null);
  const duration = Math.max(0.1, probed || (session.durationMs || 0) / 1000 || 1);

  AppState.current = {
    id: uuid(),
    blob,
    url,
    duration,
    mode: session.mode || 'screen',
    title: `Recovered video - ${fmtDate(session.startedAt || Date.now())}`,
    trimStart: 0,
    trimEnd: duration,
    notes: '',
    sessionId: session.sessionId,
  };
  AppState.recovery = null;
  toast('Recording recovered', 'success');
  location.hash = '#/preview';
}

async function discardRecovery() {
  const session = AppState.recovery;
  AppState.recovery = null;
  $('#recovery-banner').classList.add('hidden');
  if (session) await PenguDB.clearSession(session.sessionId).catch(() => {});
  toast('Unsaved recording discarded');
}

/* ---------------- static event wiring ---------------- */

function setPauseIcon(paused) {
  $('#cb-pause-icon').innerHTML = paused
    ? '<path fill="currentColor" d="M8 5v14l11-7z"/>'
    : '<path fill="currentColor" d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/>';
  const btn = $('#cb-pause');
  btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  btn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
}

function togglePause() {
  if (recorder.state === 'recording') {
    recorder.pause();
    $('#control-bar').classList.add('paused');
    setPauseIcon(true);
  } else if (recorder.state === 'paused') {
    recorder.resume();
    $('#control-bar').classList.remove('paused');
    setPauseIcon(false);
  }
}

function toggleMute() {
  const muted = !recorder.muted;
  recorder.setMuted(muted);
  const btn = $('#cb-mute');
  btn.classList.toggle('muted', muted);
  btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  btn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  $('#cb-mic-on').classList.toggle('hidden', muted);
  $('#cb-mic-off').classList.toggle('hidden', !muted);
  toast(muted ? 'Microphone muted' : 'Microphone unmuted');
}

function closeNewVideoMenu() {
  $('#new-video-menu').classList.add('hidden');
  $('#new-video-btn').setAttribute('aria-expanded', 'false');
}

function initEvents() {
  // "+ New video" dropdown.
  const newBtn = $('#new-video-btn');
  const menu = $('#new-video-menu');
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('hidden') === false;
    newBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', () => {
    closeNewVideoMenu();
    // AudioContexts created without a user gesture start suspended (autoplay
    // policy); resume the mic-meter context on the first interaction.
    if (AppState.meterCtx && AppState.meterCtx.state === 'suspended') {
      AppState.meterCtx.resume().catch(() => {});
    }
  });
  menu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      AppState.setupMode = item.dataset.mode;
      closeNewVideoMenu();
      location.hash = '#/record';
    });
  });

  $('#empty-record-btn').addEventListener('click', () => {
    AppState.setupMode = 'screen-cam';
    location.hash = '#/record';
  });

  $('#nav-notifications').addEventListener('click', (e) => {
    e.preventDefault();
    toast("You're all caught up!");
  });

  // Setup view.
  document.querySelectorAll('#setup-modes .mode-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      AppState.setupMode = btn.dataset.mode;
      selectModeButton(AppState.setupMode);
      await acquireForMode(AppState.setupMode);
    });
  });
  $('#record-back').addEventListener('click', () => { location.hash = '#/'; });
  $('#start-recording-btn').addEventListener('click', startRecording);
  $('#notes-input').addEventListener('input', (e) => { AppState.notes = e.target.value; });

  $('#cam-device').addEventListener('change', async (e) => {
    AppState.cameraId = e.target.value || null;
    await acquireForMode(AppState.setupMode);
  });
  $('#mic-device').addEventListener('change', async (e) => {
    AppState.micId = e.target.value || null;
    await acquireForMode(AppState.setupMode);
  });
  $('#crop-step').addEventListener('change', (e) => {
    if (!e.target.checked) recorder.crop = { top: 0, right: 0, bottom: 0, left: 0 };
  });
  $('#hifi-audio').addEventListener('change', async (e) => {
    AppState.hiFiAudio = e.target.checked;
    await acquireForMode(AppState.setupMode);
  });
  $('#quality').addEventListener('change', (e) => { AppState.quality = e.target.value; savePrefs(); });
  $('#format').addEventListener('change', (e) => { AppState.format = e.target.value; savePrefs(); });

  // Studio layout. The preview reads AppState.studio every frame, so a
  // change shows up without restarting anything.
  const studioChange = (key) => (e) => {
    AppState.studio[key] = e.target.value;
    savePrefs();
    renderTemplatePicker();
  };
  $('#cam-size').addEventListener('change', studioChange('cameraSize'));
  $('#studio-side').addEventListener('change', studioChange('cameraSide'));
  $('#studio-shape').addEventListener('change', studioChange('cameraShape'));
  $('#studio-corner').addEventListener('change', studioChange('cameraCorner'));
  $('#studio-name').addEventListener('input', (e) => { AppState.studio.name = e.target.value; savePrefs(); });
  document.querySelectorAll('.aspect-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      AppState.studio.aspect = btn.dataset.aspect;
      // A Short is watched on a phone: the camera reads best on top.
      if (btn.dataset.aspect === 'vertical') {
        AppState.studio.cameraSide = 'left';
        $('#studio-side').value = 'left';
      }
      savePrefs();
      applyStudioAspect();
    });
  });

  // Drop an image file onto the gallery to add it as a background.
  const gallery = $('#bg-gallery');
  gallery.addEventListener('dragover', (e) => {
    e.preventDefault();
    gallery.classList.add('drag-over');
  });
  gallery.addEventListener('dragleave', () => gallery.classList.remove('drag-over'));
  gallery.addEventListener('drop', (e) => {
    e.preventDefault();
    gallery.classList.remove('drag-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) addBackgroundFile(file);
  });

  // Devices come and go (headset unplugged, external cam attached).
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (recorder.state === 'idle' && parseRoute().name === 'record') populateDeviceSelects();
    });
  }

  initNotesPanel();

  // Control bar.
  $('#cb-pause').addEventListener('click', togglePause);
  $('#cb-restart').addEventListener('click', async () => {
    await recorder.restart();
    $('#control-bar').classList.remove('paused');
    setPauseIcon(false);
    toast('Recording restarted');
  });
  $('#cb-cancel').addEventListener('click', cancelRecording);
  $('#cb-finish').addEventListener('click', finishRecording);
  $('#cb-mute').addEventListener('click', toggleMute);
  $('#cb-hide').addEventListener('click', () => setBarHidden(true));

  // Keyboard shortcuts, ignored while typing.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNewVideoMenu();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || !e.altKey || recorder.state === 'idle') return;
    const key = e.key.toLowerCase();
    if (key === 's') { e.preventDefault(); finishRecording(); }
    else if (key === 'p') { e.preventDefault(); togglePause(); }
    else if (key === 'm') { e.preventDefault(); toggleMute(); }
    else if (key === 'n') { e.preventDefault(); setNotesOpen(!AppState.notesOpen); }
    else if (key === 'h') { e.preventDefault(); setBarHidden(!AppState.barHidden); }
  });

  // Closing the tab mid-take: warn, and rely on the flushed chunks otherwise.
  window.addEventListener('beforeunload', (e) => {
    if (recorder.state === 'idle' && !AppState.current) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // Preview view.
  $('#copy-link-btn').addEventListener('click', async () => {
    const c = AppState.current;
    if (!c) return;
    const link = `${location.origin}${location.pathname}#/v/${c.id}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard API can fail outside secure contexts; fall back to a selection hack.
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Link copied — it only opens in this browser profile', 'success');
  });
  const downloadCurrent = (format) => {
    const c = AppState.current;
    if (!c) return;
    c.title = $('#preview-title').value.trim() || c.title;
    downloadVideo(c, format);
  };
  $('#download-mp4-btn').addEventListener('click', () => downloadCurrent('mp4'));
  $('#download-webm-btn').addEventListener('click', () => downloadCurrent('webm'));
  $('#thumb-btn').addEventListener('click', () => {
    const c = AppState.current;
    if (c) saveThumbnail($('#preview-video'), $('#preview-title').value.trim() || c.title);
  });
  $('#export-cancel').addEventListener('click', () => {
    if (AppState.exportAbort) AppState.exportAbort.abort();
  });
  $('#save-btn').addEventListener('click', saveCurrent);
  $('#discard-btn').addEventListener('click', discardCurrent);

  // Watch view.
  $('#watch-back').addEventListener('click', () => { location.hash = '#/'; });

  // Recovery banner.
  $('#recovery-restore').addEventListener('click', restoreRecovery);
  $('#recovery-discard').addEventListener('click', discardRecovery);

  window.addEventListener('hashchange', router);
}

/* ---------------- boot ---------------- */

loadPrefs();
initEvents();
router();
PenguDB.requestPersistence(); // keeps the browser from evicting saved videos
checkRecovery();
