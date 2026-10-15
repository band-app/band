# ADR: chat ownership per host

**Status:** Accepted · **Date:** 2026-10-13

This amends decision 5 of [hub-workers.md](hub-workers.md) ("chat stays on the hub, and only agent stdio is remote").

## Context

Decision 5 put the ACP client and the chat event log on the hub. A worker spawns the agent and relays its stdio over the link. For a desktop app connected to a remote hub, with the worktree on the same Mac, every chat message and every streamed event goes Mac → hub → Mac → hub → Mac. On a slow or lossy network the chat feels slow although nothing in it needs to leave the laptop.

The direct local path (part 1, `docs/local-direct-path.md`) already sends terminals, files, diff and search from the desktop UI straight to the worker on `127.0.0.1`. Those have no hub state. A chat does: the hub keeps its event log, which is what the phone, other machines, history and restore read.

Checkpoints (`docs/checkpoints.md`) already copy each worktree and its agent session files to the hub, and restore can rebuild a worktree on another host from them. What restore cannot rebuild without the hub is the chat history, because that only exists where the ACP client runs.

## Decision

1. **Chat ownership is per host.** Each chat has one owner: the hub, or the worker its worktree is on. A worker owns the chats of its worktrees only when it says so in its hello (capability `chatOwnership`). The desktop app's bundled worker turns it on by default. Every other worker (npm installs, Docker, runner VMs, ephemeral workers, older builds) keeps hub-run chats, so nothing changes for them.
2. **The owner runs the ACP client and an event log.** On an owning worker, `apps/worker/src/chats/` attaches the session, records events, runs turns one at a time, keeps the message queue and answers permission and form requests. It uses the same `AcpAgentProcess` the hub uses (moved to `@band-app/host-local`). Its log has the same rows as `chat_events`: the same ids, kinds, payloads, revisions and turn starts.
3. **Event ids come from the hub.** `chat_events.id` is one sequence for all chats, and a client's cursor (`Last-Event-ID`) must mean the same on the worker and the hub. The hub leases each owning worker a block of ids (it moves `sqlite_sequence` past the block, so its own rows never land in it) and grants a fresh block with every new owned chat, so a chat's ids keep growing. A worker that is offline keeps writing from its block.
4. **The hub keeps a replicated copy.** The worker sends every event it logs to the hub over the link, in id order, and the hub acks each batch. After a drop the worker resends from its last ack. The hub inserts by id and ignores a row it has, so a resend leaves no duplicate and the order leaves no gap. The hub stays the read source for every other client (the phone, a browser, `band chats watch`), for history pages, checkpoints and restore.
5. **The hub forwards what it is asked to do.** For a chat a worker owns, the hub never starts an agent process. A message from another client, the message queue, a cron job, a subscription wake-up, an agent launch, a stop, a permission or form answer, a config change and a session listing all go to the owner over the link. Messages and stops go through an outbox (`chat_forwards`) with an id the worker remembers, so a message sent while the worker is offline waits and runs exactly once after it reconnects. The hub does not take the chat back while the owner is offline.
6. **Hub state follows replicated events.** Task records, agent status (working, question, done, failed), needs-attention, usage and the turn-end trigger that takes checkpoints come from the replicated rows (`prompt`, `turn-started`, `turn-ended`, `permission`, `elicitation`, `request-resolved`), the same rows a hub-run chat writes. Only rows the hub inserted for the first time act, so a resend does nothing twice.
7. **The local UI talks to the owner directly.** The desktop app reads a chat's events and sends, stops and answers through the worker's local listener (part 1), with the same wire format as the hub's `GET /api/chats/:chatId/events` and `POST /api/chats/:chatId/messages`. It uses the direct path only when the chat's owner is this computer's worker, and falls back to the hub when the direct path fails.
8. **Ownership changes at a clean point, and only explicitly.** A hub-run chat on an owning worker moves to the worker only when no turn runs and nothing waits on the user. The hub stops its own agent process first, sends the worker the chat's log so it can serve history locally, and logs the change. A restore or move reassigns the chat to the new worktree, and its owner follows the new host. There is never a moment when two places run the same chat.

## Consequences

Positive:

- On the desktop with a remote hub, a chat on a Mac worktree works at local speed and keeps working without the hub.
- Every other client still reads one log on the hub, and restore on another host still has the full chat.
- Old workers and every non-desktop worker run as before.

Negative:

- Two ACP clients exist: the hub's (`agent-session-service.ts`, `task-service.ts`) and the worker's (`apps/worker/src/chats/`). The worker's is smaller: it has no agent probe, no one-shot calls, no session catalog and no learned Claude Code defaults. A change to turn handling must be made in both.
- The hub learns about a turn only when its events replicate. On a slow link, status, needs-attention and checkpoints lag the worker by that much.
- A hub-originated message to an offline owner waits instead of moving the work. The user can still restore the worktree elsewhere.
- A restore while the Mac keeps working offline leaves two copies of the chat. The restore guard and the diverged copy (the second half of this change) handle it.

## Alternatives considered

**One-shot handoff, like Cursor's Move to Cloud.** The chat runs on the worker until the user goes remote, then its log moves to the hub. It needs no background replication, but the phone would see nothing until a move, and a Mac that disappears mid-turn takes the chat with it. Background replication costs little more and keeps restore working.

**Extract the hub's chat runtime into a package both sides run.** It avoids the second ACP client. The runtime reads the hub's database, settings, MCP proxy, relay grants, worktree service and status service directly, so the extraction needs about fifteen injected interfaces and touches every hub chat path at once. It is worth doing once the worker runtime has settled.

**Let the hub take an owned chat back while the worker is offline.** It keeps the chat answering, but the worker would come back to a chat that moved without it, which is the divergence the restore guard exists to handle. The user chose to wait.
