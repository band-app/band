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

In the desktop app, choose the remote hub in Settings > Hub. A hub with no local host (the default for the image) runs every worktree on a worker, so continue with the next section.

## 3. Workers and runners

A worker dials the hub, so it needs no inbound port. Open Settings > Hosts, choose Add worker, give it a name and copy the command from the tab you want. The token in it works once and expires in an hour.

### This Mac, from the desktop app

On a Mac the desktop app is the main way to add a worker. When the app connects to a remote hub (Settings > Hub), it asks "Use this Mac as a worker?" once for that hub. Yes asks the hub for a one-time token, installs the launchd agent `app.band.worker` and waits until the host shows online. The name defaults to the macOS computer name and can be changed. Folders the worker may use start empty, and a repo added later through the folder picker adds its folder. Not now is remembered for that hub. The app with its own local hub never asks, because the hub's local host already covers the machine.

The same action stays in Settings > Hosts under This computer. It shows the host's status and the worker version, which is the app version. Remove this computer uninstalls the service, ends the terminals' daemon and removes the host from the hub once it is offline. A host that still has worktrees stays on the hub, and the section says so.

The service runs the worker inside the app (`Band.app/Contents/Resources/worker`) with the app's own executable (`ELECTRON_RUN_AS_NODE=1`), so the Mac needs no Node or npm. An app update replaces the files and the app restarts the service with `launchctl kickstart -k` the first time it starts after the update. The service keeps running when you quit the app. The token never appears in the UI or the logs. It is in the plist (mode 0600), as with the npm install.

When `app.band.worker` was installed from npm, Settings > Hosts offers Switch to the worker in this app. The switch keeps the worker id, name, roots and state directory, so the host and its worktrees stay.

The npm path below stays for Linux and servers.

### npm with a service

```sh
npm install -g @band-app/worker
band-worker install-service --hub https://band.example.com --worker-id <id> --token <bootstrap token>
```

Node 22.5 or newer is required. `install-service` writes the worker's settings and starts it:

- On Linux it creates the systemd user unit `~/.config/systemd/user/band-worker.service` and enables it with `systemctl --user enable --now`. It then runs `loginctl enable-linger` so the worker keeps running after you log out. When that is refused it prints the `sudo loginctl enable-linger $USER` command.
- On macOS it creates the launchd agent `~/Library/LaunchAgents/app.band.worker.plist` and loads it.

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

### Repos on a worker

A worker owns a table from remote URL to folder (`repos.json` in its state directory). The first worktree of a repo on a worker clones it to `~/band/repos/<owner>/<name>`. Run the worker with `--repos-dir <dir>` (or `BAND_REPOS_DIR`) to clone elsewhere, and the worker serves that directory as a root. To use a checkout that already exists, add the repo from the worker's folder picker or with `band repos add --from <host id> <path>`. See [Add a repo](run-the-hub-on-a-server.md#add-a-repo).

### Runners

A runner starts workers on demand when a worktree asks for a host that does not exist yet (a Docker container, a Kubernetes Pod, a cloud VM, an SSH machine). The hooks and their settings are in [Runner hooks](runner-hooks.md), and sleeping workers in [Ephemeral workers](ephemeral-workers.md).

## Releases

A release publishes the desktop DMGs, the Homebrew cask, `@band-app/server` and `@band-app/worker` on npm, and the two images `ghcr.io/band-app/band-hub` and `ghcr.io/band-app/band-worker`. Each image is tagged with the release version and `latest`. Pull requests that change `docker/`, `deploy/compose/` or the release workflows build both images for both architectures without pushing them (`.github/workflows/images.yml`).
