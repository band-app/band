# @band-app/worker

`band-worker` is the process that runs on a machine and serves it to a Band hub. It dials the hub over `@band-app/link`, completes the handshake, and answers the hub's calls with `@band-app/host-local`: files, git, processes, terminals, language servers, agent processes and the agent environment. Nothing in the hub calls it yet. `RemoteHost` and the hub's `/api/workers/connect` endpoint land in step 2.3, and the tests here use a link server of their own.

## Run it

```sh
pnpm --filter @band-app/worker start -- \
  --hub https://hub.example.com \
  --token "$BAND_WORKER_TOKEN" \
  --root ~/code --root ~/work \
  --labels gpu=1,zone=home --name laptop
```

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--hub <url>` | `BAND_HUB_URL` | Hub URL. `http` and `ws` are accepted only for loopback, because the hello carries the token. |
| `--token <token>` | `BAND_WORKER_TOKEN`, `BAND_BOOTSTRAP_TOKEN` | A session token, or a bootstrap token (prefix `bst_`). |
| `--root <dir>` | `BAND_WORKER_ROOTS` | A directory the worker may serve. Repeat for more. With none, `<state dir>/workspaces`. |
| `--name <name>` | `BAND_WORKER_NAME` | Reported as the `name` label. |
| `--labels k=v,...` | `BAND_WORKER_LABELS` | Placement labels. |
| `--state-dir <dir>` | `BAND_WORKER_STATE_DIR` | Default `$BAND_HOME/worker`, or `~/.band/worker`. |
| `--ephemeral` | `BAND_WORKER_EPHEMERAL=1` | Exit when idle. |
| `--idle-exit <dur>` | `BAND_WORKER_IDLE_EXIT` | Idle time before an ephemeral worker exits (`90s`, `10m`, default `10m`). |

Exit codes: 0 after a signal or an idle exit, 1 when the hub rejects the worker or a bootstrap fails, 2 for a bad command line.

## State and tokens

The state directory (mode 0700) holds `worker-id`, created once and reused so the hub sees the same worker after a restart, and `session-token` (mode 0600). A session token passed with `--token` is used as given. A bootstrap token is traded once for a session token by `POST /api/workers/bootstrap` with `{ token, workerId, name }`, answered by `{ sessionToken }`. The hub rotates the session token at every handshake, and the worker saves the newest, so restarting with the same bootstrap token reuses the saved one. Tokens are never logged. This exchange is the worker's guess at the hub's endpoint (`TODO(2.3)` in `src/bootstrap.ts`).

## Path policy

Every path in a call must be absolute and, once `..` and symlinks are resolved, inside a declared root. The check follows a symlink at the end of the path only when the call does (`readFile`, `writeFile`, `list`), so `rm` and `rename` of a link act on the link. A write through a dangling link is checked against where it would land. A root itself can't be removed or renamed. A rejected call fails with code `-32010` and `data.path`.

The policy covers the paths the hub names. It does not limit what a shell, command or agent does once it runs, and a local process that swaps a directory for a symlink between the check and the use can still escape.

## Calls

Methods are named after the `Host` interface: `host.info`, `exec`, `git.exec`, `git.gh`, `worktree.*`, `fs.*`, `search.*`, `lsp.*`, `acp.*`, `scripts.*`, `pty.*`, `agentEnv.*`. Params are objects with the interface's argument names. `src/methods-basic.ts` and `src/methods-streams.ts` list them.

A result is one of `{ json }`, `{ bytes }` (base64) or `{ chan, as }`. A result over 256 KiB goes down a channel the worker opened before replying. The hub reads it to the end, then ends its own side to release the channel. Data over the message limit going to the worker works the same way: `fs.writeFile` takes `data: { chan }` for a channel the hub opened.

Calls that stream open a channel and reply with its id, so the hub sees `link.open` before the reply:

- `fs.readStream`, `fs.watch`, `search.stream`: bytes or newline-delimited JSON, worker to hub. The hub ends or resets the channel to stop.
- `lsp.connect`: language server stdio, both directions.
- `acp.spawn`: agent stdout and stdin on one channel, stderr on another, plus `acp.exit` as a notification. The hub ending its side closes stdin, and resetting the channel kills the agent.
- `pty.attach`: terminal output down, keystrokes up. Closing the channel detaches the viewer, and with `killOnClose` it kills the terminal. The reply carries the screen snapshot. A terminal that exits ends its channels and sends a `pty.exit` notification.

Terminals run in the worker process (`InProcessTerminalBackend`), so they end when the worker does. They survive a dropped link, because a channel resumes after a reconnect. Running them in the terminal daemon is a follow-up.

## Ephemeral mode

An ephemeral worker exits with code 0 once nothing has run for `--idle-exit`. A call in progress and every open channel count as activity, including channels the hub opened. A worker that has lost the hub for that long also exits.

## Tests

`pnpm --filter @band-app/worker test` runs `node:test` suites against a real link server on a random port. The ephemeral and token suites start the real `bin/band-worker.mjs`. Every test uses a temporary `BAND_HOME` and state dir.
