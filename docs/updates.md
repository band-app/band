---
title: Updates
description: Update the desktop app, workers and the hub, and learn which versions work together.
section: workers
order: 70
---

Band has three parts that you update separately: the desktop app, each worker, and the hub. This page covers all three, the version rule that links them, and what a worker update does to running agents.

## Where you see versions

Settings > Workers shows the Band version each worker runs. It marks a worker that is behind the hub, ahead of it, or too far away to connect. `band workers list` has a VERSION column with the same marks.

Once a day the hub asks GitHub for the latest release. When a newer one exists, an "Update available" button with the new version appears in the sidebar footer. It opens the "Update Band" panel. The panel lists the hub and every worker with their version and the version to move to.

To check right away after a release, an admin clicks "Check for updates" in Settings > Workers, or runs `band workers check-updates`. The page shows when the hub last checked. The Update buttons and the sidebar button appear without a reload. Checks within 30 seconds of each other share one GitHub request, because the unauthenticated API allows 60 requests an hour. A failed check shows an error icon and keeps the earlier answer.

To turn the daily check off, for example on an air-gapped hub, set `BAND_UPDATE_CHECK=off` in the hub's environment.

## Update the desktop app

The desktop app checks for updates itself and shows a toast when one is ready:

- "Band vX is available" has two buttons, "Later" and "Update". "Update" downloads the release.
- "Band vX is ready" says to restart Band to finish updating. The update also installs when you quit.

To check by hand, choose "Check for Updates…" in the Band menu. A development run has no such item. If you installed with Homebrew, `brew upgrade --cask band-app/band/band` works too.

