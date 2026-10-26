# Install Band

Band has three parts. The desktop app is the interface. The hub holds data and runs agents' chats. Workers are the machines worktrees live on. You need the first, or the first two, or all three, depending on where your code runs.

| You want | Install |
| --- | --- |
| Band on one Mac | [Desktop app only](#1-desktop-app-only) |
| One always-on hub for several devices | [A server hub](#2-a-server-hub) |
| Worktrees on other machines, containers or VMs | [Workers and runners](#3-workers-and-runners) |

## 1. Desktop app only

```sh
brew install --cask band
```

Or download the DMG for your chip from the [latest release](https://github.com/band-app/band/releases/latest). The app starts its own hub and runs worktrees on this Mac. Nothing else is needed.

To use the `band` CLI without the app, install the hub package, which includes it:

```sh
npm install -g @band-app/server
```

## 2. A server hub

The hub runs from a published image, `ghcr.io/band-app/band-hub`, for amd64 and arm64.

```sh
curl -O https://raw.githubusercontent.com/band-app/band/main/deploy/compose/compose.yml
docker compose up -d
docker compose logs band   # the first run prints an admin token once
```

The hub listens on `127.0.0.1:3456`. To pin a release, set `BAND_VERSION` (for example `BAND_VERSION=1.4.0 docker compose up -d`). Without it, compose pulls `latest`. Put settings such as `BAND_PORT` and `BAND_ADMIN_TOKEN` in an `.env` file next to `compose.yml`. [`deploy/compose/.env.example`](../deploy/compose/.env.example) lists them.

To build the image from a checkout instead of pulling it:

```sh
cd deploy/compose
docker compose -f compose.yml -f compose.build.yml up -d --build
```

HTTPS, the admin token and connecting a browser, the desktop app or the CLI are in [Run the hub on a server](run-the-hub-on-a-server.md).

In the desktop app, choose the remote hub in Settings > Hub. A hub with no local worker (the default for the image) runs every worktree on a worker, so continue with the next section.

## 3. Workers and runners

A worker dials the hub, so it needs no inbound port. Open Settings > Workers, choose Add worker, give it a name and copy the command from the tab you want. The token in it works once and expires in an hour.

### This Mac, from the desktop app

On a Mac the desktop app is the main way to add a worker. When the app connects to a remote hub (Settings > Hub), it asks "Use this Mac as a worker?" once for that hub. Yes asks the hub for a one-time token, installs the launchd agent `app.band.worker` and waits until the worker shows online. The name defaults to the macOS computer name and can be changed. Folders the worker may use start empty, and a repo added later through the folder picker adds its folder. Not now is remembered for that hub. The app with its own local hub never asks, because the hub's local worker already covers the machine.

The same action stays in Settings > Workers under This computer. It shows the worker's status and the worker version, which is the app version. Remove this computer uninstalls the service, ends the terminals' daemon and removes the worker from the hub once it is offline. A worker that still has worktrees stays on the hub, and the section says so.

The service runs the worker inside the app (`Band.app/Contents/Resources/worker`) with the app's own executable (`ELECTRON_RUN_AS_NODE=1`), so the Mac needs no Node or npm. An app update replaces the files and the app restarts the service with `launchctl kickstart -k` the first time it starts after the update. The service keeps running when you quit the app. The token never appears in the UI or the logs. It is in the plist (mode 0600), as with the npm install.

When `app.band.worker` was installed from npm, Settings > Workers offers Switch to the worker in this app. The switch keeps the worker id, name, roots and state directory, so the worker and its worktrees stay.

The npm path below stays for Linux and servers.

### npm with a service

```sh
npm install -g @band-app/worker
band-worker install-service --hub https://band.example.com --worker-id <id> --token <bootstrap token>
```

Node 22.5 or newer is required. `install-service` writes the worker's settings and starts it:

- On Linux it creates the systemd user unit `~/.config/systemd/user/band-worker.service` and enables it with `systemctl --user enable --now`. It then runs `loginctl enable-linger` so the worker keeps running after you log out. When that is refused it prints the `sudo loginctl enable-linger $USER` command.
- The unit sets `OOMPolicy=continue`. When the kernel kills an agent or a build for running out of memory, only that process dies, and the worker and the other chats keep running. Without it systemd stops the whole worker. An install from an older Band gets the setting the next time `install-service` runs. The original bootstrap token works for that run: the worker keeps the session token and worker id saved in its state directory, and never trades the spent token again. Pass the same flags as the first install (including `--state-dir` if you set one), because `install-service` rewrites the env file from them. To add the setting without reinstalling, use a drop-in:

  ```sh
  mkdir -p ~/.config/systemd/user/band-worker.service.d
  printf '[Service]\nOOMPolicy=continue\n' > ~/.config/systemd/user/band-worker.service.d/oom.conf
  systemctl --user daemon-reload
  ```
- On macOS it creates the launchd agent `~/Library/LaunchAgents/app.band.worker.plist` and loads it.
- The macOS worker writes its own log, `~/.band/worker-service/worker.log`, and rotates it at 10 MB, keeping 3 files (`worker.log`, `worker.log.1`, `worker.log.2`). A larger existing log is rotated when the worker starts. launchd's own output goes to `/dev/null`, because launchd cannot rotate a file. On Linux the unit logs to journald and writes no file: read it with `journalctl --user -u band-worker`.

The token lives in `~/.band/worker-service/worker.env` (Linux) or in the plist (macOS), both mode 0600 in a 0700 directory. After the first connect the worker keeps its own session token in its state directory and the bootstrap token is no longer used.

Options: `--root <dir>` (repeatable, the directories the worker may serve), `--name`, `--labels k=v,k=v`, `--state-dir`.

```sh
band-worker status            # exit code 0 running, 3 installed but stopped, 4 not installed
band-worker uninstall-service # removes the unit or plist and the env file, ends the terminals, keeps the worker's state
```

To run the worker in the foreground without a service, use `band-worker --hub <url> --token <token>`.

### Docker

```sh
docker run -d --name band-worker --restart unless-stopped \
  -v band-work:/work -v band-worker-state:/home/worker/.band/worker \
  -e BAND_HUB_URL=https://band.example.com -e BAND_WORKER_ID=<id> -e BAND_WORKER_TOKEN=<bootstrap token> \
  ghcr.io/band-app/band-worker:latest
```

The worker takes plain `http` only for a loopback hub. A hub on the same machine is reached with `--network host` and `http://127.0.0.1:3456`. Add worker shows the same command as a compose file in its Docker compose tab.

### What a static worker must have

A worker runs the coding agents. Band does not install or log in an agent for you, so before a worker can take a worktree, each agent it should run must be installed and logged in for the user the worker runs as. Run `band-worker doctor` on the machine to check:

```
ok   claude-code  2.4.1  installed, logged in
FAIL codex        0.9.0  installed, not logged in
       fix: codex login
FAIL gh           -      not installed
       fix: install the GitHub CLI from https://cli.github.com
```

It checks `claude`, `codex`, `opencode`, `gemini` and `cursor-agent`, then `git` and `gh`, and prints the command that fixes each gap. It exits 1 when `git` is missing or no agent is usable. On Linux it also warns, with the fix commands, when the machine has no swap and less than 16 GiB of memory, or when `fs.inotify.max_user_watches` is below 262144. It changes nothing itself, and these warnings do not change the exit code:

```
WARN worker       no swap and 7.8 GiB of memory: builds that agents run at once can be killed for running out of memory
       fix: sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
       fix: grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
WARN worker       fs.inotify.max_user_watches is 61656: agents that watch files fail with ENOSPC
       fix: echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-band-inotify.conf
       fix: sudo sysctl --system
```

`BAND_AGENT_BIN_DIRS` (a PATH-style list) names extra directories to search first, for CLIs that sit outside the service's PATH.

A connected worker sends the same report to the hub on connect and every few minutes (`BAND_CAPABILITY_REFRESH_MS`, default 3 minutes). Settings > Workers shows it for each worker (installed, version, logged in), instead of the agents in your settings.

### Repos on a worker

A worker owns a table from remote URL to folder (`repos.json` in its state directory). The first worktree of a repo on a worker clones it to `~/band/repos/<owner>/<name>`. Run the worker with `--repos-dir <dir>` (or `BAND_REPOS_DIR`) to clone elsewhere, and the worker serves that directory as a root. To use a checkout that already exists, add the repo from the worker's folder picker or with `band repos add --from <worker id> <path>`. See [Add a repo](run-the-hub-on-a-server.md#add-a-repo).

### Runners

A runner starts workers on demand when a worktree asks for a worker that does not exist yet (a Docker container, a Kubernetes Pod, a cloud VM, an SSH machine). The hooks and their settings are in [Runner hooks](runner-hooks.md), and sleeping workers in [Ephemeral workers](ephemeral-workers.md).

## Updating

Settings > Workers shows the Band version each worker runs, and marks a worker that is behind the hub. Once a day the hub asks GitHub for the latest release (`BAND_UPDATE_CHECK=off` turns that off for an air-gapped hub). When a newer one exists, the sidebar footer shows an "update available" badge. It opens a panel that lists the hub and every worker with their version and the version to move to.

Update the workers first and the hub last, so the hub is never older than its workers.

- **A worker under launchd (`app.band.worker`) or a systemd user unit (`band-worker`)**: an admin clicks Update. A dialog lists the agents on that worker, because the restart ends them. On confirm, the worker runs the `npm` that sits beside its own `node` (`BAND_NPM_BIN` overrides it, and the service file needs no PATH) as `npm i -g --prefix <prefix> @band-app/worker@<version>`, where `<prefix>` is the one the running worker is installed in (`<prefix>/lib/node_modules/@band-app/worker`). It then makes node-pty's `spawn-helper` executable, because npm 11 skips install scripts, and restarts through its service manager. A worker that does not run from such a layout (a checkout, the desktop app, the Docker image) reports why in `updateBlockedReason`, gets no Update button and shows the manual command. If the install fails, the worker keeps running as it was and the error shows on the worker. A worker with the target version is the hub's own when the worker is behind it, otherwise the latest release (when it stays within a minor of the hub).
- **Any other worker** shows the command to run by hand (`npm i -g @band-app/worker@<version>`, then restart it).
- **The hub** only shows the command; it never updates itself. The command follows `BAND_INSTALL_METHOD`, which the compose file (`compose`), the Kubernetes manifest (`k8s`, or `helm` for a chart) and the image default (`docker`) set. With none set the panel says to pull `ghcr.io/band-app/band-hub:<version>` and recreate the container.

A hub run from source reports the unreleased version `0.1.0` and accepts every worker (it logs that it skipped the check). A worker whose version differs from a released hub's by more than one minor version (`0.47.0` against `0.50.0`) is refused with a message that says what to do. The worker logs it, waits five minutes (`BAND_WORKER_VERSION_RETRY_MS`) and exits instead of redialing, and its worker shows "update required". A worker from before version reporting is accepted and shown with an unknown version. `band workers list` has a VERSION column with the same marks.

## Releases

A release publishes the desktop DMGs, the Homebrew cask, `@band-app/server` and `@band-app/worker` on npm, and the two images `ghcr.io/band-app/band-hub` and `ghcr.io/band-app/band-worker`. Each image is tagged with the release version and `latest`. Pull requests that change `docker/`, `deploy/compose/` or the release workflows build both images for both architectures without pushing them (`.github/workflows/images.yml`).

### How the release workflow runs

`release.yml` is started by hand (Actions > Release > Run workflow) and has these jobs:

1. **Build (macOS).** Checks the gate, determines the version, builds the UI and hub, then builds, signs and notarizes the DMG. It uploads the DMGs, the zips, `latest-mac.yml`, the hub bundle and the built UI as artifacts.
2. **CLI (Linux).** Builds the `band` CLI at the release version on an x64 and an arm64 runner.
3. **Publish (Linux).** Downloads those artifacts, pushes the tag, creates the GitHub release, publishes the three `@band-app/worker-cli-<platform>-<arch>` packages (the `band` CLI for darwin-arm64, linux-x64 and linux-arm64, built by the macOS job and a `cli-linux` matrix) and then `@band-app/server` and `@band-app/worker` to npm, and updates the Homebrew cask. The tag is pushed only after the signed build succeeded.
4. **Images.** Builds the two images from the tag.
5. **Mobile.** Runs after Publish. Builds the iOS app with the release version and submits it to TestFlight, and builds the Android preview APK, both through EAS with the `EXPO_TOKEN` secret. The `mobile` input is `auto` (only when `apps/mobile`, `packages/client`, `packages/shared` or `pnpm-lock.yaml` changed since the previous release tag), `always` or `skip`. The build links go in the job summary and the release notes. A failure here leaves the rest of the release shipped. App Store review stays manual.

Build and Publish use the `production` environment, so the signing, npm and tap secrets stay with the jobs that need them.

Lint and tests do not run in the release. The Build job runs `scripts/check-ci-green.sh <sha>`, which asks the GitHub API for a completed `ci.yml` run on the exact commit being released with conclusion `success` (every job succeeded or was skipped, and a re-run that succeeded counts). Runs of the `pull_request` event are ignored, because they test a merge ref. Without such a run the job fails and names the commit and the state of each `ci.yml` run it found. Start releases only after CI on main has finished.

To release a commit that CI has not passed, run the workflow with `force_tests` set to true. The gate is skipped, and the job builds the CLI, runs lint, and runs the server, web and CLI tests before building the DMG, as releases did before the gate.
