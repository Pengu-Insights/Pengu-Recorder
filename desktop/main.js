/* ============================================================
   main.js: the desktop shell (Electron main process).

   Why a desktop app at all: a web page cannot keep its own windows out of a
   full-screen recording. Windows can (SetWindowDisplayAffinity with
   WDA_EXCLUDEFROMCAPTURE, which Electron exposes as setContentProtection).
   Every window that is ours and is not meant to be filmed gets it: the
   launcher panel, the control bar, the notes and the countdown. They stay
   visible to you and are absent from the video and from screenshots.

   Windows:
     panel     the launcher, docked on the right (Loom-style)
     bar       vertical controls on the left while recording
     notes     speaker notes, never captured
     countdown 3-2-1 before a take
     engine    hidden; runs the recorder (js/recorder.js) and streams every
               version of the take straight to files on disk
     library   the original web app (index.html), for templates and the
               saved-in-browser library; opened on demand
   ============================================================ */

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, session, globalShortcut, Menu,
} = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(ROOT, 'assets', 'pengu-recorder.ico');

app.setAppUserModelId('io.penguinsights.recorder');
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ---------------- settings ---------------- */

const DEFAULTS = {
  layout: 'studio',        // 'screen' | 'screen-cam' | 'camera' | 'studio'
  sourceId: null,          // desktopCapturer id; null = the primary screen
  cameraOn: true,
  cameraId: '',
  micOn: true,
  micId: '',
  systemAudio: true,
  taskbar: 'fill',         // 'show' | 'cut' | 'fill'
  countdown: true,
  saveCamera: true,        // also write the camera alone
  saveScreen: false,       // also write the screen alone (each extra file costs frames)
  openFolder: true,
  notes: '',
  notesFont: 20,
  notesBounds: null,
  folder: null,            // null = Videos\Pengu Recorder
};
let settings = { ...DEFAULTS };

const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULTS[k]) settings[k] = saved[k];
      else if (saved[k] !== undefined && DEFAULTS[k] === null) settings[k] = saved[k];
    }
  } catch { /* first run, or an unreadable file: defaults */ }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises.writeFile(settingsFile(), JSON.stringify(settings, null, 2)).catch(() => {});
  }, 300);
}

const saveFolder = () => settings.folder || path.join(app.getPath('videos'), 'Pengu Recorder');

/* ---------------- windows ---------------- */

const win = {};

function baseWebPreferences(extra = {}) {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    ...extra,
  };
}

/* Nothing in the app navigates; links to the web open in the real browser. */
function lockDown(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
}

function floating(file, opts) {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: ICON,
    webPreferences: baseWebPreferences(),
    ...opts,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setContentProtection(true);   // the whole point: never in a capture
  w.setMenu(null);
  lockDown(w);
  w.loadFile(path.join(__dirname, file));
  return w;
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function createPanel() {
  const W = 340;
  const H = 700;
  const a = workArea();
  win.panel = floating('panel.html', {
    width: W,
    height: H,
    x: a.x + a.width - W - 12,
    y: a.y + Math.max(12, Math.round((a.height - H) / 2)),
    skipTaskbar: false,
    title: 'Pengu Recorder',
  });
  win.panel.once('ready-to-show', () => win.panel.show());
  win.panel.on('closed', () => { win.panel = null; });
}

function showPanel(banner) {
  if (!win.panel) createPanel();
  if (banner) win.panel.webContents.send('panel:banner', banner);
  win.panel.show();
  win.panel.focus();
}

function createEngine() {
  win.engine = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    skipTaskbar: true,
    webPreferences: baseWebPreferences({ backgroundThrottling: false }),
  });
  lockDown(win.engine);
  win.engine.loadFile(path.join(__dirname, 'engine.html'));
  win.engine.webContents.once('did-finish-load', () => {
    callEngine('prepare', { layout: settings.layout, source: resolveSource() }).catch(() => {});
  });
  win.engine.on('closed', () => { win.engine = null; });
}

