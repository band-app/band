# Run the hub on a server

This page covers running the Band hub on a home server or a VPS with Docker Compose. The hub keeps its data in one volume. You reach it from a browser, the desktop app or the CLI with a device token.

## Start the hub

```sh
cd deploy/compose
cp .env.example .env      # optional
docker compose up -d
docker compose logs band  # find the admin token
```

The first run builds the image from the repository, so it takes a few minutes. The hub listens on `127.0.0.1:3456` of the host. Set `BAND_BIND=0.0.0.0` in `.env` to publish it on all interfaces, and only do that on a trusted network.

### The admin token

- With `BAND_ADMIN_TOKEN` empty, the first run creates an admin token and prints it once in the log. Later starts print nothing. If you lose it, set `BAND_ADMIN_TOKEN` in `.env` and run `docker compose up -d`. The hub replaces the stored token with that value.
- With `BAND_ADMIN_TOKEN` set, the hub uses that value and never prints it.

The admin token can create more tokens (Settings > Hosts, or `band tokens create-device`). Give each device its own token and revoke it when you lose the device.

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

- **Browser.** Open `https://band.example.com/` and sign in with the token. A `?token=` query on the first visit also signs in.
- **Desktop app.** Open `https://band.example.com/#hub=https://band.example.com&token=<token>`, or choose a remote hub in Settings > Hub. A plain `http:` URL works only for loopback.
- **CLI.**
  ```sh
  export BAND_SERVER_URL=https://band.example.com
  export BAND_TOKEN=<token>
  band projects list
  ```

## Serve the UI from somewhere else

By default the hub serves the UI at `/`. Two settings change that.

- `BAND_SERVE_UI=false` runs the hub as an API only. `/` and every other non-API path answers 404.
- `BAND_ALLOWED_ORIGINS` lists the origins of a UI hosted elsewhere, comma-separated, for example `https://band-ui.example.com`. The hub allows those origins in CORS and in the WebSocket origin check. An origin not on the list is refused. The UI sends the token as a Bearer header.

The desktop app has its own copy of the UI, so it needs neither setting.

## Workspaces run on workers

The image sets `BAND_LOCAL_HOST=off`, so the hub does not run workspaces in its own container. Every workspace runs on a worker, and the entrypoint creates no sample project. The host picker lists only workers, and `workspaces.create` for the `local` host is refused.

A workspace created with no host goes to the worker named by `BAND_DEFAULT_HOST`, or to the only online worker. With no online worker, or several and no default, it fails with an error that names the setting. To add a worker, open Settings > Hosts and follow the steps there, or see the worker setup in `docker/worker.Dockerfile`. Set `BAND_LOCAL_HOST=on` to run workspaces in the container again.

## Add a project

Mount a repository into the container in `compose.yml` and register its container path:

```yaml
    volumes:
      - band-data:/data
      - /srv/repos/myrepo:/projects/myrepo
```

```sh
docker compose exec band band projects add /projects/myrepo
```

The image has no coding agent installed. With `BAND_LOCAL_HOST=on`, terminals, git worktrees and setup scripts work in the container. With it off, the repository must also exist on the worker that runs the workspace.

## Upgrade

```sh
git pull
docker compose build --pull
docker compose up -d
```

The volume keeps projects, tokens and settings. The hub applies database migrations when it starts. Back up the volume before a major upgrade.

## Back up and restore

All state is in the `band-data` volume, mounted at `/data` (the container's `$HOME`, so Band's home is `/data/.band`).

```sh
docker compose stop band
docker run --rm -v compose_band-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/band-data.tgz -C /data .
docker compose start band
```

The volume name starts with the Compose project name, which is the directory name (`compose` here). Run `docker volume ls` to see yours. To restore, stop the hub and extract the archive into the volume the same way.

## Settings reference

| Variable | Default | Effect |
| --- | --- | --- |
| `BAND_ADMIN_TOKEN` | empty | Sets the admin token. Empty makes the first run create and print one. |
| `BAND_LOCAL_HOST` | `off` | `on` allows workspaces on the hub's own machine and creates the sample project. |
| `BAND_DEFAULT_HOST` | empty | Worker id used when a workspace names no host. Empty uses the only online worker. |
| `BAND_SERVE_UI` | `true` | `false` serves the API only. |
| `BAND_ALLOWED_ORIGINS` | empty | Origins of a UI hosted elsewhere. |
| `BAND_PORT` | `3456` | Host port. |
| `BAND_BIND` | `127.0.0.1` | Host address the port binds to. |
| `BAND_DOMAIN` | empty | Hostname for the `tls` profile. |
