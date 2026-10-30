---
title: Worktrees
description: Create, read, organize and remove worktrees, the working copies agents work in.
section: using-band
order: 30
---

A worktree is one working copy of a repo that an agent works in. For a git repo it is a git worktree on its own branch, in its own folder on a worker. Its id is `<repo>-<branch>`, with slashes in the branch turned into dashes. A worktree on a worker other than the hub's own machine adds `@<worker id>`. A plain folder has one worktree, the folder itself.

A branch has a Band worktree on at most one worker. Creating the same branch on a second worker fails and offers to open the existing one.

## Create a worktree

![The New worktree dialog](/docs/screenshots/new-worktree.png)

Click **+** on a repo header, choose **Add worktree** in the repo menu, or click **+** on a group header to create it in that group. The dialog has these fields:

- **Branch.** Spaces become hyphens and characters git forbids are removed. The dialog shows the name it will create.
- **Prompt.** Optional. Band starts the default agent with this prompt. Leave it empty to start without a task.
- **Worker.** Shown when more than one worker can take the repo. Only online workers the repo is allowed on are listed.
- **More options.** The base branch (default: the repo's default branch) and, for a worker that has no clone yet, the folder of the repo on that worker.

From the CLI:

```sh
band worktrees create atlas feat/login
band worktrees create atlas feat/login --base develop
band worktrees create atlas feat/login --prompt "Add the login form" --via chat
band worktrees create atlas feat/login --worker <worker>
band worktrees create atlas feat/login --group Payments
```

`--prompt` runs the prompt through `--via terminal` (the default, which launches the agent's CLI in a terminal tab) or `--via chat`. Use `--agent`, `--model` and `--mode` to choose the agent. `--labels`, `--requires`, `--any-worker` and `--isolation` let the hub pick a worker. See the [worktrees CLI page](/docs/cli-worktrees) and [Repo workers](repo-hosts.md).

When the worktree has a [parent](origin-links.md), Band records it. It also copies files and runs the setup script. See below.

## Copy untracked files

A new worktree has only the files git tracks. Files like `.env` are missing. Band copies them from the repo's main checkout after it creates the worktree and before it runs the setup script. Declare them in `.band/config.json`:

```json
{
  "workspace": {
    "copyFiles": [".env", "config/local.json", "certs/*.pem"]
  }
}
```

Entries are paths or glob patterns relative to the repo root. You can also list patterns in a `.worktreeinclude` file at the repo root, in `.gitignore` syntax. Band copies only files that match and that git ignores. When both exist, Band copies the union. A listed file that does not exist is skipped with a warning. The copies are regular files, so edits in the worktree do not change the main checkout.

## Setup and teardown scripts

Band runs a repo's `setup` command in a new worktree and its `teardown` command before it removes one. Define them in `.band/config.json`:

```json
{
  "setup": "pnpm install",
  "teardown": "docker compose down"
}
```

A valid `.band/environment.json` takes precedence. Its `install` and `start` scripts then run as setup and its `teardown` runs as teardown. See [Agent environments](agent-environments.md). The card shows the state of setup while it runs and if it fails. A failing teardown is logged and does not stop the removal. The card menu has **Run setup** and **Run teardown** to run them again.

## The worktree card

A card shows the worktree's title or name, with a home icon on the repo's default-branch worktree. Next to it:

- **Agent status dot.** Working, monitoring, question, done, failed or idle. See [Agent status](agent-status.md).
- **Unread mark.** A dot you set yourself. See [Groups](groups.md#unread-mark).
- **Git status.** Uncommitted changes and commits ahead or behind.
- **Pull request badge.** The pull request number, colored by CI state: red for failing, yellow for pending or running, green for passed, gray for no checks or only cancelled ones, violet for merged, struck-through gray for closed. Hover for the title and status, with "Open on GitHub" and "Copy link". Click to open the Checks tab. A branch with no pull request shows its CI icon instead, if it has checks. The badge comes from GitHub through the `gh` CLI. See [GitHub integration](github-integration.md).
- **Worker tag**, when the worktree is on a worker other than the hub's own machine.

Some icons mark a state:

| Icon | Meaning |
| --- | --- |
| Spinner | The worktree is being deleted. |
| Moon or spinner | Sleeping or waking. The worker is ephemeral and stopped while idle. See [Ephemeral workers](ephemeral-workers.md). |
| Cloud with a line | The worker is offline. The tooltip shows when it was last seen and when its last checkpoint was taken. |
| Replace arrow | Superseded. The work continued on another worker, and this copy is kept until you remove it. See [Follow the work](follow-the-work.md). |
| Red compare arrows | Diverged. This superseded copy changed after the checkpoint. Click to review. |
| Ban | The repo is no longer allowed on this worker. The worktree is kept and still opens. |
| Broken link | Missing. The worker no longer has the folder. |

A plain folder shows no git status, pull request or CI badge.

Drag a card onto another card to make it a child, or onto a group header to move it into that group. See [Groups](groups.md) and [Origin links](origin-links.md).

## Card menu

Right-click a card. Some items appear only in some cases.

| Item | What it does |
| --- | --- |
| Pin worktree or Unpin worktree | Moves the worktree to the Pinned section at the top of the sidebar. |
| Mark as read or Mark as unread | Sets or clears the unread mark. |
| Rename… | Sets a title. |
| Set parent… | Picks the worktree this one was started from. |
| Remove parent | Clears the parent. Shown when there is one. |
| Copy path | Copies the folder path. Desktop app only. |
| Open in Finder | Reveals the folder. Desktop app. |
| Run setup, Run teardown | Runs the repo's script. Shown when the repo defines it. |
| Git pull, Git push | Pulls or pushes the branch. Git repos only. |
| Open on another worker… | Moves the worktree to another worker, or continues it from its last checkpoint when its worker is offline. Disabled with a reason when nothing qualifies. Shown for a worktree on a worker other than the hub's own machine. |
| Remove this copy | Deletes a superseded copy's files after a confirmation. |
| Review changes made after the checkpoint | Opens the comparison for a diverged copy. |
| Remove missing worktree | Drops the record of a worktree whose folder is gone. |
| Delete worktree | Removes the worktree. Not shown for the default branch or for a plain folder. |

## Remove a worktree

Choose **Delete worktree**, or run:

```sh
band worktrees remove atlas feat/login
band worktrees remove atlas feat/login --worker <worker>
```

Band runs the teardown script first, then removes the worktree folder and deletes the local branch. If the branch is not merged, has unpushed commits or has uncommitted changes, a dialog lists these and asks you to confirm. `--worker` is needed when the same repo and name exist on more than one worker. Removing a worktree on an offline worker removes it from the hub at once. The worker deletes the folder when it reconnects.
