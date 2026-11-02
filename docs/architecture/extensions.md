# Extensions: file editors that people and agents share

Design, 2026-11-02. Phase 4 of [plugins.md](plugins.md). Nothing is built yet. GridCraft is the first extension.

## The model

A person opens a file in an editor tab, or asks the agent to open it. The editor runs in that tab. The agent changes the open document through the editor's own tools, and the person watches each change land. The person saves. Saving writes the file, and every other window that has it open reloads.

- The editor always runs in a person's Band window. Band never runs an editor without a window.
- The agent edits the document in memory. It cannot save. The file on disk changes only when the person saves.
- An agent gets an editor's tools from the built-in `band` MCP server with no setup. Installing the extension is the only step, and an admin does it once per hub.
- Band holds no code for a particular editor, and an editor holds no code for Band beyond the protocol below.

## Terms

- An **extension** is third-party code Band installs at runtime. Its UI runs only in a sandboxed iframe. It holds no Band token and runs no code on the hub or a worker.
- An **editor** is what an extension contributes for a set of files (`contributes.fileEditors`). One extension may contribute several.
- An **editor tab** is one open file in one editor in one window.

## Package and install

The extension ships a directory, later a `.bandext` zip of it:

```
band-extension.json     manifest
index.html, *.js, *.wasm the editor's web build
LICENSE, NOTICE
```

```json
{
  "id": "gridcraft",
  "name": "GridCraft",
  "version": "0.7.0-1",
  "extensionApi": 1,
  "contributes": {
    "fileEditors": [{
      "id": "sheet",
      "label": "GridCraft",
      "selector": ["*.xlsx", "*.csv"],
      "default": true,
      "entry": "index.html",
      "binary": true,
      "tools": "tools.json"
    }]
  }
}
```

`tools.json` is the editor's `tools/list` answer, generated when the extension is built (the GridCraft wrapper runs its own MCP server once and writes the list). The hub needs it because the `band` MCP server lists tools before any tab exists (see Agent access).

Install for v1: the hub reads `<BAND_HOME>/extensions/<id>/band-extension.json` at boot and when `extensions.reload` is called. The extension repo's `scripts/install.sh` copies a build there. `band extensions list | reload`. Install from a URL, Settings > Extensions and removal come later.

## Serving

`GET /ext/<id>/<path>` serves the extension's files. It is answered before the device-token check, because the files are public static assets and the iframe has a `null` origin that carries no Band credentials.

