---
title: Checkpoints
description: How the hub keeps a copy of each worktree on a worker, so you can read it while the worker is offline and restore or move it to another worker.
section: workers
order: 50
---

The hub keeps recent checkpoints of every worktree that runs on a static worker. When the worker goes offline, the work stays readable from the hub. You can restore the worktree on another allowed worker, or move it while its worker is still online.

A checkpoint is a snapshot of the working tree. Your branch, its index and your files stay as they are while the snapshot is taken. The hub stores checkpoints on its own disk. Band never pushes one to origin.

## What a checkpoint holds

- The working tree on top of the branch head: tracked edits and untracked files that `.gitignore` does not hide.
- The commits and objects that the worker's remotes lack, so a checkpoint of a pushed branch is small. A worktree with no unpushed work and no edits stores nothing extra.
- The session files of each chat's agent, so the chat can resume on another machine.

A checkpoint does not carry ignored files (`node_modules`, build output), running processes, terminals or anything an agent keeps only in memory.

## When the hub takes one

| Trigger | When |
| --- | --- |
| `turn` | An agent turn ended in the worktree. |
| `quiet` | The files differ from the last checkpoint and have not changed for 3 minutes. |
| `shutdown` | A worker stops cleanly. The worker tells the hub first and waits up to 30 seconds. |
| `move` | A move takes a fresh one first. |
| `manual` | You run `band worktrees checkpoints <id> --take`. |

The hub stores nothing when the working tree, the branch head and the agent sessions match the newest checkpoint. It skips [ephemeral workers](ephemeral-workers.md), because their sleep already stores the worktree. Worktrees on the hub's own machine (the worker `local`) have no checkpoints.

List the checkpoints of a worktree, and take one first if you want:

```sh
band worktrees checkpoints <id>
band worktrees checkpoints <id> --take
```

## The per-repo setting

Turn checkpoints on or off in Settings > Repos, with "Checkpoints on the hub" on the repo's page. This is an admin setting. From the CLI:

```sh
band repos set <repo> --checkpoints on
band repos set <repo> --checkpoints off
band repos set <repo> --checkpoints default
```

- The default for a repo available on all workers is on.
- The default for a repo limited to chosen workers is off. Limiting a repo usually means its code must stay off other machines. See [Repo workers](repo-hosts.md).

When the setting is off, the hub stores nothing for the repo. Turning it on starts checkpoints at the next trigger. Turning it off stops new ones but keeps the existing ones. Remove the worktree to delete them.

## Offline worktrees

When a worktree's worker is offline, its card in the sidebar fades and shows an offline icon. The tooltip gives the time the worker was last seen and the age of the last checkpoint, or "No checkpoint".

Opening the worktree shows a notice above it. It names the worker, says when the last checkpoint was taken, and offers an "Open on another worker" button (see [Follow the work](follow-the-work.md)). When Band cannot offer that, the notice shows the reason instead of the button.

The notice also has a "View checkpoint (read-only)" link. The checkpoint view shows:

- Changes: the diff of the checkpoint against its branch head.
- Files: the files as the checkpoint holds them.
- Chat history: the chat log is on the hub already, so it works as before.

Terminals, the desktop, dev servers and the browser need the worker, and show "worker offline". To build the view, the hub first fetches the repo's history from its own checkout or from the remote URL, because a checkpoint holds only what the remotes lack. If the hub can reach neither, the view fails and says so.

## Restore on another worker

Restoring uses the newest checkpoint, or the one you name:

```sh
band worktrees restore <id> --to <worker>
band worktrees restore <id> --to <worker> --checkpoint <checkpoint-id>
```

The target worker must be online and allowed for the repo. If it is not allowed, the call fails with `<repo> is only available on ...`. An admin can add the worker in the same call with `--add-worker` (a checkbox in the dialog).

Restoring does this:

1. It makes sure the target has the repo, then creates the worktree on the branch and puts back the uncommitted and untracked files.
2. It compares the restored files with the checkpoint. If they differ, it removes only what it created and fails.
3. It writes the agent session files on the target. The next message in each chat resumes the session.
4. It moves the chats, terminal records, tasks, cron jobs, subscriptions and browser history to the new worktree. The new worktree id is `<repo>-<branch>@<worker id>`.

The old copy stays where it is and is marked superseded. Band takes no checkpoints of a superseded copy. Its card shows a superseded icon, and its files are untouched until you choose "Remove this copy" in the card's context menu. That is the only step that deletes files on the old worker.

If the target already holds a copy under that name, the checkpoint replaces it, and Band keeps the old state under `refs/band/backup/<worktree id>/<time>` in the target's repo. When the worktree is the repo's default branch, its new worker becomes the repo's primary worker.

If a repo has no remote URL, the target must already hold the repo.

## Move to a worker

Moving is for a worktree whose worker is online:

```sh
band worktrees move <id> --to <worker>
```

1. The hub takes a fresh checkpoint, even for a repo with checkpoints off. It deletes that checkpoint afterwards.
2. It restores the checkpoint on the target.
3. It removes the source worktree, but only after the target holds the same files. If the removal fails, the result carries a warning and the old copy stays listed as superseded.

In the sidebar, "Open on another worker…" in the worktree card's menu does a move while the worker is online. The item is disabled, with the reason shown, when the hub has no checkpoint or when the repo is limited to that one worker.

To empty a worker, use "Move all worktrees on this worker…" in Settings > Workers (admin), or:

```sh
band workers evacuate <worker> --to <other-worker>
```

It moves each worktree in turn and prints a summary. One failure does not stop the rest. It does not move a repo's own clone. An offline source worker restores from its last checkpoints and leaves its copies superseded.

## Limits

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `BAND_CHECKPOINT_KEEP` | 5 | Checkpoints kept per worktree. The oldest go first. |
| `BAND_CHECKPOINT_MAX_BYTES` | 200 MB | Size limit per worktree. A checkpoint above it is skipped and `band worktrees checkpoints <id>` prints a warning. The hub also drops older checkpoints while the kept ones exceed it. |
| `BAND_CHECKPOINT_QUIET_MS` | 180000 | How long files stay unchanged before the `quiet` trigger. |
| `BAND_CHECKPOINT_POLL_MS` | 60000 | How often the hub looks for quiet worktrees. |

Set these in the hub's environment.

## Permissions

Any device token can read checkpoints, restore and move. Adding a worker to a repo, changing the setting and evacuating a worker need an admin token. Agents cannot use checkpoints, so an agent cannot move work between workers.

## Details

- A hub only stores a checkpoint for the worktree's current owner: the copy is not superseded and it lives on the worker that sent the snapshot. The hub checks this when a checkpoint starts and again before it writes it, so a late shutdown checkpoint that races a continuation is rejected. A worker whose lease ran out snapshots locally and uploads nothing (see [Follow the work](follow-the-work.md#the-old-workers-lease)).
- Session files are re-homed on restore. Claude's session file moves under the new worktree path, and the recorded working directory is rewritten in Claude and Codex files, so the session resumes.
- A chat that the old worker ran itself ([chat ownership](chat-ownership.md)) leaves it. The new worker runs it if it owns chats, otherwise the hub does.
- Checkpoint files are under `<BAND_HOME>/checkpoints/<worktree id>/<checkpoint id>/`.
