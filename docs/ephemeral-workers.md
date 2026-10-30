---
title: Ephemeral workers
description: Workers that a runner starts on demand put their worktrees to sleep when idle and wake them on the next use.
section: workers
order: 60
---

A worktree on a worker that a [runner](runner-hooks.md) started behaves like one on a machine that stays up. When the worker has been idle for a while, the hub stores the worktree and the worker exits. The next chat message, terminal or file access for that worktree starts a new worker, restores the worktree and resumes the chat.

Workers that stay up get [checkpoints](checkpoints.md) instead of sleep.

## States

| State | What it means |
| --- | --- |
| running | A worker is online and serves the worktree. The card shows no extra label. |
| sleeping | The worker exited after the hub stored the worktree. The worktree card shows "Sleeping". |
| waking | A request for a new worker is open, or the new worker is restoring the worktree. The card shows "Waking". |

## Going to sleep

1. The worker has had no agent turn, open channel or write for the idle time, 10 minutes by default. Reads that the hub makes on its own schedule do not count.
2. The worker asks the hub whether it may exit. The hub says no while any worktree on that worker has a chat turn running, a request waiting for you, background agent work or queued messages, or while a terminal is open.
3. Otherwise the hub stores every worktree on the worker. It answers yes only when all of them are stored:
   - The working tree goes into a snapshot commit on top of the branch head. The branch, its index and the checkout stay as they are. Ignored files are not part of it.
   - The hub pushes the snapshot to the branch `band/wip/<worktree id>` on `origin`. When origin is not writable, the hub keeps a git bundle of what the remotes lack. A snapshot that every remote already has needs neither.
   - The hub copies the session files of each chat's agent.
4. The worker exits.

If anything in step 3 fails, nothing is kept half done. The worker stays up and the reason shows as `sleepError` in the output of `workers.list`. It asks again after another idle time. A worktree with uncommitted work never loses it this way.

A runner can also set a maximum lifetime for its machines. When a machine reaches it, the hub starts the same hand-off before the idle time is up, and the runner destroys the machine only after the worker exited with its worktrees stored. See [Runner hooks](runner-hooks.md#the-reaper).

## Waking up

These actions wake a sleeping worktree:

- sending a chat message,
- opening a terminal,
- opening, reading or saving a file in the editor.

Background work, such as status polling and the repo list, never wakes a worktree.

When you do one of these, the hub asks a runner for a new worker with the same labels, requirements and environment as the request that made the old one. The runner starts it under the same worker id. When the new worker connects, the hub:

1. checks out the snapshot into a new worktree on the branch,
2. puts the uncommitted changes back,
3. copies the repo's `copyFiles` again,
4. writes the agent session files back.

The chat then reattaches to the session it had. A worktree in the middle of waking shows "Waking" and does not appear as a provisioning card.

What survives: commits, uncommitted changes, untracked files that `.gitignore` does not hide, the chat and its agent session. What does not: running processes, terminals, ignored files such as `node_modules` and build output, and anything the agent kept only in memory.

A wake can fail when no runner matches, the runner fails, or the worker does not connect in time. That is the placement timeout plus five minutes. The call that asked for the wake fails, the worktree stays asleep, and the next call tries again.

## Machine snapshots

When the runner has `snapshot` and `restore` hooks, the hub also snapshots the machine's disk on every sleep, after it stored the git state and the agent sessions. A wake then restores from the snapshot instead of building the worktree again. Ignored files such as `node_modules` and build output come back, and the wake needs no checkout. If the snapshot or the restore fails, the wake falls back to the stored git state, so no work is lost. See [Snapshots](runner-hooks.md#snapshots) for the hook contract, retention and cost.

## One worktree per ephemeral worker

An ephemeral worker belongs to the worktrees created on it. Band never places another worktree on it, so a request with no matching online worker starts a new worker.

## Settings

| Setting | Where | Meaning |
| --- | --- | --- |
| `BAND_EPHEMERAL_IDLE_TIMEOUT_MS` | hub environment | Idle time the hub sends to ephemeral workers when they connect. It wins over the worker's own setting. |
| `--idle-exit <duration>`, `BAND_WORKER_IDLE_EXIT` | worker | The worker's own idle time, such as `90s`, `10m` or `1h`. Only valid with `--ephemeral`. |
| `BAND_AGENT_IDLE_TIMEOUT_MS` | hub environment | Opt-in idle stop of a chat's agent process. Unset means never. The worker stays up while that process runs. |
| `BAND_AGENT_SESSION_DIRS` | worker | Extra directories, separated like `PATH`, that hold agent sessions. |
| `BAND_PLACEMENT_TIMEOUT_MS` | hub environment | How long a request for a worker may wait. The default is 10 minutes. |

The restore puts the worktree under the new worker's first root, at `.band-worktrees/<repo>/<worktree>`. The new worker must be able to reach the repo through its remote URL, as for any request. Agent session files travel with the paths they were written under, so a worker with another root can resume a Claude Code session only if the working directory is the same.

## What survives what

On a worker, terminals run in a detached terminal daemon.

| Event | Terminals (shell, or an agent CLI in terminal mode) |
| --- | --- |
| Worker process restart, upgrade, crash or `systemctl restart` | Keep running. The hub lists the same ids and replays the scrollback. |
| Hub restart or a dropped link | Keep running. |
| Closing the terminal in the UI or CLI | The shell ends. |
| `band-worker uninstall-service` | Every shell ends. |
| Machine reboot | End. The worker does not restore their scrollback. |
| Ephemeral sleep | End. Sleep keeps git state and agent sessions, not live processes. |
