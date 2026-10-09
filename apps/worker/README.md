# @band-app/worker

`band-worker` is the process that runs on a machine and serves it to a Band hub. It dials the hub over `@band-app/link`, completes the handshake, and answers the hub's calls with `@band-app/host-local`: files, git, processes, terminals, language servers, agent processes and the agent environment. The hub reaches it through `RemoteHost` (`packages/host-remote`) and its `/api/workers/connect` endpoint. The tests here use a link server of their own.

## Install

The package is `@band-app/worker` and its binary is `band-worker`. It needs Node 22.5 or newer, and `git` on the machine for worktrees. `node-pty` compiles on Linux during the install, so a C++ toolchain, Python and `make` have to be present there (macOS and the container image need none).

```sh
npm install -g @band-app/worker
band-worker --hub https://hub.example.com --token "$BAND_WORKER_TOKEN" --root ~/code
```

`pnpm --filter @band-app/worker build` bundles the package into `dist/band-worker.mjs`. The `@band-app/*` packages are inlined and every third-party package stays a dependency, so the native modules (`node-pty`, `@vscode/ripgrep`) install for the machine the worker runs on. `scripts/pack-smoke.sh` packs the worker, installs the tarball into an empty directory, runs `band-worker --help` and starts a PTY from that install. CI runs it.

A checkout runs `src/` through `tsx`. Set `BAND_WORKER_USE_DIST=1` to run the bundle from a checkout.

The release workflow publishes this package with the same version as the desktop app, and the container image below as `ghcr.io/band-app/band-worker`.

### Run as a service

`band-worker install-service --hub <url> --token <bootstrap token> [--root <dir> --name <name> --labels k=v --worker-id <id> --state-dir <dir>]` registers the worker so it starts at login and restarts on failure (`src/service.ts`):

- Linux: the systemd user unit `~/.config/systemd/user/band-worker.service` reads `~/.band/worker-service/worker.env`, then `systemctl --user enable --now` and `loginctl enable-linger`. When linger is refused, the command prints what to run.
- macOS: the launchd agent `~/Library/LaunchAgents/app.band.worker.plist` carries the environment and logs to `~/.band/worker-service/worker.log`.

`~/.band/worker-service` is mode 0700 and the file holding the token is 0600. Neither the command nor the unit file prints or contains the token outside that file. `band-worker uninstall-service` removes the service files and keeps the worker's state. `band-worker status` exits 0 when the service runs, 3 when it is installed but stopped and 4 when it is not installed.

## Container image

`docker/worker.Dockerfile` builds a `node:22-bookworm-slim` image with the packed worker, `git`, `ssh`, `curl`, `jq` and `bash`. It runs as uid 10001 (`worker`) and keeps worktrees in the `/work` volume and the worker id and session token in `/home/worker/.band/worker`.

```sh
docker run -d -v band-work:/work -v band-worker-state:/home/worker/.band/worker \
  -e BAND_HUB_URL=https://hub.example.com \
  -e BAND_WORKER_TOKEN=bwb_... ghcr.io/band-app/band-worker:latest

# or from a checkout:
docker build -f docker/worker.Dockerfile -t band-worker .
```

The worker takes plain `http` only for a loopback hub. For a hub on the same Docker host, add `--network host` and use `http://127.0.0.1:<port>`; otherwise put the hub behind HTTPS.

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
| `--token <token>` | `BAND_WORKER_TOKEN`, `BAND_BOOTSTRAP_TOKEN` | A session token, or a bootstrap token (prefix `bwb_`). |
| `--worker-id <id>` | `BAND_WORKER_ID` | The id the hub issued with the bootstrap token. Without it the hub names the worker when it trades the token. |
| `--root <dir>` | `BAND_WORKER_ROOTS` | A directory the worker may serve. Repeat for more. With none, `<state dir>/worktrees`. |
| `--name <name>` | `BAND_WORKER_NAME` | Reported as the `name` label. |
| `--labels k=v,...` | `BAND_WORKER_LABELS` | Placement labels. |
| `--state-dir <dir>` | `BAND_WORKER_STATE_DIR` | Default `$BAND_HOME/worker`, or `~/.band/worker`. |
| `--ephemeral` | `BAND_WORKER_EPHEMERAL=1` | Exit when idle. |
| `--idle-exit <dur>` | `BAND_WORKER_IDLE_EXIT` | Idle time before an ephemeral worker exits (`90s`, `10m`, default `10m`). |