- Every answer has `Access-Control-Allow-Origin: *` (the iframe's `null` origin makes every fetch a CORS request), the right MIME type (`application/wasm`), and the `.br` or `.gz` copy when the build has one and the request accepts it.
- `..`, a symlink out of the folder and an unknown id answer 404.
- No cookies are read or set on this route.

The tab frames `/ext/<id>/<entry>` in `<iframe sandbox="allow-scripts">`, never with `allow-same-origin`. The frame cannot read Band's cookies, localStorage or DOM. The desktop CSP already allows the hub in `frame-src`.

Per-extension origins (`app://ext-<id>`, `<id>.ext.<domain>`) isolate extensions from each other. They are not needed for v1, because the protocol does not depend on the origin.

## Editor protocol

The tab creates a `MessageChannel`, posts `{ type: "band:hello", extensionApi: 1 }` to the frame with `targetOrigin: "*"` and transfers one port. The editor ignores any other message and speaks only on the port. Bytes go as transferred `ArrayBuffer`s.

| Direction | Message |
|---|---|
| Band → editor | `init { file: { name, path, mime, bytes, readOnly }, theme }` |
| Editor → Band | `ready`, `dirty { dirty }` |
| Editor → Band | `save { bytes }`. Band answers `saved` or `saveFailed { error }` |
| Band → editor | `requestSave` (Cmd+S on the tab), `theme { tokens }` |
| Band → editor | `reload { bytes }`, the file changed on disk and the tab has no unsaved edits |
| Band → editor | `mcp { message }`, one MCP JSON-RPC request. The editor answers `mcp { message }` with the same `id` |

`mcp` carries MCP as it is, so an editor with an MCP server (GridCraft's `gridcraft-mcp`) answers `tools/list` and `tools/call` with no translation. Image content passes through as MCP image content.

## Opening, saving, reloading

- `getFilePreviewType` returns `{ kind: "extension", extensionId, editorId }` when a `default` editor's selector matches. "Open With…" in the Explorer and tab menus lists the matching editors and the built-in viewer. "Set as default for *.xlsx" is a synced client-state key with scope `all`.
- The tab stays `file:<path>` with an `editor` param, so the center tab list, saved layouts and reopening work. An editor that is gone falls back to the built-in viewer.
- Bytes in come from `GET /api/worktree-file`. Bytes out go to a new `PUT /api/worktree-file/<worktreeId>/<path>`: raw body, any device token (like `worktree.saveFile`), 50 MB cap, the GET route's path rules, written through `host.fs.writeFile` so worker worktrees work.
- After a save, and whenever the file changes on disk (the file watch), every other tab on that file gets `reload` when it has no unsaved edits. A tab with unsaved edits shows the existing "load theirs or keep yours" banner instead.

## Agent access

### Tools

For every installed editor, the `band` MCP server (`api/mcp-proxy/band-tools.ts`) lists each tool from its `tools.json` as `<extension>_<tool>`, with a required `file` argument (a path in the chat's worktree) added to the input schema. Plus two of its own:

- `band_editor_open { file, editor? }` opens the file in a tab in a person's window, or reuses an open one, and answers when the editor is `ready`.
- `band_editor_list` returns the editor tabs open in this chat's worktree: file, editor, window, dirty.

The list comes from the manifests, not from open tabs, because the `band` server is stateless (a new server per request) and agents read their tool list once, at session start. A tool listed while no tab is open answers with a message that says to call `band_editor_open`.

Tools the extension marks as not for agents (`"agent": false` in `tools.json`, for GridCraft `save_workbook`, `open_workbook`) are left out, so the person decides when to save.

### Call path

```
agent → /mcp-proxy/band → hub → status stream → window → editor tab → iframe port
                                                                   ↓
agent ← /mcp-proxy/band ← hub ← editors.result (tRPC) ← window ← mcp answer
```

- Each window registers its open editor tabs with the hub (`editors.register { clientId, worktreeId, file, extensionId, editorId }`, `editors.unregister`) and keeps the list current. The hub forgets a window's tabs when its activity report expires (`client-activity-service`, 3 minutes) or it unregisters on page hide.
- A call picks the tab for `(worktree, file, editor)` in the window that most recently had focus (`services.setActivity` reports). It sends `editor-call { callId, tabKey, message }` on the status stream to that client only. The window passes it to the tab, and posts the answer with `editors.result { callId, message }`.
- `band_editor_open` with no tab open sends `editor-open { file, editor }` to the most recently focused window of any worktree. That window opens the tab, and the call waits for `ready` (30 s). With no window connected it answers "No Band window is open. Ask the person to open Band."
- A call times out after 60 s with an error naming the window.
- Scope: a chat reaches only editor tabs of its own worktree. The relay and the MCP endpoint leave `editors.register | unregister | result` to device tokens; an agent's token cannot call them.

## Security

- The iframe is `sandbox="allow-scripts"` with a `null` origin. It can't reach Band's storage or DOM and gets no token.
- It can still make network requests (fetch, WebSocket) to anywhere. v1 accepts this, because only an admin installs an extension. A later version adds a CSP on `/ext/` (`connect-src` from a manifest permission).
- The editor sees only the file it was given. It cannot read other files, run commands or call Band APIs.
- An agent's tool call can change only the document in an open tab of its own worktree, and cannot save it.

## PRs

1. **Extension host (band).** `/ext/<id>/` serving, `extensions.list | reload`, `band extensions list | reload`, the binary `PUT`, the editor registry, Open With, the `ExtensionEditor` tab with the protocol, reload on save and on file change. Tests use a small fixture extension (an HTML page that speaks the protocol and edits a text file), not GridCraft.
2. **GridCraft extension (band-extension-gridcraft).** A port bridge in place of the same-origin `?host=parent` bridge, `band-extension.json`, `tools.json` generated at build, `scripts/install.sh`.
3. **Agent access (band).** `editors.register | unregister | result`, the `editor-call` and `editor-open` status events, the tools from manifests in the `band` MCP server, `band_editor_open | list`. Depends on 1. Proven end to end with the fixture extension, then by hand with GridCraft.

1 and 2 run in parallel. 3 starts when 1 merges.

## Not in v1

Install from a URL or `.bandext`, Settings > Extensions, per-extension origins, a network CSP, the mobile app, the direct path for the `PUT` route, editors with no file (a new document), and running an editor without a window.
