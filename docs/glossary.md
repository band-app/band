# Glossary

## Repo

One repository that Band knows about, registered with `band repos add` or the Add repo dialog. The hub identifies a repo by its remote URL (the `origin` URL without credentials) and its default branch, and it keeps no folder of its own for it. A repo is either `git` or `plain` (a folder with no git). The name is unique. It is the repository name from the URL, or the folder's base name for a repo with no remote.

A plain folder and a repo with no remote have no URL to clone from. They belong to the one worker that holds them, and a worktree for them can only run there.

In the API a repo is `repos.*`, in the database the `repos` table, and in the CLI `band repos`.

## Worker

A computer connected to the hub that runs worktrees and agents, static or started on demand by a runner. The hub's own machine is a built-in worker (the id `local`), shown as "This Mac" in desktop local mode. In code a worker is a `Host`: the `Host` interface, `HostRegistry`, `hostId`, the `hosts` table, `packages/host-*` and the `@h-...` worktree ids keep the word. The program is `band-worker` (`apps/worker`).

A **runner** is a recipe that starts workers on demand. Settings > Runners lists the "Workers started" by each one, with the cloud handle as a detail. See `docs/runner-hooks.md`.

In the API a worker is `workers.*` (`hosts.*` is an alias), and in the CLI `band workers`.

## Renamed names and their aliases

The concept was called a host. The names people type moved to "worker", and the old names still work.

| Old name | New name | Where |
| --- | --- | --- |
| `hosts.*` | `workers.*` | tRPC. Both routers answer with the same procedures and the same admin and relay rules. |
| `band hosts ...` | `band workers ...` | CLI. The old command is hidden from `--help`. |
| `--hosts` | `--workers` | `band repos set` |
| `--host-repo-path` | `--worker-repo-path` | `band worktrees create` |
| `--add-host` | `--add-worker` | `band worktrees move`, `restore`, `band workers evacuate` |
| `--any-host` | `--any-worker` | `band worktrees create` |
| `--host` | `--worker` | `band worktrees create`, `remove`, `set-origin`, `continue` |
| `BAND_LOCAL_HOST` | `BAND_LOCAL_WORKER` | Hub: whether the hub's own machine runs worktrees |
| `BAND_DEFAULT_HOST` | `BAND_DEFAULT_WORKER` | Hub: the worker used when a worktree names none |
| `BAND_HOST_REPO_PATH` | `BAND_WORKER_REPO_PATH` | Line a runner hook prints for the repository path |
| `BAND_HOST_LABELS` | `BAND_WORKER_LABELS` | Provisioning script environment (the script exports both) |
| `BAND_HOST_ID` | `BAND_WORKER_ID` | Read by `band notify`. Runner hooks get both with the same value. |

When both a new and an old environment variable are set, the new one wins. `band-worker` itself reads only `BAND_WORKER_*`, as it did before the rename. A `BAND_LOCAL_WORKER` value that is neither an off spelling (`off`, `false`, `0`) nor an on spelling (`on`, `true`, `1`) counts as off, and the hub logs a warning.

The web, mobile and CLI clients call `workers.*`, so they need a hub that has the `workers` router (the release that introduces it). They have no fallback to `hosts.*` against an older hub. Wire fields such as `hostId`, `hostRepoPath` and `allowedHostIds` and the database columns keep their names.

The old names stay for at least two releases. Removal is planned for no earlier than two releases after the one that introduces `workers.*`.

## Repo mapping

Each worker (the hub's own machine and every remote worker) keeps its own table from a normalized remote URL to a folder. `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r` are one key. When a worktree lands on a worker, the worker uses the mapped folder if it exists, and otherwise clones the repo to `~/band/repos/<owner>/<name>` (`--repos-dir` or `BAND_REPOS_DIR` change that) and records the folder. A worker keeps its table in `<state dir>/repos.json`. The hub's `repo_hosts` table is a cache of what the workers report, refreshed when a worker connects and after each call the hub makes.

Adding a repo from a worker's folder picker records that folder in the worker's table, so the worker never clones it again.

## Allowed workers and primary worker

A repo can be limited to some workers (`repos.allowed_host_ids`, `null` for all). Band refuses to create a worktree, clone or placement for it anywhere else. Only the primary worker (`repos.primary_host_id`) lists the repo's default-branch worktree. See `docs/repo-hosts.md`.

## Worktree

One working copy of a repo that an agent and a user work in. Its id is `<repo>-<branch>`, for example `band-feat-login`. A worktree has chats, terminals, browser tabs and a git status. A branch has a worktree on one worker only.

For a git repo a worktree is a git worktree created with `git worktree add`, and the id's branch is the branch it was created on. A plain (non-git) repo uses the word without a git worktree: it has one implicit worktree, the folder itself, with no branch isolation and no git features.

A worktree can have a title, at most 100 characters, that the sidebar and pickers show in place of its name (`worktrees.setTitle`, `band worktrees rename`). The id, the folder and the branch do not change, and clearing the title brings the name back.

In the API a worktree is `worktrees.*`, in the CLI `band worktrees`, and in an agent's environment `BAND_WORKTREE_ID`.

## Origin link

The record on a worktree of where it was started from: the origin worktree, and the chat or terminal in it. The origin can be on any repo and worker. A worktree started from the UI has no origin unless the user picks one. A worktree whose origin was deleted keeps the ids and reports its origin as removed. See `docs/origin-links.md`.

## Projects (removed)

Band had projects: a cross-repo body of work with a context repo, a project folder on each worker and a coordinator chat. They were removed in favour of origin links, where a chat started from another chat records where it came from (see the implementation plan, section 15). There is no `projects.*` API, `band projects` command or project settings. Claude Code's own `~/.claude/projects` directory is unrelated.

## Terms that kept their names

- `.band/config.json` still reads `workspace.copyFiles`, `workspace.defaultVia` and `workspace.terminal`. The format of a file in a user's repo is not renamed.
- Claude Code stores transcripts under `~/.claude/projects`. That directory belongs to Claude, so Band reads it by that name.
- A pnpm workspace is a package of this monorepo and has nothing to do with a Band worktree.

A **checkpoint** is the hub's own copy of a worktree on a static worker, taken after an agent turn, after quiet files and on a clean worker shutdown. It keeps the work readable when the worker is offline and lets it be restored on another worker. A copy replaced by a restore is **superseded**. See `docs/checkpoints.md`.

**Follow the work** is continuing a worktree on another allowed worker from its latest checkpoint when its worker is offline, on request or automatically for a repo that opts in. The copy left behind is superseded, and flagged diverged when its worker returns with changes the checkpoint lacks. See `docs/follow-the-work.md`.
