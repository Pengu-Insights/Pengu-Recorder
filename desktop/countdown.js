const n = document.querySelector('#n');
window.penguDesktop.on('countdown:tick', (value) => {
  n.textContent = value;
  n.classList.remove('pop');
  void n.offsetWidth; // restart the animation
  n.classList.add('pop');
});
