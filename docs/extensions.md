---
title: Editor extensions
description: Install an editor extension on the hub, open matching files in it, and write one that speaks the editor protocol.
section: more
order: 40
---

An editor extension adds an editor for some kinds of files, such as spreadsheets. A person opens a matching file in a center tab, edits it and saves it back to the worktree. The extension is a folder of web files. It runs only in a sandboxed iframe, holds no Band token and runs no code on the hub or on a worker.

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

The tab sends it to the hub with `editors.setSelection`. The hub keeps the latest selection per worktree and forgets it when that tab closes or its window stops reporting. A collapsed selection (`null`) clears it.

Keyboard focus inside the frame does not reach Band, so the editor handles Cmd+S itself and sends `save`.

Band saves with `PUT /api/worktree-file/<worktreeId>/<path>`, a raw body up to 50 MB, for an existing file in the worktree. A worktree on a worker is written on that worker. Any device token may save, as with the built-in editor. An agent cannot call this route.

### Reloading

After a save, and whenever the file changes on disk, every other tab on that file compares the new bytes with the ones it knows. With no unsaved edits it sends `reload`. With unsaved edits it shows the banner "This file changed while you have unsaved edits" with **Load theirs** and **Keep mine**. A tab's own save does not count as a change.

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

Settings > Extensions lists every installed extension with its version, editors and file types. A folder that failed to load shows an error icon with a popover naming the folder and the reason. An admin can install from a URL (with an optional SHA-256) or upload a `.tar.gz`, remove an extension after a confirmation, and reload the folder after copying one in by hand. The upload posts the file as the raw body of `POST /api/extensions/install` with the device token as a Bearer header.

For each file type an extension handles, the page shows the default editor and lets an admin change it or go back to the manifest default. It reads and writes the same synced `band:extension-defaults` key as Open With, so the two stay in step. A non-admin device sees the list and the defaults but no install, remove, reload or default controls.

## Limits

- The frame can still make network requests. Only an admin installs an extension, and a later version will add a content security policy to `/ext/`.
- The editor sees only the file it was given.
- Not built yet: a `.bandext` zip, per-extension origins, an agent path for an editor with no open window, and opening an editor from `band_editor_open` in the phone-width layout.
