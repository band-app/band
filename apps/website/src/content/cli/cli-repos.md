---
title: band repos
description: Register repos by path, remote URL or worker folder, and set which workers a repo may use.
section: cli
order: 20
commands: [repos]
---

A repo is one registered repository, or a plain folder. `band repos` adds repos to the hub, lists them and changes how they are placed on workers. Worktrees are covered in [band worktrees](/docs/cli-worktrees).

## Ways to add a repo

`repos add` has three forms. Pass exactly one.

- **A path on the hub's machine.** `band repos add ~/code/my-app`. The path can be a git repository or a plain folder. A plain folder gets kind `plain` in `repos list`.
- **A remote URL.** `band repos add --url <url>`. The hub stores the URL without credentials. A worker clones it the first time a worktree lands there. Without `--branch`, the hub asks the remote for its default branch.
- **A folder on a worker.** `band repos add --from <worker> <path>`. The hub inspects the folder on that worker and records the repo and its location there. A folder outside the worker's roots is refused until you repeat the command with `--add-root`, which serves the folder from that worker after you confirmed it. Find worker ids with `band workers list`.

`--url` refuses a remote that another repo already uses. `--from` records the folder on the repo that already has that remote.

All three forms print the repo name. With `--output json` they print `{"name", "path", "remoteUrl"}`.

```sh
band repos add ~/code/my-app
band repos add --url https://github.com/acme/my-app.git --branch main
band repos add --from my-laptop ~/code/my-app
band repos add --from my-laptop ~/elsewhere/my-app --add-root
```

## Listing repos

```sh
band repos list
```

```text
NAME    PATH               WORKTREES    KIND  URL                                   CLONES                   WORKERS  CHECKPOINTS
my-app  /Users/me/my-app   3 worktrees  git   https://github.com/acme/my-app.git    h-3f2a9c1d7b04:/srv/app  all      -
```

| Column | Meaning |
| --- | --- |
| `NAME` | The repo name. Other commands take it as `<repo>`. |
| `PATH` | The checkout on the hub's machine. Empty when the hub holds none. |
| `WORKTREES` | Number of worktrees. |
| `KIND` | `git` or `plain`. |
| `URL` | The remote URL, or `-`. |
| `CLONES` | Where workers hold the repo, as `<worker id>:<path>` separated by commas, or `-`. |
| `WORKERS` | Worker ids the repo is limited to, or `all`. |
| `CHECKPOINTS` | `on`, `off`, or `-` when the default applies. |

JSON output has one object per repo:

```json
{"repos":[{"name":"my-app","path":"/Users/me/my-app","kind":"git","worktreeCount":3,"remoteUrl":"https://github.com/acme/my-app.git","clones":[],"allowedHostIds":null,"primaryHostId":null,"checkpointsEnabled":null,"autoContinue":null}]}
```

`allowedHostIds` is `null` for all workers, otherwise a list of worker ids.

## Limiting a repo to workers

`repos set` changes placement and recovery settings. It needs at least one flag, and some of them need an admin token.

- `--workers a,b` limits the repo to those workers. Use ids or names. `--workers all` lifts the limit.
- `--primary <worker>` picks the worker that lists the repo's default-branch worktree. `--primary auto` lets the hub choose.
- `--checkpoints on|off|default` controls whether the hub keeps checkpoints of the repo's worktrees. By default a repo with no worker limit gets checkpoints and a limited repo does not.
- `--auto-continue on|off` controls whether a worktree on an offline worker continues on another one without asking.

`set` prints one line per change.

```sh
band repos set my-app --workers my-laptop,build-box --primary my-laptop
band repos set my-app --checkpoints on
band repos set my-app --workers all
```

See [Repo workers](/docs/repo-hosts) and [Checkpoints](/docs/checkpoints).

## Removing a repo

```sh
band repos remove my-app
```

This unregisters the repo. It prints nothing in text mode and `{"ok":true}` in JSON mode.
