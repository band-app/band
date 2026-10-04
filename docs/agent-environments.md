# Agent environments

A repository can say what its workspaces need by committing `.band/environment.json`. Band reads it when it sets up a workspace and shows it in Settings > Environment. It is the repo's answer to "what has to be installed and running before an agent can work here".

This page covers the file format and how it relates to `.devcontainer/devcontainer.json` and `.band/config.json`. Building images from it, choosing a host for a workspace and running it in a container are later steps. Today Band parses the file, validates it, runs its commands and compares `requires` with the tools a host reports.

## The three layers

| Layer | Contains | Defined by |
|---|---|---|
| 1. Worker base | `band-worker`, Node, git, gh, ripgrep, the agent CLIs | The Band release |
| 2. Project toolchain | Node 24 and pnpm, Python and uv, Go, Postgres client, Playwright browsers | The repo: a devcontainer, or `build` in `environment.json` |
| 3. Workspace setup | `pnpm install`, migrations, seed data, dev servers | The repo: `install`, `start`, `terminals` and `teardown` in `environment.json` |

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
| `start` | Shell command that prepares the workspace, such as creating a per-workspace database. |
| `terminals` | A list of `{ "name", "command" }`. Band opens one terminal per entry after setup succeeds. Names must be unique. |
| `teardown` | Shell command that runs before Band removes the workspace. |
| `secrets` | Names of environment variables the workspace needs. Values never go in this file and Band does not store them here. |
| `isolation` | `worktree`, `container` or `vm`. |
| `resources` | `cpu` (a number) and optional `memory` and `disk`, as sizes such as `8Gi`. |
| `services` | Names mapped to the image of a service the workspace needs, such as `"postgres": "postgres:16"`. |
| `requires` | Minimum tool versions, such as `{ "node": ">=24" }`. See below. |

## How setup runs

When a workspace is created, Band runs `install` and then `start` in a terminal tab of the workspace. It runs them as one script that stops at the first command that fails. When that script ends with exit code 0, or when there is none, Band opens the `terminals`. A failed setup leaves them closed.

On removal, Band runs `teardown` and waits for it, as it does for `teardown` in `config.json`.

The commands run on the host that owns the workspace, so a workspace on a worker runs them on the worker. Band reads the file from the workspace's worktree first and from the project checkout second, so an untracked or ignored `environment.json` in the main checkout also works.

## Relation to `.band/config.json`

`environment.json` supersedes the `setup` and `teardown` commands in `.band/config.json`.

- When a valid `environment.json` has `install` or `start`, it supplies the setup command. Otherwise Band reads `setup` from `config.json`.
- When it has `teardown`, it supplies the teardown command. Otherwise Band reads `teardown` from `config.json`.
- A file with problems is ignored and Band logs a warning, so a typo does not stop workspaces from being created. Settings > Environment and `band env validate` show the problems.

Everything else in `config.json`, such as `workspace.copyFiles`, is unchanged. A repo that has only `config.json` keeps working.

## Relation to devcontainer

Use `.devcontainer/devcontainer.json` for the toolchain when you can. It is a standard that editors and other tools understand, and its `features` install Node, Python and Docker for you. Point `build.devcontainer` at it. Use `dockerfile` or `image` when a devcontainer does not fit.

Band does not build these yet. It checks that the file exists and nothing more.

## Requires and host tools

`requires` maps a tool name to a version range. Band compares it with the versions a host reports. A worker reports its tools in its hello message and `hosts.list` returns them as `tools`. The tools are `node`, `python` (from `python3`), `go`, `pnpm`, `uv`, `docker` and `git`, and a tool that is not installed is left out. `python3` is accepted as a name in `requires`.

A range can be `>=24`, `>24`, `<=3`, `^3.12`, `~1.22.1`, `24` or `24.x`. Space separated comparators combine (`>=20 <23`), and `||` joins alternatives (`18 || >=20`). Pre-release tags are ignored.

Settings > Environment lists each host and, for one that does not meet `requires`, what is missing and the version it has. Nothing blocks a workspace on an unmet requirement yet. Choosing hosts by `requires` comes with placement.

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

The hub reads the file, so the path must exist on the hub's machine. The same check is available as `environment.validate` over tRPC, and `environment.forProject` returns a project's environment with the host check.
