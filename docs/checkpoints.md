# Checkpoints

The hub keeps recent checkpoints of every worktree that runs on a static worker. When the worker goes offline, the work stays readable from the hub. A person can restore the worktree on another allowed host, or move it while its host is still online.

A checkpoint is the sleep snapshot of [ephemeral workers](ephemeral-workers.md) (a commit of the working tree, built in a temporary index so the branch, its index and the files stay as they are), stored on the hub only. Band never pushes a checkpoint to origin.

## What a checkpoint holds

- The working tree on top of the branch head: tracked edits and untracked files that `.gitignore` does not hide.
- A git bundle of the commits and objects the worker's remotes lack, so a checkpoint of a pushed branch is small. A worktree with no unpushed work and no edits has no bundle.
- The files of each chat's agent session, so the chat can resume on another machine.

The files are under `<BAND_HOME>/checkpoints/<worktree id>/<checkpoint id>/`, with a row in the `worktree_checkpoints` table.

Not carried: ignored files (`node_modules`, build output), running processes, terminals and anything an agent keeps only in memory.

## When the hub takes one

| Trigger | When |
| --- | --- |
| `turn` | An agent turn ended in the worktree. |
| `quiet` | The files differ from the last checkpoint and have not changed for 3 minutes. The hub checks every minute. |
| `shutdown` | A worker stops cleanly (`SIGTERM`, `band-worker` exiting). The worker tells the hub first and waits up to 30 s. |
| `move` | A move takes a fresh one first. |
| `manual` | `band worktrees checkpoints <id> --take`. |

Nothing is stored when the working tree, the branch head and the agent sessions match the newest checkpoint. Ephemeral workers are skipped, because their sleep already stores the worktree. Worktrees on the hub's own machine have no checkpoints.

### Limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `BAND_CHECKPOINT_KEEP` | 5 | Checkpoints kept per worktree. The oldest go first. |
| `BAND_CHECKPOINT_MAX_BYTES` | 200 MB | Size limit per worktree. A checkpoint above it is skipped and the worktree shows a warning (`band worktrees checkpoints <id>` prints it). Older checkpoints are also dropped while the kept ones together exceed it. |
| `BAND_CHECKPOINT_QUIET_MS` | 180000 | How long files stay unchanged before the `quiet` trigger. |
| `BAND_CHECKPOINT_POLL_MS` | 60000 | How often the hub looks for quiet worktrees. |

All four are read from the hub's environment.

## The per-repo setting

"Checkpoints on the hub" in Settings > Repos, or `band repos set <repo> --checkpoints on|off|default`. It is an admin setting.

- Default for a repo available on all hosts: on.
- Default for a repo limited to chosen hosts: off, because limiting a repo usually means its code must stay off other machines.

When it is off the hub stores nothing for the repo, and `checkpoints.take` refuses. Turning it on starts checkpoints at the next trigger. Turning it off stops new ones but does not delete the existing ones; remove the worktree to delete them.

## Offline worktrees

When a worktree's host is offline its card shows an offline icon and fades. The tooltip (hover; the icon also carries an `aria-label`) has the host's last seen time and the checkpoint age, or "No checkpoint". The card's menu has one item, **Open on another host…**, for a worktree on a worker. It is disabled with its reason when the hub has no checkpoint, and when the repo is limited to that one host ("Only available on <host>"). While the host is online the same item moves the worktree (see Move to host below); while it is offline it opens the [continue dialog](follow-the-work.md), which says that ignored files (`.env`, `node_modules`) are not carried over.

Opening the worktree shows a notice above it: "<host> is offline (last seen …). Last checkpoint …", with an **Open on another host** button (`follow.offer` and `follow.continue`). When the offer is blocked the notice shows the reason and no button. The right panel then says the host is offline, with a link to **View checkpoint (read-only)**; the same link is in the notice. The checkpoint view shows:

- Changes shows the diff of the checkpoint against its branch head.
- Files lists and opens the files as the checkpoint holds them.
- Chat history is on the hub already and works as before.

Terminals, the desktop, dev servers and the browser need the host and show "host offline". The hub reads the checkpoint with git on a bare repo it builds from the bundles under `view.git` in the worktree's checkpoint directory. It fetches the repo's history from the hub's checkout or remote URL first, because a bundle only has what the remotes lack. If the hub can reach neither, the view fails with a message that says so.

## Restore on another host

`band worktrees restore <id> --to <host>` uses the newest checkpoint, or `--checkpoint <id>`:

1. The target host must be online and allowed for the repo. If it is not allowed, the call is refused with `<repo> is only available on ...`. An admin can add the host in the same call (`--add-host`, the checkbox in the dialog).
2. The hub makes sure the target has the repo, fetches what origin has, sends the bundle, and runs `git worktree add -B <branch>` with the working tree of the checkpoint. The edits are uncommitted again.
3. The hub compares the restored files with the checkpoint. If they differ, it removes only what it just created and fails.
4. The agent session files are written on the target. The next message in each chat resumes the session (`session/resume`, or `session/load` when the agent cannot resume).
5. The worktree on the new host gets the id `<repo>-<branch>@<new host>`. Chats, terminal records, tasks, cron jobs, subscriptions and browser history move to it.

The old copy is marked superseded and nothing is deleted on the old host. When that host comes back, Band does not run both: it takes no checkpoints of the superseded copy, lists it as "Superseded by <id>" and leaves the files untouched. Remove it from its card when you no longer need it. That is the only step that deletes files.

If a repo has no remote URL, the target must already know the repo, or the call must name where it keeps it (`hostRepoPath` in tRPC).

## Move to host

`band worktrees move <id> --to <host>` is for a worktree whose host is online:

1. Take a fresh checkpoint (even for a repo with checkpoints off; it is deleted afterwards).
2. Restore it on the target, as above.
3. Remove the source worktree, only after the target checked out the same files. If the removal fails, the result carries a warning and the old copy stays listed as superseded.

`band hosts evacuate <host> --to <host>` (Move all worktrees on this host in Settings > Hosts, admin) does this for every worktree on a host, one after the other, and prints a summary. One failure does not stop the others. A repo's own clone is not moved. An offline source host restores from the last checkpoints and leaves its copies superseded.

## Continue when a host is offline

When someone acts on an offline worktree (a chat message, a terminal, an agent launch), Band offers a restore on another host, or does it by itself for a repo that opts in. See [Follow the work](follow-the-work.md).

## Permissions

Reading checkpoints, restore and move take any device token. Adding a host to a repo, changing the setting and evacuating a host need an admin token. The MCP endpoint and the worker relay do not offer `checkpoints.*`, so an agent cannot move work between hosts.
