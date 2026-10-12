# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub, using
**Security > Report a vulnerability** on this repository. Do not open a public
issue for a vulnerability.

Expect a first response within a week. This is a side project, so please be
patient with timelines.

## Scope

Pengu Recorder is a static client-side application. It has no server, no
accounts, no authentication, and no network calls at runtime beyond loading its
own files and a web font. The relevant attack surface is therefore:

- Anything that could cause a recording to leave the user's machine.
- Anything that could expose data from one origin to another, for example
  through the Picture-in-Picture windows or object URLs.
- Cross-site scripting through recording titles, presenter notes or file
  metadata rendered back into the page.
- Anything that keeps camera or microphone tracks alive after a recording ends.

## Out of scope

- Issues that require the user to paste hostile code into their own devtools.
- Browser bugs with no mitigation available in application code. Report those
  upstream, and open an issue here if a workaround is possible.
