# Runner hooks

A runner is a pair of scripts the hub runs to get a machine for a workspace that has none. When `workspaces.create` carries a `placement` that no online host satisfies, the hub records a host request. `RunnerService` (`apps/hub/src/server/services/runner-service.ts`) takes that request, runs the runner's `spawn` script, and completes the request once the worker that script started says hello.

The hub ships three hooks in `runners/`: `local`, `ssh` and `docker`. Any executable can be a hook.

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
| `maxConcurrent` | How many requests the runner has in flight at once. Default 1. |
| `timeoutSec` | Seconds from the start of an attempt to the worker's hello. Default 120. |
| `maxLifetimeSec` | Optional. How long a machine may live, counted from its spawn. Past it the reaper has the worker store its workspaces and exit, then runs `destroy`. Without it a machine lives until it exits. |
| `lifetimeGraceSec` | Seconds after `maxLifetimeSec` the reaper waits for the workspaces to be stored. Past that hard deadline it destroys the machine anyway. Default 600. |
| `env` | Extra environment for the hook, such as `BAND_SSH_TARGET`. The settings file is readable by any device token, so put no secrets here. |

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
| `BAND_MACHINE_HANDLE` | Only for `destroy`. The handle `spawn` printed, when it printed one. |
| `BAND_RUNNER_DIR` | A directory for the runner under `BAND_HOME`. Mode 0700, created by the hub. The hook runs with it as its working directory. |
| `BAND_NODE` | The Node binary the hub runs on. |

A hook must:

- Start `band-worker` for `BAND_WORKER_ID` with the token, and return. The worker keeps running after the hook exits, so detach it and redirect its output. The hub treats a hook as finished when it exits, even if a child holds its pipes.
- Exit 0 once the worker is started. Any other exit code fails the attempt. The hub does not wait for the worker inside `spawn`.
- Read the token from the environment, not from a command line. `band-worker` reads `BAND_HUB_URL`, `BAND_WORKER_ID` and `BAND_BOOTSTRAP_TOKEN` itself.
- Optionally print `BAND_MACHINE_HANDLE=<id>` on its own line: a name for the machine that `destroy` and `status` can find again, such as a container id, a pid or a VM id. No spaces. The hub stores it in `runner_machines` and passes it to `destroy` as `BAND_MACHINE_HANDLE`.
- Optionally print `BAND_HOST_PROJECT_PATH=<path>` on its own line: where the repository is on the worker. The hub passes it as `hostProjectPath` when it fulfils the request. The path must be inside one of the worker's roots.

`destroy` gets the same environment without `BAND_BOOTSTRAP_TOKEN`, plus `BAND_MACHINE_HANDLE`. It should stop the worker and remove what `spawn` made, and it should succeed when there is nothing to undo. For a machine the hub has no record of (an orphan), the hub sets `BAND_MACHINE_HANDLE` and `BAND_RUNNER_ID` and leaves `BAND_WORKER_ID` and the request variables unset, so a `destroy` must be able to work from the handle alone. It must check that the handle is one of its own machines before it kills anything.

`status` runs with the runner's `env`, `BAND_RUNNER_ID`, `BAND_RUNNER_DIR`, `BAND_HUB_URL` and `BAND_NODE`, and no request or worker variables. It prints the handle of every machine of this runner that still exists, one per line (the first word of a line counts, and `#` starts a comment), and exits 0. It must list only this runner's machines.

## What the hub does

1. A runner with a free slot leases the oldest request its labels fit. A lease is one guarded SQL update, so two runners never take the same request. The hub renews the lease every 10 s while it works.
2. It runs `spawn`. A script still running after `timeoutSec` is killed.
3. After `spawn` exits 0 it waits for the host to come online. When it does, the hub fulfils the request and creates the workspace on that host.
4. An attempt fails when `spawn` exits non-zero, runs past the timeout, or the worker does not say hello in time. The hub then runs `destroy` and deletes the host it made. It tries once more with a new host and token. After the second failure the request fails, and its error holds the reason and the last 20 log lines.
5. Cancelling the request stops the run and runs `destroy`.

When the worker later exits because it was idle, the hub stores its workspaces and starts a new worker with the same id on the next message, terminal or file access. That wake is another request, and `spawn` runs again with the same `BAND_WORKER_ID`, so the hook must start that id on a clean machine. See [Ephemeral workers](ephemeral-workers.md).

## The reaper

