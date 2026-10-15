# Local direct path

When the desktop app uses a remote hub and a worktree lives on this computer's own worker, the app sends that worktree's terminal traffic, file tree, file reads and saves, diffs and searches straight to the worker on `127.0.0.1`. Without it, every keystroke in a terminal on your own Mac travels Mac to hub to Mac and back, so a slow link to the hub slows your own machine.

The hub still decides who may do what. It issues a short-lived token for one worktree, and every call the worker serves passes the same checks as the same call from the hub. If the direct path fails, the app uses the hub without showing anything.

## When it is used

All of these must hold:

- The page runs in the desktop app. A browser tab never uses the direct path and never probes loopback ports.
- This computer runs a worker for the current hub. The app reads its id from the installed service (`worker_local_id`, `this-computer-worker.ts`).
- The worktree's id names that worker (`<repo>-<branch>@<worker id>`, `worktreeIdIsOnHost`).
- The worker has a direct listener. An older worker answers `direct.register` with "method not found", the hub returns no token, and the app keeps using the hub.

## What goes direct

| Path | Procedures |
| --- | --- |
| HTTP `POST /direct/<procedure>` | `worktree.listFiles`, `getFile`, `saveFile`, `getDiff`, `getChanges`, `getFileDiff`, `searchFiles`, `searchContent` |
| WebSocket `/terminal?worktreeId=…&terminalId=…` | The hub's terminal protocol: replay on `attach`, `ack`, input, `resize`, `ping`, title and exit frames |

A chat this worker owns ([chat ownership](chat-ownership.md)) goes there too: its event stream, messages, stop and answers, on the same token. Everything else goes to the hub: the events of chats the hub runs, LSP, file watching, the formatter, git staging, commits, pull and push, worktree lifecycle, the browser pane and the desktop viewer. The list of direct procedures is `DIRECT_PROCEDURES` in `packages/shared/src/direct-access.ts`.

A new terminal is still created through the hub (`terminal.create`), which spawns the PTY on the worker. The app opens the tab's socket at the same time, so the worker holds an upgrade for up to 5 seconds until the PTY appears. A terminal that never appears there closes with code `4100`, and the app reconnects through the hub, which spawns it. A pane whose first connect carries spawn options (`init`) goes to the hub from the start. Closing a terminal also goes through the hub (`terminal.kill`), so a `close` frame on a direct socket leaves the PTY running.

## Tokens

1. The app calls `worktree.directAccess { worktreeId, hostId }` on the hub with its device token. `hostId` is this computer's worker id.
2. The hub checks that the worktree lives on that worker, mints a `bwd_` token, and sends `direct.register { token, scope, ttlMs }` to the worker over the link. The scope holds the worktree id, its folder and its repo's default branch, all from the hub's records.
3. The worker keeps the token's SHA-256 with its scope, sets the expiry on its own clock (at most an hour ahead, whatever the hub asks), and answers with its listener's port and that expiry. The client on the same machine compares it with the same clock.
4. The hub returns `{ hostId, port, token, expiresAt }`, or null when the direct path does not apply.

A token lasts 10 minutes (`BAND_DIRECT_TOKEN_TTL_MS` overrides it). The app asks for a new one in the background once less than 2 minutes remain. When that renewal fails, the app keeps using the old token until it expires and asks again 15 seconds later. A terminal socket is checked when it opens, so an open terminal keeps working after its token expires. `worktree.directAccess` is left out of the MCP endpoint and the worker relay, so an agent cannot get a token.

The hub stores no direct tokens. Removing a worktree, or revoking the device token that asked, does not end a live direct token, which runs out on its own within 10 minutes. A restarted worker knows none of its old tokens.

## What the worker checks

The listener (`apps/worker/src/direct.ts`) binds `127.0.0.1` only, on a port the system picks, separate from the agent relay in `relay.ts`. On every request it checks, in order:

- The `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise), which stops a page that rebinds a DNS name to loopback.
- An `Origin`, when present, is the desktop app's page for a remote hub, `app://h-<12 hex>` (403 otherwise, `app://local` included). CORS answers only those origins.
- The token is registered and not expired (401 otherwise). A hub device token is no credential here.
- The call names the token's worktree (403 otherwise). A terminal must also belong to that worktree.

File, diff and search calls then run the same service classes the hub runs (`@band-app/worktree-ops`), over a host whose calls go through the worker's own method handlers (`Registrar.invoke`). So the path policy that keeps a link call inside the worker's roots applies unchanged, and a refused path fails with the same message on both paths.

## Falling back

The app's tRPC clients have a link in front of the hub link (`directWorkerLink`, `apps/web/src/lib/direct-worker.ts`). For a direct procedure on a local worktree it calls the worker, and passes the call to the hub when:

- the request fails to connect or takes longer than 15 seconds,
- the worker answers 401 (an expired token, or a worker that restarted), which also drops the cached token,
- the worker answers with any status other than 200 or a 500 that carries the procedure's own error.

A 500 with an error is the procedure failing, as it would on the hub, so the app shows it.

The terminal socket (`lib/terminal-cache.ts`) asks for a direct target before each connect. A direct socket that never opens, closes with `4100`, or drops after it opened reconnects through the hub at once, and the hub replays the screen. After a connection failure the direct path rests for 15 seconds, and new connections after that try the worker again. A socket that is already open on the hub stays there.

## Tests

- `apps/hub/tests/direct-path.test.ts`: a real hub and a real `band-worker`. It types, resizes and reattaches over the direct terminal socket, compares every direct procedure's answer with the hub's for the same worktree, covers the refusals (no token, unknown, expired, another worktree, a path outside the worktree, a non-loopback interface, a foreign `Host` or `Origin`) and a worker restart with its shell kept in the terminal daemon.
- `apps/web/e2e-desktop/desktop-direct-path.spec.ts`: the real desktop app with this Mac added as a worker. The terminal socket goes to `127.0.0.1`, the file tree and a file read go there and not to the hub, a worker restart falls back to the hub with the screen kept, a file opened after the restart reads without an error, and a later connection uses the worker again.

Not measured automatically: terminal echo latency over a slow link to the hub. Check it with macOS Network Link Conditioner (about 300 ms RTT) and the packaged app.
