# Agent environments

A repository can say what its worktrees need by committing `.band/environment.json`. Band reads it when it sets up a worktree and shows it in Settings > Environment. It is the repo's answer to "what has to be installed and running before an agent can work here".

This page covers the file format, how it relates to `.devcontainer/devcontainer.json` and `.band/config.json`, and how Band builds and caches an image from it. Choosing a host for a worktree and booting the image in a container are later steps. Today Band parses the file, validates it, runs its commands, compares `requires` with the tools a host reports and builds the image.

## The three layers

| Layer | Contains | Defined by |
|---|---|---|
| 1. Worker base | `band-worker`, Node, git, gh, ripgrep, the agent CLIs | The Band release |
| 2. Repo toolchain | Node 24 and pnpm, Python and uv, Go, Postgres client, Playwright browsers | The repo: a devcontainer, or `build` in `environment.json` |
| 3. Worktree setup | `pnpm install`, migrations, seed data, dev servers | The repo: `install`, `start`, `terminals` and `teardown` in `environment.json` |

`environment.json` describes layers 2 and 3. Layer 1 belongs to the host.

## Example

```json
{
  "build": { "devcontainer": ".devcontainer/devcontainer.json" },
  "install": "pnpm install --frozen-lockfile && pnpm prisma generate",
  "start": "./scripts/worktree-setup.sh",
  "terminals": [{ "name": "dev", "command": "pnpm dev" }],
  "teardown": "./scripts/worktree-teardown.sh",
  "secrets": ["DATABASE_URL", "STRIPE_TEST_KEY"],
  "isolation": "container",
  "resources": { "cpu": 4, "memory": "8Gi" },
  "services": { "postgres": "postgres:16" },
  "requires": { "node": ">=24", "python": ">=3.12" }
}
```

Every key is optional. An unknown key is an error, and the error names the key.

## Keys

| Key | Meaning |
|---|---|
| `build` | How to get the toolchain. Exactly one of `devcontainer` (path to a `devcontainer.json`), `dockerfile` (path to a Dockerfile) or `image` (an image name). A `devcontainer` or `dockerfile` path must be inside the repository and the file must exist. |
| `install` | Shell command that installs dependencies. |
| `start` | Shell command that prepares the worktree, such as creating a per-worktree database. |
| `terminals` | A list of `{ "name", "command" }`. Band opens one terminal per entry after setup succeeds. Names must be unique. |
| `teardown` | Shell command that runs before Band removes the worktree. |
| `secrets` | Names of environment variables the worktree needs. Values never go in this file and Band does not store them here. |
| `isolation` | `worktree`, `container` or `vm`. |
| `resources` | `cpu` (a number) and optional `memory` and `disk`, as sizes such as `8Gi`. |
| `services` | Names mapped to the image of a service the worktree needs, such as `"postgres": "postgres:16"`. |
| `requires` | Minimum tool versions, such as `{ "node": ">=24" }`. See below. |

## How setup runs

When a worktree is created, Band runs `install` and then `start` in a terminal tab of the worktree. It runs them as one script that stops at the first command that fails. When that script ends with exit code 0, or when there is none, Band opens the `terminals`. A failed setup leaves them closed.

On removal, Band runs `teardown` and waits for it, as it does for `teardown` in `config.json`.

The commands run on the host that owns the worktree, so a worktree on a worker runs them on the worker. Band reads the file from the worktree's worktree first and from the repo checkout second, so an untracked or ignored `environment.json` in the main checkout also works.

## Relation to `.band/config.json`

`environment.json` supersedes the `setup` and `teardown` commands in `.band/config.json`.

- When a valid `environment.json` has `install` or `start`, it supplies the setup command. Otherwise Band reads `setup` from `config.json`.
- When it has `teardown`, it supplies the teardown command. Otherwise Band reads `teardown` from `config.json`.
- A file with problems is ignored and Band logs a warning, so a typo does not stop worktrees from being created. Settings > Environment and `band env validate` show the problems.

Everything else in `config.json`, such as `workspace.copyFiles`, is unchanged. A repo that has only `config.json` keeps working.

## Relation to devcontainer

Use `.devcontainer/devcontainer.json` for the toolchain when you can. It is a standard that editors and other tools understand, and its `features` install Node, Python and Docker for you. Point `build.devcontainer` at it. Use `dockerfile` or `image` when a devcontainer does not fit.

Band does not build these yet. It checks that the file exists and nothing more.

## Requires and host tools

`requires` maps a tool name to a version range. Band compares it with the versions a host reports. A worker reports its tools in its hello message and `hosts.list` returns them as `tools`. The tools are `node`, `python` (from `python3`), `go`, `pnpm`, `uv`, `docker` and `git`, and a tool that is not installed is left out. `python3` is accepted as a name in `requires`.

A range can be `>=24`, `>24`, `<=3`, `^3.12`, `~1.22.1`, `24` or `24.x`. Space separated comparators combine (`>=20 <23`), and `||` joins alternatives (`18 || >=20`). Pre-release tags are ignored.

Settings > Environment lists each host and, for one that does not meet `requires`, what is missing and the version it has. Nothing blocks a worktree on an unmet requirement yet. Choosing hosts by `requires` comes with placement.

## Checking a file

```sh
band env validate            # the repository in the current directory
band env validate ../other   # another repository, or its environment.json
```

It prints `OK <file>` and exits 0, or prints each problem as `<key path>: <message>` and exits 1.

```
/repo/.band/environment.json has 2 problems:
  instal: unknown key
  isolation: must be one of "worktree", "container", "vm" (got "docker")
```

