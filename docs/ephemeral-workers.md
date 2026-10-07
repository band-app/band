# Ephemeral workers

A worktree placed on a worker that a runner started behaves like one on a machine that stays up. When the worker has been idle for a while, the hub stores the worktree and the worker exits. The next message, terminal or file access for that worktree starts a new worker, restores the worktree and resumes the chat.

## States

| State | What it means |
|---|---|
| running | A worker is online and serves the worktree. |
| sleeping | The worker exited after the hub stored the worktree. The worktree card shows "Sleeping". |
| waking | A host request for a new worker is open, or the worker is restoring the worktree. The card shows "Waking". |

`repos.list` carries the state as `lifecycle` on each worktree. A running worktree has none.

## Going to sleep

1. The worker has had no agent turn, open channel or write for the idle time (10 minutes by default). Reads the hub makes on its own schedule do not count. `--idle-exit`, `BAND_IDLE_EXIT` of the `local` hook and `BAND_EPHEMERAL_IDLE_TIMEOUT_MS` on the hub set the time. The hub's setting wins, because the hub sends it to the worker when it connects.
2. The worker sends `lifecycle.idle`. The hub refuses while a chat of any worktree on that worker has a turn running, a request waiting on the user, background work of its own or queued messages, or while a terminal is open.
3. Otherwise the hub stores each worktree through ordinary calls on the worker's link, and answers yes only when all of them are stored:
   - The working tree goes into a snapshot commit on top of the branch head. It is built in a temporary index, so the branch, its index and the checkout stay as they are. Ignored files are not part of it.
   - The snapshot is pushed to `refs/heads/band/wip/<worktree id>` on `origin`. When origin is not writable, the hub keeps a git bundle of what the remotes lack in `<BAND_HOME>/sleep/<worktree id>/snapshot.bundle`. A snapshot that every remote already has needs neither.
   - The files of each chat's agent session are copied to `<BAND_HOME>/sleep/<worktree id>/sessions.json`.
4. The worker exits with code 0.

The reaper starts the same hand-off before the idle time when a machine reaches its runner's `maxLifetimeSec`: the hub sends the worker `lifecycle.sleep`, the worker answers at once and sends `lifecycle.idle`, and steps 2 to 4 follow. The reaper destroys the machine after the worker has exited with its worktrees stored (see [Runner hooks](runner-hooks.md#the-reaper)).

If anything in step 3 fails, nothing is kept half done. The worker stays up, `hosts.list` reports the reason as `sleepError`, and the worker asks again after another idle time. A worktree with uncommitted work, no writable origin and no usable `<BAND_HOME>/sleep` never loses that work this way.

## Waking up

A chat message, `terminal.create` or opening a terminal pane, and the file calls of the editor (`worktree.listFiles`, `getFile`, `saveFile`, `createFile`) call `ephemeralLifecycleService.ensureAwake`. Background work, such as the status pollers and the repo list, does not, so it never wakes a worktree.

1. The hub records a host request that repeats the labels, requirements and environment of the request that made the host, and names the sleeping host in `input.wake`. The request does not show as a provisioning card.
2. A runner leases it and runs `spawn` with the sleeping host's id. The hub revokes the old tokens of that host and issues a bootstrap token for the same id.
3. When the new worker says hello, the hub checks the snapshot out into a new worktree on the branch (`git worktree add -B`), puts the uncommitted changes back with `git read-tree -u --reset <snapshot>` and `git reset`, copies the repo's `copyFiles` again and writes the agent session files back.
4. The chat reattaches with `session/resume` (or `session/load` when the agent cannot resume) on the session it had.

What survives: git state (commits, uncommitted changes and untracked files that `.gitignore` does not hide), the chat and its agent session. What does not: running processes, terminals, ignored files such as `node_modules` and build output, and anything the agent kept only in memory.

A failed wake (no runner matches, the runner fails, the worker does not connect within `BAND_PLACEMENT_TIMEOUT_MS` plus five minutes) fails the call that asked for it. The worktree stays asleep and the next call tries again.

## Machine snapshots

When the runner that started the worker has `snapshot` and `restore` hooks, the hub also snapshots the machine's disk on every sleep, after it has stored the git state and the agent sessions, and a wake restores from the snapshot instead of building the worktree again. Ignored files such as `node_modules` and build output come back, and the wake needs no checkout. If the snapshot or the restore fails, the wake falls back to the stored git state described above, so no work is lost. See [Snapshots](runner-hooks.md#snapshots) for the hook contract, retention and cost.

## Claims

A worker that says `ephemeral` in its hello is claimed by the worktrees created on it. Placement never offers it to another worktree, so a request without a matching online host always starts a new worker.

## Settings and limits

| Setting | Where | Meaning |
|---|---|---|
| `BAND_EPHEMERAL_IDLE_TIMEOUT_MS` | hub | Idle time the hub sends to ephemeral workers. |
| `BAND_AGENT_IDLE_TIMEOUT_MS` | hub | Idle stop of a chat's agent process. The worker stays up while that process runs. |
| `BAND_AGENT_SESSION_DIRS` | worker | Extra directories (separated like `PATH`) that hold agent sessions. |
| `BAND_PLACEMENT_TIMEOUT_MS` | hub | How long a wake request may wait for a worker. |

The restore puts the worktree under the new worker's first root, at `.band-worktrees/<repo>/<worktree>`. A repo must be reachable from the new worker through `BAND_REPO_URLS` (the stored remote URL, else the repo path), as for any request. Agent session files travel with the paths they were written under, so a worker with another root can resume a Claude Code session only if the working directory is the same.

## What survives what

Terminals on a worker run in a detached terminal daemon (see `apps/worker/README.md`).

| Event | Terminals (shell, agent CLI in tui mode) |
| --- | --- |
| Worker process restart, upgrade, crash, `systemctl restart` | Keep running. The hub lists the same ids and replays the scrollback. |
| Hub restart or a dropped link | Keep running, as before. |
| Closing the terminal in the UI or CLI | The shell ends. |
| `band-worker uninstall-service` | Every shell ends. |
| Machine reboot | End. Their scrollback is not restored on the worker. |
| Ephemeral sleep | End. Sleep keeps git state and agent sessions, not live processes. |