The desktop app runs its local hub as a background service (see [Install](install.md#the-local-hub-is-a-background-service)). The first start after an update restarts that service, then the worker service, so both run the new bundle. The desktop app updates only the app. A hub or worker on another machine needs its own update.

## Version rule

A worker can connect to a hub when both have the same major version and their middle numbers differ by at most 1. While Band is at 0.x, the middle number is the "minor" version. A worker at 0.49.0 connects to a hub at 0.50.0 or at 0.48.0, but not to one at 0.51.0.

A worker outside that range is refused. In Settings > Workers it shows "Update required" with the message from the hub, for example `worker 0.47.0 is too old for hub 0.50.0, update it to 0.50.0`. The worker logs the refusal, waits 5 minutes and exits, so a service manager does not make it redial every few seconds. A worker from before version reporting is accepted and shown with an unknown version.

A hub run from source reports the unreleased version 0.1.0. It skips the check and accepts every worker.

Because of this rule, one release step is safe in either order. For anything larger, update the hub and the workers in the same session.

## Update a worker

Only an admin can update a worker. Settings > Workers and the "Update Band" panel both show an "Update" button next to a worker that is behind.

1. Click "Update". A dialog asks "Update `<worker>` to `<version>`?".
2. The dialog lists the agents that the restart will end. Confirm with "Update and restart".
3. The worker installs the new version with `npm`, then restarts through its service manager. The worker row shows "Installing…" and then "Restarting…".

If the install fails, the worker keeps running on its old version and shows "Update failed" with the error. The button then reads "Retry update". An update that does not reconnect on the target version within 3 minutes also counts as failed.

The target is the hub's version when the worker is behind it. When the worker already matches the hub, the target is the latest release, as long as the worker would still be within one minor version of the hub.

The Update button works for a worker that runs under launchd (`app.band.worker`) or a systemd user unit (`band-worker`), installed with `npm i -g` (see [Install](install.md) and [Adding workers](adding-workers.md)). A worker that does not run from such an install, such as the desktop app's bundled worker or a Docker image, has no Update button. It shows the reason and the command to run by hand. The same applies to any other worker:

```text
npm i -g @band-app/worker@<version>
```

Restart the worker afterwards.

### Update a worker automatically

Each worker's drawer in Settings > Workers has an "Update automatically when idle" switch and its Update button, and Settings > Hub has the same controls for the hub: the version, the latest release, "Check for updates", Update now and the switch. An admin on any client (web, desktop, phone) sees them. Settings > Workers has one "Check for updates" for the whole page, which asks GitHub now (calls within 30 seconds share one answer). The worker that is this Mac in the desktop app shows "Updates with Band app" in its row, because the app updates the bundled worker.

A worker with the switch on installs the hub's version by itself. The hub checks every minute (`BAND_WORKER_UPDATE_AUTO_POLL_MS`) and updates a worker when all of this holds:

- it is online and set to update automatically (the switch is off by default),
- it is behind the hub, so the target is the hub's own version and never a newer release (update the hub first, workers follow),
- it can restart itself: it runs under launchd or a systemd user unit from an `npm i -g` install, and does not report `updateBlocked`,
- no update is running on it and its last update did not fail (use Retry update or Dismiss),
- no agent that the restart would end runs on it. This is the list the confirm dialog shows. Held agents survive the restart and do not count.

While such an agent runs, the hub waits, and goes ahead once the first deferral is 6 hours old (`BAND_WORKER_UPDATE_MAX_DEFER_H`). The row shows since when it waits. A hub restart restarts that clock. The desktop app's bundled worker, a worker ahead of the hub, a worker without a service manager and a worker with an unknown version are not updated automatically, and the row says why.

The setting is `settings.workerUpdate.autoHostIds` in `~/.band/settings.json` (admin only to read or write), changed with `workers.setAutoUpdate`.

### What a worker update interrupts

The dialog lists the agents that the restart will end. Chat agents that a worker started keep running through the restart. A separate background process on the worker holds them, so the update does not stop a running turn. After the worker comes back, the hub reattaches to the same agents and the chat carries on. The dialog then says "No agent will be interrupted."

If the worker does not return within 2 minutes (`BAND_AGENT_REATTACH_TIMEOUT_MS` on the hub), the hub gives up on the held agents. The next message in each chat starts a new agent process and resumes the session.

An agent that stays held through an update can still stop at the next quiet moment: if the update changed how Band launches it (a new adapter version, a changed login, or different launch settings), the hub restarts the process before the next turn, not in the middle of one.

Not every agent is held. Agents of chats that the worker runs itself (a worker started with `--own-chats`, which includes the desktop app's bundled worker) stop with the restart. Terminal sessions are not agents in this sense. They keep running through a worker restart, because a terminal daemon holds them.

An agent also stops at once when the worker's lease runs out, or when you stop or remove the chat. See [Follow the work](follow-the-work.md#the-old-workers-lease).

### Update all workers

The "Update Band" panel has an "Update all workers" button (admin). It updates each online worker that is behind, one after the other, and lists the result for each worker.

- A worker with agents that the restart would end is skipped. After the run, "Update the skipped workers anyway" updates them.
- "Update workers, then the hub" appears when the hub has an update command (see below). It updates the workers first and the hub last.

## Update the hub

The hub is updated in the way you installed it. The "Update Band" panel shows the command for your install:

| Install | Command |
| --- | --- |
| Compose | `BAND_VERSION=<version> docker compose pull && BAND_VERSION=<version> docker compose up -d` |
| Helm | `helm upgrade band-hub <chart> --reuse-values --set image.tag=<version>` |
| Kubernetes manifest | `kubectl set image deployment/band-hub hub=ghcr.io/band-app/band-hub:<version>` |
| Docker | Pull `ghcr.io/band-app/band-hub:<version>`, then stop, remove and re-run the container with your usual options. |
| npm | `npm i -g @band-app/server@<version> && systemctl --user restart band-hub` |

The panel picks the command from `BAND_INSTALL_METHOD` in the hub's environment. The compose file sets `compose`, the Kubernetes manifest sets `k8s`, and the Docker image defaults to `docker`. Set it to `helm` for a Helm chart and to `npm` for a hub installed with `npm i -g @band-app/server` under a systemd user unit named `band-hub`. When it is unset, the panel says to pull the image and recreate the container. See [Run the hub on a server](run-the-hub-on-a-server.md).

### The built-in updater

A hub installed with `npm i -g @band-app/server` and run by a systemd user unit (named `band-hub`) or a launchd agent (label `app.band.hub`) can update itself. It needs `BAND_INSTALL_METHOD=npm` in the hub's environment. Set `BAND_HUB_SERVICE_MANAGER` to `systemd` or `launchd` when the hub cannot tell which one runs it. The "Update Band" panel says why the updater is off when a condition is missing.

An update does this, in order:

1. Waits while agent turns run (automatic updates only, see below).
2. Copies the database to `<BAND_HOME>/backups/<from-version>-<time>.db` with SQLite's `VACUUM INTO`, which also captures the pages still in the write-ahead log.
3. Runs `npm i -g --prefix <prefix> @band-app/server@<version>` with the npm beside the hub's own node.
4. Restarts the service with `systemctl --user restart band-hub` or `launchctl kickstart -k gui/<uid>/app.band.hub`.
5. Polls `/api/health` until it reports the target version. `BAND_HUB_UPDATE_HEALTH_TIMEOUT_MS` sets the wait (2 minutes by default).

If the new version does not report itself in time, or the restart fails, the updater stops the service, installs the previous version, restores the backup over `band.db`, starts the service and records the run as `rolled-back`. Under launchd it stops with `launchctl bootout gui/<uid>/app.band.hub` and starts with `launchctl bootstrap gui/<uid> <plist>`, so `KeepAlive` cannot respawn the hub while the database is restored. The plist is `~/Library/LaunchAgents/app.band.hub.plist`, or `BAND_HUB_LAUNCHD_PLIST`. The panel shows it as failed, with the reason and the last log lines. The install, the restart and the check run in a small script (`<BAND_HOME>/hub-update/supervisor.mjs`) that the hub starts before the restart, because the hub cannot check its own replacement. Under systemd it runs in its own scope, so the restart does not end it.

After a successful update the updater deletes the oldest backups in `<BAND_HOME>/backups/` and keeps the newest 5. Set `hubUpdate.keepBackups` in `~/.band/settings.json` to keep another number. A failed or rolled-back run deletes nothing.

The panel shows the last run, the backup path and the log tail to an admin. The log is `<BAND_HOME>/hub-update.log` and the state of the last run is `<BAND_HOME>/hub-update-last.json`.

**Update automatically.** The switch in the panel sets `hubUpdate.auto` in `~/.band/settings.json`. It is off by default. With it on, the hub installs a newer release as soon as the release check reports one and no agent turn younger than 180 minutes (`BAND_HUB_UPDATE_MAX_TASK_AGE_MIN`) runs. If turns run, the hub waits, and goes ahead anyway once the first deferral is 6 hours old (`BAND_HUB_UPDATE_MAX_DEFER_H`). It also waits while the hub lists a live agent mid-turn (the list the update confirm dialog shows, `workers.hubInterruptions`), because a hub restart ends every agent it runs, including those a worker holds. This covers a turn that a worker runs or that an agent started itself, which no task row records. The same 6 hour limit applies. The panel shows since when it waits. An update that failed is not retried by itself for the same version.

**The Update hub button** runs the same built-in path when no `hubUpdate.command` is set. A command still wins, so an install that uses the script below keeps working.

#### Move from update.sh and the timer

1. Check that the panel shows no reason for the built-in updater being off.
2. Turn on "Update automatically".
3. Disable the timer: `systemctl --user disable --now band-hub-update.timer`. The hub does not touch your timer, so both run until you do.
4. Clear the "Hub update command" field, otherwise the button keeps running your script.

The example script does two things besides updating. It defers while turns run, which the updater does with the same limits. It does not refresh a copy of the `band` CLI, and a hub does not need one: the CLI lookup (`packages/host-local/src/process/cli-binary.ts`) finds the `@band-app/worker-cli-<platform>-<arch>` package that `npm i -g @band-app/server` installs as an optional dependency, so the update replaces the CLI along with the hub. If your setup copies a binary to `~/band-hub/binaries/band` and points `BAND_CLI_PATH` at it, remove `BAND_CLI_PATH` so the lookup uses the npm package. A stale `BAND_CLI_PATH` wins over it.

Docker, compose, Helm and Kubernetes hubs still show the command to run. The updater does not replace its own container.

### The Update hub button

An admin can set a command that the hub runs to update itself. Enter it in the "Hub update command" field of the "Update Band" panel or under Advanced in Settings > Hub, or set `hubUpdate.command` in `~/.band/settings.json`. When a command is set and a newer release exists, the panel shows an "Update hub" button.

Clicking it runs the command with `sh -c` on the hub's machine, in its own session, with `BAND_HUB_TARGET_VERSION` set to the target version. The output goes to `<BAND_HOME>/hub-update.log`. The panel shows "Updating the hub…" until the hub is back.

- A hub that comes back on the target version is done.
- A command that exits with an error, a hub that restarts on another version, or no restart within 10 minutes (`BAND_HUB_UPDATE_TIMEOUT_MS`) shows as failed, with the last lines of the log. "Dismiss" clears the failure.
- Only an admin can set the command or start the update. Agents cannot reach either.
- A hub in a Docker, compose, Helm or Kubernetes install keeps the copy-the-command text. Updating those from the button is not supported yet.
- Agents that run on workers stop when the hub stops, because only the hub holds their state. The next message in each chat starts a new agent process and resumes the session.

Run the update outside the hub's own process, so that restarting the hub does not kill it. For an npm install under systemd, create a unit file `~/.config/systemd/user/band-hub-update.service`:

```ini
[Unit]
Description=Update the Band hub

[Service]
Type=oneshot
ExecStart=%h/band-hub/update.sh
```

Then create `~/band-hub/update.sh`:

```sh
#!/bin/sh
set -e
PORT="${BAND_PORT:-3456}"
TOKEN=$(jq -r .tokenSecret ~/.band/settings.json)
MAX_TASK_AGE_MIN="${BAND_HUB_UPDATE_MAX_TASK_AGE_MIN:-180}"
MAX_DEFER_H="${BAND_HUB_UPDATE_MAX_DEFER_H:-6}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/band-hub-update-deferred"

# Restarting the hub ends every agent turn it runs. Ask the hub which turns run.
# If it does not answer, update at once, because it is not serving turns anyway.
running=$(curl -fsS -m 10 -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/trpc/tasks.list?input=$(printf %s '{"status":"running"}' | jq -sRr @uri)" \
  | jq -r --argjson now "$(date +%s)" --argjson age "$MAX_TASK_AGE_MIN" \
      '[.result.data.tasks[] | select(.status == "running" and (($now * 1000 - .startedAt) / 60000) < $age)] | length') \
  || running=0
running="${running:-0}"

if [ "$running" -gt 0 ]; then
  mkdir -p "$(dirname "$STATE")"
  [ -f "$STATE" ] || date +%s > "$STATE"
  waited_h=$(( ($(date +%s) - $(cat "$STATE")) / 3600 ))
  if [ "$waited_h" -lt "$MAX_DEFER_H" ]; then
    echo "$running agent turn(s) running, deferring the update"
    exit 0
  fi
fi
rm -f "$STATE"

npm i -g @band-app/server@"${BAND_HUB_TARGET_VERSION:-latest}"
systemctl --user restart band-hub
```

The script reads the running turns from `tasks.list`. `workers.hubInterruptions` (admin token) asks the same question as the Update hub button and lists every live agent with a `busy` flag, but `tasks.list` filters by turn age, which the script needs, so the example uses it.

Two settings, read from the environment of the unit, control the wait:

- `BAND_HUB_UPDATE_MAX_TASK_AGE_MIN` (default 180). Only turns that started within this many minutes count as running. An older turn is treated as stuck and does not hold the update.
- `BAND_HUB_UPDATE_MAX_DEFER_H` (default 6). Once the first deferral is this many hours old, the script updates even if turns run.

Set the hub update command to `systemctl --user start --no-block band-hub-update.service`. `systemctl` does not pass `BAND_HUB_TARGET_VERSION` to the unit, so this example installs `latest`. A timer on the same unit gives you scheduled updates, and the deferral makes an hourly timer safe: each run skips while turns run and updates once they finish.

The Update hub button does not defer. When agent turns are running it lists them and asks you to confirm, and `workers.updateHub` answers 409 naming them until it is called with `confirmInterruptions: true`. With no turn running it starts at once.

## Order

- With the manual commands, update the workers first and the hub last, so the hub is never older than its workers.
- With only the "Update hub" button, update the hub first and then the workers. A worker within one minor version of the hub is accepted, so this is safe for one release step.

## Environment variables

| Variable | Where | Meaning |
| --- | --- | --- |
| `BAND_UPDATE_CHECK` | hub | Set to `off` to stop the daily release check. |
| `BAND_UPDATE_CHECK_INTERVAL_MS` | hub | Time between release checks. The default is 24 hours. |
| `BAND_INSTALL_METHOD` | hub | `compose`, `helm`, `k8s`, `docker` or `npm`. Picks the update command shown. |
| `BAND_HUB_UPDATE_TIMEOUT_MS` | hub | How long the Update hub button waits for the hub to return. The default is 10 minutes. |
| `BAND_AGENT_REATTACH_TIMEOUT_MS` | hub | How long the hub waits for a restarted worker before it drops held agents. The default is 2 minutes. |
| `BAND_WORKER_VERSION_RETRY_MS` | worker | How long a refused worker waits before it exits. The default is 5 minutes. |
| `BAND_NPM_BIN` | worker | The `npm` that a worker update runs. The default is the one beside the worker's own `node`. |
| `BAND_WORKER_UPDATE_AUTO_POLL_MS` | hub | How often the hub looks for workers to update automatically. The default is 1 minute. |
| `BAND_WORKER_UPDATE_MAX_DEFER_H` | hub | How long an automatic worker update waits for running agents. The default is 6 hours. |
| `BAND_WORKER_UPDATE_RESTART_TIMEOUT_MS` | hub | How long the hub waits for an updated worker to reconnect. The default is 3 minutes. |
