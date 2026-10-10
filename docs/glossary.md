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

For a git repo a worktree is a git worktree created with `git worktree add`, and the id's branch is the branch it was created on. A plain (non-git) repo uses the word without a git worktree: it has one implicit worktree, the folder itself, with no branch isolation and no git features.

In the API a worktree is `worktrees.*`, in the CLI `band worktrees`, and in an agent's environment `BAND_WORKTREE_ID`.

## Projects (removed)

Band had projects: a cross-repo body of work with a context repo, a project folder on each host and a coordinator chat. They were removed in favour of origin links, where a chat started from another chat records where it came from (see the implementation plan, section 15). There is no `projects.*` API, `band projects` command or project settings. Claude Code's own `~/.claude/projects` directory is unrelated.

## Terms that kept their names

- `.band/config.json` still reads `workspace.copyFiles`, `workspace.defaultVia` and `workspace.terminal`. The format of a file in a user's repo is not renamed.
- Claude Code stores transcripts under `~/.claude/projects`. That directory belongs to Claude, so Band reads it by that name.
- A pnpm workspace is a package of this monorepo and has nothing to do with a Band worktree.
