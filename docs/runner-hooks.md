# Runner hooks

A runner is a pair of scripts the hub runs to get a machine for a worktree that has none. When `worktrees.create` carries a `placement` that no online host satisfies, the hub records a host request. `RunnerService` (`apps/hub/src/server/services/runner-service.ts`) takes that request, runs the runner's `spawn` script, and completes the request once the worker that script started says hello.

The hub ships six hooks in `runners/`: `local`, `ssh`, `docker`, `k8s`, `hetzner` and `contabo`. `hetzner` and `contabo` start a virtual machine per request (see [VM hooks](#vm-hooks-hetzner-and-contabo)). `docker` and `hetzner` also have snapshot hooks (see [Snapshots](#snapshots)). Any executable can be a hook.

## Configure a runner

Runners live in `~/.band/settings.json` under `runners`. `settings.update` validates them. The hub skips an invalid entry and reports it in `band runners list`.

```json
{
  "runners": [
    {
      "id": "local",
      "kind": "hook",
      "spawn": "bundled:local",
      "destroy": "bundled:local",
      "labels": { "pool": "local" },
      "isolation": "process",
      "maxConcurrent": 2,
      "timeoutSec": 120,
      "env": { "BAND_WORKER_BIN": "/usr/local/bin/band-worker" }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique. Letters, digits, `.`, `_` and `-`. |
| `kind` | `hook`. |
| `spawn` | The script that starts a worker. An absolute path, a path relative to `BAND_HOME`, or `bundled:<name>` for `runners/<name>/spawn.sh`. |
| `destroy` | Optional. The script that undoes `spawn`. `bundled:<name>` means `runners/<name>/destroy.sh`. Without it the reaper cannot destroy the runner's machines. |
| `status` | Optional. The script that lists the runner's live machines, so the reaper can find ones the hub forgot. `bundled:<name>` means `runners/<name>/status.sh`. |
| `labels` | What the runner offers. It takes a request when every label the request asks for is in this map. A request with no labels fits any runner. |
| `provides` | Optional facts about the machines it starts, like `{ "node": "24", "os": "linux" }`. When set, a request's `requires` must hold for them. When unset, `requires` is not checked. |
| `isolation` | The isolation of the machines it starts: `process` (same as `worktree`), `container` or `vm`. A request that asks for `container` or `vm` goes only to a runner that offers at least that (see [Isolation levels](#isolation-levels)). Passed to the hook as `BAND_ISOLATION`. Default `process`. |
| `desktop` | The machines it starts have a virtual desktop. Passed to the hook as `BAND_DESKTOP=1`. The `docker` hook then runs `BAND_DOCKER_DESKTOP_IMAGE` (default `band-worker-desktop`, built from `docker/worker-desktop.Dockerfile`) instead of the worker or repo image. Only the `docker` hook reads it, so other hooks start a host with no desktop. With `BAND_DOCKER_NETWORK=host`, x11vnc's loopback port is the machine's loopback and any local process can reach it, so use the default bridge network. Default `false`. |
| `maxConcurrent` | How many requests the runner has in flight at once. Default 1. |
| `timeoutSec` | Seconds from the start of an attempt to the worker's hello. Default 120. |
| `maxLifetimeSec` | Optional. How long a machine may live, counted from its spawn. Past it the reaper has the worker store its worktrees and exit, then runs `destroy`. Without it a machine lives until it exits. |
| `lifetimeGraceSec` | Seconds after `maxLifetimeSec` the reaper waits for the worktrees to be stored. Past that hard deadline it destroys the machine anyway. Default 600. |
| `env` | Extra environment for the hook, such as `BAND_SSH_TARGET`. The settings file is readable by any device token, so put no secrets here. |
| `snapshot`, `restore` | Optional, set both or neither. The hooks that snapshot a sleeping worker's machine and start it again from the snapshot (see [Snapshots](#snapshots)). `bundled:<name>` means `runners/<name>/snapshot.sh` and `restore.sh`. |
| `snapshotDelete` | Optional. The script that removes a snapshot. `bundled:<name>` means `runners/<name>/snapshot-delete.sh`. Without it the hub forgets a snapshot it no longer wants but cannot remove it, and logs a warning. |
| `snapshotKeep` | How many snapshots of this runner to keep, newest first. Default 3. |
| `snapshotTtlSec` | Seconds a snapshot lives. Default 7 days. |
| `snapshotTimeoutSec` | Seconds the `snapshot` hook may run. Default 600, at most 780. |

`bundled:` hooks are found in the nearest `runners/` directory above the hub's bundle, or in `BAND_RUNNERS_DIR`.

## Isolation levels

A worktree asks for a level with `isolation` in its environment (`placement.environment.isolation`, or `.band/environment.json` once placement reads it). A runner offers a level with its `isolation` setting.

| Level | Meaning | Placement |
| --- | --- | --- |
| `worktree` | A git worktree on a worker that other worktrees share. The default. | Goes to an online worker whose labels match, or to a runner offering any level. A worker a runner started is ephemeral and belongs to the worktree it was started for, so only a worker registered by hand is shared. A worker started for a `container` or `vm` worktree is never used. |
| `container` | A worker of its own, in a container. | Never reuses a host. A runner offering `container` or `vm` starts a new worker for each worktree. |
| `vm` | A worker of its own in a virtual machine. | Only a runner with `isolation: "vm"` takes it. The bundled hooks start no virtual machines, so you bring your own hook. |

A stronger level satisfies a weaker request, so a `vm` runner takes a `container` request. If no configured runner offers the level a `container` or `vm` worktree asks for, `worktrees.create` fails at once with `No runner offers isolation vm` (or `container`) instead of waiting for the placement timeout. A runner outside the hub's settings that leases requests with `hostRequests.lease` should pass `filter.isolation` with the level it offers.

The hub labels each worker it starts for a `container` or `vm` worktree with `band.isolation=<level>`, and placement skips hosts with that label.

## The contract

For each attempt the hub issues a one-time bootstrap token for a new host, then runs `spawn` with this environment and nothing else from the hub's own environment except `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `SHELL` and `SSH_AUTH_SOCK`:

| Variable | Value |
| --- | --- |
| `BAND_HUB_URL` | The URL the worker dials. `env.BAND_HUB_URL` of the runner, else `BAND_RUNNER_HUB_URL`, else `BAND_PUBLIC_URL`, else `http://127.0.0.1:<hub port>`. A worker accepts plain `http` only for a loopback hub, so a remote machine needs an `https` URL. |
| `BAND_WORKER_ID` | The id of the host the hub created. The worker must run with this id. |
| `BAND_BOOTSTRAP_TOKEN` | Trade for a session token once. Valid for the attempt's timeout plus a minute. |
| `BAND_REPO_URLS` | Comma-separated clone URLs of the request's repository, without credentials. The hub's local path when the repo has no origin remote; only a hook on the hub's machine can use that. |
| `BAND_ENVIRONMENT` | The request's `placement.environment` as JSON, parsed and checked with the `.band/environment.json` parser (`docs/agent-environments.md`), so it has the same shape. `{}` when there is none. A request whose environment does not parse fails at once, with the problems and their key paths, and no hook runs. |
| `BAND_CLONE_BY_HUB` | `1` when the vault holds a git credential for the first repository URL. The hook must skip its own clone and still print `BAND_HOST_REPO_PATH`. The hub clones into that path through the worker once it says hello, so the clone can use the credential (see [Git credentials](#git-credentials-for-private-repositories)). Unset otherwise, and always unset for `restore`. The `local`, `ssh`, `docker` and `k8s` hooks honor it. The VM hooks clone in cloud-init and ignore it, so a private repository needs a hook of your own there. |
| `BAND_REPO_IMAGE` | The repo's current environment image (`band env build`, `docs/agent-environments.md`), empty before its first ready build. |
| `BAND_DESKTOP` | `1` when the runner has `desktop: true`, else unset. |
| `BAND_ISOLATION` | The environment's `isolation` (`worktree`, `container` or `vm`) when it sets one, else the runner's `isolation`. |
| `BAND_LABELS` | The request's labels as `k=v,k=v`. Pass them to the worker (`BAND_WORKER_LABELS`) so the host carries them. |
| `BAND_REQUIRES` | The request's `placement.requires` as JSON. |
| `BAND_REPO` | The repo name. |
| `BAND_RUNNER_ID`, `BAND_REQUEST_ID` | The runner and the host request. |
| `BAND_MACHINE_HANDLE` | Only for `destroy`. The handle `spawn` printed, when it printed one. |
| `BAND_RUNNER_DIR` | A directory for the runner under `BAND_HOME`. Mode 0700, created by the hub. The hook runs with it as its working directory. |
| `BAND_NODE` | The Node binary the hub runs on. |

A hook must:

- Start `band-worker` for `BAND_WORKER_ID` with the token, and return. The worker keeps running after the hook exits, so detach it and redirect its output. The hub treats a hook as finished when it exits, even if a child holds its pipes.
- Exit 0 once the worker is started. Any other exit code fails the attempt. The hub does not wait for the worker inside `spawn`.
- Read the token from the environment, not from a command line. `band-worker` reads `BAND_HUB_URL`, `BAND_WORKER_ID` and `BAND_BOOTSTRAP_TOKEN` itself.
- Optionally print `BAND_MACHINE_HANDLE=<id>` on its own line: a name for the machine that `destroy` and `status` can find again, such as a container id, a pid or a VM id. No spaces. The hub stores it in `runner_machines` and passes it to `destroy` as `BAND_MACHINE_HANDLE`.
- Optionally print `BAND_HOST_REPO_PATH=<path>` on its own line: where the repository is on the worker. The hub passes it as `hostRepoPath` when it fulfils the request. The path must be inside one of the worker's roots.

`destroy` gets the same environment without `BAND_BOOTSTRAP_TOKEN`, plus `BAND_MACHINE_HANDLE`. It should stop the worker and remove what `spawn` made, and it should succeed when there is nothing to undo. For a machine the hub has no record of (an orphan), the hub sets `BAND_MACHINE_HANDLE` and `BAND_RUNNER_ID` and leaves `BAND_WORKER_ID` and the request variables unset, so a `destroy` must be able to work from the handle alone. It must check that the handle is one of its own machines before it kills anything.

`status` runs with the runner's `env`, `BAND_RUNNER_ID`, `BAND_RUNNER_DIR`, `BAND_HUB_URL` and `BAND_NODE`, and no request or worker variables. It prints the handle of every machine of this runner that still exists, one per line (the first word of a line counts, with or without a `BAND_MACHINE_HANDLE=` prefix; the VM hooks print `BAND_MACHINE_HANDLE=<id> worker=... state=...`), and exits 0. It must list only this runner's machines.

## Git credentials for private repositories

A hook has only the bootstrap token, so it cannot clone a private repository. Workers get git credentials from the hub instead:

1. Create a fine-grained personal access token on GitHub (Settings > Developer settings > Personal access tokens > Fine-grained tokens). Give it the repositories the workers need and the repository permissions Contents (read and write) and Pull requests (read and write).
2. Store it on the hub with a pattern over the repository path. The pattern is matched against `owner/repo` (no `.git`), `*` stays inside one segment and `**` crosses segments:

   ```sh
   printf '%s' "$TOKEN" | band vault put github-band --kind git --host github.com --path 'band-app/*'
   ```

   Settings > Credentials has the same form. `--scope repo:<name>` limits an item to one repo, and a repo-scoped item wins over a global one, then the pattern with more literal characters wins. `--username` defaults to `x-access-token`, which GitHub accepts for a token.
3. Nothing else is configured. When a worker starts, it adds a git credential helper to the environment of every git command, agent and terminal it runs (`GIT_CONFIG_*` and `GIT_TERMINAL_PROMPT=0`). The helper (`band-worker git-credential`) asks the worker over a Unix socket in a private temp directory, and the worker asks the hub with the `git.credential` call on its link. The hub answers only for a remote of a repository placed on that worker: a repo with a checkout or a worktree there, or the repository it is about to clone there. Any other repository is refused, and a remote with no matching vault item gets no credential.

The git token is never written to the worker's disk, never put in an environment variable and never logged (the hub logs the worker, host and path of each request, not the credential). Git's `store` and `erase` do nothing, and the helper replaces the machine's own credential helpers, so no keychain keeps it. A process on the worker that runs `git credential fill` for a placed repository can read the token. This is accepted, because an agent must be able to push. Three things limit the exposure:

- Use a fine-grained PAT limited to the repositories the workers need and to the permissions above, so a leaked token reaches nothing else.
- The hub logs every request (worker, host and path, never the credential), so each use is traceable to a worker.
- The git token is never on the worker's disk, in its environment or in any log, so it is gone when the process that asked for it exits. (`GH_TOKEN` for `gh` is the exception, see [Git and GitHub auth](#git-and-github-auth).)

The credential source sits behind the `GitTokenSource` interface (`services/_utils/git-token-source.ts`), so a GitHub App that mints installation tokens can replace the vault lookup later.

## Git and GitHub auth

The hub and workers use `git` for clones and pushes and `gh` for pull requests, checks and the GitHub subscription poller. Both images (`band-hub`, `band-worker`) contain `gh`, pinned by the `GH_VERSION` build argument. Each kind of machine authenticates differently.

| Machine | git | gh |
| --- | --- | --- |
| Attached worker (`band-worker --token ...` that you started) | Its own ssh keys or credential helper. The worker adds the hub's git helper, which answers only when the vault has a matching item. | Its own `gh auth login`. The hub sends nothing, unless the worker sets `BAND_WORKER_GH_TOKEN=hub`. |
| Runner-started worker | The vault `git` item, through the helper described above. | `GH_TOKEN` from the same vault item, in the environment of agents and terminals only. |
| Hub | The vault `git` item, for clones the hub makes through a worker. | The machine's own `gh auth login`. With none, `GH_TOKEN` from the vault `git` item for `github.com`. |

For `gh`, the hub uses the `git` item for `github.com` whose path pattern is broadest (a repo-scoped item wins over a global one). A dedicated `github` item kind does not exist yet. A worker asks with the `gh.token` call on its link every time it starts an agent or a terminal. The token goes into that child's environment only. It is not written to the worker's disk, not kept in the worker's memory between spawns, and not logged on either side. A worker whose own environment has `GH_TOKEN` or `GITHUB_TOKEN` keeps it, and the hub answers only workers it started through a runner or workers that opted in.

Any process of an agent on the worker can read its own environment, so use a fine-grained PAT limited to the repositories the workers need.

Token scopes for one PAT that serves git, `gh` and the hub's poller:

- Repository permissions: Contents (read and write), Pull requests (read and write), Metadata (read), Commit statuses (read) and Checks (read), so `gh pr create`, `gh pr checks` and the subscription poller work.
- Repository permission Webhooks (read and write), only if the hub registers GitHub webhooks (it needs a public URL, see [Run the hub on a server](run-the-hub-on-a-server.md)). Without it the hub polls.
- A classic token needs `repo`, and `admin:repo_hook` for webhooks.

With no `gh` login and no vault item, the hub's GitHub calls fail with "No GitHub credential for gh on this hub" and the command to store one. The poller logs it once and keeps running.

## Snapshots

A runner with `snapshot` and `restore` hooks keeps the disk of a sleeping worktree. Without them a wake builds the worktree again from the git state and agent session files the hub stored when it went to sleep (see [Ephemeral workers](ephemeral-workers.md)), so ignored files such as `node_modules` and build output are lost. With them, the wake starts a machine from the disk image that was taken at sleep, so installed dependencies, build output and untracked files are there at once.

The git and session state is still stored first, on every sleep. The snapshot comes on top of it, and the wake falls back to the stored state when anything about the snapshot goes wrong. A snapshot can make a wake faster and fuller, and it can fail without losing work.

| Hook | Environment | Output |
| --- | --- | --- |
| `snapshot` | `BAND_WORKER_ID`, `BAND_MACHINE_HANDLE` (what `spawn` printed, empty when it printed none), `BAND_WORKTREE_IDS` (comma-separated ids of the worktrees on the host), `BAND_RUNNER_ID`, `BAND_RUNNER_DIR`, `BAND_HUB_URL`, `BAND_ISOLATION`, `BAND_NODE` and the runner's `env`. | `BAND_SNAPSHOT_ID=<id>` on its own line, required. `BAND_SNAPSHOT_SIZE=<bytes>` optional. Exit 0. |
| `restore` | The `spawn` environment, with a new `BAND_BOOTSTRAP_TOKEN`, and `BAND_SNAPSHOT_ID`. | Optional `BAND_MACHINE_HANDLE=<id>`. It starts the worker with `BAND_WORKER_ID` and the token, as `spawn` does, and exits 0. |
| `snapshot-delete` | `BAND_SNAPSHOT_ID`, `BAND_WORKER_ID`, `BAND_MACHINE_HANDLE` and the common variables. | Exit 0, also when the snapshot is gone already. |

`spawn` and `restore` print `BAND_MACHINE_HANDLE=<id>` for the machine they made, and the hub passes it to `snapshot`, `destroy` and `snapshot-delete` of that machine. A hook that finds its machine by the worker id needs no handle.

A `restore` hook must not reuse the session token the snapshot holds. The hub revoked it when the worker went to sleep, and a worker that finds a saved session token uses it instead of the bootstrap token, so it would never connect. Delete the worker's saved `session-token` file from the restored disk (in `BAND_WORKER_STATE_DIR`) before the worker starts. The bundled hooks do. The restored worker has the same `BAND_WORKER_ID` as before.

### Sleep

1. The worker is idle and asks to exit. The hub stores the git state and the agent sessions, as without snapshots.
2. The hub runs `snapshot` while the worker still runs. It runs for at most `snapshotTimeoutSec`, because the worker waits 15 minutes for the hub's answer. A failing or timed out hook is logged, and the sleep goes on without a snapshot.
3. The hub records the snapshot in `runner_snapshots` (`runners.snapshots` lists them) and deletes the host's older ones.
4. The worker exits. The hub then runs `destroy` for its machine, so the machine does not outlive the snapshot.

### Wake

A wake is a host request like any other, and any runner whose labels fit may lease it. The runner that took the snapshot runs `restore` with it. Another runner, or one whose snapshot was removed or has expired, runs `spawn` and the hub restores from the stored git state.

1. `restore` starts a new machine from the snapshot, with a new bootstrap token. A `restore` that fails, or whose worker does not say hello within `timeoutSec`, runs `destroy` and then `spawn` in the same attempt, and the git restore takes over.
2. When the worker says hello after a restore, the hub checks that each worktree's checkout is on the machine at the commit it had. If it is, the hub only writes the agent session files again. If it is not, it restores from git.
3. The used snapshot is deleted with `snapshot-delete`.

### Retention and cost

A snapshot is storage you pay for until it is deleted. The hub deletes a snapshot when a wake has used it, when a newer one of the same host replaces it, and in a sweep every minute (`BAND_SNAPSHOT_SWEEP_MS`) that removes anything past `snapshotTtlSec` and everything beyond the newest `snapshotKeep` of a runner. A worktree whose snapshot is deleted before its wake still wakes, from the stored git state, only without its ignored files. Leave `snapshotKeep` at least as large as the number of ephemeral workers you expect to sleep at once, or the oldest sleepers lose their snapshots to newer ones.

A `snapshot-delete` that fails leaves the snapshot recorded, and the sweep tries again after 10 minutes, so a flaky provider API does not leak it. A snapshot whose runner has no `snapshotDelete` hook, or was removed from the settings, is forgotten with a warning in the hub log, and you remove it by hand. The log of each snapshot, restore and delete is `BAND_HOME/runners/logs/<worker id>.log` (`band runners log <worker id>`).

### Limits

- A snapshot holds disk state only. Running processes, memory, open terminals and dev servers do not survive. The environment's `start` and `terminals` run again after a wake, as on any new worker.
- The disk is copied while the worker runs, so it is crash-consistent. The hub has stored the work before it takes the snapshot and nothing writes after that, since the worker is idle and its agents and terminals have stopped.
- A snapshot belongs to the runner and the machine that made it. It is not portable to another runner, region, architecture or docker daemon.
- A host with several worktrees has one snapshot for the machine. Waking one worktree restores all of them.

## What the hub does

1. A runner with a free slot leases the oldest request its labels fit. A lease is one guarded SQL update, so two runners never take the same request. The hub renews the lease every 10 s while it works.
2. It runs `spawn`. A script still running after `timeoutSec` is killed.
3. After `spawn` exits 0 it waits for the host to come online. When it does, the hub fulfils the request and creates the worktree on that host.
4. An attempt fails when `spawn` exits non-zero, runs past the timeout, or the worker does not say hello in time. The hub then runs `destroy` and deletes the host it made. It tries once more with a new host and token. After the second failure the request fails, and its error holds the reason and the last 20 log lines.
5. Cancelling the request stops the run and runs `destroy`.

When the worker later exits because it was idle, the hub stores its worktrees and starts a new worker with the same id on the next message, terminal or file access. That wake is another request, and `spawn` runs again with the same `BAND_WORKER_ID`, so the hook must start that id on a clean machine. See [Ephemeral workers](ephemeral-workers.md).

## The reaper

`RunnerReaperService` (`apps/hub/src/server/services/runner-reaper-service.ts`) makes sure no machine a runner started leaks. The hub records each machine in the `runner_machines` table (`spawning`, `running`, `stopping`, `destroyed` or `lost`, with the handle, the worker id, the request and the times). Every `BAND_REAPER_INTERVAL_MS` (default 30 s) it destroys, through the runner's `destroy` hook:

- **A machine that never said hello.** A machine still `spawning` that no attempt in flight owns (for example after a hub restart) is destroyed once `timeoutSec` plus `BAND_REAPER_HELLO_GRACE_MS` (default 60 s) have passed since the spawn. The host row it made is removed.
- **A lost machine.** A running machine whose host row is gone is destroyed at once. One whose worker has been `offline` or `lost` for `BAND_REAPER_OFFLINE_MS` (default 2 minutes) is destroyed too, which also cleans up after an ephemeral worker that went to sleep and exited. The time counts from the hub's boot at the earliest, so a hub restart does not destroy workers that are about to redial.
- **An orphan.** For a runner with `status` and `destroy`, a handle that `status` lists and no live `runner_machines` row has is destroyed. The sweep skips a runner while one of its spawns is in flight.
- **A machine past `maxLifetimeSec`.** The machine becomes `stopping`. The reaper sends `lifecycle.sleep` to the worker, which then goes through the same hand-off as an idle one (docs/ephemeral-workers.md): the hub refuses while an agent turn, queued message or terminal runs, and otherwise stores each worktree's snapshot and agent sessions before the worker exits. The reaper asks again every sweep and shows the reason in the machine's note. It runs `destroy` only after the worker has exited with every worktree stored. A machine with no worktrees is destroyed at once.

A machine whose worktrees are not stored is never destroyed early. It waits until the hard deadline (`maxLifetimeSec` plus `lifetimeGraceSec` after the spawn, or the offline threshold plus `lifetimeGraceSec`). If that passes, the machine is destroyed anyway and the hub logs an error naming the worktrees that were lost. A worker that is not ephemeral cannot hand its worktrees over, so a machine like that waits for the deadline.

When `destroy` fails, the reaper runs it again on the next sweeps. After the third failure the machine is `lost` and stays listed. If a later `status` still lists its handle, the orphan sweep tries again.

A worker id that wakes up gets a new machine row, and the row of its earlier machine ends as `destroyed` (replaced), because the hook wipes the old machine when it starts the new one.

Settings > Runners lists the machines with their state and age. An admin can destroy one there (`runners.destroyMachine`). The hub refuses while the machine holds worktrees that are not stored, and the UI then offers "Destroy anyway". Only admin tokens can list machines or destroy them, and the MCP endpoint and the worker relay leave `runners.*` out.

## Logs

The hub keeps everything a hook prints in `BAND_HOME/runners/logs/<request id>.log`, one line per output line, tagged `spawn stdout`, `spawn stderr`, `destroy stdout` and so on. Before a line is stored the hub replaces the attempt's bootstrap token and anything shaped like a Band token (`bwb_`, `bws_`, `bdt_`, `brt_`) with `[redacted]`. Read a log with `band runners log <request id>` or from Settings > Runners.

## Bundled hooks

### `local`

Starts an ephemeral `band-worker` on the hub's machine. Everything lives under `$BAND_RUNNER_DIR/<worker id>/`: its own `HOME` and `BAND_HOME` (`home/.band`), its state dir, and a work dir that is its only root. If `BAND_REPO_URLS` is set, `spawn` clones the first URL into the work dir and prints `BAND_HOST_REPO_PATH`. It writes the worker's pid to `pid` and prints it as `BAND_MACHINE_HANDLE`. `destroy` kills that pid, waits for it to exit, and removes the directory. `status` lists the pids of the worker directories whose process is alive. With only a handle, `destroy` acts only when one of the runner's directories holds that pid. A `spawn` for a worker id that already has a directory (a worker waking up) deletes the old directory first, because a woken worker is a new machine, and it refuses when that worker's pid is still alive.

Settings (`env`): `BAND_WORKER_BIN` is the worker, either a `.mjs`/`.js` file run with `BAND_NODE` or an executable (default `band-worker` on `PATH`). `BAND_IDLE_EXIT` sets how long an idle worker waits before it exits, like `90s` (default 10 minutes).

### `ssh`

Runs the same steps on another machine: `ssh $BAND_SSH_TARGET 'sh -s'` with a script on stdin. The script, which carries the bootstrap token, is sent over stdin, so the token is in no command line on either machine. The worker's files go to `$BAND_SSH_DIR/<worker id>/` on the target. `destroy` kills the pid and removes that directory. The handle is the remote pid, and `status` lists the live ones on the target.

Settings (`env`):

| Variable | Meaning |
| --- | --- |
| `BAND_SSH_TARGET` | `user@host`. Required. |
| `BAND_SSH_OPTS` | Extra ssh options, split on spaces, like `-p 2222 -i /keys/runner`. |
| `BAND_WORKER_CMD` | How to start the worker on the target. Default `band-worker`. Use `npx --yes @band-app/worker` for a target with no install. |
| `BAND_SSH_DIR` | Directory on the target. Default `.band-runner` under its home. |
| `BAND_SSH_CLONE_LOCAL` | Set to `1` when the target sees the hub's file system, so a repository with no origin can be cloned from its path. |
| `BAND_IDLE_EXIT` | Idle wait before the worker exits. |

The target must reach `BAND_HUB_URL`, and `ssh` must log in without a prompt (the hub passes `BatchMode=yes`). Because `HOME` and `SSH_AUTH_SOCK` are passed through, an agent-held key works. The host key is accepted on first use (`StrictHostKeyChecking=accept-new`); set `BAND_SSH_OPTS` to change that.

### `docker`

Starts the worker image in a hardened container with `docker run --detach --rm`. The flags follow Bunny's docker runtime (`packages/runner/src/runtime/dockerRuntimeAdapter.ts`, `docker/client.ts`).

| Setting | Why |
| --- | --- |
| `--user 65532:65532` | A non-root uid with no entry in `/etc/passwd`. |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | No capabilities, and a process cannot gain any. |
| `--read-only`, `--tmpfs /tmp`, `--volume /work` | The root file system is read-only. The worker writes to `/tmp` (memory, 512 MB by default) and to the `/work` volume (its `HOME`, state and checkouts). The volume is anonymous, so `--rm` removes it. |
| `--pids-limit 512`, `--memory`, `--cpus` | From `BAND_DOCKER_PIDS_LIMIT` and the environment's `resources` (`memory` `8Gi` becomes `8g`). `resources.disk` is not enforced. |
| `--label band.runner`, `band.request`, `band.worker` | The runner, the host request and the worker id, for `docker ps --filter label=...`. |
| `--network bridge` | The default. See below. |

The repo's image is `BAND_REPO_IMAGE` when this docker daemon has it or can pull it (it has the toolchain, the installed dependencies and the worker, and needs `git` for the clone). When it cannot get the image, for example one built on another host with no registry, the hook says so in its log and runs the base image. Nothing from the host is mounted and the docker socket is never passed in. The token goes in with `-e BAND_BOOTSTRAP_TOKEN`, so it is not in a command line or `ps`. It is in the container's config, though, so anyone who can run `docker inspect` on that daemon can read it. That is accepted: access to a docker daemon is root-equivalent on that machine, and the token is single-use and spent when the worker exchanges it. The container clones the first of `BAND_REPO_URLS` into `/work/<repo>` before the worker starts, so the repository needs a URL the container can reach. When the vault holds a git credential for it (`BAND_CLONE_BY_HUB`), the container skips that clone and the hub clones through the worker after hello. A repo with no origin remote has only a path on the hub's machine, which fails the clone.

Settings (`env`):

| Variable | Meaning |
| --- | --- |
| `BAND_DOCKER_IMAGE` | The worker base image, run when the repo has no ready environment image. Default `band-worker`, built with `docker build -f docker/worker.Dockerfile -t band-worker .`. |
| `BAND_DOCKER_NETWORK` | Docker network. Default `bridge`. |
| `BAND_DOCKER_PIDS_LIMIT` | Default 512. |
| `BAND_DOCKER_MEMORY`, `BAND_DOCKER_CPUS` | Limits for an environment with no `resources`. Default none. |
| `BAND_DOCKER_TMP_SIZE` | Size of the `/tmp` tmpfs. Default `512m`. |
| `BAND_IDLE_EXIT` | Idle wait before the worker exits, like `90s`. |
| `DOCKER_HOST` | A remote docker daemon, such as `ssh://user@build-host`. |

`snapshot.sh`, `restore.sh` and `snapshot-delete.sh` give the runner the snapshot hooks (`"snapshot": "bundled:docker"`, `"restore": "bundled:docker"`, `"snapshotDelete": "bundled:docker"`). `docker commit` leaves volumes out and `/work` is a volume, so `snapshot.sh` copies the contents of `/work` (the checkouts, the worker's `HOME` and its state) into a plain directory `/snapshot` of a helper container made from the worker's own image, and commits the helper as the image `band-snapshot:<worker id>-<time>`. The image carries the labels `band.snapshot.base` (the ID of the image the worker ran from), `band.worker` and `band.runner`. `restore.sh` is `spawn.sh` in restore mode: it runs the base image, fills the new container's `/work` volume from `/snapshot` with a short-lived container that shares the volume, removes the worker's dead session token and starts the worker. It does not clone. The snapshot image is only read during that copy, so `snapshot-delete.sh` (`docker rmi`) can remove it while the new container runs. The image lives on the docker daemon (`DOCKER_HOST`), takes the size of `/work` on top of the base image, and `docker image prune -a` removes it, so do not run that on the daemon of a runner that has sleeping worktrees.

Without a snapshot, a wake of an ephemeral host runs `spawn` again with the same worker id. The old container is gone by then (`--rm`), so it starts a fresh one. A container with that name that has stopped is removed first, and one that still runs makes `spawn` fail. `destroy` runs `docker rm --force --volumes band-<worker id>` and succeeds when the container is gone already. `spawn` prints the container id as `BAND_MACHINE_HANDLE`. `status` lists the ids of the containers with the label `band.runner=<runner id>`, and `destroy` called with only a handle removes that container when it carries the runner's label.

A worker takes plain `http` only for a loopback hub, and a container on the `bridge` network cannot reach the hub's loopback. So the hub URL must be `https`, or on Linux the runner uses `"BAND_DOCKER_NETWORK": "host"` with the default `http://127.0.0.1:<port>`.

On the hub's machine (a container runner on the same host as the hub, Linux):

```json
{
  "id": "docker",
  "spawn": "bundled:docker",
  "destroy": "bundled:docker",
  "labels": { "pool": "docker" },
  "isolation": "container",
  "maxConcurrent": 4,
  "timeoutSec": 180,
  "env": { "BAND_DOCKER_NETWORK": "host" }
}
```

On a separate docker host, with a hub that has a public `https` URL (set `BAND_PUBLIC_URL`, or `BAND_HUB_URL` in `env`):

```json
{
  "id": "docker-build-host",
  "spawn": "bundled:docker",
  "destroy": "bundled:docker",
  "labels": { "pool": "build" },
  "isolation": "container",
  "maxConcurrent": 8,
  "env": {
    "DOCKER_HOST": "ssh://runner@build-host",
    "BAND_DOCKER_IMAGE": "ghcr.io/example/band-worker:latest",
    "BAND_HUB_URL": "https://hub.example.com"
  }
}
```

The hub runs the docker CLI, which reaches the daemon over ssh with the hub user's keys (`HOME` and `SSH_AUTH_SOCK` are passed through). The container, its `/work` volume and the image all live on that host.

A `worktrees.create` call picks this runner with `placement: { labels: { pool: "docker" }, environment: { isolation: "container" } }`. `band worktrees create --isolation container --labels pool=docker` does the same from the CLI.

### `k8s`

Starts the worker as a Pod in a Kubernetes namespace with `kubectl`. The hook renders the manifests in `runners/k8s/render.mjs` and pipes them to `kubectl create`. The security settings match the docker hook, written as a Pod `securityContext`:

| Setting | Why |
| --- | --- |
| `runAsNonRoot`, `runAsUser: 65532`, `fsGroup: 65532` | A non-root uid, as in the docker hook. |
| `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false` | No capabilities, and a process cannot gain any. |
| `readOnlyRootFilesystem`, `emptyDir` at `/tmp` (memory) and `/work` | The worker writes to `/tmp` (512 MiB by default) and to `/work` (its `HOME`, state and checkouts). Both go away with the Pod. |
| `seccompProfile: RuntimeDefault` | The container runtime's default syscall filter. |
| `automountServiceAccountToken: false` | The worker gets no credentials for the Kubernetes API. |
| `resources.requests` and `limits` | Both set to the environment's `resources.cpu` and `resources.memory` (`8Gi` is a valid Kubernetes quantity as is), so the Pod is Guaranteed. `resources.disk` is not enforced. |
| Labels `band.runner`, `band.request`, `band.worker` | The runner, the host request and the worker id, for `kubectl get pods -l band.worker=<id>`. |

The bootstrap token never appears in a command line or in the Pod manifest. The hook creates the Pod first, reads its uid from the `kubectl create` answer, and then creates a Secret named like the Pod with an `ownerReferences` entry for it. The Pod reads the token with `secretKeyRef`, and the garbage collector deletes the Secret with the Pod. If the Secret cannot be created, the hook retries for `BAND_K8S_SECRET_WAIT` seconds (default 30, the time the garbage collector needs to remove the Secret of a previous Pod of the same worker), then deletes the Pod and fails. `spawn` prints `BAND_MACHINE_HANDLE=<namespace>/<name>` and, when the request has a repository, `BAND_HOST_REPO_PATH=/work/<repo>`.

A worker id that wakes an ephemeral host runs `spawn` again. A Pod of that worker in `Pending` or `Running` makes `spawn` fail. A finished one is deleted before the new Pod is created, and the garbage collector removes its Secret.

Settings (`env`):

| Variable | Meaning |
| --- | --- |
| `BAND_K8S_NAMESPACE` | Namespace for the workers. Default `band-workers`. |
| `BAND_K8S_IMAGE` | The worker base image. Default `band-worker`. The hub's `BAND_REPO_IMAGE` wins when the repo has an environment image, so that image must be pullable by the cluster (set `environmentBuilder.registry`, and `BAND_K8S_PULL_SECRET` for a private one), or the Pod stays in `ImagePullBackOff` until `timeoutSec`. |
| `BAND_K8S_KIND` | `pod` (default), `job` (`backoffLimit: 0`, deleted 5 minutes after it finishes) or `sandbox`. |
| `BAND_K8S_RUNTIME_CLASS` | `runtimeClassName`, such as `kata` or `gvisor`. A request for `isolation: vm` fails at once when this is unset, because the node's default runtime would be a shared-kernel container. Set `"isolation": "vm"` on the runner when it is set. |
| `BAND_K8S_PULL_POLICY`, `BAND_K8S_PULL_SECRET` | `imagePullPolicy` and an `imagePullSecrets` name. |
| `BAND_K8S_CA_CONFIGMAP`, `BAND_K8S_CA_KEY` | A ConfigMap in the namespace that holds the CA of a hub behind a private certificate (key `ca.crt` by default). It is mounted read-only at `/etc/band-ca` and `NODE_EXTRA_CA_CERTS` points at it. The ConfigMap is mounted by the kubelet, so the runner needs no RBAC for it. |
| `BAND_K8S_TMP_SIZE`, `BAND_K8S_WORK_SIZE` | Sizes of `/tmp` (default `512Mi`) and `/work` (default `10Gi`). |
| `BAND_K8S_SECRET_WAIT` | Seconds to retry the token Secret create. Default `30`. |
| `BAND_K8S_CONTEXT` | `kubectl --context`. |
| `BAND_KUBECTL_BIN` | The kubectl binary. Default `kubectl`. |
| `KUBECONFIG` | Hooks run with `HOME` only, so `~/.kube/config` is read by default. |
| `BAND_IDLE_EXIT` | Idle wait before the worker exits, like `90s`. |

`destroy` deletes the Pod (or Job, or Sandbox) with `--ignore-not-found` (the Secret goes with it, because the runner never reads or deletes Secrets: `kubectl delete` reads the object first), so a missing object is success and an unreachable cluster is an error. `status.sh` prints `BAND_MACHINE_HANDLE=<namespace>/<pod> worker=<id> request=<id> state=<phase>` (the VM hooks' format) for the pods with the worker's label (or the runner's, or every worker pod). The hub does not call `status` yet (plan step 3.7).

`BAND_K8S_KIND=sandbox` creates a `Sandbox` (`agents.x-k8s.io/v1alpha1`, from kubernetes-sigs/agent-sandbox) whose `spec.podTemplate` is the Pod above. It needs that repo's CRDs and controller. It has not been run against a cluster yet, and `deploy/k8s/agent-sandbox.yaml` shows the shape. It creates a `Sandbox` and not a `SandboxClaim` because a claim refers to a shared `SandboxTemplate`, which cannot carry one worker's id and token.

Setup on a cluster:

1. `kubectl apply -f deploy/k8s/namespace.yaml -f deploy/k8s/rbac.yaml`. The `band-workers` namespace enforces the `restricted` Pod Security Standard, which these Pods meet.
2. `deploy/k8s/check-rbac.sh` runs `kubectl auth can-i --as system:serviceaccount:band:band-hub` and fails unless the account can create, delete, get, list and watch pods and create secrets in `band-workers`, and can do nothing else. It cannot read a Secret back, and it cannot touch other namespaces.
3. Build the worker image (`docker/worker.Dockerfile`) and push it where the cluster pulls from.
4. Run the hub. `deploy/k8s/hub.yaml` is an example Deployment that uses the `band-hub` service account. The stock hub image has neither `kubectl` nor `runners/`, so build `deploy/k8s/Dockerfile.hub` on top of it. Outside the cluster, any machine with `kubectl` access to the namespace works.
5. Add the runner.

How the worker reaches the hub: a worker takes plain `http` only for a loopback hub, so a Pod cannot use `http://band-hub.band.svc`. Give the hub an `https` URL the Pods trust (an Ingress or Gateway with a certificate) and set it as `BAND_HUB_URL` in the runner's `env`, or `BAND_PUBLIC_URL` on the hub.

```json
{
  "id": "k8s",
  "spawn": "bundled:k8s",
  "destroy": "bundled:k8s",
  "labels": { "pool": "k8s" },
  "isolation": "container",
  "maxConcurrent": 8,
  "timeoutSec": 180,
  "env": {
    "BAND_HUB_URL": "https://band.example.com",
    "BAND_K8S_NAMESPACE": "band-workers",
    "BAND_K8S_IMAGE": "registry.example.com/band-worker:latest",
    "KUBERNETES_SERVICE_HOST": "kubernetes.default.svc",
    "KUBERNETES_SERVICE_PORT": "443"
  }
}
```

The two `KUBERNETES_SERVICE_*` entries are for a hub that runs in the cluster: hooks run with a minimal environment, and `kubectl` finds the service account token only when it sees them. A hub outside the cluster uses a kubeconfig instead and drops them. For a VM-isolated runner add `"isolation": "vm"` and `"BAND_K8S_RUNTIME_CLASS": "kata"`.

Tests: `apps/hub/tests/runner-k8s.test.ts` runs the scripts against a stub `kubectl` and checks the manifests (securityContext, resources, labels, the owned Secret, the CA ConfigMap, the RuntimeClass, the token in no argument). The CI job `k8s (kind)` creates a kind cluster, applies `deploy/k8s`, runs `deploy/k8s/check-rbac.sh`, and runs `apps/hub/tests/runner-k8s-kind.test.ts`. That test starts a hub behind a self-signed TLS terminator, runs the hook as the `band-hub` service account, waits for the Pod's worker to say hello, inspects the live Pod, and destroys it. To run it on your own cluster, set `BAND_K8S_TEST_IMAGE` (an image the cluster has) and `BAND_K8S_TEST_KUBECONFIG` (an admin kubeconfig), and `BAND_K8S_TEST_HUB_HOST` when the pods cannot reach this machine at the gateway of docker's `kind` network.

## VM hooks: hetzner and contabo

Both hooks create a machine whose cloud-init installs the worker, starts it as `band-worker --ephemeral` under systemd and powers the machine off when the worker exits. Set `"isolation": "vm"` on the runner, so a request that asks for `vm` isolation can use it (see [Isolation levels](#isolation-levels)). The hooks print `BAND_MACHINE_HANDLE=<id>` (the provider's id for the machine) and, when the repo has a clone URL, `BAND_HOST_REPO_PATH`.

Each hook has `spawn`, `destroy` and `status` (`runners/<name>/{spawn,destroy,status}.sh`). `status` prints one line per machine the runner knows: `BAND_MACHINE_HANDLE=<id> worker=<worker id> request=<request id> state=<provider state>`. `destroy` finds its machine by the worker id, so it works without the handle, and it succeeds when the machine is gone already.

### The cloud-init

`runners/_shared/cloud-init.mjs` renders the same user data for both providers. It writes `/etc/band-worker.env` (mode 0600, the contract's variables), a `band-worker.service` unit and a bootstrap script, then runs the script. The unit has `Restart=no`, `RuntimeMaxSec` (12 hours, set it with `BAND_VM_MAX_HOURS`) and `ExecStopPost=+/usr/sbin/poweroff`. A bootstrap step that fails also powers the machine off, because a machine with no worker only costs money. The image must be Debian or Ubuntu (the script uses `apt`).

Settings (`env`, for both hooks):

| Variable | Meaning |
| --- | --- |
| `BAND_VM_WORKER` | `npm` (default) installs Node 22 from NodeSource and runs `npm install -g $BAND_VM_WORKER_PACKAGE`. `docker` installs `docker.io` and runs `BAND_VM_WORKER_IMAGE` with the same hardening flags as the `docker` hook. |
| `BAND_VM_WORKER_PACKAGE` | The npm package with `band-worker`. Default `@band-app/worker`. |
| `BAND_VM_WORKER_IMAGE` | The worker image. Required in `docker` mode. |
| `BAND_VM_MAX_HOURS` | Hours until the worker is stopped and the machine powers off. Default 12. |
| `BAND_IDLE_EXIT` | Idle wait before the worker exits, like `90s`. |

The clone happens on the machine, so the repo needs a URL it can reach. A repo with only a local path on the hub's machine is not cloned. The machine must reach `BAND_HUB_URL`, and a worker takes plain `http` only for a loopback hub, so use an `https` URL.

### Token handling

The bootstrap token is in the user data, which the provider stores and the machine keeps. It is single use and spent when the worker exchanges it, and the bootstrap script deletes `/etc/band-worker.env` and cloud-init's copies of the user data once the unit has started. The provider's metadata service keeps serving the user data for the life of the machine, so any process on it can still read the token. Single use is what makes that harmless once the worker has connected. Anyone who can read the machine's user data through your provider account before then can read the token, so keep the provider token to people who may run worktrees. The token is in no command line of the hook and no hook log line. The hooks read provider credentials from their own environment and never print them. The runner's `env` is stored in `~/.band/settings.json`, which any device token can read, so for a shared hub write a small wrapper script that exports the credentials and then runs the bundled hook (`exec /path/to/band/runners/hetzner/spawn.sh`), and set `spawn` and `destroy` to the wrapper's absolute path. Putting them in `env` is fine for a hub only you use.

### hetzner

Creates a Hetzner Cloud server per request with the labels `band.runner`, `band.request` and `band.worker`. A spawn for a worker id that already has a server deletes the old one first, since a woken worker comes back on a clean machine. `destroy` deletes the server. Billing is hourly, so a server costs what it runs: cx22 is a few euro cents per hour.

| Variable | Meaning |
| --- | --- |
| `HCLOUD_TOKEN` | A repo API token with read and write access. Required. |
| `HCLOUD_SERVER_TYPE` | Default `cx22`. |
| `HCLOUD_IMAGE` | Default `ubuntu-24.04`. |
| `HCLOUD_LOCATION` | Default `fsn1`. |
| `HCLOUD_SSH_KEYS` | Comma-separated key names or ids, to log in for debugging. Optional. |
| `HCLOUD_FIREWALLS` | Comma-separated firewall ids. Optional. The worker needs outbound access only. |

```json
{
  "id": "hetzner",
  "spawn": "bundled:hetzner",
  "destroy": "bundled:hetzner",
  "labels": { "pool": "vm" },
  "isolation": "vm",
  "maxConcurrent": 4,
  "timeoutSec": 420,
  "env": { "HCLOUD_TOKEN": "...", "BAND_HUB_URL": "https://hub.example.com" }
}
```

Allow several minutes in `timeoutSec`: the machine boots, installs Node and the worker, and clones before the worker says hello.

`snapshot.sh`, `restore.sh` and `snapshot-delete.sh` give the runner the snapshot hooks (`"snapshot": "bundled:hetzner"` and so on). `snapshot` calls `create_image` with type `snapshot` on the server (the handle, else the server with the worker's label), waits for the action and prints the image id and its size. The image carries the labels `band.runner`, `band.worker` and `band.snapshot`. `restore` creates a server from that image with the same labels and a cloud-init made for a restore: it skips the install and the clone (they are on the disk), deletes the saved session token and starts the worker with the new bootstrap token. `snapshot-delete` deletes the image. Hetzner bills snapshots per GB and month, and a snapshot of a running server is crash-consistent. Set `snapshotTimeoutSec` to cover the snapshot: it takes minutes for a large disk. A snapshot is for the same server type or one with at least the same disk, in the same architecture. The restore uses the runner's `HCLOUD_SERVER_TYPE`.

### contabo

Contabo instances are billed monthly, so deleting one does not stop the charge. The hook has two modes.

- `pool` (default). `CONTABO_POOL` lists instance ids you already pay for. `spawn` takes one that is idle, renames it `band-busy-<worker id>` and reinstalls it with the user data. `destroy` reinstalls it with no user data, which leaves a clean disk without the token, and renames it `band-idle`. An instance that is still installing is not offered, so a request that arrives right after a release can fail with "no idle instance". Two spawns of one runner take the pool one at a time, through a lock in `BAND_RUNNER_DIR`. Listing an instance in `CONTABO_POOL` authorises the hook to wipe it, including a first spawn on an instance that was never named `band-idle`. Instances in the pool must be used by this runner only, because Contabo has no way to claim one atomically across runners.
- `new` (`CONTABO_MODE=new`). `spawn` buys an instance (`CONTABO_PRODUCT_ID`, one month). `destroy` cancels it. Contabo ends the contract at the end of the billing period, so each request costs a month. Use it only when you accept that.

| Variable | Meaning |
| --- | --- |
| `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD` | The API credentials from the Contabo customer panel (OAuth password grant). Required. |
| `CONTABO_IMAGE_ID` | The id of the OS image to install, a Debian or Ubuntu one. Required. |
| `CONTABO_POOL` | Comma-separated instance ids. Required in `pool` mode. |
| `CONTABO_PRODUCT_ID` | The product to buy, like `V92`. Required in `new` mode. |
| `CONTABO_REGION` | Default `EU`. `new` mode only. |
| `CONTABO_SSH_KEYS` | Comma-separated secret ids of ssh keys to install. Optional. |
| `CONTABO_LOCK_WAIT` | Seconds a spawn waits for the pool lock. Default 60. |

Contabo has no per-instance labels in this hook, so `status` identifies a machine by its display name and does not report the request id. A reinstall takes a few minutes, so allow the same `timeoutSec` as for Hetzner or more.

### Tests

`apps/hub/tests/runner-vm-hooks.test.ts` runs each hook as the hub would, against Express stubs of the Hetzner and Contabo APIs (`fixtures/hetzner-stub.ts`, `fixtures/contabo-stub.ts`, reached through `HCLOUD_API_URL`, `CONTABO_AUTH_URL` and `CONTABO_API_URL`), and checks the cloud-config it sends. It runs `cloud-init schema` on the user data when `cloud-init` is installed, and otherwise checks the document's shape. CI calls no real cloud. A live test creates and deletes one Hetzner server when `BAND_LIVE_HCLOUD_TOKEN` is set, and is skipped without it:

```sh
BAND_LIVE_HCLOUD_TOKEN=... pnpm --filter @band-app/server exec vitest run tests/runner-vm-hooks.test.ts
```

## Writing a hook

A minimal hook that starts a worker in a container:

```sh
#!/bin/sh
set -eu
docker run -d --rm --name "band-$BAND_WORKER_ID" \
  -e BAND_HUB_URL -e BAND_WORKER_ID -e BAND_BOOTSTRAP_TOKEN \
  -e BAND_WORKER_LABELS="$BAND_LABELS" -e BAND_WORKER_EPHEMERAL=1 \
  --network host my-band-worker-image
```

`-e NAME` with no value copies the variable from the hook's environment, so the token does not appear in `ps`. It does appear in `docker inspect` of the container. The matching `destroy` is `docker rm -f "band-$BAND_WORKER_ID"`.