function createBar() {
  const W = 64;
  const H = 400;
  const a = workArea();
  win.bar = floating('bar.html', {
    width: W,
    height: H,
    x: a.x + 12,
    y: a.y + Math.round((a.height - H) / 2),
    focusable: true,
  });
  win.bar.on('closed', () => { win.bar = null; });
}

function createNotes() {
  const a = workArea();
  const b = settings.notesBounds;
  win.notes = floating('notes.html', {
    width: b ? b.width : 380,
    height: b ? b.height : 480,
    x: b ? b.x : a.x + a.width - 380 - 364,
    y: b ? b.y : a.y + Math.round((a.height - 480) / 2),
    resizable: true,
    minWidth: 240,
    minHeight: 160,
    transparent: false,
    backgroundColor: '#14161F',
  });
  const remember = () => {
    if (!win.notes) return;
    settings.notesBounds = win.notes.getBounds();
    saveSettings();
  };
  win.notes.on('moved', remember);
  win.notes.on('resized', remember);
  win.notes.once('ready-to-show', () => win.notes.show());
  win.notes.on('closed', () => {
    win.notes = null;
    broadcast('notes:state', false);
  });
  broadcast('notes:state', true);
}

function toggleNotes(open) {
  const isOpen = !!win.notes;
  const want = open === undefined ? !isOpen : open;
  if (want && !isOpen) createNotes();
  if (!want && isOpen) win.notes.close();
}

function createCountdown() {
  const S = 220;
  const d = screen.getPrimaryDisplay().bounds;
  win.countdown = floating('countdown.html', {
    width: S,
    height: S,
    x: d.x + Math.round((d.width - S) / 2),
    y: d.y + Math.round((d.height - S) / 2),
    focusable: false,
  });
  win.countdown.setIgnoreMouseEvents(true);
  win.countdown.on('closed', () => { win.countdown = null; });
}

function openLibrary(hash = '') {
  if (win.library) {
    if (hash) win.library.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    win.library.show();
    win.library.focus();
    return;
  }
  win.library = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    icon: ICON,
    title: 'Pengu Recorder',
    backgroundColor: '#F7F7F0',
    webPreferences: baseWebPreferences(),
  });
  win.library.setMenu(null);
  lockDown(win.library);
  win.library.loadFile(path.join(ROOT, 'index.html'), { hash: hash.replace(/^#/, '') });
  win.library.once('ready-to-show', () => win.library.show());
  win.library.on('closed', () => { win.library = null; });
}

function broadcast(channel, payload) {
  for (const w of Object.values(win)) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/* ---------------- capture sources ---------------- */

function ownSourceIds() {
  return new Set(Object.values(win)
    .filter((w) => w && !w.isDestroyed())
    .map((w) => w.getMediaSourceId()));
}

/* Asking Windows for its capture sources takes two to three seconds on some
   laptops (hybrid graphics), and the main process is stuck meanwhile. So
   screens are named from the display list, which is instant, and windows
   are only listed when someone asks to record a single window. */
function displayInfo(d) {
  return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

function screenName(d, index, count, primary) {
  return count > 1 ? `Screen ${index + 1}${d.id === primary.id ? ' (main)' : ''}` : 'Full screen';
}

let listedScreens = null;  // exact ids, once Windows has been asked
let listedWindows = [];

function quickScreens() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.map((d, i) => ({
    id: `screen:${i}:0`, kind: 'screen', name: screenName(d, i, displays.length, primary), display: displayInfo(d),
  }));
}

function knownSources() {
  return [...(listedScreens || quickScreens()), ...listedWindows];
}

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const mine = ownSourceIds();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  listedScreens = screens.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id) || primary;
    return { id: s.id, kind: 'screen', name: screenName(d, i, screens.length, primary), display: displayInfo(d) };
  });
  listedWindows = sources
    .filter((s) => !s.id.startsWith('screen:') && !mine.has(s.id) && s.name && s.name.trim())
    .map((s) => ({ id: s.id, kind: 'window', name: s.name }));
  return knownSources();
}

