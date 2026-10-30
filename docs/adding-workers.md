---
title: Add a worker
description: Connect a Mac or Linux machine to your hub so worktrees and agents can run on it.
section: workers
order: 20
---

A worker is a machine that runs worktrees, terminals and coding agents. The hub keeps data and chats, and workers do the work. A worker dials the hub, so it needs no inbound port. The hub's own machine is the worker `local` when you use the desktop app. A hub from the Docker image has no local worker, so you add at least one.

Workers run on macOS and Linux (x64 and arm64). Windows is not supported yet.

## What a worker needs

Band does not install or log in a coding agent for you. Before a worker can take a worktree, install and log in each agent it should run, as the user the worker runs as. Also install `git`, and `gh` if you use GitHub features.

Run `band-worker doctor` on the machine to check. It lists `claude`, `codex`, `opencode`, `gemini` and `cursor-agent`, then `git` and `gh`, and prints a fix command for each gap.

```text
ok   claude-code  2.4.1  installed, logged in
FAIL codex        0.9.0  installed, not logged in
       fix: codex login
FAIL gh           -      not installed
       fix: install the GitHub CLI from https://cli.github.com
```

`doctor` exits 1 when `git` is missing or no agent is usable. On Linux it also warns when the machine has no swap and less than 16 GiB of memory, or when `fs.inotify.max_user_watches` is below 262144. These warnings do not change the exit code. `doctor` changes nothing itself.

Set `BAND_AGENT_BIN_DIRS` (a PATH-style list) to name extra directories that hold agent CLIs outside the service's PATH.

## Ways to add a worker

| Machine | Method |
| --- | --- |
| A Mac with the desktop app | [This Mac](#this-mac-from-the-desktop-app) |
| A blank Linux or macOS machine | [One command](#one-command) |
| A machine you set up yourself | [Manual install](#manual-install) |

All of them start in Settings > Workers, which needs an admin device token.

## This Mac, from the desktop app

When the desktop app connects to a remote hub (Settings > Hub), it asks "Use this Mac as a worker?" once for that hub. Yes installs a launchd agent named `app.band.worker` and waits until the worker shows online. Not now is remembered for that hub. The name defaults to the macOS computer name and you can change it. The folders the worker may use start empty. A repo you add later through the folder picker adds its folder.

The app with its own local hub never asks, because the hub's `local` worker already covers the machine.

The worker runs inside the app with the app's own executable, so the Mac needs no Node or npm. An app update replaces the files and restarts the service the first time the app starts after the update. The service keeps running when you quit the app.

The same action stays in Settings > Workers under This computer. It shows the worker's status and version, and Remove this computer uninstalls the service and removes the worker from the hub once it is offline. A worker that still has worktrees stays on the hub. If an npm-installed worker named `app.band.worker` already exists, Settings > Workers offers Switch to the worker in this app. The switch keeps the worker id, name, folders and state, so its worktrees stay.

## One command

Settings > Workers > Add a worker > Get provisioning command shows a line like this:

```sh
curl -fsSL https://hub.example.com/api/provision/<code>/script | sh
```

Run it as the normal user on a blank Linux or macOS machine. It installs Node if needed, installs the worker and starts it as a service. The line works once and expires after an hour. See [Provision a worker](provisioning.md) for what the script does, the optional provisioning repo and cloud-init.

## Manual install

Settings > Workers > Manual install > Add worker creates a one-time token. Copy it right away, because the hub keeps only a hash and cannot show it again. The token works once and expires in an hour. The dialog offers the command for each method.

### npm service

Use this on Linux and on a Mac without the desktop app. It needs Node 22.5 or newer.

```sh
npm install -g @band-app/worker
band-worker install-service --hub https://band.example.com --worker-id <id> --token <bootstrap token>
```

`install-service` writes the worker's settings and starts it.

- On Linux it creates the systemd user unit `~/.config/systemd/user/band-worker.service` and enables it. It then runs `loginctl enable-linger` so the worker keeps running after you log out. If that is refused, it prints the `sudo loginctl enable-linger $USER` command. The unit sets `OOMPolicy=continue`, so when the kernel kills an agent or a build for running out of memory, only that process dies.
- On macOS it creates the launchd agent `~/Library/LaunchAgents/app.band.worker.plist` and loads it. The worker writes `~/.band/worker-service/worker.log` and rotates it at 10 MB, keeping three files.
- On Linux, read the log with `journalctl --user -u band-worker`.

Options: `--root <dir>` (repeatable, a directory the worker may serve), `--name`, `--labels k=v,k=v` and `--state-dir`.

```sh
band-worker status             # exit code 0 running, 3 installed but stopped, 4 not installed
band-worker uninstall-service  # removes the unit or plist, ends the terminals, keeps the worker's state
```

### npm foreground

To run the worker in the terminal until you stop it, install the package and run:

```sh
band-worker --hub https://band.example.com --worker-id <id> --token <bootstrap token>
```

The same values can come from `BAND_HUB_URL`, `BAND_WORKER_ID` and `BAND_WORKER_TOKEN` (or `BAND_BOOTSTRAP_TOKEN`).

### Docker

```sh
docker run -d --name band-worker --restart unless-stopped \
  -v band-work:/work -v band-worker-state:/home/worker/.band/worker \
  -e BAND_HUB_URL=https://band.example.com -e BAND_WORKER_ID=<id> -e BAND_WORKER_TOKEN=<bootstrap token> \
  ghcr.io/band-app/band-worker:latest
```

The Docker compose tab in the dialog gives the same setup as a `compose.yml`. A worker accepts plain `http` only for a hub on loopback. For a hub on the same machine, add `--network host` and use `http://127.0.0.1:3456`. Any other hub needs an `https` URL.

## Tokens

The one-time token is a bootstrap token. The worker trades it once for a session token and saves that token and its worker id in its state directory. After that the bootstrap token is no longer used, and a second use of it fails.

The token is not shown again. On Linux, the service keeps it in `~/.band/worker-service/worker.env`. On macOS it sits in the launchd plist. Both files have mode 0600 in a 0700 directory. The worker removes the token from the environment that agents and terminals inherit.

To cut a worker off, remove it in Settings > Workers, or run `band workers remove <id>` for a worker that is offline and has no worktrees. Removing revokes its tokens.

## Repos on a worker

Each worker maps a repo's remote URL to a folder of its own. The first worktree of a repo on a worker clones it to `~/band/repos/<owner>/<name>`. Run the worker with `--repos-dir <dir>` (or `BAND_REPOS_DIR`) to clone elsewhere. To use a checkout that already exists, add the repo from the worker's folder picker, or run:

```sh
band repos add --from <worker-id> /home/me/code/myrepo
```

A folder outside the directories the worker serves needs `--add-root` and your confirmation. See [Hub on a server](run-the-hub-on-a-server.md#add-a-repo).

## Next steps

- [Repo workers](repo-hosts.md) limits a repo to some workers.
- [Trust levels and agent access](agent-host-access.md) sets how far an agent on a worker can reach.
- [Runners](runner-hooks.md) starts workers on demand.
- [Updates](updates.md) updates workers from the hub.