Exit codes: 0 after a signal or an idle exit, 1 when the hub rejects the worker or a bootstrap fails, 2 for a bad command line.

## Path policy

A hub call may name a path only when it resolves, with `..` folded and symlinks followed, to one of these:

- A root (`--root`, a root added through the repo picker, or the default `<state dir>/worktrees`).
- A folder the worker manages itself: `<BAND_HOME>/projects` (project folders and their `repos/<repo>` clones) and the clone directory (`--repos-dir`, default `~/band/repos`). They are served from startup, whatever the roots, because the worker creates them. The managed directory itself cannot be removed or moved.
- A git worktree registered by a repo that sits inside a root.

Anything else is refused with "is outside the worker's roots". The message adds "It is a worktree of <repo>, which is not inside a root" only for a linked worktree whose main repo is outside the roots. A plain checkout never gets the hint. A symlink inside a managed folder that leads elsewhere is refused like any other.

## State and tokens

The state directory (mode 0700) holds `worker-id`, created once and reused so the hub sees the same worker after a restart, and `session-token` (mode 0600). A session token passed with `--token` is used as given. A bootstrap token is traded once for a session token by `POST /api/workers/exchange` with `{ token, workerId?, name? }`, answered by `{ sessionToken, workerId }`. The hub binds the token to the host id it issued it for, and the worker adopts that id and saves it as `worker-id`. A session token lives until it is revoked. Restarting with the same bootstrap token reuses the saved one. Tokens are never logged.

## The band CLI

On every connect the worker asks the hub for the `band` CLI built for its platform and keeps it in `<state dir>/bin/band`, replacing it when the SHA-256 differs. It runs `band skills install` with that binary, and puts the directory first on the PATH of every agent and terminal it starts. Those processes call the hub through the relay with their own token.

The hub answers from `$BAND_CLI_BINARIES_DIR/band-<platform>-<arch>` (for example `band-linux-x64`, `band-linux-arm64`, `band-darwin-arm64`), then from its own CLI when the worker has the hub's platform and architecture. A hub on macOS serving a Linux worker needs the Linux binaries in that directory. The Docker image sets `BAND_CLI_PATH=/opt/band/binaries/band`, so a hub container serves workers of its own platform with no setup. `findCliBinary` also honours `BAND_CLI_PATH` and a `band` on the hub's PATH. With none available the worker logs a warning and runs without `band`.

## Path policy

Every path in a call must be absolute and, once `..` and symlinks are resolved, inside a declared root. The check follows a symlink at the end of the path only when the call does (`readFile`, `writeFile`, `list`), so `rm` and `rename` of a link act on the link. A write through a dangling link is checked against where it would land. A root itself can't be removed or renamed. A rejected call fails with code `-32010` and `data.path`.

A path outside every root is also allowed when, once resolved, it is or lies inside a git worktree that a repo on this worker lists in `git worktree list`, and that repo is itself inside a root. A repo is one with a URL mapping on the worker, or a git folder that is a root or sits directly in one. This covers worktrees another tool made outside the repo folder. Only the resolved path counts, so a symlink in a root that points at a non-worktree folder is refused, and one that points at a registered worktree is allowed. The worker reads each repo's worktree list at most every 5 seconds, and `worktree.create` and `worktree.remove` clear it at once. A worktree removed with plain `git` outside the worker is refused again within 5 seconds. When a refused path is a worktree of a repo that is not inside a root, the error names that repo and says to add its folder as a root.

The policy covers the paths the hub names. It does not limit what a shell, command or agent does once it runs, and a local process that swaps a directory for a symlink between the check and the use can still escape.

## Calls