function resolveSource() {
  const sources = knownSources();
  const screens = sources.filter((s) => s.kind === 'screen');
  return sources.find((s) => s.id === settings.sourceId)
    || screens.find((s) => /main|Full/.test(s.name))
    || screens[0]
    || null;
}

/* ---------------- engine RPC ---------------- */

let rpcSeq = 0;
const rpcWaiting = new Map();

function callEngine(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!win.engine) { reject(new Error('engine-missing')); return; }
    const id = ++rpcSeq;
    rpcWaiting.set(id, { resolve, reject });
    win.engine.webContents.send('engine:call', { id, method, args });
  });
}

ipcMain.on('engine:reply', (e, { id, ok, result, error }) => {
  const waiting = rpcWaiting.get(id);
  if (!waiting) return;
  rpcWaiting.delete(id);
  if (ok) waiting.resolve(result); else waiting.reject(new Error(error));
});

/* ---------------- the take on disk ---------------- */

const FILE_NAMES = {
  main: 'video', camera: 'camera', screen: 'screen', reel: 'reel', short: 'short', youtube: 'youtube',
};

let take = null;   // { dir, base, ext, queues, streams, labels }

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function beginTake({ ext, keys }) {
  const base = `Pengu ${stamp()}`;
  const dir = path.join(saveFolder(), base);
  fs.mkdirSync(dir, { recursive: true });
  take = { dir, base, ext, queues: new Map(), streams: new Map(), labels: new Map(keys.map((k) => [k.key, k.label])) };
}

function takeFile(t, key) {
  return path.join(t.dir, `${t.base} - ${FILE_NAMES[key] || key}.${t.ext}`);
}

function endStream(ws) {
  return new Promise((resolve) => ws.end(resolve));
}

/* Chunks of one file are written strictly in order. A newer generation
   (the take was restarted) truncates the file and starts it over. */
function enqueue(key, job) {
  const prev = take.queues.get(key) || Promise.resolve();
  const next = prev.then(job).catch((err) => console.error('write failed', key, err));
  take.queues.set(key, next);
  return next;
}

ipcMain.on('take:chunk', (e, key, gen, bytes) => {
  if (!take || !take.labels.has(key)) return;
  const t = take;
  enqueue(key, async () => {
    let s = t.streams.get(key);
    if (s && gen < s.gen) return;
    if (!s || gen > s.gen) {
      if (s) await endStream(s.ws);
      s = { gen, ws: fs.createWriteStream(takeFile(t, key), { flags: 'w' }) };
      t.streams.set(key, s);
    }
    if (!s.ws.write(Buffer.from(bytes))) await new Promise((r) => s.ws.once('drain', r));
  });
});

async function finishTake() {
  const t = take;
  take = null;
  if (!t) return [];
  await Promise.all([...t.queues.values()]);
  await Promise.all([...t.streams.values()].map((s) => endStream(s.ws)));
  const files = [];
  for (const key of t.streams.keys()) {
    const file = takeFile(t, key);
    try {
      const { size } = fs.statSync(file);
      if (size > 0) files.push({ key, label: t.labels.get(key) || key, file, size });
      else fs.rmSync(file, { force: true });
    } catch { /* never written */ }
  }
  if (!files.length) fs.rmSync(t.dir, { recursive: true, force: true });
  return files;
}

async function discardTake() {
  const t = take;
  take = null;
  if (!t) return;
  await Promise.all([...t.queues.values()]);
  await Promise.all([...t.streams.values()].map((s) => endStream(s.ws)));
  // Only ever the folder this take created.
  fs.rmSync(t.dir, { recursive: true, force: true });
}

/* ---------------- recording flow ---------------- */

const rec = {
  state: 'idle',           // 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
  elapsedMs: 0,
  since: 0,                // Date.now() when the running stretch began
  muted: false,
};

