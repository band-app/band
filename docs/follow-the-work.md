---
title: Follow the work
description: Continue a worktree on another worker from its latest checkpoint when its own worker is offline.
section: workers
order: 55
---

When a worktree's worker is offline and you need a live worker, Band offers to continue the worktree on another allowed worker from the hub's latest [checkpoint](checkpoints.md). A repo can opt in to doing this without asking. When the original worker comes back, Band keeps its copy and compares it with the checkpoint, so nothing it did while it was away is lost.

## What triggers it

These actions need a live worker. On a worktree whose worker is offline, each one starts the offer:

- sending a chat message,
- opening a terminal,
- starting an agent.

Reading never triggers it. The diff, the files and the chat history of an offline worktree come from the checkpoint, as [offline worktrees](checkpoints.md#offline-worktrees) describe. A worktree on an [ephemeral worker](ephemeral-workers.md) gets no offer, because it sleeps and wakes instead.

## The prompt

The chat shows a dialog titled "Open on another worker":

> `<worker>` is offline. Continue on `<target>` from the checkpoint taken `<age>` ago?

The "Continue on" list holds the online workers the repo may run on. Band recommends one in this order:

1. A worker that already has a clone of the repo.
2. A worker where the chat's agent is installed and logged in.
3. The worker with the fewest worktrees.

A worker where the agent cannot start is listed with the reason, and you cannot choose it.

The dialog also says what does not carry over:

- Ignored files (`node_modules`, build output, `.env`) are not carried over.
- Running processes and open terminals are not carried over.
- The repo's setup runs on the new copy, if the repo has one.

When you accept, Band restores the checkpoint (see [Restore on another worker](checkpoints.md#restore-on-another-worker)) and the chat sends your message again to the new worktree. The agent session resumes where it left off.

From the CLI:

```sh
band worktrees continue <id>
band worktrees continue <id> --to <worker>
```

Without `--to`, Band uses the worker it recommends. The command prints the new worktree id. A worktree whose worker is online is refused. Use `band worktrees move` for that case.

## What happens when you accept

The branch, the uncommitted and untracked files, the agent sessions, and the chats, terminal records, tasks and subscriptions move to the new worktree, whose id is `<repo>-<branch>@<worker>`. Then:

1. The new copy records where it came from. Its sidebar card shows an icon with the tooltip "Continued from `<worker>`", the reason (`manual` or `auto`) and the checkpoint age.
2. The repo's setup runs on the new copy, as it does for a new worktree.
3. The old copy stays where it is, marked superseded.

## Continue automatically

Turn on "Continue on another worker automatically" in Settings > Repos, on the repo's page. This is an admin setting and it is off by default. From the CLI:

```sh
band repos set <repo> --auto-continue on
```

With it on, the action goes through without a prompt when the checkpoint is younger than 30 minutes. The chat shows a notice. An older checkpoint always asks. `BAND_AUTO_CONTINUE_MAX_AGE_MS` in the hub's environment changes the limit.

## When it is not possible

The dialog then reads "Cannot continue elsewhere" and gives the reason:

| Reason | What to do |
| --- | --- |
| The repo is limited to the offline worker (`<repo> is only available on <worker>`). | Bring the worker back, or allow another worker in Settings > Repos. |
| Checkpoints are off for the repo. | Bring the worker back, or turn checkpoints on. |
| The hub has no checkpoint yet. | Bring the worker back. |
| No other worker the repo may run on is online. | Bring a worker online. |
| The old worker's lease is still running (see below). | Wait. The button shows a countdown. |
| The agent is not available on any other worker. | Install the agent and log in on another worker, for example when Codex is installed only on the offline one. |

`band worktrees continue` prints the same text.

## The old worker's lease

Band must not run the same worktree on two workers at once. Each worker holds a lease from the hub, 5 minutes by default. While the link is up, the hub renews the lease. A worker whose lease runs out stops its agents, terminals, run scripts and language servers, and starts nothing new until the hub renews. A worker cannot tell "the hub is down" from "my network is down", so both stop it.

After everything has stopped, the worker saves each of its worktrees as a local commit under `refs/band/fenced/<folder>`. Band never uploads that commit and never stores it as a checkpoint, so the hub's checkpoints always come from a worktree's current owner. Files on disk are not touched.

The offer is blocked until the lease the hub could last have granted to the offline worker is over. This holds when the hub itself was down. The button in the worktree's notice is disabled with a countdown, and `band worktrees continue` and `restore` refuse with the time left. Set the length with `BAND_WORKER_LEASE_MS` in the hub's environment.

When the worker returns, the hub tells it which folders were continued elsewhere. It starts nothing in them, so a superseded copy stays stopped. The other worktrees on it start again. A worker too old to know leases is not held back.

## When the target already has a copy

The checkpoint wins. If the target holds an older superseded copy, a checkout of the branch, or (for the default branch) its own checkout of the repo with local changes, the continuation replaces it with the checkpoint's files. Band saves what the target held first:

- `refs/band/backup/<new worktree id>/<time>` in the target's repo is a commit of the folder as it was, with uncommitted and untracked files.
- `refs/band/backup/<new worktree id>/<time>-branch` keeps the tip of the target's branch when it had commits that the checkpoint lacks.

Nothing else is deleted. Band does not replace a live worktree of the same branch on the target.

## The default branch

A worker's default-branch worktree is the repo's own folder, and other worktrees depend on it. You can open it on another worker when its worker is offline. You can also move it while its worker is online and the folder is idle. A move is refused while the folder has a running agent, a queued message or a terminal.

On the target, Band backs up the repo's checkout as above, puts it on the checkpoint's commit and applies the checkpoint's changes. The source folder stays in place, superseded and untouched. Discarding the old copy does not remove the folder. It resets the default branch to the latest of its remote (local changes and untracked files are dropped, ignored files stay), and the folder is the repo's checkout again.

## When the original worker comes back

When the worker connects, the hub compares the working tree of each superseded copy on it with the checkpoint the continuation used. If the tree differs, the copy is flagged as diverged. Its card shows a panel that lists the files that differ, with the diff of each. Two actions settle it:

- "Bring these changes over" builds a patch of what the old copy changed since the checkpoint and applies it to the new copy. A patch that does not apply cleanly changes nothing and lists the conflicting files, so you can resolve them by hand. A clean apply marks the old copy resolved.
- "Discard old copy" removes the old worktree and its files on the old worker. Band asks first. A diverged copy asks a second time, shows the diff and gives the number of files you would lose. A copy whose changes you brought over needs only the first confirmation, until it changes again. If the old worker is offline, the removal runs when it next connects.

Until you settle it, the old copy stays on disk and takes no checkpoints.

## Limits

- Work since the last checkpoint is lost with the offline worker, unless the worker comes back and you bring it over. A worker that stops cleanly takes a checkpoint first.
- The hub's own machine (the worker `local`) is never a source or a target.
- The target needs the repo. For a repo with a remote URL, the hub clones it there. A repo with no remote can only continue on a worker that already holds it.
- Ignored files and running processes are not carried over.
- Edits made on the old worker's disk outside Band, after its lease ran out, are caught by the comparison when the worker returns. Band does not prevent them.
- A worktree on the hub's own machine is out of scope. When that machine is down, the whole UI is.
- Agents cannot use this feature.