The hub reads the file, so the path must exist on the hub's machine. The same check is available as `environment.validate` over tRPC, and `environment.forRepo` returns a repo's environment with the host check.

## Project-level environment for multi-repo tasks

A task with several member repos on a runner-started worker has one machine, so it has one environment. The hub picks it when the task request is made:

1. If the project's context repo has `.band/environment.json`, that file is the environment. Its `build.image` is the machine's image, `requires`, `isolation` and `resources` apply to the machine, and its `install` runs once in the task folder after every member worktree exists. Only `build.image` (or no `build`) is supported there for now. A file that builds from a `dockerfile` or `devcontainer` is refused with the reason, because a runner has no checkout to build it from.
2. Otherwise the primary member's file is the base: role `primary`, else the first repo listed. Its image is the machine's image. The `requires` of the other members are added to it, joining two different ranges for one tool as `a b` so both must hold, and `resources.cpu` takes the highest. The primary's `install` is part of its image build.
3. Whichever file decided, each member's own `install` runs in that member's worktree when the worktree is created, the same setup a one-member task runs. That is how a member that is not the primary gets its dependencies.

A task with one member keeps the repo's own environment, unchanged. The environment reaches the runner hook as `BAND_ENVIRONMENT` and `BAND_REPO_IMAGE` (`docs/runner-hooks.md`). Not merged yet: `services` and `secrets` of members other than the primary.

## Environment images

A repo with a `build` in its `environment.json` can have an image: layer 1, then layer 2, then the result of `install`. A runner that boots the image starts with the toolchain and the dependencies in place.

```sh
band env build api       # build now, or report a cache hit; follows the log
band env status api      # the current image and the latest build with its log
```

Settings > Environment shows the same: the current image, the status and log of the latest build, and a "Build image" button. Building needs an admin token.

### What goes into an image

The builder reads the repository from git, at the tip of `origin/<default branch>` (the local branch when the repo has no remote). Uncommitted files do not count. It exports that commit to a temporary directory on the builder host, then:

1. Builds layer 2 from `build`. A `dockerfile` is built with `docker build`, using the Dockerfile's own directory as the context. A `devcontainer` is built with `devcontainer build` (the devcontainers CLI, `npm install -g @devcontainers/cli`, must be on the builder host). An `image` is pulled.
2. Adds layer 1. A final stage copies the worker (`/opt/band-worker`) and the Node binary from the worker base image into `/opt/band`, and installs a `band-worker` command in `/usr/local/bin`. The toolchain needs no Node of its own. The worker base image is `band-worker:latest` (build it with `docker build -f docker/worker.Dockerfile -t band-worker .`) or the image named by `environmentBuilder.workerImage`. It is built on Debian, so the toolchain image should be glibc based.
3. Runs `install` in a container of that image, with the default-branch snapshot copied to `/workspace`, and commits the result. The snapshot has no `.git`. The image carries the labels `band.environment.key` and `band.environment.commit`. With no `install`, this step only tags the image.
4. Pushes the image when `environmentBuilder.registry` is set.

The image is tagged `band-env/<repo>:<first 16 characters of the key>`, under the registry prefix when there is one. The intermediate tags are removed after the build, and older `band-env/<repo>` images stay on the host until you prune them.

### When an image rebuilds

The key is a SHA-256 over:

- the Git object hash of `.band/environment.json`;
- the object hash of the Dockerfile or `devcontainer.json`, and of the directory next to it (a Dockerfile at the repository root counts only itself and `.dockerignore`, because its context would otherwise be the whole repository);
- the object hash of each lockfile and version file at the repository root: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements.txt`, `go.sum`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `mise.toml`, `.tool-versions`, `.nvmrc`, `.node-version` and `.python-version`;
- the image name of a `build.image`;
- the ID of the worker base image on the builder host.

A build for a key that already has a ready image on the builder host does nothing and reports a cache hit. If someone removed that image from the host, the build runs again. `band env build --force` builds even on a cache hit. Changes outside this list, such as source files, do not rebuild the image, because a runner checks out its branch over the snapshot and runs `install` again only when the lockfile differs.

A failed build is recorded with its log and never replaces the last ready image. The current image of a repo is its newest ready build. A key that failed is not retried automatically. Change a file in the key, or run `band env build`.

Builds start in three ways. `band env build` and the button start one by hand. The hub also rebuilds a repo that has been built at least once when the key at the default branch changes. It looks every minute (`BAND_ENVIRONMENT_BUILD_POLL_MS`), and the repos that were never built stay untouched, so a hub without Docker never tries. One build runs per repo at a time. A build that was running when the hub stopped is marked failed at the next start.

### Where it builds

Builds run on the builder host: the hub's own machine, or a worker with Docker. Set it in `~/.band/settings.json` (or with `settings.update`):

```json
{
  "environmentBuilder": {
    "hostId": "h-0123456789ab",
    "registry": "ghcr.io/acme",
    "workerImage": "band-worker:latest"
  }
}
```

`hostId` defaults to `local`. The repo needs a checkout on that host. `registry` is optional, and without it the image stays on the builder host. Every command goes through the host's `exec` with each credential-like variable (names with TOKEN, SECRET, PASSWORD, KEY and the like) and every `BAND_*` variable of the hub's environment blanked, because a build runs commands from the repository. Do not point `hostId` at a machine whose environment holds secrets you would not run a repository's scripts next to.

The `docker` runner hook boots the current image (`docs/runner-hooks.md`). Not done yet: snapshots, and a settings page for `environmentBuilder`.
