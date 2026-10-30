---
title: Hub on a server
description: Run the Band hub on a home server or a VPS with Docker Compose, add HTTPS, connect your devices and keep it updated.
section: workers
order: 10
---

This page covers running the Band hub on a home server or a VPS with Docker Compose. The hub keeps its data in one volume. You reach it from a browser, the desktop app or the CLI with a device token. Worktrees run on [workers](adding-workers.md), not in the hub container.

## Start the hub

```sh
curl -O https://raw.githubusercontent.com/band-app/band/main/deploy/compose/compose.yml
docker compose up -d
docker compose logs band  # find the admin token
```

Compose pulls `ghcr.io/band-app/band-hub:latest`. Set `BAND_VERSION` to pin a release. For settings, copy `deploy/compose/.env.example` to `.env` next to `compose.yml`. To build the image from a checkout instead, run `docker compose -f compose.yml -f compose.build.yml up -d --build` in `deploy/compose`. The hub listens on port 3456 inside the container. Compose publishes it on `127.0.0.1:3456` of the server. Set `BAND_PORT` in `.env` to change the published port, and `BAND_BIND=0.0.0.0` to publish on all interfaces. Only do that on a trusted network.

`compose.yml` passes only the variables it lists to the container (see the [settings reference](#settings-reference)). Any other `BAND_*` variable, such as `BAND_PUBLIC_URL`, must be added under `environment:` in `compose.yml` before it reaches the hub.

### The admin token

- With `BAND_ADMIN_TOKEN` empty, the first run creates an admin token and prints it once in the log. Later starts print nothing. If you lose it, set `BAND_ADMIN_TOKEN` in `.env` and run `docker compose up -d`. The hub replaces the stored token with that value.
- With `BAND_ADMIN_TOKEN` set, the hub uses that value and never prints it.

The admin token can create more tokens (Settings > Devices, or `band tokens create-device`). Give each device its own token and revoke it when you lose the device. Worker tokens are in Settings > Workers.

### Check it works

```sh
TOKEN=...   # the admin token
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3456/api/health   # 200
curl -i http://127.0.0.1:3456/api/health                                  # 401
```

## HTTPS

Do not expose the hub over plain HTTP outside a trusted network, because every request carries the token.

### With the bundled Caddy

Point a DNS name at the server and open ports 80 and 443. Then set the name in `.env` and start the `tls` profile:

```sh
BAND_DOMAIN=band.example.com
docker compose --profile tls up -d
```

Caddy gets and renews the certificate and proxies to the hub, including WebSockets. The hub stays on localhost.

### With your own reverse proxy

Proxy `https://your-host/` to `http://127.0.0.1:3456`. The proxy must pass WebSocket upgrades. In nginx that means `proxy_http_version 1.1` plus the `Upgrade` and `Connection` headers.

## Connect

Pick one.

- Browser. Open `https://band.example.com/` and sign in with the token. A `?token=` query on the first visit also signs in.
- Desktop app. Open `https://band.example.com/#hub=https://band.example.com&token=<token>`, or choose a remote hub in Settings > Hub. A plain `http:` URL works only for loopback.
- CLI. Set the URL and token, then run any command.
  ```sh
  export BAND_SERVER_URL=https://band.example.com
  export BAND_TOKEN=<token>
  band repos list
  ```

### Connect a phone

1. Add `BAND_PUBLIC_URL: https://band.example.com` under `environment:` in `compose.yml`, so the hub offers its public address as the default link address. Run `docker compose up -d`.
2. Open Settings > Devices on a device that has an admin token and choose Add device. Keep the label `Phone` or change it. Leave Admin device off unless the phone should manage tokens too.
3. The Connect dialog shows a link and a QR code. Pick the address the phone reaches the hub on, then scan the code or open the link. The link is `<address>/?pair=<code>`.
4. The code works once and expires after 15 minutes. Opening it signs the phone in as that device and replaces the device's previous token.

A hub in a container sees only container network addresses, so set `BAND_PUBLIC_URL` there. Settings > Devices lists each device. Revoke signs a device out at once.

If you lose the admin token and cannot reach Settings, set `BAND_ADMIN_TOKEN` in `.env` to a new value and run `docker compose up -d`. The hub replaces the stored token with that value.

## Serve the UI from somewhere else

By default the hub serves the UI at `/`. Two settings change that.

- `BAND_SERVE_UI=false` runs the hub as an API only. `/` and every other non-API path answers 404.
- `BAND_ALLOWED_ORIGINS` lists the origins of a UI hosted elsewhere, comma-separated, for example `https://band-ui.example.com`. The hub allows those origins in CORS and in the WebSocket origin check. An origin not on the list is refused. The UI sends the token as a Bearer header.

The desktop app has its own copy of the UI, so it needs neither setting.

## Worktrees run on workers

The image sets `BAND_LOCAL_WORKER=off`, so the hub does not run worktrees in its own container. Every worktree runs on a worker, and the entrypoint creates no sample repo. The hub is not listed as a worker in Settings > Workers or in any worker picker.

A worktree created with no worker goes to the worker named by `BAND_DEFAULT_WORKER`, or to the only online worker. With no online worker, or several and no default, it fails with an error that names the setting. To add a worker, see [Add a worker](adding-workers.md). Set `BAND_LOCAL_WORKER=on` to run worktrees in the container again. The image has no coding agent installed, so that is only useful with a mounted repo and an agent you add yourself.

## Add a repo

A repo on the hub is a remote URL and a default branch. The hub holds no checkout of it, and each worker maps the URL to a folder of its own. There are two ways to add one.

By URL. The first worktree for the repo on a worker clones it to `~/band/repos/<owner>/<name>` on that worker, and later worktrees reuse the clone.

```sh
band repos add --url https://github.com/owner/repo.git
```

Run it from any machine with the CLI set up as in [Connect](#connect).

Without `--branch` the hub reads the default branch with `git ls-remote --symref` on an online worker, or from the GitHub API when the vault holds a git credential for github.com. The clone uses the worker's own git credentials, or the vault's git credential on a runner worker (see [Runners](runner-hooks.md)).

From a worker. When a worker already has a checkout, pick it on that worker. In the UI, choose Add repo in the sidebar's Repos panel and then From a worker, and browse the worker's home directory. The hub reads the folder's `origin` URL and default branch, and the worker keeps the folder in its own mapping, so it never clones it again. A folder outside the directories the worker serves is added as a root after you confirm. The CLI does the same:

```sh
band repos add --from <worker-id> /home/me/code/myrepo --add-root
```

A folder with no git remote is added without a URL and stays on that one worker. A worktree for it can only run there.

`band repos list` shows each repo's URL and the folder it is cloned to on each worker.

With `BAND_LOCAL_WORKER=on`, you can also mount a repository into the container (the commented volume line in `compose.yml`) and register its container path with `band repos add /repos/myrepo`.

## Update

The hub shows an "update available" badge in the sidebar footer when a newer release exists. Its panel gives the command for a compose install. To update by hand, run these in the directory that holds `compose.yml`:

```sh
docker compose pull
docker compose up -d
```

To move to a specific release, set `BAND_VERSION` for both commands, for example `BAND_VERSION=1.4.0 docker compose pull`. The volume keeps repos, tokens and settings. The hub applies database migrations when it starts. Back up the volume before a major upgrade.

A hub built from a checkout (`compose.build.yml`) updates with `git pull` and `docker compose -f compose.yml -f compose.build.yml up -d --build`.

A worker within one minor version of the hub is accepted. Update workers as the [updates](updates.md) page describes.

## Back up and restore

All state is in the `band-data` volume, mounted at `/data` (the container's `$HOME`, so Band's home is `/data/.band`).

```sh
docker compose stop band
docker run --rm -v compose_band-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/band-data.tgz -C /data .
docker compose start band
```

The volume name starts with the Compose repo name, which is the directory name (`compose` here). Run `docker volume ls` to see yours. To restore, stop the hub and extract the archive into the volume the same way.

## Settings reference

| Variable | Default | Effect |
| --- | --- | --- |
| `BAND_ADMIN_TOKEN` | empty | Sets the admin token. Empty makes the first run create and print one. |
| `BAND_LOCAL_WORKER` | `off` | `on` allows worktrees on the hub's own machine and creates the sample repo. |
| `BAND_DEFAULT_WORKER` | empty | Worker id used when a worktree names no worker. Empty uses the only online worker. `BAND_LOCAL_HOST` and `BAND_DEFAULT_HOST` are still read, and the new names win. |
| `BAND_CLI_PATH` | `/opt/band/binaries/band` | The `band` CLI the hub itself uses, for example to install the skills. An npm install finds it in its `@band-app/worker-cli-<platform>-<arch>` optional dependency, so this is only for other layouts. Workers carry their own CLI and never fetch it from the hub. The dashboard's "Install band CLI" banner shows only to admin tokens, and never on a hub with `BAND_LOCAL_WORKER=off`. |
| `BAND_SERVE_UI` | `true` | `false` serves the API only. |
| `BAND_ALLOWED_ORIGINS` | empty | Origins of a UI hosted elsewhere. |
| `BAND_PORT` | `3456` | Port the server publishes the hub on. The container always listens on 3456. |
| `BAND_BIND` | `127.0.0.1` | Address on the server that the published port binds to. |
| `BAND_DOMAIN` | empty | Hostname for the `tls` profile. |
| `BAND_VERSION` | `latest` | Image tag. |
| `BAND_IMAGE` | `ghcr.io/band-app/band-hub:<version>` | Replaces the whole image name. |

Compose passes the variables above to the hub, and `BAND_INSTALL_METHOD=compose` is set for you. `BAND_PUBLIC_URL` is read by the hub but not passed by `compose.yml`.