function publishState() {
  broadcast('rec:state', {
    state: rec.state,
    elapsedMs: rec.elapsedMs + (rec.state === 'recording' ? Date.now() - rec.since : 0),
    muted: rec.muted,
    mic: settings.micOn,
    notesOpen: !!win.notes,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCountdown() {
  if (!settings.countdown) return;
  if (!win.countdown) createCountdown();
  await new Promise((r) => (win.countdown.webContents.isLoading()
    ? win.countdown.webContents.once('did-finish-load', r) : r()));
  win.countdown.showInactive();
  for (const n of [3, 2, 1]) {
    win.countdown.webContents.send('countdown:tick', n);
    await sleep(750);
  }
  win.countdown.hide();
}

const SHORTCUTS = {
  'Alt+Shift+S': () => stopRecording(),
  'Alt+Shift+P': () => togglePause(),
  'Alt+Shift+M': () => toggleMute(),
  'Alt+Shift+N': () => toggleNotes(),
};

function setShortcuts(on) {
  for (const [accel, fn] of Object.entries(SHORTCUTS)) {
    if (on) globalShortcut.register(accel, fn);
    else globalShortcut.unregister(accel);
  }
}

async function startRecording(overrides = {}) {
  if (rec.state !== 'idle') return { ok: false, error: 'busy' };
  Object.assign(settings, overrides);
  saveSettings();
  rec.state = 'starting';
  publishState();

  const source = resolveSource();
  if (win.panel) win.panel.hide();
  // Closed rather than hidden: it frees its camera, and reopens fresh.
  if (win.library) win.library.close();

  const cfg = {
    layout: settings.layout,
    source,
    cameraOn: settings.cameraOn,
    cameraId: settings.cameraId,
    micOn: settings.micOn,
    micId: settings.micId,
    systemAudio: settings.systemAudio,
    taskbar: settings.taskbar,
    saveCamera: settings.saveCamera,
    saveScreen: settings.saveScreen,
  };

  try {
    // Streams open while the countdown runs, so the 3-2-1 costs no extra time.
    const [info] = await Promise.all([callEngine('acquire', cfg), runCountdown()]);
    beginTake(info);
    await callEngine('go');
  } catch (err) {
    console.error('start failed:', err.message);
    if (win.countdown) win.countdown.hide();
    await callEngine('cancel').catch(() => {});
    await discardTake().catch(() => {});
    rec.state = 'idle';
    publishState();
    const why = /screen/.test(err.message) ? 'Could not capture that screen or window. Pick another source.'
      : /camera/.test(err.message) ? 'The camera is not available. Check it is not in use by another app.'
        : `Could not start: ${err.message}`;
    showPanel({ kind: 'error', text: why });
    return { ok: false, error: err.message };
  }

  rec.state = 'recording';
  rec.elapsedMs = 0;
  rec.since = Date.now();
  rec.muted = false;
  if (!win.bar) createBar();
  win.bar.showInactive();
  setShortcuts(true);
  publishState();
  return { ok: true };
}

async function stopRecording() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  rec.state = 'stopping';
  publishState();
  setShortcuts(false);
  if (win.bar) win.bar.hide();

  let files = [];
  let error = null;
  try {
    await callEngine('stop');
    files = await finishTake();
  } catch (err) {
    error = err.message;
  }
  rec.state = 'idle';
  rec.elapsedMs = 0;
  publishState();

  if (!files.length) {
    showPanel({ kind: 'error', text: error ? `Saving failed: ${error}` : 'Nothing was recorded.' });
    return;
  }
  const main = files.find((f) => f.key === 'main') || files[0];
  showPanel({
    kind: 'saved',
    text: files.length === 1 ? 'Saved 1 video' : `Saved ${files.length} videos`,
    files: files.map((f) => ({ label: f.label, name: path.basename(f.file), size: f.size })),
    dir: path.dirname(main.file),
  });
  if (settings.openFolder) shell.showItemInFolder(main.file);
}

async function togglePause() {
  if (rec.state === 'recording') {
    await callEngine('pause');
    rec.elapsedMs += Date.now() - rec.since;
    rec.state = 'paused';
  } else if (rec.state === 'paused') {
    await callEngine('resume');
    rec.since = Date.now();
    rec.state = 'recording';
  }
  publishState();
}

async function toggleMute() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  rec.muted = !rec.muted;
  await callEngine('mute', rec.muted);
  publishState();
}

async function restartRecording() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  await callEngine('restart');
  rec.state = 'recording';
  rec.elapsedMs = 0;
  rec.since = Date.now();
  publishState();
}

