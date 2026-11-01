const api = window.penguDesktop;
const $ = (sel) => document.querySelector(sel);

let state = { state: 'idle', elapsedMs: 0, muted: false, mic: true };
let receivedAt = Date.now();

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function tick() {
  const running = state.state === 'recording';
  $('#time').textContent = fmt(state.elapsedMs + (running ? Date.now() - receivedAt : 0));
}

function apply(next) {
  state = next;
  receivedAt = Date.now();
  const paused = state.state === 'paused';
  $('#bar').classList.toggle('paused', paused);
  $('#pause-icon').classList.toggle('hidden', paused);
  $('#play-icon').classList.toggle('hidden', !paused);
  $('#pause').title = paused ? 'Resume (Alt+Shift+P)' : 'Pause (Alt+Shift+P)';
  $('#bar').classList.toggle('muted', !!state.muted || !state.mic);
  $('#mute').disabled = !state.mic;
  $('#mute').title = !state.mic ? 'Microphone is off for this take' : (state.muted ? 'Unmute (Alt+Shift+M)' : 'Mute microphone (Alt+Shift+M)');
  $('#notes').classList.toggle('active', !!state.notesOpen);
  tick();
}

for (const cmd of ['stop', 'pause', 'mute', 'notes']) {
  $(`#${cmd}`).addEventListener('click', () => api.send('bar:cmd', cmd));
}

/* Starting over and deleting both throw the take away, so each wants a
   second click within three seconds. */
for (const cmd of ['restart', 'delete']) {
  const btn = $(`#${cmd}`);
  const title = btn.title;
  let armed = null;
  btn.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      btn.classList.remove('armed');
      btn.title = title;
      api.send('bar:cmd', cmd);
      return;
    }
    btn.classList.add('armed');
    btn.title = cmd === 'delete' ? 'Click again to delete' : 'Click again to start over';
    armed = setTimeout(() => {
      armed = null;
      btn.classList.remove('armed');
      btn.title = title;
    }, 3000);
  });
}

api.on('rec:state', apply);
api.on('notes:state', (open) => $('#notes').classList.toggle('active', open));
api.invoke('state:get').then(apply);
setInterval(tick, 250);
