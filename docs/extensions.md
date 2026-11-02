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
| `tools` | A JSON file with the editor's MCP `tools/list` answer. Agents do not use it yet. |

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
| Band to editor | `init { file: { name, path, mime, bytes, readOnly }, theme }` right after the hello |
| Editor to Band | `ready` once the document is loaded |
| Editor to Band | `dirty { dirty }` when unsaved edits start or end. The tab shows its dirty dot. |
| Editor to Band | `save { bytes }`. Band writes the file and answers `saved` or `saveFailed { error }`. |
| Band to editor | `requestSave` when the person presses Cmd+S while focus is on the tab, outside the frame |
| Band to editor | `theme { mode, tokens }` when Band's theme changes. `tokens` holds the semantic colors by name, such as `background` and `foreground`. |
| Band to editor | `reload { bytes }` when the file changed on disk and the tab has no unsaved edits |
| Both | `mcp { message }`, one MCP JSON-RPC message. Band sends a request and the editor answers with the same `id`. |

Keyboard focus inside the frame does not reach Band, so the editor handles Cmd+S itself and sends `save`.

Band saves with `PUT /api/worktree-file/<worktreeId>/<path>`, a raw body up to 50 MB, for an existing file in the worktree. A worktree on a worker is written on that worker. Any device token may save, as with the built-in editor. An agent cannot call this route.

### Reloading

After a save, and whenever the file changes on disk, every other tab on that file compares the new bytes with the ones it knows. With no unsaved edits it sends `reload`. With unsaved edits it shows the banner "This file changed while you have unsaved edits" with **Load theirs** and **Keep mine**. A tab's own save does not count as a change.

## Limits

- The frame can still make network requests. Only an admin installs an extension, and a later version will add a content security policy to `/ext/`.
- The editor sees only the file it was given.
- Not built yet: installing from a URL or a `.bandext` zip, Settings > Extensions, per-extension origins, the mobile app and agent access to an open editor.
