---
paths:
  - "**/WorktreeCenter.tsx"
  - "**/_utils/tar-extract.ts"
  - "**/biome.json"
  - "**/components/extensions/ExtensionEditor.tsx"
  - "**/extension-editor-mobile.spec.ts"
  - "**/extensions-remote.test.ts"
  - "**/helpers/make-tar.ts"
  - "**/lib/extensions.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/api/extensions/handler.ts"
  - "apps/hub/src/server/api/worktree-file-put.ts"
  - "apps/hub/src/server/services/extension-service.ts"
  - "apps/hub/tests/extensions-install.test.ts"
  - "apps/hub/tests/extensions.test.ts"
  - "apps/web/e2e/extension-editor.spec.ts"
  - "apps/web/e2e/fixtures/extensions/text-editor/**"
  - "docs/extensions.md"
  - "packages/plugin-api/src/extension-manifest.ts"
---

# Architecture: extensions

An admin installs an editor extension as a folder in `<BAND_HOME>/extensions/<id>/` (guide: `docs/extensions.md`). The extension is web files. Its UI runs only in `<iframe sandbox="allow-scripts">` with a `null` origin, so it holds no Band token, cookie or storage, and it runs no code on the hub or a worker.

- Manifest and registry. `band-extension.json` is validated by `extensionManifestSchema` (`packages/plugin-api/src/extension-manifest.ts`, strict: an unknown key is an error; `contributes.fileEditors` has id, label, selector globs, default, entry, binary and tools). `services/extension-service.ts` reads the folder at first use and on `extensions.reload`, skips a manifest that fails (logged, and listed in `errors` with the folder and reason), and requires the folder name to equal the id. It is on the machine-access exempt list in `biome.json` because the folder is hub state. `extensions.list` (any device token) and `extensions.reload` (admin) are left out of the MCP endpoint, and the relay lists neither. CLI: `band extensions list | reload | install | remove`.
- Install from a release. `extensions.install { url, sha256? }` and `extensions.remove { id }` (admin, in `NEVER_FOR_AGENTS`, left out of the MCP endpoint) back `band extensions install <url | file.tar.gz> [--sha256]`. A URL is https (or http on loopback), 200 MB at most, 2 minute timeout, and the checksum is the given `sha256` or `<url>.sha256` when that exists. A local file goes up as the raw body of `POST /api/extensions/install[?sha256=]` (admin token; a request with an agent's chat, worktree or terminal header gets 403). `ExtensionService.installArchive` reads the archive in memory with `_utils/tar-extract.ts` (refuses links, absolute and `..` paths, more than one top-level folder, `._*` files are skipped, 500 MB expanded), validates the manifest with the existing schema, requires folder name = `id`, writes to `.install-<tag>` under the extensions folder and renames over `<id>` (the old folder is kept as `.old-<tag>` until the swap works), then reloads. The scan skips folders that start with a dot. Private release assets: `gh release download`, then install the file. Tests: `apps/hub/tests/extensions-install.test.ts` (Express stub, `helpers/make-tar.ts`), `extensions_install_*` in `apps/cli/tests/integration.rs`.
- Serving. `GET /ext/<id>/<path>` (`api/extensions/handler.ts`) is answered at the top of `handleRequest`, before CORS and the device-token check, because a `null` origin carries no credentials. Static files only, `Access-Control-Allow-Origin: *` on every answer including preflight, `application/wasm`, the `.br` or `.gz` copy when accepted, 404 for `..`, an encoded slash, a symlink out, a folder and an unknown id, and no cookie read or set.
- Saving. `PUT /api/worktree-file/<worktreeId>/<path>` (`api/worktree-file-put.ts`, after the auth check) takes a raw body up to 50 MB (413), applies the GET route's path rules (400 for a path or symlink out of the worktree and for `.git`), requires an existing file (404 otherwise) and writes through `host.fs.writeFile`, so a worktree on a worker is written there. A request with `x-band-chat-id`, `x-band-worktree-id` or `x-band-terminal-id` gets 403, and the relay lists no such route.
- Web. `lib/extensions.ts` holds the registry (`extensions.list` through react-query), `resolveEditor` and the "Open With" choice. An editor is named `<extensionId>/<editorId>` and `builtin` is the code viewer. The order is the file's choice (the `editor` field of its `band-tab-state:<ws>` entry, synced with scope `all`), then the glob defaults (`band:extension-defaults`, synced, scope `all`), then a manifest `default`. A choice that names a removed editor falls back to the built-in viewer. The tab stays `file:<path>`. `EditorChoiceFileLeaf` in `WorktreeCenter.tsx` picks `ExtensionEditor` or the code viewer, and `OpenWithItems` is the submenu in the Explorer and tab menus.
- Protocol (`components/extensions/ExtensionEditor.tsx`): `band:hello` with one transferred `MessagePort`, then `init`, `ready`, `dirty`, `save` to `PUT` to `saved` or `saveFailed`, `requestSave`, `theme`, `reload`, and `mcp` (a request matched to its answer by id, `ExtensionEditorHandle.mcp`, with no caller yet). Unsaved edits are tracked on the page only (`setExtensionDirty`), never synced, and feed the tab's dirty dot and the close confirm. After a save or a file-watch event the tab fetches the bytes and compares them with the ones it knows: no edits sends `reload`, edits show the "load theirs or keep mine" banner (same test ids as the code viewer's).
- Layout. An iframe reloads when its element is removed, so an extension tab sets its panel renderer to `always` (`PanelApi.setRenderer`) and stays attached while hidden, and `LayoutView` moves a panel element between groups with `moveBefore` when the browser has it, so a tab moved to another group keeps its document. A browser without `moveBefore` reloads the frame on a move and the editor starts from disk.
- Isolation. The frame is never given `allow-same-origin`. `/ext/` has no network CSP in v1, so a frame can still make requests.
- Tests: `apps/hub/tests/extensions.test.ts` (real hub), `extensions-remote.test.ts` (real `band-worker`), `apps/web/e2e/extension-editor.spec.ts` and `extension-editor-mobile.spec.ts` with the fixture `apps/web/e2e/fixtures/extensions/text-editor/`, `extensions_*` in `apps/cli/tests/integration.rs`.
- Not done yet: agent access to an open editor (`editors.register | result`, the `band` MCP tools), install from a URL or `.bandext`, Settings > Extensions, per-extension origins, the mobile app, the direct path for `PUT`, and new files.
