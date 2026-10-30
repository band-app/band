---
title: Install
description: Install the Band desktop app, run a hub on a server, or add a worker, and get the band CLI.
section: get-started
order: 20
---

Band has three parts. The hub holds data and runs the agents' chats. Workers are the machines that hold worktrees and run agents. The desktop app and the web UI are the interface. Pick the layout that matches where your code runs.

| You want | Install |
| --- | --- |
| Band on one Mac | [Desktop app only](#1-desktop-app-only) |
| One always-on hub for several devices | [A server hub](#2-a-server-hub) |
| Worktrees on other machines, containers or VMs | [Workers and runners](#3-workers-and-runners) |

## 1. Desktop app only

The desktop app runs on macOS 11 or newer on Apple Silicon. There is no Intel build. Install it with Homebrew:

```sh
brew install --cask band-app/band/band
```

Or download `Band-<version>-apple-silicon.dmg` from the [latest release](https://github.com/band-app/band/releases/latest), open it and drag Band to Applications. The app starts its own hub and runs worktrees on this Mac. Nothing else is needed, except `git` and the coding agents you want to use. Install and log in to those yourself.

### The `band` CLI

The app bundles the `band` CLI. Two ways to put it on your PATH:

- The Homebrew cask links it into Homebrew's `bin` for you.
- With the DMG, the dashboard shows an "Install band CLI" banner. Click Install to link it as `/usr/local/bin/band`. macOS may ask for an administrator password. If a different `band` binary already sits there, the banner offers to replace it.

Check it with `band repos list`. The CLI reads the hub's address and token from `~/.band/settings.json`. Point it at another hub with `BAND_SERVER_URL` and `BAND_TOKEN`.

On a hub you installed from npm (`@band-app/server`, command `band-server`), the same banner links the CLI that npm installed beside it. The CLI comes in the `@band-app/worker-cli-<platform>-<arch>` package (darwin-arm64, linux-x64 and linux-arm64). On another platform, or with optional dependencies turned off, install that package or set `BAND_CLI_PATH`. Agents and terminals on a worker get `band` on their PATH without any of this.

## 2. A server hub

The hub runs from a published image, `ghcr.io/band-app/band-hub`, for amd64 and arm64.

```sh
curl -O https://raw.githubusercontent.com/band-app/band/main/deploy/compose/compose.yml
docker compose up -d
docker compose logs band   # the first run prints an admin token once
```

Compose publishes the hub on `127.0.0.1:3456`. To pin a release, set `BAND_VERSION` (for example `BAND_VERSION=1.4.0 docker compose up -d`). Without it, compose pulls `latest`. Put settings such as `BAND_PORT` and `BAND_ADMIN_TOKEN` in an `.env` file next to `compose.yml`. [`deploy/compose/.env.example`](../deploy/compose/.env.example) lists them.

To build the image from a checkout instead of pulling it:

```sh
cd deploy/compose
docker compose -f compose.yml -f compose.build.yml up -d --build
```

HTTPS, the admin token and connecting a browser, the desktop app or the CLI are in [Run the hub on a server](run-the-hub-on-a-server.md).

In the desktop app, choose the remote hub in Settings > Hub. A hub with no local worker (the default for the image) runs every worktree on a worker, so continue with the next section.

## 3. Workers and runners

A worker is a computer that runs worktrees and agents for a hub. Add one with a one-line command from Settings > Workers, from the desktop app (This Mac), or by hand with npm or Docker. [Add a worker](adding-workers.md) has the steps and what a worker needs. To start workers on demand in Docker, Kubernetes or a cloud, see [Runners](runner-hooks.md).

## Updating

See [Updates](updates.md) for the desktop app, workers and the hub, and for the version rules between them.
