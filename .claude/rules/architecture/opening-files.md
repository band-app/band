---
paths:
  - "**/ExternalHtmlPreview.tsx"
  - "**/dashboard/lib/local-file-target.ts"
  - "**/desktop-open-local-files.spec.ts"
  - "**/document-types-config.test.ts"
  - "**/electron-builder.yml"
  - "**/external-file-remote.test.ts"
  - "**/index.ts"
  - "**/lib/external-source.ts"
  - "**/local-files.test.ts"
  - "**/quick-open-external-file.spec.ts"
  - "**/remote-relay.test.ts"
  - "**/use-file-drop-target.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/desktop/tests/local-files.test.ts"
  - "apps/desktop/tests/local-preview.test.ts"
  - "apps/hub/src/server/api/external-file.ts"
  - "apps/hub/src/server/services/_utils/external-preview-link.ts"
  - "apps/hub/src/server/services/external-file-service.ts"
  - "apps/desktop/src/main/services/local-files.ts"
  - "apps/desktop/src/main/services/local-preview.ts"
  - "apps/hub/tests/external-file-routes.test.ts"
  - "apps/hub/tests/host-file.test.ts"
  - "apps/web/e2e-desktop/desktop-open-local-files.spec.ts"
  - "apps/web/e2e/external-file-previews.spec.ts"
  - "apps/web/e2e/tab-strip-file-drop.spec.ts"
  - "docs/opening-files.md"
---

# Architecture: opening files

Any file opens as a tab (guide: `docs/opening-files.md`). `band open` falls back to `$BAND_WORKTREE_ID`, then the hub's active worktree. A path outside the worktree is an external tab, edited and saved on the worktree's machine: `worktree.readExternalFile | saveExternalFile` (`services/external-file-service.ts`) go through `worktree.host.fs`, so a remote worker's path policy applies and the hub's disk is never read. They are left out of the MCP endpoint and the relay. The old `host.readFile | saveFile` routes are gone. They go through `worktree.host.external` (`stat | readFile | writeFile`, worker link methods `fs.external.*`), which skips the worker's path policy: a device token may open, read and save any regular file the worker's user can (no symlink, regular files only, no create on save), and `editor.openFile` uses `external.stat` for it. A caller that is an agent (`ctx.agent` from the MCP endpoint, or the chat header from the relay; a terminal's relay call has none, so a person's `band open` in a worker terminal passes) keeps the policy-limited `host.fs` and gets "Agents can only open files inside this worker's folders". Errors say "File not found", "Not a regular file" or "Permission denied". `external-file-remote.test.ts` covers it. Previews: `GET /api/external-file/<worktreeId>?path=<abs>` (`api/external-file.ts`, after the device-token check) streams the bytes through `worktree.host.external.readStream` (link method `fs.external.readStream`, no symlink, regular files) with `Range` support and answers 403 to a request carrying a chat, worktree or terminal header; the web shows PDF, image and video as a Blob URL through `adapter.readExternalBlob` (256 MB cap, token in a header only). HTML previews load `worktree.externalPreviewUrl` (`services/_utils/external-preview-link.ts`, HMAC purpose `external-preview-v1`, scoped to the file's absolute folder, answered before the device-token check at `/api/external-preview/`) in a sandboxed iframe (`ExternalHtmlPreview.tsx`), read-only. Both procedures are left out of the MCP endpoint and the relay. On this Mac the main process reads bytes with `read_local_binary` (100 MB) and serves a local HTML file's folder at `app://<host>/__local-preview/<token>/` (`services/local-preview.ts`, `local_preview_grant`). Tests: `apps/hub/tests/external-file-routes.test.ts` (also remote-loopback), the `external-*` probes in `remote-relay.test.ts`, `apps/web/e2e/external-file-previews.spec.ts`, `apps/desktop/tests/local-preview.test.ts` and `local-files.test.ts`, and the S6 case of `desktop-open-local-files.spec.ts`.

- Files from Finder are on this Mac, so the desktop main process reads and saves them (`services/local-files.ts`, IPC `read_local_file | save_local_file`, registered through `registerIpc`, so the sender guard applies; no symlink, regular files, 1 MB, no create on save). Such a tab has the path `desktop:<absolute path>` (`lib/external-source.ts`), so its tab id and dirty state never collide with a worker file at the same path.
- `app.on("open-file")` (`index.ts`) pushes paths into `OpenFileQueue`, which holds them before any window exists. The renderer drains it with `take_open_files` at start and on the `open-files-requested` event. `LocalFileOpener` plans each file with `planLocalFileOpen` (`dashboard/lib/local-file-target.ts`): inside a worktree on this Mac's worker, switch there and open a normal tab, else an external desktop tab in the current worktree. Drops onto a tab strip or the empty center area (`use-file-drop-target.ts`) and the Cmd+O picker use the same path.
- Packaging: `mac.extendInfo.CFBundleDocumentTypes` in `electron-builder.yml`, role Editor, rank Alternate. Linux and Windows are not set up.
- Tests: `apps/desktop/tests/local-files.test.ts`, `document-types-config.test.ts`, `apps/hub/tests/host-file.test.ts`, `external-file-remote.test.ts`, `apps/web/e2e-desktop/desktop-open-local-files.spec.ts`, `apps/web/e2e/tab-strip-file-drop.spec.ts`, `quick-open-external-file.spec.ts`, `open_uses_the_terminals_worktree_*` in `apps/cli/tests/integration.rs`. The Finder Open With menu entry on an installed build is checked by hand.
