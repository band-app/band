# Glossary

## Repo

One repository that Band knows about, registered with `band repos add` or the Add repo dialog. The hub identifies a repo by its remote URL (the `origin` URL without credentials) and its default branch, and it keeps no folder of its own for it. A repo is either `git` or `plain` (a folder with no git). The name is unique. It is the repository name from the URL, or the folder's base name for a repo with no remote.

A plain folder and a repo with no remote have no URL to clone from. They belong to the one host that holds them, and a worktree for them can only run there.

In the API a repo is `repos.*`, in the database the `repos` table, and in the CLI `band repos`.

## Repo mapping

Each host (the hub's own machine and every worker) keeps its own table from a normalized remote URL to a folder. `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r` are one key. When a worktree lands on a host, the host uses the mapped folder if it exists, and otherwise clones the repo to `~/band/repos/<owner>/<name>` (`--repos-dir` or `BAND_REPOS_DIR` change that) and records the folder. A worker keeps its table in `<state dir>/repos.json`. The hub's `repo_hosts` table is a cache of what the workers report, refreshed when a worker connects and after each call the hub makes.

Adding a repo from a worker's folder picker records that folder in the worker's table, so the worker never clones it again.

## Worktree

One working copy of a repo that an agent and a user work in. Its id is `<repo>-<branch>`, for example `band-feat-login`. A worktree has chats, terminals, browser tabs and a git status.

For a git repo a worktree is a git worktree created with `git worktree add`, and the id's branch is the branch it was created on. Two cases use the word without being a git worktree:

- A plain (non-git) repo has one implicit worktree, the folder itself. It has no branch isolation and no git features.
- The combined multi-repo root planned for Phase 6 is one directory that holds several repos side by side. Its single agent works with that directory as its worktree.

In the API a worktree is `worktrees.*`, in the CLI `band worktrees`, and in an agent's environment `BAND_WORKTREE_ID`.

## Project

A body of work across several repos. A project is a meta repo that lives on the hub: its context repo, which every agent of the project reads from and writes to. The hub holds the master copy, and a linked remote such as GitHub is an optional backup. A repo may belong to a project or to none, and a hub has no default project.

- The **project folder** is `<BAND_HOME>/projects/<project>/`, the working copy of the context repo. It exists on the hub and on every host doing the project's work: the coordinator's host and each host running an agent of the project. Its files sync in the background, so an edit from an agent, the UI or a terminal reaches the hub and the other hosts without anyone pushing or pulling.
- The coordinator is a project-level chat. It runs in the project folder on a host that has every repo of the project cloned. In the API its chats have a `projectId` and no `worktreeId`, and in an agent's environment it gets `BAND_PROJECT_ID` instead of `BAND_WORKTREE_ID`.

## Task

A worktree in a project that the coordinator started for one piece of work. A task covers one repo and runs one agent. Work that spans several repos is several worktrees, each with its own agent, which the coordinator manages. A task needs no API of its own: it is a worktree with a `projectId` (`worktrees.*`, `band worktrees create --project`).

## Terms that kept their names

- `.band/config.json` still reads `workspace.copyFiles`, `workspace.defaultVia` and `workspace.terminal`. The format of a file in a user's repo is not renamed.
- Claude Code stores transcripts under `~/.claude/projects`. That directory belongs to Claude, so Band reads it by that name.
- A pnpm workspace is a package of this monorepo and has nothing to do with a Band worktree.
