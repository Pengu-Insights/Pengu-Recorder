const api = window.penguDesktop;
const text = document.querySelector('#text');
let font = 20;

function setFont(px) {
  font = Math.min(48, Math.max(12, px));
  text.style.fontSize = `${font}px`;
}

let saveTimer = null;
text.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.send('notes:set', { text: text.value }), 300);
});

document.querySelector('#smaller').addEventListener('click', () => {
  setFont(font - 2);
  api.send('notes:set', { font });
});
document.querySelector('#bigger').addEventListener('click', () => {
  setFont(font + 2);
  api.send('notes:set', { font });
});
document.querySelector('#close').addEventListener('click', () => {
  api.send('notes:set', { text: text.value });
  api.send('win:close');
});

api.invoke('notes:get').then(({ text: saved, font: size }) => {
  text.value = saved || '';
  setFont(size || 20);
});
