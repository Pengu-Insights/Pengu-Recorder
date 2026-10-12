<p align="center">
  <img src="assets/pengu-logo.png" width="96" height="96" alt="">
</p>

<h1 align="center">Pengu Recorder</h1>

<p align="center">
  A screen and camera recorder that runs entirely in your browser.<br>
  No account, no upload, no backend. Recordings never leave your machine.
</p>

---

Most screen recorders ask you to sign up, then quietly upload what you recorded
to somebody else's server. This one does not have a server to upload to. It is
HTML, CSS and vanilla JavaScript: no build step, no dependencies, no analytics.
Videos are stored in your own browser's IndexedDB and stay there until you
delete them.

## Run it

`getDisplayMedia` requires a secure context, so opening `index.html` from the
file system will not work. Serve the folder over localhost:

```bash
python -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080> in Chrome or Edge.

Any static host works too, as long as it serves over HTTPS. GitHub Pages is
enough to host your own copy.

## What it does

**Three recording modes.** Screen and camera, screen only, camera only. Screen
only and camera only feed the source track straight into `MediaRecorder` with no
canvas in between, so nothing is re-encoded and text stays sharp.

**Region cropping.** Pick the exact rectangle to record before the countdown
starts. One click leaves out the Windows taskbar or the browser tab strip, or
drag any edge in. Everything outside the box is dropped before encoding, so it
never reaches the file.

**Camera bubble baked into the video.** Drag it anywhere. It is positioned in
coordinates of the shared surface, so where you drop it on screen is where it
lands in the video.

**Floating control bar.** A Document Picture-in-Picture window keeps the timer
and the buttons on top of whatever you are recording, and takes the in-page bar
out of the capture. `Alt+H` hides the in-page bar when PiP is not available.

**Presenter notes.** A teleprompter in its own always-on-top window, so it is
never part of a tab or window share.

**Crash recovery.** Chunks are flushed to IndexedDB every five seconds while
recording. Close the tab, crash the browser, lose power: the take is offered
back the next time you open the app. It also keeps long recordings out of RAM.

**The rest.** 3-2-1 countdown, pause and resume, restart, microphone mute,
device pickers, a high-fidelity audio mode that turns off echo cancellation so
shared system audio is not ducked, capture quality selector, a library with
generated thumbnails, and a watch page with a real view counter.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Alt+S` | Finish the recording |
| `Alt+P` | Pause or resume |
| `Alt+M` | Mute or unmute the microphone |
| `Alt+N` | Toggle presenter notes |
| `Alt+H` | Hide or show the in-page control bar |

## Browser support

Chrome and Edge are the targets. Firefox has no system audio sharing and only
partial `getDisplayMedia` audio support. Safari does not implement enough of
`MediaRecorder` for WebM. Document Picture-in-Picture needs Chrome 116 or newer
and degrades to an in-page bar everywhere else.

## Privacy

- No server, no account, no telemetry, no third-party scripts at runtime.
- Recordings live in your browser's IndexedDB. Nothing is uploaded anywhere.
- "Copy link" produces a local URL that only opens in the same browser profile.
- The app asks for persistent storage so the browser does not evict your videos.
- Camera and microphone are requested only for the mode you picked, and the
  tracks are stopped when you leave the setup screen.

## Known limitations

- The trim sliders constrain playback only. The downloaded `.webm` is still the
  full take. Real cutting is on the roadmap, through WebCodecs.
- Output is WebM. MP4 conversion is on the roadmap.
- Cropping routes the take through a compositing canvas, which costs a
  re-encode and some CPU. Recording without a crop does not.
- Sharing an entire monitor captures whatever is on it, the presenter notes
  window included. Share a window or a tab, or move the notes to another
  monitor.

See [ROADMAP.md](ROADMAP.md) for what is planned.

## Project layout

```
index.html      single page app shell: every view, control bar, overlays
css/styles.css  theme
js/db.js        IndexedDB wrapper: videos metadata, blobs, recovery chunks
js/recorder.js  recording engine: streams, canvas compositing, cropping, audio
js/app.js       UI wiring, hash router, crop editor, Picture-in-Picture
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
This is a side project, so reviews may take a while.

## License

MIT, see [LICENSE](LICENSE).

The Pengu Insights name, the penguin mark in `assets/`, and the Pengu Recorder
name are trademarks of Pengu Insights and are not covered by the MIT license.
Fork the code freely, but please ship it under your own name and logo.
