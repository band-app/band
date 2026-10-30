---
title: band worktrees
description: Create, list, move, group, rename and remove worktrees from the command line.
section: cli
order: 30
commands: [worktrees]
---

A worktree is one working copy of a repo that an agent works in. Its id is `<repo>-<branch>`, with slashes in the branch turned into dashes, and ends in `@<worker-id>` when the worktree is on a worker other than `local`. `band worktrees` creates and lists them and changes where they live. For the idea behind them, see [Worktrees](/docs/worktrees).

## Creating a worktree

`create` takes a repo name and a branch name. The branch is created from `--base`, or from the repo's default branch.

```sh
band worktrees create my-app feat/login
band worktrees create my-app fix/crash --base release
```

In text mode it prints the worktree's path. With `--output json` it prints `{"path": ..., "via": ..., "terminalId": ...}`. `via` and `terminalId` appear only when a prompt started an agent.

### Starting an agent with a prompt

`--prompt` starts a coding agent in the new worktree. `--agent`, `--model` and `--mode` choose which agent, model and mode (such as `plan` or `edit`). Without them the hub uses its defaults.

`--via` chooses where the prompt goes. `terminal` runs the agent's own CLI in a new terminal. `chat` sends the prompt to the worktree's chat. From the CLI the default is `terminal`, which differs from the web app. The CLI picks the first of these that is set:

1. the `--via` flag
2. the `BAND_DISPATCH` environment variable
3. `workspace.defaultVia` in the repo's `.band/config.json`
4. `cli.defaultVia` in `~/.band/settings.json`
5. `terminal`

```sh
band worktrees create my-app feat/login --prompt "Add a login form" --via chat
band worktrees create my-app feat/login --prompt "Add a login form" --agent claude-code --mode plan
```

### Choosing a worker

Without a placement flag, the worktree goes where the command runs. A command run by an agent on a worker creates on that worker.

- `--worker <worker>` creates it on one worker, by id or name. It cannot be combined with the placement flags below.
- `--labels k=v,k=v` picks an online worker that has all of these labels.
- `--requires node=>=24` picks a worker whose facts match. Repeat the flag for more than one. A plain `os=linux` needs an exact match.
- `--any-worker` picks any online worker.
- `--isolation worktree|container|vm` sets how strongly the worktree is separated. `container` and `vm` need a runner that offers that level.
- `--worker-repo-path <path>` says where the repo is on the chosen worker. It is needed the first time the repo is used on that worker.

When no online worker matches, Band waits for a runner to provide one. The command prints `provisioning (worker request <id>)` and returns, and the worktree appears when the worker connects. See [Runner hooks](/docs/runner-hooks).

```sh
band worktrees create my-app feat/login --worker build-box --worker-repo-path ~/code/my-app
band worktrees create my-app feat/login --labels gpu=true --requires node=">=24"
band worktrees create my-app feat/login --isolation container
```

### Origin and group

A worktree can record the worktree it was started from. Inside a Band terminal or agent the origin defaults to the current worktree (`BAND_WORKTREE_ID`). `--origin <worktree id>` names another one. `--no-origin` records none.

`--group <group>` puts the new worktree in a group, by id or name. Without it the worktree joins its origin's group, if it has one. See [Groups](/docs/cli-groups) and [Origin links](/docs/origin-links).

## Listing worktrees

```sh
band worktrees list
band worktrees list my-app
```

```text
REPO    BRANCH      TITLE          WORKTREE ID                        PATH                                          ORIGIN
my-app  main        -              my-app-main                        /Users/me/my-app                              -
my-app  feat/login  Login screen   my-app-feat-login (unread)         /Users/me/.band/worktrees/my-app/feat-login   my-app-main
```

| Column | Meaning |
| --- | --- |
| `REPO`, `BRANCH` | The repo and the branch. |
| `TITLE` | The title set with `rename`, or `-`. |
| `WORKTREE ID` | The id other commands take. Adds `(unread)` when marked unread, and `(superseded by <id>)` when a move or restore left this copy behind. |
| `PATH` | The folder, on the worker that holds it. |
| `ORIGIN` | The origin worktree id, `<id> (removed)` when that worktree is gone, or `-`. |

A repo name that does not exist is an error. A repo with no worktrees prints nothing.

JSON output has `repo`, `branch`, `worktreeId`, `title`, `path`, `supersededBy`, `origin`, `groupId`, `unread` and `children` for each worktree, under a `worktrees` key.

## Moving a worktree between workers

Three commands put a worktree on another worker. They differ in how they treat the source worker.

- `move <id> --to <worker>` works while the source worker is online. It takes a fresh checkpoint, restores it on the target, checks the result and then removes the source.
- `continue <id>` works when the source worker is offline. It restores the latest checkpoint on the worker the hub recommends, or on `--to`. The old copy stays and is marked superseded.
- `restore <id> --to <worker>` restores a checkpoint on the worker you name. It uses the newest checkpoint unless you pass `--checkpoint <id>`. The old copy stays, superseded.

When the target is not in the repo's allowed workers, add `--add-worker`. It needs an admin token.

```sh
band worktrees move my-app-feat-login --to build-box
band worktrees continue my-app-feat-login@h-3f2a9c1d7b04
band worktrees restore my-app-feat-login --to build-box --checkpoint <checkpoint-id>
```

`checkpoints <id>` lists the hub's checkpoints of a worktree. `--take` makes a new one first.

```sh
band worktrees checkpoints my-app-feat-login --take
```

```text
Checkpoint created
ID            TAKEN       TRIGGER  SIZE    TREE   BRANCH
cp-8e41a0b2   2m ago      manual   14 KB   dirty  feat/login
```

See [Checkpoints](/docs/checkpoints) and [Follow the work](/docs/follow-the-work).

## Organizing worktrees

- `set-group <id> <group>` moves a worktree into a group. `--none` takes it out. `--with-children` also moves every worktree started from this one, and theirs in turn.
- `set-origin <repo> <name> --origin <id>` sets the parent. `--none` removes it. Add `--worker <id>` when the worktree is not on `local`.
- `rename <id> "New title"` sets a title that the sidebar shows in place of the name. `--clear` removes it.
- `mark-unread <id>` and `mark-read <id>` set or clear the unread dot on every device. `mark-read` also clears a done or failed dot.

```sh
band worktrees set-group my-app-feat-login Reviews
band worktrees set-origin my-app feat/login --origin my-app-main
band worktrees rename my-app-feat-login "Login screen"
band worktrees mark-unread my-app-feat-login
```

## Removing a worktree

`remove` takes the repo name and the worktree name, which is the branch it was created on. Add `--worker <id>` when the same repo and name exist on more than one worker.

```sh
band worktrees remove my-app feat/login
```

Text mode prints nothing on success.
