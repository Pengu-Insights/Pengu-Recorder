/* ============================================================
   studio.js — the Studio layouts: a backdrop, the shared screen and the
   camera, arranged by a template.

   Templates:
     side           screen in a frame, camera beside it (above or below
                    it in a Short)
     corner         screen edge to edge, camera in a corner
     framed-corner  screen in a frame on the backdrop, camera in a corner
     split          two full-width panels: what you show on top, you below
                    (the Reels look); side by side in a 16:9 video
     camera         just the camera on the backdrop, for intros and outros

   Two shapes: a 16:9 YouTube video and a 9:16 YouTube Short (also TikTok
   and Reels). The canvas size decides which; see layout().

   Used twice with the same code, so the setup preview is a true preview
   of the take: by the recorder at the output size, and by the setup
   screen on a small canvas with a placeholder where the screen will go.
   ============================================================ */

const PenguStudio = (() => {
  const CAMERA_WIDTH = { small: 0.2, medium: 0.26, large: 0.32 };
  const CAMERA_WIDTH_VERTICAL = { small: 0.5, medium: 0.62, large: 0.76 };
  const CORNER_WIDTH = { small: 0.15, medium: 0.2, large: 0.26 };
  const CORNER_WIDTH_VERTICAL = { small: 0.32, medium: 0.4, large: 0.5 };
  const SPLIT_SHARE = { small: 0.4, medium: 0.5, large: 0.6 };
  const TEMPLATES = ['side', 'corner', 'framed-corner', 'split', 'camera'];
  const DEFAULTS = {
    template: 'side',
    // 'landscape' (YouTube, 16:9) | 'vertical' (Shorts, 9:16) | 'reel' (Reels, 9:16)
    aspect: 'landscape',
    cameraSide: 'right',   // side and split; in 9:16 'left' = above the screen
    cameraCorner: 'br',    // corner templates: 'br' | 'bl' | 'tr' | 'tl'
    cameraShape: 'portrait',
    cameraSize: 'medium',
    name: '',
  };
  const NO_CROP = { top: 0, right: 0, bottom: 0, left: 0 };

  /* Backdrop plus drop shadows, cached per context. Shadows are the costly
     part of the frame and they only move when the layout does, so they are
     painted once instead of 30 times a second. */
  const stages = new WeakMap();

  /** { screen, cam, screenRadius, camShape? } in canvas pixels; screen or cam may be null. */
  function layout(W, H, opts, screenAspect, hasCamera) {
    const U = Math.min(W, H);
    if (opts.template === 'camera') return layoutCameraOnly(W, H, opts);
    if (opts.template === 'split') {
      return hasCamera
        ? layoutSplit(W, H, opts, screenAspect)
        : layoutCorner(W, H, opts, screenAspect, false, false);
    }
    if (opts.template === 'corner' || opts.template === 'framed-corner') {
      return layoutCorner(W, H, opts, screenAspect, hasCamera, opts.template === 'corner');
    }
    const L = H > W
      ? layoutVertical(W, H, opts, screenAspect, hasCamera)
      : layoutLandscape(W, H, opts, screenAspect, hasCamera);
    return { ...L, screenRadius: Math.round(U * 0.016) };
  }

  /* The screen as large as the frame allows (edge to edge when `full`),
     the camera tucked into a corner on top of it. */
  function layoutCorner(W, H, opts, screenAspect, hasCamera, full) {
    const U = Math.min(W, H);
    const vertical = H > W;
    const pad = full ? 0 : Math.round(U * 0.06);
    const availW = W - 2 * pad;
    const availH = H - 2 * pad;
    let sw = availW;
    let sh = sw / screenAspect;
    if (sh > availH) {
      sh = availH;
      sw = sh * screenAspect;
    }
    sw = Math.round(sw);
    sh = Math.round(sh);
    const screen = { x: Math.round((W - sw) / 2), y: Math.round((H - sh) / 2), w: sw, h: sh };

    let cam = null;
    if (hasCamera) {
      const widths = vertical ? CORNER_WIDTH_VERTICAL : CORNER_WIDTH;
      const w = Math.round(W * (widths[opts.cameraSize] || widths.medium));
      const h = opts.cameraShape === 'portrait' ? Math.round(w * 4 / 3) : w;
      const margin = Math.round(U * 0.04);
      // Leave room under the camera for the name tag that hangs off it.
      const below = (opts.name || '').trim() ? Math.round(U * 0.03) : 0;
      const corner = opts.cameraCorner || 'br';
      cam = {
        x: corner.includes('l') ? margin : W - margin - w,
        y: corner.includes('t') ? margin : H - margin - below - h,
        w,
        h,
      };
    }
    return { screen, cam, screenRadius: full ? 0 : Math.round(U * 0.016) };
  }

  /* Reels look: the screen in one full-width panel, the camera filling the
     other. The camera panel takes a share of the height set by the camera
     size; if the screen is shorter than its panel, the spare height goes to
     the backdrop above and below rather than into black bars. */
  function contain(area, aspect) {
    let w = area.w;
    let h = w / aspect;
    if (h > area.h) {
      h = area.h;
      w = h * aspect;
    }
    w = Math.round(w);
    h = Math.round(h);
    return { x: area.x + Math.round((area.w - w) / 2), y: area.y + Math.round((area.h - h) / 2), w, h };
  }

  function layoutSplit(W, H, opts, screenAspect) {
    const U = Math.min(W, H);
    const pad = Math.round(U * 0.04);
    const gap = Math.round(U * 0.03);
    const share = SPLIT_SHARE[opts.cameraSize] || SPLIT_SHARE.medium;
    const camFirst = opts.cameraSide === 'left';
    let screen;
    let cam;

    if (H > W) {
      const panelW = W - 2 * pad;
      const avail = H - 2 * pad - gap;
      const camH = Math.round(avail * share);
      // Room for the name tag that hangs off the bottom of the camera.
      const tag = !camFirst && (opts.name || '').trim() ? Math.round(U * 0.03) : 0;
      const screenH = Math.min(avail - camH - tag, Math.round(panelW / screenAspect));
      screen = contain({ x: pad, y: 0, w: panelW, h: screenH }, screenAspect);
      const total = screen.h + gap + camH;
      const y0 = Math.round((H - total - tag) / 2);
      cam = { x: pad, y: camFirst ? y0 : y0 + screen.h + gap, w: panelW, h: camH };
      screen.y = camFirst ? y0 + camH + gap : y0;
    } else {
      const panelH = H - 2 * pad;
      const avail = W - 2 * pad - gap;
      const camW = Math.round(avail * share * 0.7);
      const area = { x: camFirst ? pad + camW + gap : pad, y: pad, w: avail - camW, h: panelH };
      screen = contain(area, screenAspect);
      cam = { x: camFirst ? pad : W - pad - camW, y: pad, w: camW, h: panelH };
    }
    return { screen, cam, screenRadius: Math.round(U * 0.03), camShape: 'panel' };
  }

  /* No screen: the camera large and centred, for an intro or an outro. */
  function layoutCameraOnly(W, H, opts) {
    const vertical = H > W;
    let w;
    let h;
    if (vertical) {
      w = Math.round(W * 0.8);
      h = opts.cameraShape === 'portrait' ? Math.round(w * 4 / 3) : w;
    } else {
      h = Math.round(H * 0.74);
      w = opts.cameraShape === 'portrait' ? Math.round(h * 3 / 4) : h;
    }
    const cam = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
    return { screen: null, cam, screenRadius: 0 };
  }

  /* Shorts: the screen spans the width, the camera stacks above or below. */
  function layoutVertical(W, H, opts, screenAspect, hasCamera) {
    const pad = Math.round(W * 0.06);
    const gap = Math.round(W * 0.05);
    const availW = W - 2 * pad;
    const availH = H - 2 * pad;

    let sw = availW;
    let sh = sw / screenAspect;
    // A tall shared window must still leave room for the camera.
    const maxScreenH = hasCamera ? availH * 0.55 : availH;
    if (sh > maxScreenH) {
      sh = maxScreenH;
      sw = sh * screenAspect;
    }
    sw = Math.round(sw);
    sh = Math.round(sh);

    let cam = null;
    if (hasCamera) {
      let w = Math.round(W * (CAMERA_WIDTH_VERTICAL[opts.cameraSize] || CAMERA_WIDTH_VERTICAL.medium));
      let h = opts.cameraShape === 'portrait' ? Math.round(w * 5 / 4) : w;
      // Room for the name tag that straddles the bottom edge.
      const room = availH - sh - gap - Math.round(W * 0.04);
      if (h > room) {
        w = Math.round(w * room / h);
        h = room;
      }
      cam = { x: Math.round((W - w) / 2), y: 0, w, h };
    }

    const total = sh + (cam ? gap + cam.h : 0);
    const y0 = Math.round((H - total) / 2);
    const screen = { x: Math.round((W - sw) / 2), y: y0, w: sw, h: sh };
    if (cam) {
      if (opts.cameraSide === 'left') {
        cam.y = y0;
        screen.y = y0 + cam.h + gap;
      } else {
        cam.y = y0 + sh + gap;
      }
    }
    return { screen, cam };
  }

  function layoutLandscape(W, H, opts, screenAspect, hasCamera) {
    const pad = Math.round(H * 0.06);
    const gap = Math.round(H * 0.04);
    const availH = H - 2 * pad;

    let cam = null;
    if (hasCamera) {
      let w = Math.round(W * (CAMERA_WIDTH[opts.cameraSize] || CAMERA_WIDTH.medium));
      let h = opts.cameraShape === 'portrait' ? Math.round(w * 4 / 3) : w;
      if (h > availH) {
        w = Math.round(w * availH / h);
        h = availH;
      }
      cam = { x: 0, y: Math.round((H - h) / 2), w, h };
    }

    const areaW = W - 2 * pad - (cam ? cam.w + gap : 0);
    let sw = areaW;
    let sh = sw / screenAspect;
    if (sh > availH) {
      sh = availH;
      sw = sh * screenAspect;
    }
    sw = Math.round(sw);
    sh = Math.round(sh);

    // Centre screen and camera as one group, so a narrow screen does not
    // leave the camera stranded at the edge of the frame.
    const total = sw + (cam ? gap + cam.w : 0);
    const x0 = Math.round((W - total) / 2);
    const screen = { x: x0, y: Math.round((H - sh) / 2), w: sw, h: sh };
    if (cam) {
      if (opts.cameraSide === 'left') {
        cam.x = x0;
        screen.x = x0 + cam.w + gap;
      } else {
        cam.x = x0 + sw + gap;
      }
    }
    return { screen, cam };
  }

  function roundRectPath(ctx, r, radius) {
    const rad = Math.min(radius, r.w / 2, r.h / 2);
    ctx.beginPath();
    ctx.moveTo(r.x + rad, r.y);
    ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
    ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
    ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
    ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
    ctx.closePath();
  }

  function camPath(ctx, cam, shape, U) {
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(cam.x + cam.w / 2, cam.y + cam.h / 2, Math.min(cam.w, cam.h) / 2, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, cam, Math.round(U * 0.03));
    }
  }

  function getStage(ctx, W, H, background, L, opts) {
    const s = L.screen;
    const key = [W, H, s ? `${s.x},${s.y},${s.w},${s.h},${L.screenRadius}` : '-',
      L.cam ? `${L.cam.x},${L.cam.y},${L.cam.w},${L.cam.h}` : '-', L.camShape || opts.cameraShape].join('|');
    const cached = stages.get(ctx);
    if (cached && cached.key === key && cached.background === background) return cached.canvas;

    const canvas = (cached && cached.canvas) || document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    if (background) {
      g.drawImage(background, 0, 0, W, H);
    } else {
      const fill = g.createLinearGradient(0, 0, W, H);
      fill.addColorStop(0, '#14132B');
      fill.addColorStop(1, '#2A2850');
      g.fillStyle = fill;
      g.fillRect(0, 0, W, H);
    }

    const U = Math.min(W, H);
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.38)';
    g.shadowBlur = U * 0.045;
    g.shadowOffsetY = U * 0.014;
    g.fillStyle = '#000';
    if (L.screen) {
      roundRectPath(g, L.screen, L.screenRadius);
      g.fill();
    }
    if (L.cam) {
      camPath(g, L.cam, L.camShape || opts.cameraShape, U);
      g.fill();
    }
    g.restore();

    stages.set(ctx, { key, background, canvas });
    return canvas;
  }

  /* Stand-in for the shared screen on the setup preview. */
  function paintPlaceholder(ctx, r) {
    const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    g.addColorStop(0, '#20253A');
    g.addColorStop(1, '#131624');
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    const bar = r.h * 0.075;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(r.x, r.y, r.w, bar);
    ['#FF5F57', '#FEBC2E', '#28C840'].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(r.x + bar * (0.7 + i * 0.6), r.y + bar / 2, bar * 0.18, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    const lineH = r.h * 0.035;
    [0.55, 0.4, 0.62, 0.3].forEach((len, i) => {
      roundRectPath(ctx, { x: r.x + r.w * 0.08, y: r.y + bar + r.h * (0.12 + i * 0.09), w: r.w * len, h: lineH }, lineH / 2);
      ctx.fill();
    });

    if (r.h < 60) return; // template thumbnails: too small to read
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = `600 ${Math.round(r.h * 0.065)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Your screen goes here', r.x + r.w / 2, r.y + r.h * 0.72);
  }

  /* Stand-in for the camera: a simple head-and-shoulders silhouette. */
  function paintPerson(ctx, r) {
    const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    g.addColorStop(0, '#E3ECFB');
    g.addColorStop(1, '#B7CBEE');
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const s = Math.min(r.w, r.h);
    const cx = r.x + r.w / 2;
    ctx.fillStyle = '#1455C8';
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(cx, r.y + r.h * 0.42, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, r.y + r.h * 0.42 + s * 0.52, s * 0.34, s * 0.3, 0, Math.PI, 0);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /**
   * object-fit: cover from a video into a rect, with optional framing:
   * `frame.zoom` tightens the crop (2 = twice as close) and `frame.x` / `frame.y`
   * move the part of the source that stays visible, 0.5 being centred.
   */
  function drawCover(ctx, video, r, frame) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const zoom = Math.max(1, (frame && frame.zoom) || 1);
    const scale = Math.max(r.w / vw, r.h / vh) * zoom;
    const sw = Math.min(vw, r.w / scale);
    const sh = Math.min(vh, r.h / scale);
    const fx = frame && typeof frame.x === 'number' ? frame.x : 0.5;
    const fy = frame && typeof frame.y === 'number' ? frame.y : 0.5;
    // The focus point cannot pull the window past the edges of the frame.
    const sx = Math.min(Math.max(fx * vw - sw / 2, 0), vw - sw);
    const sy = Math.min(Math.max(fy * vh - sh / 2, 0), vh - sh);
    ctx.drawImage(video, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
  }

  function drawNameTag(ctx, cam, name, U) {
    const fs = Math.round(U * 0.026);
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    const padX = fs * 0.8;
    const maxText = Math.max(fs * 2, cam.w * 1.1 - padX * 2);
    let text = name;
    while (text.length > 1 && ctx.measureText(text).width > maxText) text = text.slice(0, -1);
    if (text !== name) text = `${text.trimEnd()}…`;

    const w = ctx.measureText(text).width + padX * 2;
    const h = fs * 1.9;
    // Straddles the bottom edge of the camera, like a broadcast lower third.
    const r = { x: cam.x + (cam.w - w) / 2, y: cam.y + cam.h - h / 2, w, h };
    ctx.fillStyle = '#1455C8';
    roundRectPath(ctx, r, h / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = Math.max(1.5, fs * 0.08);
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, r.x + w / 2, r.y + h / 2 + fs * 0.04);
  }

  /**
   * Draw one Studio frame.
   * src: { background: canvas|null, screen: video|null, crop, camera: video|null,
   *        opts, placeholder: bool (paint stand-ins for a missing screen and
   *        camera, for the setup preview and the template thumbnails) }
   */
  function draw(ctx, W, H, src) {
    const opts = { ...DEFAULTS, ...(src.opts || {}) };
    const crop = src.crop || NO_CROP;
    const screen = src.screen;
    const screenReady = !!(screen && screen.readyState >= 2 && screen.videoWidth);

    let aspect = 16 / 9;
    let sx = 0; let sy = 0; let sw = 0; let sh = 0;
    if (screenReady) {
      const vw = screen.videoWidth;
      const vh = screen.videoHeight;
      sx = crop.left * vw;
      sy = crop.top * vh;
      sw = Math.max(2, vw - sx - crop.right * vw);
      sh = Math.max(2, vh - sy - crop.bottom * vh);
      aspect = sw / sh;
    }

    const L = layout(W, H, opts, aspect, !!(src.camera || src.placeholder));
    const U = Math.min(W, H);
    ctx.drawImage(getStage(ctx, W, H, src.background, L, opts), 0, 0);

    if (L.screen) {
      ctx.save();
      roundRectPath(ctx, L.screen, L.screenRadius);
      ctx.clip();
      if (screenReady) {
        ctx.drawImage(screen, sx, sy, sw, sh, L.screen.x, L.screen.y, L.screen.w, L.screen.h);
      } else if (src.placeholder) {
        paintPlaceholder(ctx, L.screen);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(L.screen.x, L.screen.y, L.screen.w, L.screen.h);
      }
      ctx.restore();
    }

    if (L.cam) {
      const cam = src.camera;
      ctx.save();
      camPath(ctx, L.cam, L.camShape || opts.cameraShape, U);
      ctx.clip();
      ctx.fillStyle = '#1C1E2B';
      ctx.fillRect(L.cam.x, L.cam.y, L.cam.w, L.cam.h);
      // Not mirrored, same as the camera bubble: the video shows the real
      // orientation, so a sign or a T-shirt reads the right way round.
      if (cam && cam.readyState >= 2 && cam.videoWidth) drawCover(ctx, cam, L.cam, src.cameraFrame);
      else if (src.placeholder) paintPerson(ctx, L.cam);
      ctx.restore();

      ctx.save();
      camPath(ctx, L.cam, L.camShape || opts.cameraShape, U);
      ctx.lineWidth = Math.max(2, U * 0.004);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.stroke();
      ctx.restore();

      const name = (opts.name || '').trim();
      if (name) drawNameTag(ctx, L.cam, name, U);
    }
  }

  return { draw, layout, DEFAULTS, TEMPLATES };
})();
