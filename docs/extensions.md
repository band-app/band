---
title: Editor extensions
description: Install an editor extension on the hub, open matching files in it, and write one that speaks the editor protocol.
section: more
order: 40
---

An editor extension adds an editor for some kinds of files, such as spreadsheets. A person opens a matching file in a center tab, edits it and saves it back to the worktree. The extension is a folder of web files. It runs only in a sandboxed iframe, holds no Band token and runs no code on the hub or on a worker.

## Official extensions

Band lists the extensions of `band-app/band-extensions` as official. The hub fetches one file, `https://github.com/band-app/band-extensions/releases/download/catalog/index.json`, at startup and once a day, and keeps it in memory. `BAND_EXTENSION_CATALOG_URL` replaces the URL and is read on every fetch. If the file cannot be read, the hub logs it once and Settings > Extensions shows "Catalog unavailable".

The file is a JSON list. Each entry has:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description` | What the list shows. `id` is the extension id and folder name. |
| `version` | Plain MAJOR.MINOR.PATCH. |
| `url`, `sha256` | The `.tar.gz` release archive and its checksum. The hub refuses an archive that does not match. |
| `minBand` | The oldest Band version that can run it. An older hub shows "Not compatible" and offers no button. |
| `worker` | True when the extension has a part that runs on workers. The confirm dialog says it runs code on workers (standard and admin workers only). |
| `requires` | Worker facts it needs, such as `os=darwin`. |

An entry that fails validation is skipped. Nothing installs by itself: an admin clicks Install, or Update to vX when the catalog has a newer version than the installed one. The same calls are `band extensions catalog` and `band extensions install --official <id>`.

The hub records how each extension was installed in `<BAND_HOME>/extensions/.installs/<id>.json` (source, sha256, version). An extension is Official when it was installed from the catalog, or when its archive's sha256 equals the catalog's for that id. Otherwise the list says "Installed from URL" or "Installed from file". A folder copied in by hand has no record and shows "Installed by hand".

## Install

From a release archive, which is a `.tar.gz` with one top-level folder named by the extension id:

```sh
band extensions install https://example.com/sheet-1.0.0.tar.gz
band extensions install ./sheet-1.0.0.tar.gz --sha256 <hex>
band extensions remove sheet
```

The hub downloads an https URL (or http on loopback) up to 200 MB with a 2 minute timeout. A local file is uploaded to the hub, so it works against a remote hub. The hub checks the sha256 you pass, or `<url>.sha256` when that file exists. It refuses an archive with an absolute path, a `..` segment, a symlink or hard link, more than one top-level folder, a folder name that differs from the manifest `id`, or an invalid manifest. The old version stays until the new one has passed every check. `install` and `remove` need an admin token.

Band sends no GitHub token. For a private repo, download the asset with `gh release download` and run `band extensions install ./file.tar.gz`.

To install by hand instead, the hub reads extensions from `<BAND_HOME>/extensions/<id>/`, usually `~/.band/extensions/<id>/`. An admin copies the extension's folder there, then runs:

```sh
band extensions reload
band extensions list
```

`reload` needs an admin token. `list` shows each extension with its editors and an `error:` line for a folder that failed to load, with the reason. The hub also reads the folder at boot. A manifest with an unknown key or a bad selector is skipped and logged.

## Folder layout

```
band-extension.json     manifest
index.html, *.js, *.wasm the editor's web build
tools.json              optional, the editor's tools/list answer
LICENSE, NOTICE
```

The folder name must equal the manifest's `id`.

```json
{
  "id": "gridcraft",
  "name": "GridCraft",
  "version": "0.7.0-1",
  "extensionApi": 1,
  "contributes": {
    "fileEditors": [
      {
        "id": "sheet",
        "label": "GridCraft",
        "selector": ["*.xlsx", "*.csv"],
        "default": true,
        "entry": "index.html",
        "binary": true,
        "tools": "tools.json"
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `selector` | File name globs. `*` matches any run of characters and `?` one character. Matching ignores case and looks at the file name only. |
| `default` | When true, a matching file opens in this editor without a choice. A person's own default wins. |
| `entry` | The page the tab frames, relative to the folder. |
| `binary` | The editor reads and writes bytes, not text. |
| `tools` | A JSON file with the editor's MCP `tools/list` answer. Agents get these tools (see Agent access). A tool entry with `"agent": false` is left out. |

## Serving

`GET /ext/<id>/<path>` serves the folder's files. It needs no token, because the iframe has a `null` origin and carries no Band credentials. Every answer allows any origin, has the right MIME type (`application/wasm` for `.wasm`) and sets no cookie. The `.br` or `.gz` copy of a file is served when it exists and the request accepts it. A `..` segment, a symlink out of the folder, a folder and an unknown id answer 404.

## Open With and defaults

A matching file opens in the extension's editor when its manifest says `default` or the person set it as the default. Right-click a file in the Explorer, or its tab, and choose **Open With…** to pick the extension's editor or the built-in viewer. The same submenu has **Set <editor> as default for *.glob**. The choice for one file is kept in its tab state, and the default per glob is the synced client-state key `band:extension-defaults`, so every device uses it. If the extension is removed, the file opens in the built-in viewer.

## The editor protocol

The tab frames `/ext/<id>/<entry>` in `<iframe sandbox="allow-scripts">`. It never allows same-origin, so the frame cannot read Band's cookies, local storage or DOM. When the frame loads, the tab creates a `MessageChannel` and posts one message with `targetOrigin: "*"` and the second port transferred:

```js
{ type: "band:hello", extensionApi: 1 }
```

The editor listens for it, keeps `event.ports[0]` and ignores every other `window` message. All further traffic goes over the port. Bytes travel as `ArrayBuffer`, and the sender transfers them.

| Direction | Message |
| --- | --- |
| Band to editor | `init { file: { name, path, mime, bytes, readOnly }, theme, layout }` right after the hello. `layout` is optional. |
| Editor to Band | `ready` once the document is loaded |
| Editor to Band | `dirty { dirty }` when unsaved edits start or end. The tab shows its dirty dot. |
| Editor to Band | `save { bytes }`. Band writes the file and answers `saved` or `saveFailed { error }`. |
| Band to editor | `requestSave` when the person presses Cmd+S while focus is on the tab, outside the frame |
| Band to editor | `theme { mode, tokens }` when Band's theme changes. `tokens` holds the semantic colors by name, such as `background` and `foreground`. |
| Band to editor | `reload { bytes }` when the file changed on disk and the tab has no unsaved edits |
| Band to editor | `layout { layout }` whenever the layout changes. `layout` is `"compact"` or `"regular"`. |
| Editor to Band | `selection { selection }` when the selection changes, debounced to about 250 ms. `selection` is `null` when nothing is selected. |
| Both | `mcp { message }`, one MCP JSON-RPC message. Band sends a request and the editor answers with the same `id`. |

`layout` and `selection` are optional, so an editor that ignores them keeps working, and Band ignores messages it does not know.

### Layout

`compact` means a phone-width window (under 1024 px) or the iOS app. The editor hides its ribbon, toolbars and side panels, sizes its controls for touch, and favours viewing and selecting over editing chrome. `regular` restores the normal interface. In the compact layout the tab shows a bar under the editor with the file name, an "unsaved changes" note and a **Save** button, which sends `requestSave`.

### Selection

```js
selection = { address, kind, label, text?, rect? }
```

- `address` is the format's own address, which the editor's tools accept: `Sheet1!B2:C4` for a spreadsheet cell range, a shape id for a slide.
- `kind` is `cell`, `range`, `shape`, `text`, `paragraph`, `node` or `element`.
- `label` is short text for a person, such as `Sheet1!B2:C4`.
- `text` is the selected content as text (tab-separated for a cell range). The hub keeps at most 4 KB and ends a longer one with `…`.
- `rect` is optional, in the editor's own document units.

The tab sends it to the hub with `editors.setSelection`. The hub keeps the latest selection per worktree. It stays after the tab closes or the window stops reporting, because the phone closes its editor screen to open the chat. It goes when a new selection replaces it, when the editor sends `null` (a collapsed selection), or after 30 minutes (`BAND_EDITOR_SELECTION_TTL_MS`, read on every check).

Keyboard focus inside the frame does not reach Band, so the editor handles Cmd+S itself and sends `save`.

Band saves with `PUT /api/worktree-file/<worktreeId>/<path>`, a raw body up to 50 MB, for an existing file in the worktree. A worktree on a worker is written on that worker. In the desktop app, for a worktree on this Mac's worker, the editor reads and saves over loopback with the same rules (see [local direct path](local-direct-path.md)), and uses the hub route when the direct path is unavailable. Any device token may save, as with the built-in editor. An agent cannot call this route.

### Reloading

After a save, and whenever the file changes on disk, every other tab on that file compares the new bytes with the ones it knows. With no unsaved edits it sends `reload`. With unsaved edits it shows the banner "This file changed while you have unsaved edits" with **Load theirs** and **Keep mine**. A tab's own save does not count as a change.

## Worker services

An extension can run code on workers. The manifest lists each process under `contributes.workerServices`:

```json
{
  "contributes": {
    "workerServices": [
      { "id": "main", "entry": "service.mjs", "requires": ["os=darwin"], "capability": "simulator" }
    ]
  }
}
```

`entry` is a `.mjs` file in the extension folder. `requires` takes worker facts (`os=darwin`, `arch=arm64`) and binary names that must be on the worker's `PATH`. `capability` is the name the worker reports in its capabilities while the service runs, and the name the hub uses to call it.

### Where it runs

The hub keeps the `.tar.gz` of each installed extension in `<BAND_HOME>/extensions/.archives/` and tells every eligible worker which extensions to run (`extensions.sync`, with id, version and sha256). It does this when a worker connects and after every install, update, removal and `workers.setTrust`. The worker downloads the archive from the hub over its link (`extensions.fetch`), checks the sha256, unpacks it under `<state dir>/extensions/<id>/<version>/` and removes other versions. Then it starts one process per service whose `requires` hold.

A worker is eligible when its trust level is `standard` or `admin` and it is a connected worker. A `restricted` worker (the default for ephemeral and runner-started workers) never receives the archive and never runs the code, and the hub's own machine runs none. Installing an extension is admin only, and the install is the approval: an extension with a worker service runs code on every standard and admin worker, as the worker's user. The process has its own environment and nothing else separating it from the worker: there is no sandbox.

`workers.list` returns `extensionServices` for each worker, with `extensionId`, `serviceId`, `capability`, `version`, `state` (`running`, `restarting`, `stopped`, `failed` or `not-eligible`) and a `reason`. A restricted worker shows `not-eligible` with the reason `restricted`, and a service whose `requires` fail shows the failed requirement, such as `needs os=darwin, this worker has linux`.

### Environment for a worktree's agents and terminals

A service can give the agents and terminals of a worktree environment variables, for example the `DISPLAY` of a virtual screen it keeps per worktree. The manifest lists the names the service may set:

```json
{ "id": "main", "entry": "service.mjs", "capability": "desktop", "worktreeEnv": ["DISPLAY"] }
```

Before the worker starts an agent (`acp.spawn`, and a chat it owns) or a terminal (`pty.spawn`) in a worktree, it sends each running service of that kind `worktree.env { worktreeKey, worktreePath }` and adds the returned `env` object to the child's environment. The answer is filtered: a name the manifest does not list is ignored, a value must be a string of at most 1024 characters without a newline or NUL, and a service that fails, is not running, or takes more than 10 seconds adds nothing and the agent or terminal starts anyway. The manifest refuses names that start with `BAND_`, `GIT_`, `LD_`, `DYLD_`, `SSH_`, `GH_`, `GITHUB_`, `NPM_` or `NODE_`, `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `PWD`, `IFS`, and any name containing `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `API_KEY` or `PRIVATE`. The service's variables are applied last, so they win over the worker's own environment (a worker started with a `DISPLAY` of its own gets the worktree's). The call never starts a stopped service. Only standard and admin workers run services, so a restricted worker adds nothing. In the SDK this is the `worktreeEnv(scope)` handler.

### The process

The worker starts `process.execPath <entry>` with the extension folder as the working directory. Under Electron (the desktop app's bundled worker) the spawn sets `ELECTRON_RUN_AS_NODE=1` itself, so it does not depend on what the worker inherited. The environment is an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`, `DISPLAY`, `XDG_RUNTIME_DIR`). No `BAND_*`, `GIT_CONFIG_*` or token variable reaches the service.

A service that exits is started again after 1 s, then 2 s, then 4 s. A third exit within 5 minutes marks it `failed` with the last exit code and stderr, and it stays failed until the next sync. A lease fence stops the process, and the next call after the hub renews starts it again. The service also stops when the worker shuts down, when the extension is removed or updated, and when the worker's trust drops to `restricted`.

A bundled plugin with the same capability name takes precedence on that worker, and the worker logs it. Band bundles no worker plugin now, so the official `simulator` extension runs as it is.

### The protocol

Control messages are NDJSON on the service's stdin (worker to service) and stdout (service to worker). A request is `{id, method, params}` and its answer `{id, result}` or `{id, error: {message}}`.

| Method | Meaning |
| --- | --- |
| `init { worker, version, serviceId, stateDir }` | Sent once, first. `stateDir` survives updates and restarts. |
| `call { method, params, worktreeKey, worktreePath }` | Returns the JSON result. |
| `stream.open { streamId, name, params, worktreeKey, worktreePath }` | Opens a live stream. |
| `stream.close { streamId }` | The viewer left. |
| `worktree.env { worktreeKey, worktreePath }` | Answers `{ env }`: variables for the agents and terminals of the worktree. See above. |
| `worktree.release { worktreeKey, worktreePath, reason }` | `removed` (delete state), `fenced` or `shutdown` (keep it). For a removed worktree the service did not serve since it started, `worktreeKey` is `""` and only `worktreePath` is set. |
| `stop` | Exit after finishing up. The worker kills the process after 3 s. |

The service sends the notification `stream.end { streamId }` to end a stream. Stream data does not use stdio. It goes over file descriptor 3, a pipe the worker opens beside stdio, as binary frames: a 4-byte big-endian length, a 4-byte stream id, a kind byte (0 text, 1 bytes) and the payload, in both directions. The hub reaches a service with the same `plugin.call` and `plugin.stream` link methods as a bundled worker plugin.

### Who can reach a service

Same rule as a bundled worker plugin's stream. `GET /api/plugins/<capability>/worktrees/<worktreeId>/stream` (stream name `screen`) accepts any device token, admin or not. Text messages from the viewer reach the service from the start. The old `{"type":"control",...}` frame is accepted and ignored. An agent never reaches a service: the worker relay lists no such route (WebSocket routes are not relayed), `extensions.callService` is admin only, and `extensions.*` is left out of the MCP endpoint and the relay. Any number of viewers may hold a stream of one panel at once (two devices): each gets its own stream to the service, and the hub does not refuse a second one.

### Keeping a worker in step

The hub sends `extensions.sync` when a worker connects and after every install, update, removal and trust change. It also remembers the set each worker acknowledged and, with every lease renewal, sends it again when the worker has not acknowledged the current set. A sync that failed (the link was down, the worker was busy) therefore repeats until it succeeds, so a worker lowered to `restricted` stops its services even if the first sync never arrived. The call is idempotent.

### Lease

A service does not start or restart while the worker's lease is not valid, like `acp.spawn`. A service stopped by the fence, or a service synced while the lease is out, shows `stopped` and starts at the next renewal.

### The SDK

`packages/extension-worker-sdk` implements the service side. It is plain JavaScript with no dependencies, so an author copies `src/` next to the entry file or bundles it:

```js
import { defineWorkerService } from "./sdk/index.mjs";

defineWorkerService({
  onInit: ({ worker, stateDir }) => {},
  calls: { echo: (params, { worktreeKey, worktreePath }) => params },
  streams: {
    screen: (params, scope, stream) => {
      stream.send("hello");
      return { onMessage: (m) => stream.send(m), onClose: () => {} };
    },
  },
  worktreeEnv: ({ worktreeKey }) => ({ DISPLAY: ":7" }),
  onRelease: (worktreeKey, reason, worktreePath) => {},
  onReleasePath: (worktreePath) => {}, // a removed worktree this run never served
  onStop: () => {},
});
```

`console.log` writes to stderr, because stdout is the control channel.

### Limits

- Panels and tools are described above. `extensions.callService` (admin) and `/api/plugins/<capability>/worktrees/<worktreeId>/stream` (stream name `screen`) still reach a service directly.
- A service's scopes (the worktrees it served) are kept in memory. When a worktree is removed that the service has not served since it started, the worker sends `worktree.release` with an empty `worktreeKey` and the path, and the SDK calls `onReleasePath(path)`. A service that must act on such a worktree keeps its own index from key to path.
- The worker passes one `BAND_*` variable to a service, `BAND_SIMULATOR_NAME_PREFIX`, which test runs set.

## Language servers

An extension can give the code viewer a language server. Band bundles none: without an extension, a file has no completions, hover or diagnostics. Install the official `typescript-lsp` extension from Settings > Extensions for TypeScript and JavaScript, and `python-lsp` for Python.

```json
"languageServers": [{
  "id": "typescript",
  "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  "files": ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"],
  "command": "node_modules/typescript-language-server/lib/cli.mjs",
  "args": ["--stdio"],
  "rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"],
  "requires": ["node"]
}]
```

| Field | Meaning |
| --- | --- |
| `id` | The server id. The server's key is `<extension id>/<server id>`, which is the `lang` of the `/lsp` socket. |
| `languages` | LSP languageIds the server handles. |
| `files` | File name globs, matched like a file editor's `selector`. The code viewer opens a file against the first ready server whose globs match. |
| `command` | A path inside the extension folder ending in `.js`, `.mjs` or `.cjs`, which the worker runs with its own node, or the name of a binary on the worker's PATH. |
| `args`, `requires` | Arguments, and the worker facts or binaries the server needs. A missing binary shows as `needs <binary>` in `workers.list` (`languageServers[].reason`). |
| `rootMarkers` | Files at the worktree root that mark a project. With none present the server refuses to start ("No project"). Empty means always. |

The worker unpacks the extension like a worker service (see Worker services) and its LSP manager spawns one process per worktree and server in the worktree's folder, with the worktree's `node_modules/.bin` first on the PATH. Framing, sharing between editors, the path policy, the lease fence and removal of the worktree work as before. `workers.list` returns `languageServers` for each worker (key, languages, files, state `ready` or `unavailable`, reason), and the code viewer reads it. A restricted worker and the hub's own machine run no language servers. `initializationOptions` is not supported yet.

## Panels

An extension can add a worktree panel: a page in the center "+" menu that is not tied to a file. Declare it next to the worker service that feeds it:

```json
"contributes": {
  "workerServices": [{ "id": "main", "entry": "service.mjs", "capability": "screen" }],
  "panels": [{ "id": "screen", "label": "Screen", "icon": "monitor", "entry": "panel.html", "capability": "screen" }]
}
```

`capability` must be the capability of one of the extension's own services. The menu offers the panel when the worktree's worker is online and its service runs there, so a restricted worker, a worker that fails `requires` and the hub's own machine show nothing. `icon` is one of `globe`, `terminal`, `monitor`, `smartphone`, `image`, `box`, `play`, `activity`; any other name gets a puzzle icon. The tab stays mounted while hidden and is saved with the other center tabs. `"defaultControl"` is still accepted so existing manifests load, and has no effect: input is always on.

A panel may set `"binaryInput": true` (default false) to send binary frames to the service, for a protocol such as VNC. The page sends them with `stream.send { id, message }` where `message` is an `ArrayBuffer` or typed array. The hub passes each binary frame (1 MiB at most) to the service, from the start like text frames. Without the flag every binary frame from the page is dropped, as before, and text frames behave the same either way.

The page runs in `<iframe sandbox="allow-scripts">` with an opaque origin, like an editor, so it has no Band cookie, token or storage. Band posts `{ type: "band:hello", extensionApi: 1 }` with one transferred `MessagePort`. Everything else goes over that port.

From Band to the page:

- `init { worktreeId, theme, layout, visible }`, sent once. `theme` is `{ mode, tokens }`, the same shape editors get. The page answers `{ type: "ready" }`.
- `theme { mode, tokens }` whenever Band's theme changes (light or dark, Settings > Appearance edits), the same message editors get.
- `stream.opened { id }`, `stream.frame { id, data }` (an `ArrayBuffer`), `stream.message { id, text }` and `stream.closed { id, code, reason }`.
- `call.result { id, result }` and `call.error { id, message }`.
- `control { enabled }`, `visible { visible }` and `layout { layout }`.

From the page to Band:

- `stream.open { id, name, params }` opens the stream `name` of the service. A panel may hold 4 streams. Ids are the page's own strings.
- `stream.send { id, message }` sends a text message to the service.
- `stream.close { id }`.
- `call { id, method, params }` calls `method` of the service on this worktree's worker and answers with `call.result` or `call.error`.

Input is always on. The hub passes every text message the page sends to the service from the start, and Band sends the page `control { enabled: true }` once its first stream opens, so pages written for the older view-only protocol enable their input. Band has no Take control button for panels. Binary messages from the page are always dropped.

Frames go from the service through the worker, the link and the hub to the browser. In the desktop app, for a worktree on this Mac's own worker, the panel opens the stream on the worker's loopback listener instead (`ws://127.0.0.1:<port>/plugins/<capability>/stream?worktreeId=<id>&name=<stream>&params=<json>`, the same checks as the terminal socket: `Host`, `Origin`, token and worktree), and falls back to the hub route when that socket cannot open. Either way the service's `params` carry `profile`: `"direct"` on the loopback path (no hub link carries the frames, so a full-size, full-rate stream is fine) and `"hub"` through the hub (send smaller frames at a capped rate). Band sets `profile` after the page's own params, so the page cannot choose it. The hub route is `/api/extensions/<extension id>/worktrees/<worktree id>/stream?panel=<panel id>&name=<stream>&params=<json>`. It takes any device token and closes with code 4001 and a reason when the panel, the service or the worker is missing. Agents never reach it: the worker relay lists neither the route nor `extensions.panelCall`, and the MCP endpoint leaves `extensions.*` out.

## Tools

An extension can give agents tools that its worker service answers:

```json
"tools": [{
  "name": "echo",
  "description": "Echoes its arguments back",
  "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
  "service": "main",
  "method": "echo"
}]
```

Band adds each tool to the built-in `band` MCP server as `<extension id>_<name>`, for example `echo-service_echo`. A call goes to `method` on the service `service`, on the worker of the calling chat's worktree, with the call's arguments as `params`. The service's result is the tool result. A plain result is returned as JSON text. A result of the form `{ "content": [ ... ] }` is passed to the agent as the MCP tool result, with two block types: `{ "type": "text", "text": "..." }` and `{ "type": "image", "data": "<base64>", "mimeType": "image/png" | "image/jpeg" }`. An image is at most 5 MB decoded. Any other block type, another image type, bad base64 or an oversized image makes the call a tool error that names the problem. Images reach only the chat that made the call. No tab has to be open. The arguments cannot name another worktree. When the chat's worker does not run the service, the tool answers an error that names the worker. `"agent": false` leaves the tool out of the agent's list. `inputSchema` is a JSON Schema and is advertised as written. The service validates its own arguments.

## Mods

A mod adapts something Band already does: it restyles and restructures the web and desktop UI. It is one contribution of an extension (`contributes.mod`). One mod per extension. Several installed mods stack in install order (folder name order), and Settings > Extensions lists them in that order.

**A mod is trusted code.** It runs in the page with this device's token and can change or read anything the UI can. There is no sandbox. Installing the extension (an admin action) is the approval. Settings > Extensions says so next to the mod list.

```json
{
  "id": "macos-look",
  "name": "macOS look",
  "version": "0.1.0",
  "extensionApi": 1,
  "contributes": {
    "mod": {
      "css": ["mod.css"],
      "module": "mod.js",
      "window": {
        "material": "sidebar",
        "titleBarStyle": "hiddenInset",
        "toolbar": "unified",
        "trafficLightPosition": { "x": 20, "y": 18 }
      }
    }
  }
}
```

- `css`: a file name or a list of them, added to the page as `<link rel="stylesheet" data-band-mod="<id>">`. They may use any value. Prefer Band's CSS variables (`globals.css`) so Settings > Appearance still works.
- `module`: an ES module (`.js` or `.mjs`) in the folder, loaded with `import()` from `/ext/<id>/<file>?v=<version>`. Its default export is called with the `band` host object. The module must not import or bundle React: use `band.React`, which is Band's instance.
- `window`: desktop window options, applied by the Electron main process when it creates the window. Each field is optional and a missing one keeps today's default.
  - `material`: `sidebar` (default), `none` (no vibrancy layer), or any Electron vibrancy name (`titlebar`, `selection`, `menu`, `popover`, `header`, `sheet`, `window`, `hud`, `fullscreen-ui`, `tooltip`, `content`, `under-window`, `under-page`).
  - `titleBarStyle`: `hiddenInset` (default), `hidden`, `default`.
  - `toolbar`: `none` (default), `unified` or `compact`. Adds an empty native toolbar, which gives the window the large corner radius of a macOS toolbar window (about 19 px without, 25 px compact, 33 px unified, estimated from window captures). The page keeps running under the title bar. Needs the native addon, otherwise it is ignored with a log line (`BAND_FORCE_NATIVE_LOAD_FAIL=1` forces that for a test).
  - `trafficLightPosition`: `{ x, y }` in CSS px (default 13, 10).
  - The window options are read at window creation from `<BAND_HOME>/extensions/*/band-extension.json`, so a change needs a restart of the app.

The manifest is strict: an unknown key, or a bad `window` value, is refused with its path (`contributes.mod.window.material`) and the folder is listed under errors.

### Desktop bridge

When the desktop app runs with an installed mod that has `window` options, it gives the page:

- `--mac-*` CSS variables with the live AppKit colors: `--mac-label`, `--mac-label-secondary`, `--mac-label-tertiary`, `--mac-label-quaternary`, `--mac-separator`, `--mac-selected-content`, `--mac-selected-content-inactive`, `--mac-window-background`, `--mac-control-background`, `--mac-under-page`, `--mac-link` and `--mac-accent`. They follow the macOS appearance and the accent color and are updated when either changes. They follow the macOS appearance, not Band's theme, so use them only when the two agree (`prefers-color-scheme` against `.dark`) and fall back to fixed values otherwise. The CSS keyword `AccentColor` does not work in this Chromium.
- `--mac-symbols: 1`, set only when the native addon loaded, and the `band-symbol://<name>?pt=13&w=0&s=4` protocol: a PNG of the SF Symbol `<name>` (black on transparent, `w` is an NSFontWeight from -0.8 to 0.8, `s` the pixel scale). Use it as `mask-image` with `background: currentColor`. The scheme is allowed by the app's `img-src`. Gate rules with `@container style(--mac-symbols: 1)` so a browser keeps its own icons.

### The module

```js
export default function (band) {
  const h = band.React.createElement;
  band.override("sidebar.worktreeCard", (props, Default) => {
    const status = band.hooks.useAgentStatus(props.worktreeId);
    return h("div", null, h(Default), h("small", null, `${props.branch} ${status ?? ""}`));
  });
  band.transformSidebarItems((items, { repoName }) => items.filter((i) => i.name !== "scratch"));
}
```

The types are in `packages/plugin-api/src/mod-api.ts` (`BandModHost`, `ModRegionProps`). The props are a public API, versioned with `extensionApi`.

An override is `(props, Default) => element`. `Default` renders the stock component with the stock props, so wrapping it keeps clicks, drag and drop and menus. The function is rendered as a component, so it may call `band.hooks.*`. A later override of the same region wraps the earlier one.

| Region | Wraps | Props |
| --- | --- | --- |
| `sidebar` | the repos panel (header, list, footer actions) | `repoCount` |
| `sidebar.repoGroup` | one repo's header and its worktree list | `repoName`, `kind`, `collapsed`, `worktreeCount` |
| `sidebar.worktreeCard` | one worktree row | `worktreeId`, `repoName`, `branch`, `hostId`, `isActive`, `pinned`, `isRoot` |
| `worktree.header` | the tab strip of each group of the center layout | `groupId`, `tabs` (`id`, `title`, `selected`) |

Other parts of the UI are reachable through CSS only.

`band.transformSidebarItems(fn)` receives the worktrees of one repo in stock order (`name`, `branch`, `hostId`, `pinned`) and the context `{ repoName }`, and returns the ones to show, in order. Without the mod the stock order returns.

`band.hooks`: `useAgentStatus(worktreeId)`, `useBranchStatus(worktreeId)`, `useWorktrees()`. `band.extensionApi` and `band.extensionId` are also set.

### Errors and safe mode

- An override that throws while it renders makes Band render the stock component for that region. Settings > Extensions shows an error icon with a popover next to the mod (`aria-label` "<mod> mod failed in <region>"). A transform that throws is skipped and reported as `sidebar.items`, a module that fails to load as `load`.
- Safe mode loads no mod CSS and no module. Three ways in: `BAND_MODS=off` on the hub (`extensions.list` returns `modsOff`), the "Turn off mods" switch in Settings > Extensions (a per-device setting in `localStorage`, `band:mods-off`), and `?mods=off` in the URL, which sets the same setting. The switch is rendered in a shadow root on a fixed host that is a direct child of the body, with inline `!important` styles, so mod CSS cannot hide it. The desktop app also skips the mod's window options when `BAND_MODS=off` is in its environment.

Tests: `apps/hub/tests/extensions.test.ts` (manifest), `apps/web/e2e/mods.spec.ts` with the fixture `apps/web/e2e/fixtures/extensions/test-mod/`, `apps/desktop/tests/mod-window.test.ts`.

## Agent hint

A manifest may set `"agentHint"`, a string of at most 300 characters. The built-in `band` MCP server sends one line per extension that has a hint (`- <extension id>: <hint>`, ordered by id) as its MCP `instructions`, so an agent sees the hint in its system prompt before it loads any tool. Newlines in a hint become spaces. An extension without a hint adds nothing. Use it for the one fact an agent needs to pick your tools, for example "Use simulator_* tools to drive the iOS Simulator".

## Agent access

An agent in a chat can list, open, read and edit the document of an editor tab in its own worktree. It never saves: the edit shows in the tab as unsaved changes, and the person saves.

The built-in `band` MCP server lists these tools:

| Tool | What it does |
| --- | --- |
| `band_editor_list` | The editor tabs open in this worktree: file, editor, window and whether the tab has unsaved edits. |
| `band_editor_open` | Opens a file in its editor in the person's window, or reuses the open tab, and waits until the editor is ready. |
| `band_editor_selection` | What the person selected: file, editor, address, label and text. Says "Nothing is selected in an open editor." otherwise. |
| `<extension id>_<tool>` | Each tool from the editors' `tools.json`, with a required `file` argument (a path in the worktree) added to its schema. A tool marked `"agent": false` is not listed. |

The tool list comes from the manifests, not from open tabs. A tool call for a file with no open tab answers that it is not open and says to call `band_editor_open`. With no Band window connected, `band_editor_open` answers "No Band window is open. Ask the person to open Band."

How a call reaches the editor: each window registers its open editor tabs with the hub (`editors.register`, `editors.unregister`, repeated every minute) under the client id it already reports activity with. The hub sends the call to the window that most recently had focus, as an `editor-call` status event addressed to that client. The tab passes it to the editor as an `mcp` message and the window posts the answer with `editors.result`. A call that gets no answer fails after 60 seconds. `band_editor_open` sends `editor-open` to the most recently focused window of any worktree and waits up to 30 seconds for the tab to register.

A chat reaches only the editor tabs of its own worktree. All `editors.*` procedures are for device tokens: the worker relay and the MCP endpoint refuse them, so an agent cannot register a tab, forge a selection or answer a call.

### Selection in the chat

When the worktree has a selection, the chat composer shows a chip, "<label> · <file name>". The **X** removes it for one message only. A message sent with the chip carries this block after the person's text:

```
Selected in <path> (<extensionId>/<editorId>): <label>
Address: <address>
<text>
```

## Embedding an editor

`/embed/editor?worktreeId=<id>&path=<path>&editor=<extensionId/editorId>` renders only the editor tab for that file, full screen, in the compact layout with the Save bar. The iOS app loads it in a web view. It signs in like the rest of the web app, with the `band_token` cookie that a `?token=` link sets. The page registers its tab and reports selections like a normal tab. A missing file or an editor that is not installed shows an error message in place of the editor.

## Settings > Extensions

Settings > Extensions starts with the official catalog (name, description, version, and Install, Installed, Update to vX or Not compatible with this Band version), a Reload button that also rereads the catalog, and the install controls. It lists every installed extension with its version, where it came from, editors and file types. A folder that failed to load shows an error icon with a popover naming the folder and the reason. An admin can install from a URL (with an optional SHA-256) or upload a `.tar.gz`, remove an extension after a confirmation, and reload the folder after copying one in by hand. The upload posts the file as the raw body of `POST /api/extensions/install` with the device token as a Bearer header.

For each file type an extension handles, the page shows the default editor and lets an admin change it or go back to the manifest default. It reads and writes the same synced `band:extension-defaults` key as Open With, so the two stay in step. A non-admin device sees the list and the defaults but no install, remove, reload or default controls.

## Limits

- The frame can still make network requests. Only an admin installs an extension, and a later version will add a content security policy to `/ext/`.
- The editor sees only the file it was given.
- Not built yet: a `.bandext` zip, per-extension origins, an agent path for an editor with no open window, and opening an editor from `band_editor_open` in the phone-width layout.
