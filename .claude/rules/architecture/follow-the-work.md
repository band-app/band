---
paths:
  - "**/checkpoint-wins.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/api/chat-submit.ts"
  - "apps/hub/src/server/api/trpc.ts"
  - "apps/hub/src/server/services/follow-service.ts"
  - "apps/hub/src/server/services/worker-lease-service.ts"
  - "apps/hub/tests/follow-the-work.test.ts"
  - "apps/hub/tests/worker-lease.test.ts"
  - "apps/web/e2e/follow-the-work.spec.ts"
  - "apps/worker/src/lease.ts"
  - "apps/worker/tests/fencing.test.ts"
  - "docs/follow-the-work.md"
  - "packages/shared/src/continuation.ts"
---

# Architecture: follow the work

When a worktree's worker is offline, an action that needs a live worker continues the worktree on another allowed worker from its latest checkpoint (`services/follow-service.ts`, guide: `docs/follow-the-work.md`).

- The gate. `followService.gate(worktreeId, { chatId?, agentId? })` runs before a chat message (`api/chat-submit.ts`, answers 409 with a `HostOfflineAnswer`), `terminals.create` and `agentSessions.launch` (tRPC PRECONDITION_FAILED, the answer in the error's `data.hostOffline`, put there by the `errorFormatter` in `api/trpc.ts`). It is a no-op for a worktree whose worker is online, on the hub's own machine, asleep (ephemeral lifecycle) or superseded. Reading (checkpoint views, chat history) never calls it.
- The offer (`follow.offer`, `FollowService.offer`) checks in this order: the repo is limited to the offline worker, checkpoints are off, no checkpoint exists, no allowed online worker, the chat's agent is unavailable on every candidate (capability report plus `modelRefreshService.launchProblemOn`). Each gives a `blocked.reason` and a message. Otherwise the targets are sorted by agent ready, has a clone, fewest worktrees, and the first agent-ready one is `recommended`. Types are in `packages/shared/src/continuation.ts`.
- The lease (issue #901, `services/worker-lease-service.ts`, `apps/worker/src/lease.ts`, link method `lease.renew`). The hub renews each non-ephemeral worker's lease (`BAND_WORKER_LEASE_MS`, default 5 minutes, read on every call) every fifth of it, writes `workers.last_seen_at` on each acknowledgement and sends the folders of superseded copies as `blockedPaths`. The hub also sends that list at once, as the same renewal, whenever a superseded mark is set or cleared or a superseded copy is removed (`pushBlockedPaths`, called by `CheckpointService.restoreFrom`, `FollowService` and `WorktreeService.remove`), so a move, restore or discard takes effect on the worker in about a second. Requests for one worker that overlap share one follow-up renewal, and an offline worker is skipped. A worker whose lease runs out (hub down or network down) kills its agents, terminals, MCP processes, browsers, language servers and script plans, then snapshots each worktree locally (`refs/band/fenced/<folder>`, `<state dir>/fenced.json`, never uploaded, never a checkpoint), and refuses `acp.spawn`, `pty.spawn`, `scripts.prepare` and `scripts.runHidden` until the next renewal (`LeaseGuard.assertMayRun`). `follow.offer` answers `lease-active` with `leaseExpiresAt` while `workerLeaseService.remainingMs(host)` is positive for an offline worker (the UI counts down on the button), and `CheckpointService.restoreFrom` refuses an offline source the same way, so `continue`, auto-continue, `restore` and `evacuate` all wait. An old worker that answers "method not found" is never held back. Tests: `apps/worker/tests/fencing.test.ts`, `apps/hub/tests/worker-lease.test.ts`, `checkpoint-wins.test.ts` (test hubs set `BAND_WORKER_LEASE_MS` to 1.5 s and `killWorker` waits it out).
- Automatic continuation needs `repos.auto_continue` (`RepoQueries.setAutoContinue`, `repos.update { autoContinue }` admin, `band repos set --auto-continue`) and a checkpoint younger than `BAND_AUTO_CONTINUE_MAX_AGE_MS` (default 30 minutes, read on every call). Older checkpoints always prompt.
- `follow.continue` / `FollowService.continueOn` calls `CheckpointService.restore`, then records `ContinuedFrom` on the new copy (`worktrees.continued_from`, written only by `RepoQueries.setContinuedFrom`, kept by `saveAll`), starts the repo's setup there and broadcasts a notice to the chats. One continuation per worktree runs at a time. The old copy stays superseded and is never deleted by it.
- Divergence. When a worker connects, `WorkerLinkService.onConnected` calls `followService.onHostReturned`, which builds a snapshot of each superseded copy on that worker and compares its tree with the checkpoint's (`worktrees.divergence`, `RepoQueries.setDivergence`). `follow.divergence` and `follow.divergenceDiff` read it, `follow.bringOver` applies the difference as a patch on the new copy (`git apply --check` first, so a conflict changes nothing), and `follow.discardOld` removes the old copy only with `confirm: true`, and a diverged copy also needs `discardChanges: true` (a `resolved` verdict holds while the copy's tree equals `Divergence.treeSha`). For the default-branch worktree it resets the branch to its remote's latest and clears the superseded mark instead of removing the folder.
- `follow.*` is left out of the MCP endpoint and the worker relay. CLI: `band worktrees continue <id> [--to <worker>]`, `band repos set --auto-continue on|off`.
- Tests: `apps/hub/tests/follow-the-work.test.ts` (two real workers plus one without the scripted agent, scripted ACP stub), `apps/web/e2e/follow-the-work.spec.ts`, `repos_set_auto_continue_*` and `worktrees_continue_*` in `apps/cli/tests/integration.rs`.
- Not done yet: continuing on the hub's own machine, a placement-style retry when the chosen target fails, and a settings field for the age limit.
