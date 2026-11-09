---
paths:
  - "**/desktop-direct-path.spec.ts"
  - "**/diff-service.ts"
  - "**/direct-path.test.ts"
  - "**/direct.ts"
  - "**/errors.ts"
  - "**/file-watch.ts"
  - "**/file-watcher.ts"
  - "**/lib/direct-worker.ts"
  - "**/lsp-proxy.ts"
  - "**/output-flow.ts"
  - "**/search-service.ts"
  - "**/strip-queries.ts"
  - "**/terminal-cache.ts"
  - "**/terminal-socket.ts"
  - "packages/worktree-ops/src/resolver.ts"
  - "apps/hub/src/server/api/plugins/stream-handler.ts"
  - "apps/hub/src/server/services/direct-access-service.ts"
  - "apps/hub/src/server/services/files-service.ts"
  - "apps/hub/tests/direct-path.test.ts"
  - "apps/web/e2e-desktop/desktop-direct-path.spec.ts"
  - "apps/worker/src/direct-files.ts"
  - "apps/worker/src/direct.ts"
  - "docs/local-direct-path.md"
  - "docs/simulator.md"
  - "packages/link/src/direct.ts"
  - "packages/shared/src/direct-access.ts"
  - "packages/worktree-ops/**"
  - "packages/worktree-ops/src/lsp-socket.ts"
  - "**/ExtensionPanel.tsx"
  - "**/extension-panels-tools.test.ts"
  - "packages/worktree-ops/src/resolver.ts"
  - "docs/extensions.md"
---

# Architecture: local direct path

The desktop app talks to its own machine's worker on `127.0.0.1` for that worker's worktrees: terminal sockets, the language server socket `/lsp`, the file-change socket `/watch` and `worktree.listFiles | getFile | saveFile | getDiff | getChanges | getFileDiff | searchFiles | searchContent | listBranches | getCommitHistory | getCommitHistorySignature | getCommitDetails | createFile | createDirectory | renamePath | copyPath | deletePath` and `GET` on `/api/worktree-file`, `/api/uploads` and `/api/shared` and `PUT` on `/api/worktree-file` (an extension editor's save, `putDirectFile` in `lib/direct-worker.ts`, `putDirectFile` in `apps/worker/src/direct-files.ts` with the hub route's rules; 405, 401, 403, a network error or a 5xx send the editor to the hub) (`apps/worker/src/direct-files.ts`, token in the `Authorization` header only, shown by the web app as a Blob URL through `useDirectAssetUrl`) (`DIRECT_PROCEDURES`, `packages/shared/src/direct-access.ts`). Guide: `docs/local-direct-path.md`.

