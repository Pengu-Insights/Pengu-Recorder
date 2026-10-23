/* ============================================================
   converter.js — re-encode a saved take into MP4 or WebM, applying
   the trim on the way.

   No ffmpeg.wasm (a 30 MB download) and no muxer library: the take is
   played once, off screen, and its own frames and sound are fed into a
   fresh MediaRecorder set to the target format. The cost is time — an
   export takes as long as the clip — which the UI says up front.
       <video> --captureStream()------------------> video track --+
              \--createMediaElementSource -> audio track ---------+-> MediaRecorder
   ============================================================ */

const PenguConverter = (() => {
  function once(target, event, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  function seek(video, t) {
    if (Math.abs(video.currentTime - t) < 0.01) return Promise.resolve();
    const done = once(video, 'seeked');
    video.currentTime = t;
    return done;
  }

  /**
   * Resolves a Blob in `format` ('mp4' | 'webm') holding [start, end] of `blob`.
   * opts: { format, start, end (Infinity = to the last frame), duration
   *         (for progress when end is Infinity), onProgress(fraction), signal }
   */
  async function exportVideo(blob, opts) {
    const mimeType = PenguRecorder.mimeFor(opts.format);
    if (!mimeType) throw new Error('format-unsupported');
    const start = Math.max(0, opts.start || 0);
    const end = opts.end;
    const span = Math.max(0.1, (Number.isFinite(end) ? end : opts.duration || 1) - start);
    const signal = opts.signal;

    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    // In the document but out of sight: Chrome is more willing to keep
    // decoding a video that is attached, even while the tab is hidden.
    Object.assign(video.style, {
      position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px',
      opacity: '0', pointerEvents: 'none',
    });
    document.body.appendChild(video);

    let audioCtx = null;
    let recorder = null;
    let poll = null;
    const cleanup = () => {
      clearInterval(poll);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
      if (audioCtx) audioCtx.close().catch(() => {});
    };

    try {
      const meta = once(video, 'loadedmetadata');
      video.src = url;
      await meta;

      // Sound goes through Web Audio and never reaches the speakers, so the
      // export plays silently while the user keeps working.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume().catch(() => {});
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaElementSource(video).connect(dest);

      const capture = video.captureStream ? video.captureStream() : video.mozCaptureStream();

      /* captureStream only grows a video track once frames flow, so play
         briefly to get one, then rewind to the start of the trim. */
      await seek(video, start);
      await video.play();
      if (!capture.getVideoTracks().length) await once(capture, 'addtrack', 3000).catch(() => {});
      video.pause();
      await seek(video, start);

      const track = capture.getVideoTracks()[0];
      if (!track) throw new Error('no-video-track');
      const stream = new MediaStream([track, ...dest.stream.getAudioTracks()]);

      const w = video.videoWidth || 1920;
      const h = video.videoHeight || 1080;
      // A second generation loses detail, so give it more bits than a live take.
      const bitrate = Math.round(PenguRecorder.bitrateFor(w, h) * 1.25);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const parts = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };

      const finished = new Promise((resolve, reject) => {
        let stopping = false;
        const stop = (err) => {
          if (stopping) return;
          stopping = true;
          clearInterval(poll);
          video.pause();
          recorder.onstop = () => (err ? reject(err) : resolve());
          if (recorder.state !== 'inactive') recorder.stop();
          else recorder.onstop();
        };
        const check = () => {
          const t = video.currentTime;
          if (opts.onProgress) opts.onProgress(Math.min(1, Math.max(0, (t - start) / span)));
          if (t >= end || video.ended) stop();
        };
        video.addEventListener('ended', () => stop());
        video.addEventListener('error', () => stop(new Error('playback-failed')));
        video.addEventListener('timeupdate', check);
        poll = setInterval(check, 50);
        if (signal) {
          if (signal.aborted) stop(new DOMException('Export cancelled', 'AbortError'));
          signal.addEventListener('abort', () => stop(new DOMException('Export cancelled', 'AbortError')));
        }
      });

      recorder.start(1000);
      await video.play();
      await finished;
      if (opts.onProgress) opts.onProgress(1);
      return new Blob(parts, { type: mimeType.split(';')[0] });
    } finally {
      cleanup();
    }
  }

  return { exportVideo };
})();