`RunnerReaperService` (`apps/hub/src/server/services/runner-reaper-service.ts`) makes sure no machine a runner started leaks. The hub records each machine in the `runner_machines` table (`spawning`, `running`, `stopping`, `destroyed` or `lost`, with the handle, the worker id, the request and the times). Every `BAND_REAPER_INTERVAL_MS` (default 30 s) it destroys, through the runner's `destroy` hook:

- **A machine that never said hello.** A machine still `spawning` that no attempt in flight owns (for example after a hub restart) is destroyed once `timeoutSec` plus `BAND_REAPER_HELLO_GRACE_MS` (default 60 s) have passed since the spawn. The host row it made is removed.
- **A lost machine.** A running machine whose host row is gone is destroyed at once. One whose worker has been `offline` or `lost` for `BAND_REAPER_OFFLINE_MS` (default 2 minutes) is destroyed too, which also cleans up after an ephemeral worker that went to sleep and exited. The time counts from the hub's boot at the earliest, so a hub restart does not destroy workers that are about to redial.
- **An orphan.** For a runner with `status` and `destroy`, a handle that `status` lists and no live `runner_machines` row has is destroyed. The sweep skips a runner while one of its spawns is in flight.
- **A machine past `maxLifetimeSec`.** The machine becomes `stopping`. The reaper sends `lifecycle.sleep` to the worker, which then goes through the same hand-off as an idle one (docs/ephemeral-workers.md): the hub refuses while an agent turn, queued message or terminal runs, and otherwise stores each workspace's snapshot and agent sessions before the worker exits. The reaper asks again every sweep and shows the reason in the machine's note. It runs `destroy` only after the worker has exited with every workspace stored. A machine with no workspaces is destroyed at once.

A machine whose workspaces are not stored is never destroyed early. It waits until the hard deadline (`maxLifetimeSec` plus `lifetimeGraceSec` after the spawn, or the offline threshold plus `lifetimeGraceSec`). If that passes, the machine is destroyed anyway and the hub logs an error naming the workspaces that were lost. A worker that is not ephemeral cannot hand its workspaces over, so a machine like that waits for the deadline.

When `destroy` fails, the reaper runs it again on the next sweeps. After the third failure the machine is `lost` and stays listed. If a later `status` still lists its handle, the orphan sweep tries again.

A worker id that wakes up gets a new machine row, and the row of its earlier machine ends as `destroyed` (replaced), because the hook wipes the old machine when it starts the new one.

Settings > Runners lists the machines with their state and age. An admin can destroy one there (`runners.destroyMachine`). The hub refuses while the machine holds workspaces that are not stored, and the UI then offers "Destroy anyway". Only admin tokens can list machines or destroy them, and the MCP endpoint and the worker relay leave `runners.*` out.

## Logs

The hub keeps everything a hook prints in `BAND_HOME/runners/logs/<request id>.log`, one line per output line, tagged `spawn stdout`, `spawn stderr`, `destroy stdout` and so on. Before a line is stored the hub replaces the attempt's bootstrap token and anything shaped like a Band token (`bwb_`, `bws_`, `bdt_`, `brt_`) with `[redacted]`. Read a log with `band runners log <request id>` or from Settings > Runners.

## Bundled hooks

### `local`

Starts an ephemeral `band-worker` on the hub's machine. Everything lives under `$BAND_RUNNER_DIR/<worker id>/`: its own `HOME` and `BAND_HOME` (`home/.band`), its state dir, and a work dir that is its only root. If `BAND_REPO_URLS` is set, `spawn` clones the first URL into the work dir and prints `BAND_HOST_PROJECT_PATH`. It writes the worker's pid to `pid` and prints it as `BAND_MACHINE_HANDLE`. `destroy` kills that pid, waits for it to exit, and removes the directory. `status` lists the pids of the worker directories whose process is alive. With only a handle, `destroy` acts only when one of the runner's directories holds that pid. A `spawn` for a worker id that already has a directory (a worker waking up) deletes the old directory first, because a woken worker is a new machine, and it refuses when that worker's pid is still alive.

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

A wake of an ephemeral host runs `spawn` again with the same worker id. The old container is gone by then (`--rm`), so it starts a fresh one. A container with that name that has stopped is removed first, and one that still runs makes `spawn` fail. `destroy` runs `docker rm --force --volumes band-<worker id>` and succeeds when the container is gone already.

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