- Hub: `worktree.directAccess { worktreeId, hostId }` (`services/direct-access-service.ts`) returns `{ hostId, port, token, expiresAt }` only when the worktree is on that worker, else null. `RemoteHost.direct.issue` mints a `bwd_` token and sends `direct.register` (`packages/link/src/direct.ts`). Tokens last 10 minutes (`BAND_DIRECT_TOKEN_TTL_MS`, read on every token), counted by the worker on its own clock and capped at 1 hour; `direct.register` carries `ttlMs` and the worker answers with `expiresAt`. The hub stores none. The procedure is left out of the MCP endpoint and the relay.
- Worker: `apps/worker/src/direct.ts` is a loopback listener separate from the relay, started on the first registration. It keeps token hashes with their scope, checks `Host` (421), `Origin` (`app://h-<hex>` only, 403), the token (401) and the worktree (403). Calls run `@band-app/worktree-ops` over a worker whose calls go through `Registrar.invoke`, the same handlers and path policy as a link call. The terminal socket serves `attachSession` from `@band-app/worktree-ops/terminal-socket` and waits up to 5 s for a PTY the hub is spawning, then closes with `4100`. The hello lists the `direct` and `directTerminal` capabilities.
- `packages/worktree-ops` holds `FilesService`, `DiffService`, `SearchService`, `GitGraphService`, `PathsService`, the file-route helpers (`http-files.ts`: byte ranges, MIME types, `Content-Disposition`), their input schemas, `directOps` (one definition per direct procedure, used by the hub's router and the worker) and the terminal WebSocket protocol (`terminal-socket.ts`, `output-flow.ts`, `strip-queries.ts`). The hub's `services/files-service.ts`, `diff-service.ts` and `search-service.ts` only build them over `worktreeService.resolve`. `WorktreeNotFoundError` lives in `worktree-ops/resolver.ts` and `errors.ts` re-exports it.
- Desktop: `worker_local_id` returns the installed service's `BAND_WORKER_ID` when it serves the current hub. The CSP's `connect-src` allows `http://127.0.0.1:*` and `ws://127.0.0.1:*` for a remote hub's pages only (not `app://local`).
- Terminal create: `POST /direct/terminal.create` (`DIRECT_TERMINAL_CREATE`, handled by `DirectListener.createTerminal` before the `DIRECT_PROCEDURES` lookup) spawns a plain terminal with `spawnTerminal` (`apps/worker/src/methods-streams.ts`, shared with the link's `pty.spawn`), mints the relay token in the worker (`Relay.issue`, revoked on the PTY's exit) and notifies the hub with `terminal.created` (`METHOD_TERMINAL_CREATED`, `TerminalService.onDirectCreated` records, lays out and emits `terminal-created`). `worktree.directAccess` returns `terminalCreate: true` only for a worker whose hello lists `directTerminal`. `directWorkerLink` routes a `terminal.create` mutation with a UUID id and no env there and falls back to the hub with the same id. Agent, script and cronjob terminals keep the hub. See `docs/local-direct-path.md`.
- Plugin streams: the worker also serves `GET /plugins/<plugin id>/stream?worktreeId=…` as a WebSocket upgrade (`DIRECT_PLUGIN_STREAM_PATH`, same checks and token subprotocol as the terminal), bridged by `bridgePluginStream` (`@band-app/worktree-ops/plugin-stream-socket`, shared with the hub's `api/plugins/stream-handler.ts`) and opened with `profile: "direct"` merged into the stream's params after the viewer's own (the query may add `name` and a JSON object `params`). `ExtensionPanel.tsx` asks `directPluginStreamTarget` first for each stream and falls back to the hub route `/api/extensions/<id>/worktrees/<wt>/stream`, which adds `profile: "hub"` (a service sends smaller frames, 15 fps at most; `docs/extensions.md`). A stream that opened on the hub asks `directPluginStreamTarget` again every 15 s and swaps to a direct socket without telling the page, so one failure at open does not pin it to the hub for its life; the panel shows a "via hub" marker (`extension-panel__via-hub`, reason from `directUnavailableReason`) while any stream is on the hub. Tests: the plugin stream refusal cases in `direct-path.test.ts` and the profile case in `extension-panels-tools.test.ts`. The desktop app's use of the direct stream for a panel has no automated test, because the desktop e2e has no fixture extension panel.
- Web: `directWorkerLink` (`lib/direct-worker.ts`) sits in front of the hub link in both tRPC clients, and `terminal-cache.ts` asks `directTerminalTarget` before each connect. Fallback to the hub on a connect error, a timeout, 401 or any refusal, then 15 s before the direct path is tried again.
- LSP and watch: `packages/worktree-ops/src/lsp-socket.ts` (`serveLspSocket`, the hub's `lsp-proxy.ts` is a wrapper) and `file-watch.ts` (the hub's `file-watcher.ts` is a wrapper) are shared with the worker, which serves `/lsp` and `/watch` in `direct.ts` under the same Host, Origin, token and worktree checks. The web opens them direct first (`directLspTarget`, `directWatchTarget`) and falls back to the hub when the socket does not open. The hub's only watch subscriber is `worktree.fileChanges`.
- Tests: `apps/hub/tests/direct-path.test.ts` (real hub and worker), `apps/web/e2e-desktop/desktop-direct-path.spec.ts` and `desktop-direct-extension-files.spec.ts` (real desktop app with this Mac as a worker; the second runs the fixture `text-editor` extension and asserts the hub sees no file `GET` or `PUT`). `formatFile`, `resolvePath`, `/api/worktree-preview` and the chat upload `POST` stay on the hub. Not done yet: the formatter, the signed preview route and videos above 64 MB.
