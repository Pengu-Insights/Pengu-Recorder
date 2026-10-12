# Contributing

Thanks for taking a look.

## Running it

There is no build step and no dependencies. Serve the folder over localhost and
open it in Chrome or Edge:

```bash
python -m http.server 8080
```

`getDisplayMedia` needs a secure context, so `file://` will not work.

## House style

- Vanilla JavaScript, no framework, no bundler, no runtime dependencies. A pull
  request that adds a build step is unlikely to be merged.
- Comments explain why, not what. If a workaround exists because a browser
  behaves oddly, say which browser and what it does.
- Keep the three recording paths in mind: screen only and camera only feed the
  source track straight to `MediaRecorder`, and only screen plus camera or a
  crop go through the compositing canvas.

## Before opening a pull request

Browser APIs here are hard to unit test, so test by hand and say what you did:

1. Record in all three modes, with and without a crop.
2. Pause, resume, restart, cancel, finish.
3. Close the tab mid-recording and check that the recovery banner offers the
   take back.
4. Check the console for errors.

Include your browser and operating system version in the pull request.

## Reporting bugs

Open an issue with the browser version, what you shared (monitor, window or
tab), what you expected and what happened. Console output helps.

Security issues go through private reporting instead, see
[SECURITY.md](SECURITY.md).
