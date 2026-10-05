# Runner hooks

A runner is a pair of scripts the hub runs to get a machine for a workspace that has none. When `workspaces.create` carries a `placement` that no online host satisfies, the hub records a host request. `RunnerService` (`apps/hub/src/server/services/runner-service.ts`) takes that request, runs the runner's `spawn` script, and completes the request once the worker that script started says hello.

The hub ships five hooks in `runners/`: `local`, `ssh`, `docker`, `hetzner` and `contabo`. The last two start a virtual machine per request (see [VM hooks](#vm-hooks-hetzner-and-contabo)). `docker` and `hetzner` also have snapshot hooks (see [Snapshots](#snapshots)). Any executable can be a hook.

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
| `destroy` | Optional. The script that undoes `spawn`. `bundled:<name>` means `runners/<name>/destroy.sh`. |
| `labels` | What the runner offers. It takes a request when every label the request asks for is in this map. A request with no labels fits any runner. |
| `provides` | Optional facts about the machines it starts, like `{ "node": "24", "os": "linux" }`. When set, a request's `requires` must hold for them. When unset, `requires` is not checked. |
| `isolation` | The isolation of the machines it starts: `process` (same as `worktree`), `container` or `vm`. A request that asks for `container` or `vm` goes only to a runner that offers at least that (see [Isolation levels](#isolation-levels)). Passed to the hook as `BAND_ISOLATION`. Default `process`. |
| `maxConcurrent` | How many requests the runner has in flight at once. Default 1. |
| `timeoutSec` | Seconds from the start of an attempt to the worker's hello. Default 120. |
| `env` | Extra environment for the hook, such as `BAND_SSH_TARGET`. The settings file is readable by any device token, so put no secrets here. |
| `snapshot`, `restore` | Optional, set both or neither. The hooks that snapshot a sleeping worker's machine and start it again from the snapshot (see [Snapshots](#snapshots)). `bundled:<name>` means `runners/<name>/snapshot.sh` and `restore.sh`. |
| `snapshotDelete` | Optional. The script that removes a snapshot. `bundled:<name>` means `runners/<name>/snapshot-delete.sh`. Without it the hub forgets a snapshot it no longer wants but cannot remove it, and logs a warning. |
| `snapshotKeep` | How many snapshots of this runner to keep, newest first. Default 3. |
| `snapshotTtlSec` | Seconds a snapshot lives. Default 7 days. |
| `snapshotTimeoutSec` | Seconds the `snapshot` hook may run. Default 600, at most 780. |

`bundled:` hooks are found in the nearest `runners/` directory above the hub's bundle, or in `BAND_RUNNERS_DIR`.

## Isolation levels

A workspace asks for a level with `isolation` in its environment (`placement.environment.isolation`, or `.band/environment.json` once placement reads it). A runner offers a level with its `isolation` setting.

| Level | Meaning | Placement |
| --- | --- | --- |
| `worktree` | A git worktree on a worker that other workspaces share. The default. | Goes to an online worker whose labels match, or to a runner offering any level. A worker a runner started is ephemeral and belongs to the workspace it was started for, so only a worker registered by hand is shared. A worker started for a `container` or `vm` workspace is never used. |
| `container` | A worker of its own, in a container. | Never reuses a host. A runner offering `container` or `vm` starts a new worker for each workspace. |
| `vm` | A worker of its own in a virtual machine. | Only a runner with `isolation: "vm"` takes it. The bundled hooks start no virtual machines, so you bring your own hook. |

A stronger level satisfies a weaker request, so a `vm` runner takes a `container` request. If no configured runner offers the level a `container` or `vm` workspace asks for, `workspaces.create` fails at once with `No runner offers isolation vm` (or `container`) instead of waiting for the placement timeout. A runner outside the hub's settings that leases requests with `hostRequests.lease` should pass `filter.isolation` with the level it offers.

The hub labels each worker it starts for a `container` or `vm` workspace with `band.isolation=<level>`, and placement skips hosts with that label.

## The contract

For each attempt the hub issues a one-time bootstrap token for a new host, then runs `spawn` with this environment and nothing else from the hub's own environment except `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `SHELL` and `SSH_AUTH_SOCK`:

| Variable | Value |
| --- | --- |
| `BAND_HUB_URL` | The URL the worker dials. `env.BAND_HUB_URL` of the runner, else `BAND_RUNNER_HUB_URL`, else `BAND_PUBLIC_URL`, else `http://127.0.0.1:<hub port>`. A worker accepts plain `http` only for a loopback hub, so a remote machine needs an `https` URL. |
| `BAND_WORKER_ID` | The id of the host the hub created. The worker must run with this id. |
| `BAND_BOOTSTRAP_TOKEN` | Trade for a session token once. Valid for the attempt's timeout plus a minute. |
| `BAND_REPO_URLS` | Comma-separated clone URLs of the request's repository, without credentials. The hub's local path when the project has no origin remote; only a hook on the hub's machine can use that. |
| `BAND_ENVIRONMENT` | The request's `placement.environment` as JSON, parsed and checked with the `.band/environment.json` parser (`docs/agent-environments.md`), so it has the same shape. `{}` when there is none. A request whose environment does not parse fails at once, with the problems and their key paths, and no hook runs. |
| `BAND_PROJECT_IMAGE` | The project's current environment image (`band env build`, `docs/agent-environments.md`), empty before its first ready build. |
| `BAND_ISOLATION` | The environment's `isolation` (`worktree`, `container` or `vm`) when it sets one, else the runner's `isolation`. |
| `BAND_LABELS` | The request's labels as `k=v,k=v`. Pass them to the worker (`BAND_WORKER_LABELS`) so the host carries them. |
| `BAND_REQUIRES` | The request's `placement.requires` as JSON. |
| `BAND_PROJECT` | The project name. |
| `BAND_RUNNER_ID`, `BAND_REQUEST_ID` | The runner and the host request. |
| `BAND_RUNNER_DIR` | A directory for the runner under `BAND_HOME`. Mode 0700, created by the hub. The hook runs with it as its working directory. |
| `BAND_NODE` | The Node binary the hub runs on. |

A hook must:

- Start `band-worker` for `BAND_WORKER_ID` with the token, and return. The worker keeps running after the hook exits, so detach it and redirect its output. The hub treats a hook as finished when it exits, even if a child holds its pipes.
- Exit 0 once the worker is started. Any other exit code fails the attempt. The hub does not wait for the worker inside `spawn`.
- Read the token from the environment, not from a command line. `band-worker` reads `BAND_HUB_URL`, `BAND_WORKER_ID` and `BAND_BOOTSTRAP_TOKEN` itself.
- Optionally print `BAND_HOST_PROJECT_PATH=<path>` on its own line: where the repository is on the worker. The hub passes it as `hostProjectPath` when it fulfils the request. The path must be inside one of the worker's roots.

`destroy` gets the same environment without `BAND_BOOTSTRAP_TOKEN`. It should stop the worker and remove what `spawn` made, and it should succeed when there is nothing to undo.

## Snapshots

A runner with `snapshot` and `restore` hooks keeps the disk of a sleeping workspace. Without them a wake builds the workspace again from the git state and agent session files the hub stored when it went to sleep (see [Ephemeral workers](ephemeral-workers.md)), so ignored files such as `node_modules` and build output are lost. With them, the wake starts a machine from the disk image that was taken at sleep, so installed dependencies, build output and untracked files are there at once.

The git and session state is still stored first, on every sleep. The snapshot comes on top of it, and the wake falls back to the stored state when anything about the snapshot goes wrong. A snapshot can make a wake faster and fuller, and it can fail without losing work.

| Hook | Environment | Output |
| --- | --- | --- |
| `snapshot` | `BAND_WORKER_ID`, `BAND_MACHINE_HANDLE` (what `spawn` printed, empty when it printed none), `BAND_WORKSPACE_IDS` (comma-separated ids of the workspaces on the host), `BAND_RUNNER_ID`, `BAND_RUNNER_DIR`, `BAND_HUB_URL`, `BAND_ISOLATION`, `BAND_NODE` and the runner's `env`. | `BAND_SNAPSHOT_ID=<id>` on its own line, required. `BAND_SNAPSHOT_SIZE=<bytes>` optional. Exit 0. |
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
2. When the worker says hello after a restore, the hub checks that each workspace's checkout is on the machine at the commit it had. If it is, the hub only writes the agent session files again. If it is not, it restores from git.
3. The used snapshot is deleted with `snapshot-delete`.

### Retention and cost

A snapshot is storage you pay for until it is deleted. The hub deletes a snapshot when a wake has used it, when a newer one of the same host replaces it, and in a sweep every minute (`BAND_SNAPSHOT_SWEEP_MS`) that removes anything past `snapshotTtlSec` and everything beyond the newest `snapshotKeep` of a runner. A workspace whose snapshot is deleted before its wake still wakes, from the stored git state, only without its ignored files. Leave `snapshotKeep` at least as large as the number of ephemeral workers you expect to sleep at once, or the oldest sleepers lose their snapshots to newer ones.

A `snapshot-delete` that fails leaves the snapshot recorded, and the sweep tries again after 10 minutes, so a flaky provider API does not leak it. A snapshot whose runner has no `snapshotDelete` hook, or was removed from the settings, is forgotten with a warning in the hub log, and you remove it by hand. The log of each snapshot, restore and delete is `BAND_HOME/runners/logs/<worker id>.log` (`band runners log <worker id>`).

### Limits

- A snapshot holds disk state only. Running processes, memory, open terminals and dev servers do not survive. The environment's `start` and `terminals` run again after a wake, as on any new worker.
- The disk is copied while the worker runs, so it is crash-consistent. The hub has stored the work before it takes the snapshot and nothing writes after that, since the worker is idle and its agents and terminals have stopped.
- A snapshot belongs to the runner and the machine that made it. It is not portable to another runner, region, architecture or docker daemon.
- A host with several workspaces has one snapshot for the machine. Waking one workspace restores all of them.

## What the hub does

1. A runner with a free slot leases the oldest request its labels fit. A lease is one guarded SQL update, so two runners never take the same request. The hub renews the lease every 10 s while it works.
2. It runs `spawn`. A script still running after `timeoutSec` is killed.
3. After `spawn` exits 0 it waits for the host to come online. When it does, the hub fulfils the request and creates the workspace on that host.
4. An attempt fails when `spawn` exits non-zero, runs past the timeout, or the worker does not say hello in time. The hub then runs `destroy` and deletes the host it made. It tries once more with a new host and token. After the second failure the request fails, and its error holds the reason and the last 20 log lines.
5. Cancelling the request stops the run and runs `destroy`.

When the worker later exits because it was idle, the hub stores its workspaces and starts a new worker with the same id on the next message, terminal or file access. That wake is another request, and `spawn` runs again with the same `BAND_WORKER_ID`, so the hook must start that id on a clean machine. See [Ephemeral workers](ephemeral-workers.md).

## Logs

The hub keeps everything a hook prints in `BAND_HOME/runners/logs/<request id>.log`, one line per output line, tagged `spawn stdout`, `spawn stderr`, `destroy stdout` and so on. Before a line is stored the hub replaces the attempt's bootstrap token and anything shaped like a Band token (`bwb_`, `bws_`, `bdt_`, `brt_`) with `[redacted]`. Read a log with `band runners log <request id>` or from Settings > Runners.

## Bundled hooks

### `local`

Starts an ephemeral `band-worker` on the hub's machine. Everything lives under `$BAND_RUNNER_DIR/<worker id>/`: its own `HOME` and `BAND_HOME` (`home/.band`), its state dir, and a work dir that is its only root. If `BAND_REPO_URLS` is set, `spawn` clones the first URL into the work dir and prints `BAND_HOST_PROJECT_PATH`. It writes the worker's pid to `pid`. `destroy` kills that pid and removes the directory. A `spawn` for a worker id that already has a directory (a worker waking up) deletes the old directory first, because a woken worker is a new machine, and it refuses when that worker's pid is still alive.

Settings (`env`): `BAND_WORKER_BIN` is the worker, either a `.mjs`/`.js` file run with `BAND_NODE` or an executable (default `band-worker` on `PATH`). `BAND_IDLE_EXIT` sets how long an idle worker waits before it exits, like `90s` (default 10 minutes).

### `ssh`

Runs the same steps on another machine: `ssh $BAND_SSH_TARGET 'sh -s'` with a script on stdin. The script, which carries the bootstrap token, is sent over stdin, so the token is in no command line on either machine. The worker's files go to `$BAND_SSH_DIR/<worker id>/` on the target. `destroy` kills the pid and removes that directory.

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

The project's image is `BAND_PROJECT_IMAGE` when this docker daemon has it or can pull it (it has the toolchain, the installed dependencies and the worker, and needs `git` for the clone). When it cannot get the image, for example one built on another host with no registry, the hook says so in its log and runs the base image. Nothing from the host is mounted and the docker socket is never passed in. The token goes in with `-e BAND_BOOTSTRAP_TOKEN`, so it is not in a command line or `ps`. It is in the container's config, though, so anyone who can run `docker inspect` on that daemon can read it. That is accepted: access to a docker daemon is root-equivalent on that machine, and the token is single-use and spent when the worker exchanges it. The container clones the first of `BAND_REPO_URLS` into `/work/<project>` before the worker starts, so the repository needs a URL the container can reach. A project with no origin remote has only a path on the hub's machine, which fails the clone.

Settings (`env`):

| Variable | Meaning |
| --- | --- |
| `BAND_DOCKER_IMAGE` | The worker base image, run when the project has no ready environment image. Default `band-worker`, built with `docker build -f docker/worker.Dockerfile -t band-worker .`. |
| `BAND_DOCKER_NETWORK` | Docker network. Default `bridge`. |
| `BAND_DOCKER_PIDS_LIMIT` | Default 512. |
| `BAND_DOCKER_MEMORY`, `BAND_DOCKER_CPUS` | Limits for an environment with no `resources`. Default none. |
| `BAND_DOCKER_TMP_SIZE` | Size of the `/tmp` tmpfs. Default `512m`. |
| `BAND_IDLE_EXIT` | Idle wait before the worker exits, like `90s`. |
| `DOCKER_HOST` | A remote docker daemon, such as `ssh://user@build-host`. |

`snapshot.sh`, `restore.sh` and `snapshot-delete.sh` give the runner the snapshot hooks (`"snapshot": "bundled:docker"`, `"restore": "bundled:docker"`, `"snapshotDelete": "bundled:docker"`). `docker commit` leaves volumes out and `/work` is a volume, so `snapshot.sh` copies the contents of `/work` (the checkouts, the worker's `HOME` and its state) into a plain directory `/snapshot` of a helper container made from the worker's own image, and commits the helper as the image `band-snapshot:<worker id>-<time>`. The image carries the labels `band.snapshot.base` (the ID of the image the worker ran from), `band.worker` and `band.runner`. `restore.sh` is `spawn.sh` in restore mode: it runs the base image, fills the new container's `/work` volume from `/snapshot` with a short-lived container that shares the volume, removes the worker's dead session token and starts the worker. It does not clone. The snapshot image is only read during that copy, so `snapshot-delete.sh` (`docker rmi`) can remove it while the new container runs. The image lives on the docker daemon (`DOCKER_HOST`), takes the size of `/work` on top of the base image, and `docker image prune -a` removes it, so do not run that on the daemon of a runner that has sleeping workspaces.

A wake of an ephemeral host without a snapshot runs `spawn` again with the same worker id. The old container is gone by then (`--rm`), so it starts a fresh one. A container with that name that has stopped is removed first, and one that still runs makes `spawn` fail. `destroy` runs `docker rm --force --volumes band-<worker id>` and succeeds when the container is gone already.

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

A `workspaces.create` call picks this runner with `placement: { labels: { pool: "docker" }, environment: { isolation: "container" } }`. `band workspaces create --isolation container --labels pool=docker` does the same from the CLI.

## VM hooks: hetzner and contabo

Both hooks create a machine whose cloud-init installs the worker, starts it as `band-worker --ephemeral` under systemd and powers the machine off when the worker exits. Set `"isolation": "vm"` on the runner, so a request that asks for `vm` isolation can use it (see [Isolation levels](#isolation-levels)). The hooks print `BAND_MACHINE_HANDLE=<id>` (the provider's id for the machine) and, when the project has a clone URL, `BAND_HOST_PROJECT_PATH`.

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

The clone happens on the machine, so the project needs a URL it can reach. A project with only a local path on the hub's machine is not cloned. The machine must reach `BAND_HUB_URL`, and a worker takes plain `http` only for a loopback hub, so use an `https` URL.

### Token handling

The bootstrap token is in the user data, which the provider stores and the machine keeps. It is single use and spent when the worker exchanges it, and the bootstrap script deletes `/etc/band-worker.env` and cloud-init's copies of the user data once the unit has started. The provider's metadata service keeps serving the user data for the life of the machine, so any process on it can still read the token. Single use is what makes that harmless once the worker has connected. Anyone who can read the machine's user data through your provider account before then can read the token, so keep the provider token to people who may run workspaces. The token is in no command line of the hook and no hook log line. The hooks read provider credentials from their own environment and never print them. The runner's `env` is stored in `~/.band/settings.json`, which any device token can read, so for a shared hub write a small wrapper script that exports the credentials and then runs the bundled hook (`exec /path/to/band/runners/hetzner/spawn.sh`), and set `spawn` and `destroy` to the wrapper's absolute path. Putting them in `env` is fine for a hub only you use.

### hetzner

Creates a Hetzner Cloud server per request with the labels `band.runner`, `band.request` and `band.worker`. A spawn for a worker id that already has a server deletes the old one first, since a woken worker comes back on a clean machine. `destroy` deletes the server. Billing is hourly, so a server costs what it runs: cx22 is a few euro cents per hour.

| Variable | Meaning |
| --- | --- |
| `HCLOUD_TOKEN` | A project API token with read and write access. Required. |
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
