# Badge Simulator canvas

A [GitHub Copilot app](https://docs.github.com/copilot) canvas that runs a
Universe 2026 app from `badge/apps/<app>` on the 3D badge simulator from
[badger.github.io](https://badger.github.io). It is a project extension, so
Copilot loads it automatically for anyone who clones this repository.

- **Live reload**: the canvas watches `badge/apps/<app>` and reruns the app
  whenever a file changes, so it always shows the latest code.
- **Badge controls**: zoom (+/−), **Screen**/**Full** views (starts in
  Full) and **Rotate** to turn the badge upside down. You can click the 3D
  buttons, use the on-screen keys, or use the keyboard (arrows, Space/Enter =
  Select, Esc = Home, WASD/J/K/U for the gamepad).
- **Theme**: follows the Copilot app's light or dark theme.
- **HOME** runs the app's `on_exit` and restarts it, because there is no menu.
- **Output** shows `print()` output and tracebacks from MicroPython.
- **Recording the badge** briefly enlarges the 3D view to a fixed stage,
  records the whole badge for 4 seconds as a GIF (cropped to the badge, up to
  1000px tall), then restores the view. Everything runs in the canvas page
  itself — no headless browser or Playwright is involved.
- **Automatic share**: when the canvas is opened with
  `{ "issue": "owner/repo#number" }` it records once on load, uploads the GIF
  with the GitHub CLI and adds (or updates) a **Your Virtual Universe 26
  badge** artifact on that issue, with no Copilot turn. A hidden panel can't
  render, so it waits (up to two minutes) for the panel to come to the front,
  and GitHub calls are retried.
- **Share** records on demand and saves the GIF to the Downloads folder as
  `virtual-universe-26-badge.gif`, revealing it in the file manager.
- **GitHub login**: apps get the signed-in `gh` user's login as
  `github_login.txt` in their folder (used by `universe_congrats`).
- With no app chosen or remembered, the canvas opens `universe_congrats`.

## Using it

Ask Copilot to "open the Badge Simulator for flappy_mona", or have the agent
call `open_canvas` with `canvasId: "badge-simulator"` and
`input: { "app": "<folder under badge/apps>", "issue"?: "owner/repo#number" }`. You can also choose an app
from the drop-down in the canvas.

When you ask Copilot to build or run a badge app, it can open the app here,
check it, and record a GIF of it.

The agent can drive the canvas with `invoke_canvas_action`:

| Action | Input | Purpose |
| --- | --- | --- |
| `load_app` | `{ "app": "snake" }` | Switch to another app |
| `reload` | `{ "restart_runtime"?: true }` | Rerun now (normally automatic) |
| `get_output` | `{ "lines"?: 80, "since"?: cursor }` | Status (running, crashed, fps, frames, resolution, orientation, backlight), recent output and the last error mapped to `badge/apps/...:line` |
| `press` | `{ "button": "select", "duration_ms"?: 120 }` | Press `up`, `down`, `left`, `right`, `select`, `home`, `back`, `menu` (or `a`/`b`/`c`); combine with `"a+b"` |
| `screenshot` | `{ "label"?: "title" }` | Save the badge screen as a PNG and return its path |
| `record` | `{ "duration_ms"?: 3000, "fps"?: 15, "steps"?: [...], "restart"?: true, "video"?: true, "save_frames"?: true, "view"?: "badge", "sheet"?: false }` | Record the screen (or, with `view: "badge"`, the whole 3D badge) while optional `run_script` steps run. Writes an animated GIF, a labelled contact-sheet PNG of evenly spaced frames, and optionally MP4/WebM video and per-frame PNGs. Returns their paths, `distinct_frames` and `longest_static_ms` |
| `share` | `{}` | Same as the **Share** button; returns the GIF path and artifact URL |
| `exec` | `{ "code": "score", "timeout_ms"?: 5000 }` | Run MicroPython in the running app's globals (a REPL); expressions return their repr |
| `wait_for` | `{ "pattern"?: "regex", "frames"?: 30, "until_crash"?: true, "timeout_ms"?: 5000, "since"?: cursor }` | Wait for output, rendered frames or a crash instead of sleeping |
| `run_script` | `{ "steps": [...], "restart"?: true }` | Scripted test: `press`, `wait_ms`, `screenshot`, `exec`, `wait_for` and `rotate` steps, stopping on a crash |
| `rotate` | `{ "upside_down"?: true }` | Turn the badge upside down (or toggle) |
| `check_app` | `{ "app"?: "snake" }` | Pre-flight checks: `__init__.py`, 24x24 `icon.png`, README rules from CI, 2025 API usage and committed secrets |

A good debugging loop is `check_app`, then `run_script` (or `wait_for`) to
exercise the app, then `error.location` from the result to find the failing
line, fix it, and repeat; the canvas reloads on save. To check motion or
animation, `record` the interaction and view the contact sheet; the GIF or
video is ready to attach to a pull request. Keep the canvas visible
while testing: a hidden panel pauses the simulator.

Only one `record` action can run per canvas at a time, including its optional
restart and export. An explicit `scale` must be an integer from 1 to 4.
Capture waits for a real app frame rather than recording the initial placeholder,
includes the latest screen when stopped, and excludes export time from its
reported capture duration and GIF timing.

The simulator approximates the badge firmware, so test on real hardware before
you open a pull request.

## How it works

`extension.mjs` starts a loopback HTTP server for each canvas. The server
hosts `web/`, sends the app's files to the page, and pushes reload events when
they change. The page (`web/simulator.js`) runs the badge's MicroPython WASM
runtime in a web worker and draws frames on the 3D model. Recordings stream
changed frames from the page to the extension, and `media.mjs` encodes the GIF
and PNGs without dependencies. Video comes from the browser's `MediaRecorder`.
Screenshots and recordings are written to the session's
`files/badge-simulator/` folder.

The runtime (about 6 MB: WASM, simulator filesystem and badge model) is
downloaded from the badger.github.io revision in `web/BUILD_INFO.json` the
first time you open the canvas. It is cached in
`~/.copilot/cache/badge-simulator/<revision>/` (or under `$COPILOT_HOME`), so
the canvas works offline after that.

## Updating the simulator

`web/simulator.js` is generated. Edit `src/entry.ts`, `web/index.html` or
`web/simulator.css`, then rebuild against the site's simulator modules:

```bash
node .github/extensions/badge-simulator/build.mjs            # latest main
node .github/extensions/badge-simulator/build.mjs --ref <sha> # specific revision
```

The script clones `badger/badger.github.io`, installs its dependencies, bundles
`src/entry.ts` with esbuild and records the revision in `web/BUILD_INFO.json`,
which also selects the matching runtime. Pass `--site <checkout>` to reuse a
local clone. Reload extensions in Copilot (or restart the app) to pick up
changes to `extension.mjs`.

Run the dependency-free recording regression tests with Node.js 24 or newer:

```powershell
node --test .github\extensions\badge-simulator\recording.test.mjs
```
