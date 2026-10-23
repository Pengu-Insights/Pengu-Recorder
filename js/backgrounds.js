/* ============================================================
   backgrounds.js — backdrops for the Studio layout.

   Three sources, one id scheme:
     preset:<name>  painted procedurally on a canvas at whatever size the
                    take needs. Nothing to download, and a 4K take gets a
                    4K backdrop instead of an upscaled JPEG.
     file:<name>    images shipped in assets/backgrounds/ (see BUNDLED).
     user:<id>      images the user added (an AI-generated wallpaper, a
                    brand slide). Stored as blobs in IndexedDB (db.js
                    `backgrounds`), so they never leave the browser.
   ============================================================ */

const PenguBackgrounds = (() => {
  const DEFAULT_ID = 'preset:blue-white';
  const MAX_UPLOAD_BYTES = 25e6;

  /* glows: [x, y, radius, colour, alpha] — x/y as fractions of the frame,
     radius as a fraction of its longer side. */
  const PRESETS = [
    /* Blue and white first: the Pengu colours, and the light ones keep a
       bright, clean look behind a dark screen. */
    { id: 'blue-white', label: 'Blue & white', base: ['#FFFFFF', '#E6EFFD'], vignette: 0.04, grain: 0.5,
      glows: [[0.00, 0.00, 0.55, '#1455C8', 0.40], [1.00, 1.00, 0.60, '#1455C8', 0.45], [0.85, 0.10, 0.35, '#7FB2FF', 0.35]] },
    { id: 'sky', label: 'Sky', base: ['#F7FAFF', '#C9DDFB'], vignette: 0.04, grain: 0.5,
      glows: [[0.20, 0.20, 0.50, '#FFFFFF', 0.90], [0.85, 0.85, 0.55, '#4B86E8', 0.35]] },
    { id: 'blue-waves', label: 'Blue waves', kind: 'waves', base: ['#FFFFFF', '#E3EDFD'], line: '#1455C8',
      vignette: 0.03, grain: 0.5, glows: [[0.50, 1.00, 0.55, '#4B86E8', 0.25]] },
    { id: 'blue-grid', label: 'Blue grid', kind: 'grid', base: ['#FFFFFF', '#EDF3FE'], dot: 'rgba(20, 85, 200, 0.16)',
      vignette: 0.03, grain: 0.5, glows: [[0.90, 0.10, 0.45, '#4B86E8', 0.25], [0.10, 0.90, 0.45, '#1455C8', 0.20]] },
    { id: 'royal', label: 'Royal blue', base: ['#0B3A8C', '#1455C8'],
      glows: [[0.15, 0.15, 0.50, '#FFFFFF', 0.22], [0.90, 0.90, 0.55, '#4B86E8', 0.55]] },
    { id: 'blue-split', label: 'Blue & white split', kind: 'split', base: ['#FFFFFF', '#F1F6FF'], band: ['#0F409A', '#1455C8'],
      vignette: 0.03, grain: 0.5, glows: [] },
    { id: 'aurora', label: 'Aurora', base: ['#0B1026', '#1B1F4B'],
      glows: [[0.12, 0.18, 0.55, '#19E3B1', 0.50], [0.88, 0.22, 0.50, '#7B5CFF', 0.60], [0.55, 1.00, 0.60, '#2E7BFF', 0.50]] },
    { id: 'pengu', label: 'Pengu', base: ['#0A2E6E', '#1455C8'],
      glows: [[0.10, 0.90, 0.60, '#4B86E8', 0.60], [0.90, 0.10, 0.45, '#7FB2FF', 0.45], [0.82, 0.88, 0.25, '#E9F13A', 0.22]] },
    { id: 'sunset', label: 'Sunset', base: ['#2B1055', '#D53A6B'],
      glows: [[0.20, 0.95, 0.60, '#FF8A3D', 0.65], [0.85, 0.15, 0.50, '#FF4E8A', 0.45], [0.55, 0.45, 0.35, '#FFC857', 0.25]] },
    { id: 'ocean', label: 'Ocean', base: ['#04161F', '#0E4A5E'],
      glows: [[0.15, 0.15, 0.55, '#1FC8DB', 0.40], [0.85, 0.85, 0.60, '#2C7BE5', 0.45]] },
    { id: 'lavender', label: 'Lavender', base: ['#E9E4FF', '#FDE7F3'], vignette: 0.06, grain: 0.6,
      glows: [[0.10, 0.20, 0.50, '#B9A7FF', 0.55], [0.90, 0.80, 0.55, '#FFB3D9', 0.55], [0.75, 0.10, 0.35, '#A7D8FF', 0.45]] },
    { id: 'peach', label: 'Peach', base: ['#FFE8D6', '#FFD3DD'], vignette: 0.06, grain: 0.6,
      glows: [[0.85, 0.15, 0.55, '#FF9A8B', 0.45], [0.15, 0.85, 0.55, '#FFC39E', 0.50]] },
    { id: 'forest', label: 'Forest', base: ['#06261C', '#12432F'],
      glows: [[0.20, 0.25, 0.50, '#2FD283', 0.35], [0.85, 0.80, 0.55, '#A3E635', 0.25]] },
    { id: 'waves', label: 'Night waves', kind: 'waves', base: ['#070B24', '#1E1B4B'], line: '#7C8CFF',
      glows: [[0.50, 0.55, 0.55, '#4F46E5', 0.35]] },
    { id: 'bokeh', label: 'Neon bokeh', kind: 'bokeh', base: ['#12002A', '#2A0845'],
      palette: ['#FF3CAC', '#2BD2FF', '#784BA0', '#FFD86F'],
      glows: [[0.50, 0.50, 0.60, '#6A11CB', 0.35]] },
    { id: 'graphite', label: 'Graphite', kind: 'grid', base: ['#121419', '#232731'],
      glows: [[0.80, 0.20, 0.50, '#3B82F6', 0.22], [0.15, 0.85, 0.45, '#A855F7', 0.18]] },
  ];

  /* Images shipped with the app, e.g. AI-generated wallpapers. Drop a file in
     assets/backgrounds/ and list it here: { id: 'file:<name>', label, src }. */
  const BUNDLED = [];

  const cache = new Map();      // `${id}@${w}x${h}` -> canvas
  const CACHE_LIMIT = 6;
  const thumbCache = new Map(); // preset id -> data URL
  let userUrls = [];            // object URLs handed out by list(), revoked on the next call
  let grainTile = null;

  /* ---------- painting ---------- */

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /* Deterministic RNG, so a preset paints the same at every size. */
  function seeded(seed) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Smooth gradients band badly once H.264 or VP9 quantise them. A faint
     noise layer breaks the bands up before the encoder sees them. */
  function getGrainTile() {
    if (grainTile) return grainTile;
    grainTile = document.createElement('canvas');
    grainTile.width = 128;
    grainTile.height = 128;
    const g = grainTile.getContext('2d');
    const img = g.createImageData(128, 128);
    const rand = seeded(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.round(rand() * 255);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      img.data[i + 3] = 14;
    }
    g.putImageData(img, 0, 0);
    return grainTile;
  }

  function paintWaves(ctx, w, h, p) {
    const lines = 16;
    const step = Math.max(4, w / 160);
    ctx.lineWidth = Math.max(1, h / 540 * 1.4);
    for (let i = 0; i < lines; i++) {
      ctx.strokeStyle = rgba(p.line, 0.08 + 0.16 * (1 - i / lines));
      ctx.beginPath();
      for (let x = 0; x <= w + step; x += step) {
        const u = x / w;
        const y = h * (0.42 + i * 0.022)
          + Math.sin(u * Math.PI * 2.2 + i * 0.32) * h * 0.07
          + Math.sin(u * Math.PI * 0.9 + i * 0.6) * h * 0.05;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function paintBokeh(ctx, w, h, p) {
    const rand = seeded(42);
    for (let i = 0; i < 46; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = h * (0.015 + rand() * 0.1);
      const c = p.palette[i % p.palette.length];
      const a = 0.08 + rand() * 0.22;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, a));
      g.addColorStop(0.7, rgba(c, a * 0.6));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paintGrid(ctx, w, h, p) {
    const gap = Math.min(w, h) / 27;
    const r = Math.max(0.8, Math.min(w, h) / 700);
    ctx.fillStyle = p.dot || 'rgba(255, 255, 255, 0.10)';
    for (let y = gap / 2; y < h; y += gap) {
      for (let x = gap / 2; x < w; x += gap) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* A diagonal blue band across a white field. */
  function paintSplit(ctx, w, h, p) {
    const g = ctx.createLinearGradient(0, h, w, 0);
    g.addColorStop(0, p.band[0]);
    g.addColorStop(1, p.band[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.62);
    ctx.lineTo(w, h * 0.30);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(20, 85, 200, 0.25)';
    ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.012);
    ctx.beginPath();
    ctx.moveTo(0, h * 0.57);
    ctx.lineTo(w, h * 0.25);
    ctx.stroke();
  }

  function paintPreset(ctx, w, h, p) {
    const base = ctx.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, p.base[0]);
    base.addColorStop(1, p.base[1]);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    if (p.kind === 'grid') paintGrid(ctx, w, h, p);
    if (p.kind === 'split') paintSplit(ctx, w, h, p);

    const m = Math.max(w, h);
    for (const [x, y, r, c, a] of p.glows || []) {
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * m);
      g.addColorStop(0, rgba(c, a));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    if (p.kind === 'waves') paintWaves(ctx, w, h, p);
    if (p.kind === 'bokeh') paintBokeh(ctx, w, h, p);

    const vig = ctx.createRadialGradient(w / 2, h / 2, m * 0.3, w / 2, h / 2, m * 0.8);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, `rgba(0, 0, 0, ${p.vignette ?? 0.35})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = p.grain ?? 1;
    ctx.fillStyle = ctx.createPattern(getGrainTile(), 'repeat');
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** object-fit: cover for a still image. */
  function paintImage(ctx, w, h, img) {
    const iw = img.width;
    const ih = img.height;
    const scale = Math.max(w / iw, h / ih);
    const sw = w / scale;
    const sh = h / scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
  }

  async function loadImage(id) {
    let blob = null;
    if (id.startsWith('user:')) {
      blob = await PenguDB.getBackground(id.slice(5));
    } else if (id.startsWith('file:')) {
      const entry = BUNDLED.find((b) => b.id === id);
      if (entry) blob = await fetch(entry.src).then((r) => (r.ok ? r.blob() : null));
    }
    if (!blob) throw new Error(`background ${id} not found`);
    return createImageBitmap(blob);
  }

  /* ---------- public API ---------- */

  /** A canvas of exactly w x h holding the backdrop. Cached per size. */
  async function render(id, w, h) {
    const key = `${id}@${w}x${h}`;
    if (cache.has(key)) return cache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const preset = id && id.startsWith('preset:') && PRESETS.find((p) => p.id === id.slice(7));
    if (preset) {
      paintPreset(ctx, w, h, preset);
    } else {
      try {
        const img = await loadImage(id || '');
        paintImage(ctx, w, h, img);
        if (img.close) img.close();
      } catch {
        // A deleted or unreadable image falls back to the default backdrop.
        return id === DEFAULT_ID ? canvas : render(DEFAULT_ID, w, h);
      }
    }

    cache.set(key, canvas);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return canvas;
  }

  function presetThumb(p) {
    if (!thumbCache.has(p.id)) {
      const c = document.createElement('canvas');
      c.width = 192;
      c.height = 108;
      paintPreset(c.getContext('2d'), 192, 108, p);
      thumbCache.set(p.id, c.toDataURL('image/jpeg', 0.85));
    }
    return thumbCache.get(p.id);
  }

  /** Every backdrop on offer: [{ id, label, thumb, removable }]. */
  async function list() {
    userUrls.forEach((u) => URL.revokeObjectURL(u));
    userUrls = [];

    let uploads = [];
    try {
      uploads = await PenguDB.listBackgrounds();
    } catch {
      uploads = [];
    }
    const user = uploads.map((b) => {
      const url = URL.createObjectURL(b.blob);
      userUrls.push(url);
      return { id: `user:${b.id}`, label: b.name || 'Your image', thumb: url, removable: true };
    });
    const bundled = BUNDLED.map((b) => ({ id: b.id, label: b.label, thumb: b.src, removable: false }));
    const presets = PRESETS.map((p) => ({
      id: `preset:${p.id}`, label: p.label, thumb: presetThumb(p), removable: false,
    }));
    return [...user, ...bundled, ...presets];
  }

  /** Store an image the user picked. Resolves the new background id. */
  async function add(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('not-an-image');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('too-large');
    // Decode once up front: a file the browser cannot read must not be kept.
    const probe = await createImageBitmap(file);
    if (probe.close) probe.close();
    const id = crypto.randomUUID
      ? crypto.randomUUID()
      : `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await PenguDB.addBackground({
      id,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 60),
      blob: file,
      createdAt: Date.now(),
    });
    return `user:${id}`;
  }

  async function remove(id) {
    if (!id.startsWith('user:')) return;
    await PenguDB.removeBackground(id.slice(5));
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${id}@`)) cache.delete(key);
    }
  }

  return { DEFAULT_ID, render, list, add, remove };
})();