Methods are named after the `Host` interface: `host.info`, `exec`, `git.exec`, `git.gh`, `worktree.*`, `fs.*`, `search.*`, `lsp.*`, `acp.*`, `scripts.*`, `pty.*`, `agentEnv.*`. Params are objects with the interface's argument names. `src/methods-basic.ts` and `src/methods-streams.ts` list them.

A result is one of `{ json }`, `{ bytes }` (base64) or `{ chan, as }`. A result over 256 KiB goes down a channel the worker opened before replying. The hub reads it to the end, then ends its own side to release the channel. Data over the message limit going to the worker works the same way: `fs.writeFile` takes `data: { chan }` for a channel the hub opened.

Calls that stream open a channel and reply with its id, so the hub sees `link.open` before the reply:

- `fs.readStream`, `fs.watch`, `search.stream`: bytes or newline-delimited JSON, worker to hub. The hub ends or resets the channel to stop.
- `lsp.connect`: language server stdio, both directions.
- `acp.spawn`: agent stdout and stdin on one channel, stderr on another, plus `acp.exit` as a notification. The hub ending its side closes stdin, and resetting the channel kills the agent.
- `pty.attach`: terminal output down, keystrokes up. Closing the channel detaches the viewer, and with `killOnClose` it kills the terminal. The reply carries the screen snapshot. A terminal that exits ends its channels and sends a `pty.exit` notification.

Terminals run in a terminal daemon, a detached process the worker launches on the first spawn (`src/terminal-daemon.ts`, bundled to `dist/terminal-daemon.mjs`, the same code as the hub's daemon). It owns the PTYs and a scrollback mirror, so a shell survives a worker restart, an upgrade or a crash. The daemon's files live in `<state dir>/run/` (mode 0700): the pid record, the token and the log, and the socket (mode 0600, moved to a private dir in `/tmp` when the path would exceed the Unix socket limit). Scrollback checkpoints are in `<state dir>/terminal-history/`.

After a restart the worker reconnects to the daemon when the hub connects. `pty.listAll` lists the same terminal ids, and `pty.attach` replays the screen. A shell that exited while the worker was down left a record in `<state dir>/run/exits/`, and the worker sends its `pty.exit` (exit code, `killed: false`) on the next connect, once. The daemon exits when it has no shell and no worker connected. Closing a terminal kills its shell. `band-worker uninstall-service` ends the daemon and every shell. The systemd unit has `KillMode=process` and the launchd plist `AbandonProcessGroup`, so stopping or restarting the service leaves the shells running.

`BAND_TERMINAL_DAEMON=0` keeps terminals in the worker process, where they end with it. A worker started in a test process (`Worker.start` without `persistentTerminals`) does the same.

## Ephemeral mode

An ephemeral worker asks the hub whether it may exit once nothing has run for `--idle-exit` (the hub can replace that time with `lifecycle.policy`). It exits with code 0 only when the hub answers that every worktree on it is stored. A refusal, such as a running terminal or a failed upload, keeps the worker up, and it asks again after another idle time. Against a hub with no `lifecycle.idle` handler it exits at once, as before.

A call in progress and every open channel count as activity, including channels the hub opened. The reads the hub makes on its own schedule (`host.info`, `worktree.list`, `git.exec`, `git.gh`, and the read-only `fs.*` and `search.listFiles` calls) hold the worker while they run but do not restart the idle clock, so a status poller does not keep a machine awake. A worker that has lost the hub for an hour (or its idle time, if longer) also exits, because it cannot store anything without the hub.

Two methods serve the hub's sleep and wake handshake: `lifecycle.exportSessions` reads the agent session files for the given session ids from `~/.claude/projects`, `~/.codex/sessions` and the directories in `BAND_AGENT_SESSION_DIRS`, and `lifecycle.importSessions` moves staged files back there. See [Ephemeral workers](../../docs/ephemeral-workers.md).

## Tests

`pnpm --filter @band-app/worker test` runs `node:test` suites against a real link server on a random port. The ephemeral and token suites start the real `bin/band-worker.mjs`. Every test uses a temporary `BAND_HOME` and state dir.
