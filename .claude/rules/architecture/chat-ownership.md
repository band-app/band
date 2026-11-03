---
paths:
  - "**/agent-session-service.ts"
  - "**/chat-ownership-direct.test.ts"
  - "**/direct.ts"
  - "**/helpers/cuttable-proxy.ts"
  - "**/local-http.ts"
  - "**/log-schema.ts"
  - "**/log.ts"
  - "**/owner.ts"
  - "**/payload.ts"
  - "**/runtime.ts"
  - "**/store.ts"
  - "**/task-service.ts"
  - "**/turns.ts"
  - "apps/hub/src/api/chat-events.ts"
  - "apps/hub/src/server/infra/db/queries/chat-events.ts"
  - "apps/hub/src/server/services/chat-ownership-service.ts"
  - "apps/hub/tests/chat-ownership.test.ts"
  - "apps/web/e2e-desktop/desktop-direct-path.spec.ts"
  - "apps/web/src/lib/direct-chat.ts"
  - "apps/worker/src/chats/**"
  - "apps/worker/tests/service.test.ts"
  - "docs/architecture/chat-ownership.md"
  - "docs/chat-ownership.md"
  - "packages/chat-runtime/**"
  - "packages/link/src/chats.ts"
---

# Architecture: chat ownership

A worker started with `--own-chats` (`BAND_WORKER_OWN_CHATS=1`, the hello capability `chatOwnership`; the desktop app's bundled worker installs with it) runs the chats of its own worktrees and replicates them to the hub (ADR `docs/architecture/chat-ownership.md`, guide `docs/chat-ownership.md`). `chats.ownerHostId` (in the chat's `panel_states` JSON, written only by `ChatService.setOwner`) names the owner; undefined is the hub.

- Shared pieces live in `packages/chat-runtime`: the `chat_events` table (`log-schema.ts`, re-exported by the hub's schema), `ChatEventQueries` over any drizzle db (`log.ts`, with `insertRows`, `readChat`, `readIdRange` and `reserveIdBlock`), `rowsToEvents`, `AcpAgentProcess`, `PendingWork`, the SSE writer, `turnUsage` and the session state read from a log. The hub's `infra/db/queries/chat-events.ts` binds the queries to its db.
- Worker (`apps/worker/src/chats/`): `store.ts` (`<state dir>/chats.db` on `node:sqlite`, loaded lazily), `runtime.ts` (one chat's ACP session, a smaller port of `agent-session-service.ts`), `turns.ts` (turns and the queue, a port of `task-service.ts`), `owner.ts` (link methods, seeding, replication, forwards) and `local-http.ts` (the chat routes, the hub's wire format, served by the direct listener in `direct.ts` on its token). The web side is `apps/web/src/lib/direct-chat.ts`: a `HubFetch` for the chat hook's stream, sends and history that tries the worker first. A change to turn handling goes in both runtimes.
- Link (`packages/link/src/chats.ts`): hub to worker `chat.own | forward | release | setConfigOption | listSessions`; worker to hub `chat.replicate | idBlock | history | launch | sessionState` and the notifications `chat.live.changed | chat.transient | chat.activity`. Large row batches go over a channel (`payload.ts`).
- Hub (`services/chat-ownership-service.ts`): `ownerFor` hands a chat over at a clean point (no task, `agentSessionService.isActive` false, empty hub queue) after stopping the hub's process; `taskService.submitTask | submitOrQueueTask | abortTask | cancelTask | getTask | hasRunningTask`, `agentSessionService.ensureSession` (never runs an owned chat), the answers, `setConfigOption`, `listSessions`, the pending and work checks, the queue router and `api/chat-events.ts` consult it. Forwards go through the `chat_forwards` outbox (delivered in order on connect, rerouted when the chat moved). Replicated rows are inserted by id and only new ones act (`ingest`: tasks, status, summary, `emitTurnEnded`). Rows for a chat the worker no longer owns go to `chat_event_holds`. `chat-submit` skips the follow-the-work gate for an owned chat, so a message to an offline owner waits.
- Every worker registers `lifecycle.exportSessions | importSessions` (before this only ephemeral ones did), so checkpoints carry agent session files on static workers too.
- Tests: `apps/hub/tests/chat-ownership.test.ts` (real hub, an owning and a plain `band-worker`, scripted ACP stub; S2 to S6, S9), `chat-ownership-direct.test.ts` (the direct send and stream, token scope, a cut link within the lease through `helpers/cuttable-proxy.ts`), the chat step of `apps/web/e2e-desktop/desktop-direct-path.spec.ts` (the real app sends and streams on 127.0.0.1; the fake launchd passes `BAND_TEST_ACP_*` to the worker), `apps/worker/tests/service.test.ts` (`--own-chats` in the service file).
- A worker whose hub lease ran out (#905) starts no agent for an owned chat either (`assertMayRun`). Whether owned chats should keep running while fenced is an open decision.
- Not done yet: the restore guard and the diverged copy shown in the UI (the second half), and moving an existing desktop install to `--own-chats` without adding This Mac again.
