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

**Four recording modes.** Screen and camera, Studio, screen only, camera only.
Screen only and camera only feed the source track straight into `MediaRecorder`
with no canvas in between, so nothing is re-encoded and text stays sharp.

**Studio layouts.** Five templates, each previewed with your own background:
the screen in a frame with your camera beside it; the screen edge to edge with
your camera in a corner; the screen framed on the background with your camera in
a corner; a split screen, what you show on top and you below; and just you, for
intros and outros. The camera can be a portrait, a
square or a circle, in any corner. Twenty-two backgrounds, blue and white
gradients first, are painted in the browser at the size of the take, so a 4K video gets a
4K backdrop. Add your own images too, for example wallpapers made with an AI image
generator: they are kept in IndexedDB and never uploaded. An optional name tag
sits under the camera. The setup screen shows a live preview of the layout.

**Made for YouTube and Reels.** Studio records a 16:9 YouTube video, a 9:16
YouTube Short (also right for TikTok), or a 9:16 Instagram Reel, which starts
on the split screen with you underneath what you are showing. Vertical takes
are 1080 x 1920. Pause on
any frame and save it as a thumbnail at YouTube's size.

**MP4 or WebM, in high resolution.** Records straight to MP4 (H.264) in Chrome
and Edge, or to WebM. Either take downloads in either format: the other one is
re-encoded in the browser. Capture goes up to 4K, the camera asks for 1080p, and
the bitrate follows the frame size up to 40 Mbps.

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
generated thumbnails, and a watch page with a real view counter. Downloads
apply your trim.

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

- Converting between MP4 and WebM, or downloading a trimmed take, re-encodes
  the video by playing it once in the background, so it takes as long as the
  clip. A faster path through WebCodecs is on the roadmap.
- MP4 recording needs Chrome or Edge 126 or newer. Elsewhere the app records
  WebM. Plain Chromium builds have no AAC encoder, so their MP4s carry Opus
  audio, which QuickTime does not play.
- Cropping and the Studio layout route the take through a compositing canvas,
  which costs a re-encode and some CPU. Screen only without a crop does not.
- Sharing an entire monitor captures whatever is on it, the presenter notes
  window included. Share a window or a tab, or move the notes to another
  monitor.

See [ROADMAP.md](ROADMAP.md) for what is planned.

## Project layout

```
index.html      single page app shell: every view, control bar, overlays
css/styles.css  theme
js/db.js          IndexedDB wrapper: video metadata, blobs, recovery chunks, backgrounds
js/backgrounds.js Studio backgrounds: painted presets and the user's own images
js/studio.js      Studio compositor: background, framed screen, camera, name tag
js/recorder.js    recording engine: streams, canvas compositing, cropping, audio, format
js/converter.js   MP4 / WebM export with the trim applied
js/app.js         UI wiring, hash router, crop editor, Picture-in-Picture, downloads
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
This is a side project, so reviews may take a while.

## License

MIT, see [LICENSE](LICENSE).

The Pengu Insights name, the penguin mark in `assets/`, and the Pengu Recorder
name are trademarks of Pengu Insights and are not covered by the MIT license.
Fork the code freely, but please ship it under your own name and logo.
