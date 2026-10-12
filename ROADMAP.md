# Roadmap

Ordered by impact. Checked items are shipped.

## High impact

- [ ] **Real trim on export.** The sliders constrain playback only; the
  downloaded file is still the full take. Plan: WebCodecs plus `mp4-muxer` or
  `webm-muxer`, not ffmpeg.wasm (a 30 MB download) and not re-recording through
  `MediaRecorder` (re-encodes, and takes as long as the video).
- [ ] **MP4 output.** WebM does not open everywhere. Falls out of the WebCodecs
  work above.
- [ ] **Drawing tools while recording** (pen, highlighter, arrows), drawn onto
  the compositing canvas so they land in the video. Note that screen only and
  camera only skip the canvas, so enabling drawing has to route them through it.
- [x] **Always-visible control bar**, as a Document Picture-in-Picture window.
- [x] **Region cropping**, with presets for the taskbar and the browser bars.

## Medium impact

- [ ] **Pause the camera without pausing the recording**, freezing or hiding the
  bubble.
- [ ] **Cursor zoom and click highlight.** Only possible on the composited path.
- [x] **Configurable capture quality**, auto, 1080p or 720p, with the bitrate
  following the frame size.

## The big jump

- [ ] **A backend**, which is what turns this from a local tool into a product:
  1. A small server for uploads and real public links.
  2. View tracking per link open.
  3. Email notification when somebody watches.
  4. Timestamped comments.

## Shipped

- [x] Screen only and camera only record the source track directly, with no
      canvas re-encode
- [x] Draw clock in a Web Worker, so compositing holds 30 fps while the tab is
      hidden
- [x] Crash recovery: chunks flushed to IndexedDB every 5 seconds, with a
      recovery banner on the next visit
- [x] Presenter notes in their own Picture-in-Picture window
- [x] Camera bubble positioned in coordinates of the shared surface
- [x] IndexedDB split into metadata and blobs, so a view counter bump does not
      rewrite the video file
- [x] Bitrate scaled to the frame size, 2 to 16 Mbps
- [x] Camera and microphone pickers, with hot-plug handling
- [x] High-fidelity audio mode, so the echo canceller stops ducking shared
      system audio
- [x] Audio warnings when a take is collecting no sound
- [x] Keyboard shortcuts
- [x] Storage quota display and a request for persistent storage
- [x] Accessibility pass: labels, focus rings, live regions, keyboard paths
