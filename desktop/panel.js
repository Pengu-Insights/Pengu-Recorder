/* The launcher: pick what to record, with what, and go. Docked on the right,
   kept out of every capture by the main process. */

const api = window.penguDesktop;
const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = 'pengu-recorder:prefs';
const CAMERA_OFF = '__off';
const PICK_WINDOW = '__windows';

let settings = {};
let sources = [];

/* ---------- the Studio look lives in the template editor's preferences ---------- */

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeStudio(patch) {
  const prefs = readPrefs();
  prefs.studio = { ...(prefs.studio || {}), ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ }
}

function renderTemplate() {
  const studio = readPrefs().studio || {};
  const t = studio.template || 'side';
  $('#tpl').value = t;
  $('#tpl-shape').value = studio.cameraShape || 'portrait';
  $('#tpl-corner').value = studio.cameraCorner || 'br';
  $('#tpl-corner').classList.toggle('hidden', t !== 'corner' && t !== 'framed-corner');
  $('#tpl-shape').classList.toggle('hidden', t === 'split');
}

/* ---------- settings ---------- */

async function set(patch) {
  Object.assign(settings, patch);
  settings = await api.invoke('settings:set', patch);
  render();
}

function selectSeg(root, value) {
  root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === value ? 'true' : 'false'));
}

function currentSource() {
  return sources.find((s) => s.id === $('#source').value) || null;
}

function render() {
  selectSeg($('#layout'), settings.layout);
  selectSeg($('#taskbar'), settings.taskbar);

  const layout = settings.layout;
  const source = currentSource();
  const usesScreen = layout !== 'camera';
  $('#source-row').classList.toggle('off', !usesScreen);
  $('#source').disabled = !usesScreen;
  $('#camera-row').classList.toggle('off', layout === 'screen');
  $('#camera').disabled = layout === 'screen';
  $('#template-group').classList.toggle('hidden', layout !== 'studio');
  $('#taskbar-group').classList.toggle('hidden', !usesScreen || !source || source.kind !== 'screen');

  const mic = $('#mic-toggle');
  mic.classList.toggle('on', settings.micOn);
  mic.textContent = settings.micOn ? 'On' : 'Off';
  mic.setAttribute('aria-pressed', settings.micOn ? 'true' : 'false');
  $('#mic-row').classList.toggle('off', !settings.micOn);

  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.checked = !!settings[input.dataset.setting];
  });
  if (layout === 'studio') renderTemplate();
}

/* ---------- sources and devices ---------- */

function fillSources(list) {
  sources = list;
  const sel = $('#source');
  const keep = settings.sourceId;
  sel.innerHTML = '';
  const screens = list.filter((s) => s.kind === 'screen');
  const windows = list.filter((s) => s.kind === 'window');
  for (const s of screens) sel.add(new Option(s.name, s.id));
  if (!windows.length) sel.add(new Option('A single window…', PICK_WINDOW));
  if (windows.length) {
    const group = document.createElement('optgroup');
    group.label = 'A single window';
    for (const s of windows) group.appendChild(new Option(s.name.length > 48 ? `${s.name.slice(0, 46)}…` : s.name, s.id));
    sel.appendChild(group);
  }
  if (keep && list.some((s) => s.id === keep)) sel.value = keep;
  else if (screens[0]) sel.value = screens[0].id;
}

async function fillDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch { /* no devices API */ }
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');

  const cam = $('#camera');
  cam.innerHTML = '';
  cam.add(new Option('No camera', CAMERA_OFF));
  cams.forEach((d, i) => cam.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  const camKnown = cams.some((d) => d.deviceId === settings.cameraId);
  cam.value = !settings.cameraOn ? CAMERA_OFF : (camKnown ? settings.cameraId : (cams[0] ? cams[0].deviceId : CAMERA_OFF));

  const mic = $('#mic');
  mic.innerHTML = '';
  if (!mics.length) mic.add(new Option('No microphone found', ''));
  mics.forEach((d, i) => mic.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId === 'default' ? '' : d.deviceId)));
  mic.value = mics.some((d) => d.deviceId === settings.micId) ? settings.micId : '';
}

/* ---------- banner ---------- */