async function deleteRecording() {
  if (rec.state !== 'recording' && rec.state !== 'paused') return;
  rec.state = 'stopping';
  setShortcuts(false);
  if (win.bar) win.bar.hide();
  await callEngine('cancel').catch(() => {});
  await discardTake().catch(() => {});
  rec.state = 'idle';
  publishState();
  showPanel({ kind: 'info', text: 'Recording deleted.' });
}

ipcMain.on('engine:autostop', () => stopRecording());

/* ---------------- IPC from the windows ---------------- */

ipcMain.handle('panel:init', () => ({
  settings,
  sources: knownSources(),
  folder: saveFolder(),
  state: rec.state,
}));

ipcMain.handle('panel:sources', () => listSources());

ipcMain.handle('settings:set', (e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULTS && (typeof v === typeof DEFAULTS[k] || DEFAULTS[k] === null)) settings[k] = v;
  }
  saveSettings();
  if (patch && ('layout' in patch || 'sourceId' in patch)) {
    callEngine('prepare', { layout: settings.layout, source: resolveSource() }).catch(() => {});
  }
  return settings;
});

ipcMain.handle('rec:start', (e, overrides) => {
  const allowed = {};
  if (overrides && ['screen', 'screen-cam', 'camera', 'studio'].includes(overrides.layout)) {
    allowed.layout = overrides.layout;
  }
  return startRecording(allowed);
});

ipcMain.on('bar:cmd', (e, cmd) => {
  if (cmd === 'stop') stopRecording();
  else if (cmd === 'pause') togglePause();
  else if (cmd === 'restart') restartRecording();
  else if (cmd === 'delete') deleteRecording();
  else if (cmd === 'mute') toggleMute();
  else if (cmd === 'notes') toggleNotes();
});

ipcMain.on('win:notes', (e, open) => toggleNotes(open));
ipcMain.on('win:templates', () => openLibrary('#/record?mode=studio'));
ipcMain.on('win:library', () => openLibrary('#/'));
ipcMain.on('win:folder', (e, dir) => {
  const target = typeof dir === 'string' && dir.startsWith(saveFolder()) ? dir : saveFolder();
  fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
});
ipcMain.on('win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w === win.panel) {
    if (rec.state === 'idle') app.quit();
    else w.hide();
  } else if (w) {
    w.close();
  }
});
ipcMain.on('win:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});

ipcMain.handle('notes:get', () => ({ text: settings.notes, font: settings.notesFont }));
ipcMain.on('notes:set', (e, { text, font } = {}) => {
  if (typeof text === 'string') settings.notes = text.slice(0, 200000);
  if (typeof font === 'number') settings.notesFont = Math.min(48, Math.max(12, Math.round(font)));
  saveSettings();
});

ipcMain.handle('state:get', () => ({
  state: rec.state,
  elapsedMs: rec.elapsedMs + (rec.state === 'recording' ? Date.now() - rec.since : 0),
  muted: rec.muted,
  mic: settings.micOn,
  notesOpen: !!win.notes,
}));

/* ---------------- app lifecycle ---------------- */

app.on('second-instance', () => {
  if (rec.state === 'idle') showPanel();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadSettings();

  // Camera and microphone for our own pages only; nothing else is ever asked.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = details.requestingUrl || wc.getURL();
    const own = url.startsWith('file:');
    // Screen capture only for the engine, the one page that records.
    const engine = own && url.endsWith('/desktop/engine.html');
    cb((own && (permission === 'media' || permission === 'clipboard-sanitized-write'))
      || (engine && permission === 'display-capture'));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && (!origin || origin.startsWith('file')));

  createEngine();
  createPanel();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
