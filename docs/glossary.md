# Glossary

## Repo

One repository that Band knows about, registered with `band repos add` or the Add repo dialog. A repo is either `git` (it has a `.git` directory) or `plain` (a folder with no git). The name is unique and is the folder's base name by default.

In the API a repo is `repos.*`, in the database the `repos` table, and in the CLI `band repos`.

## Worktree

One working copy of a repo that an agent and a user work in. Its id is `<repo>-<branch>`, for example `band-feat-login`. A worktree has chats, terminals, browser tabs and a git status.

For a git repo a worktree is a git worktree created with `git worktree add`, and the id's branch is the branch it was created on. Two cases use the word without being a git worktree:

- A plain (non-git) repo has one implicit worktree, the folder itself. It has no branch isolation and no git features.
- The combined multi-repo root planned for Phase 6 is one directory that holds several repos side by side. Its single agent works with that directory as its worktree.

In the API a worktree is `worktrees.*`, in the CLI `band worktrees`, and in an agent's environment `BAND_WORKTREE_ID`.

## Project

Reserved for the cross-repo unit planned for Phase 6: a body of work across several repos with its own context repo. Nothing in the code uses it yet.

## Terms that kept their names

- `.band/config.json` still reads `workspace.copyFiles`, `workspace.defaultVia` and `workspace.terminal`. The format of a file in a user's repo is not renamed.
- Claude Code stores transcripts under `~/.claude/projects`. That directory belongs to Claude, so Band reads it by that name.
- A pnpm workspace is a package of this monorepo and has nothing to do with a Band worktree.