let bannerDir = null;
function showBanner({ kind, text, dir }) {
  const b = $('#banner');
  b.className = `banner ${kind === 'saved' ? '' : kind}`;
  $('#banner-text').textContent = text;
  bannerDir = dir || null;
  $('#banner-open').classList.toggle('hidden', !dir);
  b.classList.remove('hidden');
}

/* ---------- wiring ---------- */

$('#close').addEventListener('click', () => api.send('win:close'));
$('#banner-dismiss').addEventListener('click', () => $('#banner').classList.add('hidden'));
$('#banner-open').addEventListener('click', () => api.send('win:folder', bannerDir));

/* Windows are listed only on request: asking for them takes a few seconds. */
async function loadWindows() {
  const sel = $('#source');
  const previous = settings.sourceId;
  sel.innerHTML = '';
  sel.add(new Option('Finding windows…', ''));
  sel.disabled = true;
  const list = await api.invoke('panel:sources');
  sel.disabled = false;
  fillSources(list);
  const first = list.find((s) => s.kind === 'window');
  if (first) {
    sel.value = first.id;
    set({ sourceId: first.id });
    try { sel.showPicker(); } catch { /* the click that asked has expired */ }
  } else {
    sel.value = previous || (list[0] && list[0].id);
  }
}

$('#source').addEventListener('change', (e) => {
  if (e.target.value === PICK_WINDOW) loadWindows();
  else set({ sourceId: e.target.value });
});
$('#camera').addEventListener('change', (e) => {
  const off = e.target.value === CAMERA_OFF;
  set(off ? { cameraOn: false } : { cameraOn: true, cameraId: e.target.value });
});
$('#mic').addEventListener('change', (e) => set({ micId: e.target.value }));
$('#mic-toggle').addEventListener('click', () => set({ micOn: !settings.micOn }));

$('#layout').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) set({ layout: b.dataset.v });
});
$('#taskbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) set({ taskbar: b.dataset.v });
});

$('#tpl').addEventListener('change', (e) => { writeStudio({ template: e.target.value }); renderTemplate(); });
$('#tpl-shape').addEventListener('change', (e) => writeStudio({ cameraShape: e.target.value }));
$('#tpl-corner').addEventListener('change', (e) => writeStudio({ cameraCorner: e.target.value }));
$('#tpl-edit').addEventListener('click', () => api.send('win:templates'));

document.querySelectorAll('[data-setting]').forEach((input) => {
  input.addEventListener('change', () => set({ [input.dataset.setting]: input.checked }));
});

$('#t-notes').addEventListener('click', () => api.send('win:notes'));
$('#t-templates').addEventListener('click', () => api.send('win:templates'));
$('#t-folder').addEventListener('click', () => api.send('win:folder'));
const toggleMore = (open) => {
  $('#more').classList.toggle('hidden', !open);
  $('#t-more').setAttribute('aria-expanded', open ? 'true' : 'false');
};
$('#t-more').addEventListener('click', () => toggleMore($('#more').classList.contains('hidden')));
$('#more-close').addEventListener('click', () => toggleMore(false));

$('#start').addEventListener('click', async () => {
  const btn = $('#start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  $('#banner').classList.add('hidden');
  toggleMore(false);
  await api.invoke('rec:start').catch(() => {});
});

api.on('panel:banner', showBanner);
api.on('notes:state', (open) => $('#t-notes').setAttribute('aria-pressed', open ? 'true' : 'false'));
api.on('rec:state', ({ state }) => {
  if (state === 'idle') {
    $('#start').disabled = false;
    $('#start').textContent = 'Start recording';
  }
});

window.addEventListener('storage', (e) => {
  if (e.key === PREFS_KEY && settings.layout === 'studio') renderTemplate();
});

fillDevices();
navigator.mediaDevices.addEventListener('devicechange', fillDevices);

(async function init() {
  const data = await api.invoke('panel:init');
  settings = data.settings;
  fillSources(data.sources);
  const folder = data.folder.split(/[\\/]/).slice(-2).join(' › ');
  $('#hint').textContent = `Saves to ${folder}`;
  $('#hint').title = data.folder;
  render();
  fillDevices();
}());
