![CI](https://github.com/YOUR_GITHUB_USER/dsh-browser-cdp/actions/workflows/ci.yml/badge.svg)

# dsh-browser-cdp

A **DeepSeek Harness bundle** that drives the in-app **Sidebar browser** over the
Chrome DevTools Protocol (CDP).

No Chrome extension, no native-messaging host, no extra bridge server and no
custom launcher: the plugin attaches to the `<webview>` guests that the Sidebar
already creates and exposes a `browser_*` tool family to the agent.

> **Security note:** CDP exposes the whole app Chromium, including the
> `dsh-app://app` UI page. The plugin refuses `page` targets by default and only
> drives Sidebar `webview` guests. The endpoint is loopback-only, but any local
> process that can read the port can control the browser. Treat it like a local
> debugging port, not a public API.

## Features

- Navigation, history, reload
- ARIA snapshot with `e1…eN` refs, click / type / select / hover / scroll /
  key press / file upload
- Read page as text, HTML or accessibility tree
- Screenshots (viewport or full page), console, network capture and response
  bodies, performance metrics
- Cookie jar (including HttpOnly), `localStorage` / `sessionStorage`
- One-shot JavaScript and **persistent userscripts** stored under `$DSH_HOME`,
  re-injected after a plugin/app restart
- Optional **stealth layer**: Chrome UA + Client Hints, `window.chrome` helpers,
  iframe coverage
- **Automatic CDP restart**: if the app was started without remote debugging,
  the plugin offers a Cancel/OK dialog and relaunches it with a free CDP port

## Requirements

- DeepSeek Harness **desktop** app, version `0.2.1-rc.3` or newer
- macOS or Windows (the desktop app's supported platforms; Linux is untested)
- The app must be able to restart itself (the plugin does this on demand)

End users do **not** need Node.js, npm or Git when installing a GitHub release /
prebuilt bundle. Node.js 22+ is only needed for development.

The plugin never runs in a Web profile: it is disabled by the bundle patch and
also checks `process.versions.electron` at runtime.

## Install

### Option A — from GitHub (recommended)

Ask the DSH agent to install the bundle, or use the plugin-manager UI:

```json
{ "action": "install_bundle", "target": "github:YOUR_GITHUB_USER/dsh-browser-cdp" }
```

Pin a release:

```json
{ "action": "install_bundle", "target": "github:YOUR_GITHUB_USER/dsh-browser-cdp#v1.0.0" }
```

A plain HTTPS spec can also work in some DSH builds:

```
https://github.com/YOUR_GITHUB_USER/dsh-browser-cdp
```

The package ships prebuilt `lib/` files, so installation does not require a
TypeScript build. Restart DeepSeek Harness once after installing; the bundle
patch inserts one Host row (`browser-cdp`).

### Option B — from a local clone

```bash
git clone https://github.com/YOUR_GITHUB_USER/dsh-browser-cdp.git
cd dsh-browser-cdp
npm install
npm run build
```

Then install the absolute path:

```json
{ "action": "install_bundle", "target": "/absolute/path/to/dsh-browser-cdp" }
```

Windows PowerShell:

```json
{ "action": "install_bundle", "target": "C:\\Users\\<you>\\dsh-browser-cdp" }
```

If your DSH build requires a `file:` spec, use `file:C:/Users/<you>/dsh-browser-cdp`
(or the macOS/Linux equivalent). Quote paths that contain spaces.

### Option C — npm (optional)

If you publish the package to a registry:

```
npm publish
plugin_manager install_bundle dsh-browser-cdp@1.0.0
```

`private` is intentionally not set, so `npm publish` is allowed.

### After install

1. Restart DeepSeek Harness.
2. Open a page in the right Sidebar (or call `browser_navigate`).
3. Run `browser_diagnose`.

If the app was started without CDP, the plugin shows a dialog after a short
grace period. **OK** restarts the app with `--remote-debugging-port=<free port>`;
**Cancel** stops polling for this process. You can also call the explicit
`browser_enable_cdp` tool at any time.

## First launch and CDP

Chromium only starts its DevTools server during browser-process initialization,
so an already-running app cannot enable CDP in place. On startup the plugin polls
every three seconds:

- if a CDP endpoint is found, polling stops;
- after the grace period, with no endpoint and no dialog open, it offers one
  Cancel/OK dialog (or restarts silently when `autoRestart: always`);
- **OK** writes a request, a detached helper quits the app, relaunches the app
  executable with a free port, and waits for `/json/version` to answer;
- **Cancel** marks the process as `cancelled` and stops polling. The explicit
  `browser_enable_cdp` tool still works.

The helper is a detached Node process and does not hardcode an install path:

- app executable: `process.execPath`;
- main process: `process.ppid`;
- macOS: `osascript` quit, `.app` bundle name derived from the executable path;
- Windows: `taskkill`, PowerShell/WPF confirmation dialog;
- launch: removes `ELECTRON_RUN_AS_NODE` so the Electron binary starts as the
  app, not as Node;
- endpoint: published to `$DSH_HOME/browser-cdp.json` only after CDP answers.

Logs:

- macOS/Linux: `~/.dsh/browser-cdp-restart.log`
- Windows: `%USERPROFILE%\.dsh\browser-cdp-restart.log`
- override the directory with `DSH_HOME`

### macOS launcher (optional)

`scripts/dsh-cdp.sh` is a macOS convenience wrapper. It locates the app bundle by
bundle id (`com.deepseek.dsh`) through Spotlight/AppleScript, so it does not
hardcode `/Applications/...`:

```bash
scripts/dsh-cdp.sh            # focus a connected app, or start a stopped one
scripts/dsh-cdp.sh --restart  # relaunch a running app without CDP
scripts/dsh-cdp.sh --prompt   # ask before relaunching
```

Windows does not use this script; the plugin's startup dialog and
`browser_enable_cdp` are the supported path.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_diagnose` | Endpoint/target report and relaunch hint |
| `browser_enable_cdp` | Restart the app with CDP when the endpoint is missing |
| `browser_list_tabs` | Controllable Sidebar targets (`targetId`, title, URL, lease) |
| `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation |
| `browser_snapshot` | Visible interactive elements with `e1…eN` refs |
| `browser_click` / `browser_type` / `browser_select` / `browser_hover` / `browser_scroll` / `browser_press_key` | Input |
| `browser_read_page` | `text`, `html` or accessibility tree |
| `browser_screenshot` | Viewport or `fullPage`, attached as an image |
| `browser_evaluate` | Main-world JavaScript, JSON result |
| `browser_inject_script` | One-shot JS, or persisted under `$DSH_HOME` and re-injected |
| `browser_list_scripts` | List persisted userscripts and the store path |
| `browser_get_cookies` / `browser_set_cookie` | Cookie jar of the tab partition (HttpOnly included) |
| `browser_get_storage` | `localStorage` / `sessionStorage` |
| `browser_network` / `browser_network_body` | Captured requests and retained response bodies |
| `browser_console` | Console and `Log` entries |
| `browser_upload_file` | `DOM.setFileInputFiles` |
| `browser_metrics` | `Performance.getMetrics` |
| `browser_activate_tab` | Best-effort `Target.activateTarget` |

Typical flow: `browser_snapshot` → `browser_click` / `browser_type` with a ref.
Refs are invalidated by any main-frame navigation; take a new snapshot.

The default target is the most recently used tab. In split panes, pass an
explicit `targetId` so a command cannot land in the other pane.

## Configuration

The bundle row is `browser-cdp`. Defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | empty | Empty discovers the running app automatically |
| `allowPageTargets` | `false` | Never drive the DSH UI page; only `http(s)` pages if enabled |
| `maxNetworkEvents` | `1000` | Captured network records |
| `maxConsoleEvents` | `500` | Captured console records |
| `snapshotMaxNodes` | `300` | Snapshot node cap |
| `navTimeoutMs` | `15000` | Navigation timeout |
| `commandTimeoutMs` | `30000` | Per-CDP-command timeout |
| `maxTextChars` | `20000` | Text result cap |
| `screenshotFormat` | `png` | `png` or `jpeg` |
| `redactSensitive` | `true` | Strip credential-ish data from diagnostics |
| `stealth` | `true` | Chrome UA/CH and `window.chrome` helpers |
| `autoRestart` | `prompt` | `off`, `prompt` or `always` |
| `restartDelayMs` | `2500` | Delay before the helper quits the app |
| `restartGuardMs` | `120000` | Minimum spacing between restart attempts |

## Persistent userscripts

`browser_inject_script { source, persist: true }` writes the snippet to:

- macOS: `~/.dsh/browser-cdp-scripts.json`
- Windows: `%USERPROFILE%\.dsh\browser-cdp-scripts.json`
- or `$DSH_HOME/browser-cdp-scripts.json` when set

The plugin:

- reads the file 1.5 s after activation and attaches every current tab;
- applies scripts to every new tab as it appears;
- re-installs them after a plugin/app restart or a target recreation;
- lists them with `browser_list_scripts`;
- removes one with `browser_inject_script { remove: "<id>" }`.

Scripts are global to every Sidebar page and run with full page privileges.
The file is plain JSON; review it before sharing a profile. External edits are
picked up on the next plugin/app restart.

Example:

```js
browser_inject_script {
  source: "document.body.insertAdjacentHTML('beforeend', '<div id=\"hello\">hello world</div>')",
  persist: true,
  id: "hello-banner"
}
```

## Stealth

`stealth: true` (default) reduces the most common "this is Electron" tells:

- replaces the Electron UA with desktop Chrome for the current Chromium version
  (`Chrome/152.0.0.0` style);
- sets matching `userAgentData` brands (`Google Chrome`, `Chromium`) and Client
  Hints (`architecture`, `bitness`, `platformVersion`);
- overrides `Accept-Language` and the network UA;
- adds `chrome.app`, `chrome.csi`, `chrome.loadTimes` and `chrome.webstore` in
  every frame, including iframes.

On `bot.sannysoft.com` this moved the result from Electron/`HEADCHR_IFRAME FAIL`
to Chrome 152 with `WebDriver missing`, `PHANTOM_UA ok`, `HEADCHR_UA ok`,
`HEADCHR_CHROME_OBJ ok`, `HEADCHR_IFRAME ok` and `CHR_DEBUG_TOOLS ok`.

Limits:

- a page that loaded before the session attached already sent Electron request
  headers; call `browser_reload` after the first attach;
- the very first request of a new tab can still use Electron until the session
  attaches; a main-process `webContents.setUserAgent` would be needed for a
  zero-leak first request;
- `chrome.csi` / `chrome.loadTimes` are JavaScript shims; a site that inspects
  `Function.prototype.toString` can tell they are not native;
- `chrome.runtime` is intentionally not faked;
- no fingerprint layer guarantees passage through Cloudflare/Turnstile or a
  site-specific risk engine;
- `cf_clearance` cookies are UA-bound: after switching the UA, log in again.

Set `stealth: false` for raw Electron behavior when debugging.

## Sidebar split probe (client half)

The Host bundle has no direct API to open or split the Sidebar: layout belongs
to the client (`ui-sidebar-right` / `ui-dockkit`). The bundle includes an
**opt-in client probe** that demonstrates the client API:

```js
localStorage['dsh-browser-cdp.probe'] = 'split'
```

After a client reload, the probe:

1. waits for a mounted Session;
2. calls `ctx.sidebarRight.toggleExpanded()`;
3. calls `ctx.sidebarRight.split()`;
4. if a new pane is returned, calls
   `ctx.sidebarRight.openTab('browser', { paneId, params: { url } })`.

The result is written to `localStorage['dsh-browser-cdp.probe.result']`.

Requirements:

- the client boot graph must include this bundle's `./client` entry (reload or
  restart after installing);
- the Sidebar must have fewer than two docked panes; `split()` returns
  `undefined` at the two-pane budget or when the pane is empty/floating or the
  halves do not fit.

This probe is a developer diagnostic, not a Host tool. A Host↔client bridge
would be needed to expose split/open-pane as an agent tool. In the current Host
API, `window.open` stays in the source tab's pane, and `browser_navigate` just
navigates the chosen target.

## Windows notes

- Install the official DeepSeek Harness desktop app; no Node/npm is required
  for a prebuilt GitHub install.
- The confirmation dialog is PowerShell/WPF (`MessageBox` with OK/Cancel).
- Quit uses `taskkill /PID`; if the app does not close within 20 s, it falls
  back to `/F`. Sessions survive, but unsaved UI state may not.
- The restart log is at `%USERPROFILE%\.dsh\browser-cdp-restart.log`.
- The CDP port is loopback-only. No firewall rule should be needed.
- If the helper cannot start (antivirus/EDR), `browser_enable_cdp` and the log
  are the first places to check. Running DSH elevated while the helper is not
  (or vice versa) can also block `taskkill`.
- `scripts/dsh-cdp.sh` is macOS-only; use `browser_enable_cdp` on Windows.

### Windows test checklist

1. Install DSH and confirm the Sidebar browser works.
2. Install the bundle from GitHub or a local path.
3. Restart DSH.
4. Ask the agent: `browser_diagnose`.
5. If CDP is missing, click OK in the dialog or call `browser_enable_cdp`.
6. `browser_navigate https://example.com`, then `browser_snapshot`.
7. Check `browser_list_tabs`, a screenshot and a persistent script.
8. Check the restart log and `browser-cdp.json` under `%USERPROFILE%\.dsh`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `CDP: not available` | Call `browser_enable_cdp`; inspect the restart log |
| Dialog never appears | `autoRestart: off`; plugin failed to load; client boot error |
| OK closes the app but it does not reopen | Restart log; antivirus; try a manual launch with `--remote-debugging-port=0` |
| Stale endpoint | Delete `$DSH_HOME/browser-cdp.json` and restart; the helper rewrites it |
| Tool acts on the wrong pane | Pass explicit `targetId` from `browser_list_tabs` |
| Split probe returns `pane: null` | Already two docked panes, empty/floating pane, or no room |
| Persistent script missing | `browser_list_scripts`; path; restart after external edits |

## Development

```bash
npm install
npm run typecheck
npm run build
npm run check:lib      # build and fail if committed lib/ is stale
npm run pack:check     # npm pack --dry-run
```

Layout:

```
src/                 Host plugin (tools, CDP session, restart helper, stealth)
src/client/          Opt-in client split probe
lib/                 Built output, committed for GitHub installs
cordis.patch.yml     Bundle row and desktop-only guard
locale/              UI strings
scripts/dsh-cdp.sh   macOS launcher (optional)
```

`lib/` is committed on purpose: `plugin_manager install_bundle github:...` must
not need TypeScript at install time. CI runs `npm run build` and fails if `lib/`
differs.

### CI

`.github/workflows/ci.yml` builds on Ubuntu, Windows and macOS with Node 22,
runs `typecheck`, `build`, `git diff --exit-code -- lib` and `npm pack --dry-run`.

### Publish this repository

1. Replace every `YOUR_GITHUB_USER` in `package.json` and `README.md` with your
   GitHub account.
2. Create an empty public repository named `dsh-browser-cdp`.
3. Push:

   ```bash
   git remote add origin git@github.com:YOUR_GITHUB_USER/dsh-browser-cdp.git
   git push -u origin main
   ```

4. Create a release tag:

   ```bash
   git tag v1.0.0
   git push origin main --tags
   ```

5. Create a GitHub release from the tag (optional, but recommended). Users can
   then install the tag with
   `github:YOUR_GITHUB_USER/dsh-browser-cdp#v1.0.0`.

The repository already includes the built `lib/` output, so a GitHub install
does not need Node.js or TypeScript on the target machine. Do not add `lib/` to
`.gitignore`.

## Known limits

- The app must be restarted to enable CDP; an already-running process cannot be
  switched on in place.
- CDP is loopback-only but exposes the whole app Chromium; do not expose it to a
  network.
- Cross-origin iframes are not first-class targets; tools act on the main frame.
- `Page.reload` on a `<webview>` recreates the guest and drops the CDP session;
  the plugin uses `location.reload()` instead.
- `targetId` changes when a pane/tab is recreated, dragged or moved; re-list.
- Very small Sidebar widths can make split/pointer input unreliable; activate
  the tab or use `browser_evaluate`.
- The plugin cannot create tabs or split panes from the Host API; see the client
  probe.
- No stealth layer guarantees passage through Cloudflare/Turnstile.

## License

MIT. See [LICENSE](LICENSE).
