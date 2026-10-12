# Follow the work

When a worktree's host is offline and someone needs a live host, Band offers to continue the worktree on another allowed host from the hub's latest [checkpoint](checkpoints.md). A repo can opt in to doing it without asking. When the original host comes back, its copy is kept and compared with the checkpoint, so nothing it did while it was away is lost.

## What triggers it

An action that needs a live host on a worktree whose host is offline:

- sending a chat message,
- opening a terminal,
- starting an agent (`agentSessions.launch`).

Reading never triggers it. The diff, the files and the chat history of an offline worktree come from the hub's checkpoint, as [offline worktrees](checkpoints.md#offline-worktrees) describe. A worktree on an ephemeral worker is not offered a continuation, because it sleeps and wakes (see [ephemeral workers](ephemeral-workers.md)).

## The prompt

The chat shows a dialog:

> `<host>` is offline. Continue on `<target>` from the checkpoint taken `<age>` ago?

The target list holds the online workers the repo may run on. The hub recommends one: a host that already has a clone of the repo first, then a host where the agent the chat uses is installed and logged in (from the host's capability report and a live launch check), then the host with the fewest worktrees. A host where the agent cannot start is listed with the reason and cannot be chosen.

The dialog also says what does not carry over and what runs:

- Ignored files (`node_modules`, build output, `.env`) are not carried over.
- Running processes and open terminals are not carried over.
- The repo's setup runs on the new copy, if the repo has one.

Accepting calls `follow.continue`. The chat then sends the message again to the new worktree, with the agent session resumed (`session/resume`, or `session/load` when the agent cannot resume).

## What happens when you accept

The restore is the same as [Restore on another host](checkpoints.md#restore-on-another-host): the branch, the uncommitted and untracked files, the agent sessions and the chats, terminal records, tasks and subscriptions move to the new worktree id `<repo>-<branch>@<host>`. Then:

1. The move is recorded on the new copy: the host it came from, the host it runs on, the reason (`manual` or `auto`), the checkpoint id and its time. The worktree header and the Host and Origin views show it ("Continued from `<host>`").
2. The repo's setup runs on the new copy, the way it does for a new worktree.
3. The old copy stays where it is, marked superseded.

`band worktrees continue <id> [--to <host>]` does the same from the CLI, and prints the new worktree id.

## Continue automatically

"Continue on another host automatically" in Settings > Repos, or `band repos set <repo> --auto-continue on|off`. It is an admin setting and is off by default.

With it on, the action goes through without a prompt when the checkpoint is younger than the age limit, and the chat shows a notice and the header records the move as `auto`. An older checkpoint always asks. The limit is 30 minutes. `BAND_AUTO_CONTINUE_MAX_AGE_MS` in the hub's environment changes it.

## When it is not possible

The dialog and the API answer with a reason and no target choice:

| Reason | Message starts with | What to do |
| --- | --- | --- |
| The repo is limited to the offline host | `<repo> is only available on <host>` | Bring the host back, or allow another host in Settings > Repos. |
| Checkpoints are off for the repo | `Checkpoints are off for <repo>` | Bring the host back, or turn checkpoints on. |
| The hub has no checkpoint yet | `The hub has no checkpoint of <id>` | Bring the host back. |
| No other allowed host is online | `<host> is offline and no other host that <repo> may run on is online` | Bring a host online. |
| The agent is missing on every other host | `... the agent for this work is not available on any other host` | Install and log in the agent on another host, for example Codex that is installed only on the offline one. |

`band worktrees continue` prints the same text. A worktree whose host is online is refused with a pointer to `band worktrees move`, which is the way to move work while the source is up.

## When the original host comes back

When the worker connects, the hub compares the working tree of each copy it holds that a continuation superseded with the checkpoint the continuation used. If the tree differs, the copy is flagged `diverged` in `repos.list` and its card.

The panel of a diverged copy (`follow.divergence`) lists the files that differ and the diff of each one. Two actions settle it:

- **Bring these changes over** (`follow.bringOver`) builds a patch of what the old copy changed since the checkpoint and applies it to the new copy. A patch that does not apply cleanly changes nothing and comes back with the conflicting files, so you can resolve them by hand. A clean apply marks the old copy `resolved`.
- **Discard old copy** (`follow.discardOld`) removes the old worktree and its files on the old host. It needs `confirm: true`, and the UI asks first. A diverged copy is refused unless the call also passes `discardChanges: true`: the refusal names how many files would be lost, and the UI shows the diff and asks a second time with that count. A copy whose changes were brought over counts as resolved and needs only `confirm`, until it changes again. Nothing else in this feature deletes files on any host. If the old host is offline, the removal runs when it next connects.

Until a person settles it, the old copy stays on disk and takes no checkpoints.

## Limits

- Work since the last checkpoint is lost with the offline host, unless the host comes back and a person brings it over. A host that stops cleanly takes a checkpoint first (`shutdown` trigger).
- The local host (the hub's own machine) is never a source or a target.
- A continuation needs the target to have the repo. For a repo with a remote URL the hub clones it there. A repo with no remote can only continue on a host that already holds it.
- Ignored files and running processes are not carried over.
- `follow.*` is not offered to agents: the MCP endpoint and the worker relay leave it out.

## Where it lives

`apps/hub/src/server/services/follow-service.ts` holds the offer, the gate, the continuation and the divergence checks. The chat route (`api/chat-submit.ts`), `terminals.create` and `agentSessions.launch` call `followService.gate` before they use the host. Types shared with the UI are in `packages/shared/src/continuation.ts`. Tests: `apps/hub/tests/follow-the-work.test.ts` (two real workers and a scripted ACP agent) and `apps/web/e2e/follow-the-work.spec.ts`.
