# Band server on Linux — Docker test harness

Runs the **standalone `@band-app/server`** (web-only, no Electron desktop app)
on a stock Debian container with **no zsh and no Homebrew** — the exact
environment the Linux-compatibility work (issue #594) targets. Use it to
verify the server boots and the smoke flow works on Linux from a macOS host.

## Run

```sh
# from the repo root
docker compose up --build
# (or, with the standalone v2 binary: docker-compose up --build)
```

On startup the container prints an access URL:

```
 Open:  http://localhost:3457/?token=band-local
```

> The container listens on 3456 internally but is published on host **3457**,
> because Band's default port is 3456 — if you already run Band natively it
> owns 3456 and would shadow the container. Change the mapping in
> `docker-compose.yml` (`ports:` and `BAND_HOST_PORT`) if you like.

Open that in your browser. The `?token=` sets the auth cookie (production
mode enforces it); after the first load you can drop the query string.

Change the token via `BAND_ACCESS_TOKEN` in `docker-compose.yml`.

## What this exercises

- **Shell fallback** — the container has bash + sh but no zsh and no `$SHELL`,
  so `defaultShell()` falls back to `/bin/bash`. Spawn a terminal in the UI to
  confirm it attaches.
- **PATH resolution** — no Homebrew; `prependBinDirs()` uses `/usr/local/bin`
  (+ Linuxbrew only if present) via `path.delimiter`.
- **CLI + skills** — the Rust `band` binary is built and installed at
  `/usr/local/bin/band`, so boot-time `band skills install` resolves and you
  can run `band` inside the container:
  ```sh
  docker compose exec band band --help
  docker compose exec band band skills install
  ```
- **Tunnel install hint** — clicking "Install Tunnel" surfaces the Linux
  package-manager hint instead of shelling out to a nonexistent `brew`.

## Add a project

The container **auto-creates and registers a `sample` project** at
`/data/projects/sample` on first boot, so there's always something to open.
To add more, note: a "project" is just a directory the server can see (a git
repo, or a plain folder — plain folders get a single implicit workspace).

> **The path must exist inside the container.** Registering a path that isn't
> there (e.g. the placeholder `/projects/myrepo` without a matching bind
> mount) leaves a project whose directory is missing — terminals then fail
> with `Workspace directory does not exist: <path>`. Either mount a real repo
> at that path (option 2) or use an in-container path like
> `/data/projects/...`. Remove a broken entry with `band projects remove <name>`.

Three ways to add your own:

### 1. Create a sample repo inside the container (quickest)

Put it under `/data` so it lives in the persisted `band-data` volume, then
register it with the bundled `band` CLI (which talks to the local server):

```sh
docker compose exec band sh -lc \
  'mkdir -p /data/projects/sample && cd /data/projects/sample \
   && git init -q && echo "# Sample" > README.md \
   && git add -A && git commit -qm init'

docker compose exec band band projects add /data/projects/sample
```

It appears immediately in the web UI. You can also drive it entirely from the
CLI — e.g. create a workspace (git worktree):

```sh
docker compose exec band band workspaces create sample feat/demo
docker compose exec band band projects list
docker compose exec band band workspaces list
```

### 2. Mount a real host repo

Uncomment the bind mount in `docker-compose.yml` (read-write, so `git
worktree` can write its metadata into the repo's `.git`):

```yaml
    volumes:
      - band-data:/data
      - /absolute/path/to/your/repo:/projects/myrepo
```

Then register it (uid mismatches are already handled — the entrypoint sets
`git config --global --add safe.directory '*'`):

```sh
docker compose exec band band projects add /projects/myrepo
# …or use "Register Project" in the UI and enter /projects/myrepo
```

### 3. From the UI

Use **Register Project** and type the container path (e.g. `/projects/myrepo`
or `/data/projects/sample`).

> Note: `--label` on `band projects add` refers to a pre-defined grouping
> label, not a display name — omit it unless you've created labels. Remove a
> project with `band projects remove <name>`.

## Persisted state

Everything the server writes (SQLite DB, `settings.json`, installed skills
under `~/.agents`) lives in the `band-data` volume mounted at `/data`
(`$HOME` in the container). Inspect or reset it:

```sh
docker compose down            # keep state
docker compose down -v         # wipe state (removes the band-data volume)
```

## Known gaps (out of scope for #594)

- **Coding agents aren't installed.** `claude` / `codex` / etc. are not in the
  image, so "run an agent task" end-to-end won't work here — terminals, setup
  scripts, git/worktrees, and skills install do. Mount an agent binary or
  extend the image if you need to drive a real agent.
- **This is not a publishable image.** It builds from source on every run and
  ships the whole `dist/` bundle; it's meant for local Linux verification, not
  distribution.
