---
paths:
  - "apps/hub/src/server/services/ephemeral-lifecycle-service.ts"
  - "apps/hub/tests/ephemeral-lifecycle.test.ts"
  - "apps/web/e2e/sleeping-worktree.spec.ts"
  - "apps/worker/src/context.ts"
  - "apps/worker/tests/lifecycle.test.ts"
  - "docs/ephemeral-workers.md"
  - "packages/link/src/relay.ts"
  - "runners/local/spawn.sh"
---

# Architecture: ephemeral lifecycle

Worktrees on an ephemeral worker sleep when it idles and wake on the next use (`services/ephemeral-lifecycle-service.ts`, `worktree_sleep` table, guide: `docs/ephemeral-workers.md`).

- Sleep. An ephemeral worker that was idle for its idle time sends `lifecycle.idle` (`packages/link/src/relay.ts`) and exits with code 0 only on `exit: true`. The hub refuses while a turn, a request waiting on the user, background agent work, queued messages or a terminal exist for a worktree on that worker. Otherwise it stores every worktree through calls on the worker's link: a snapshot commit built in a temporary index (`GIT_INDEX_FILE`) on top of the branch head, pushed to `refs/heads/band/wip/<worktree id>` on `origin` or, when that is not writable, kept as a git bundle in `<BAND_HOME>/sleep/<worktree id>/`; plus the agent session files (`lifecycle.exportSessions`, `sessions.json`). A worker stores all of its worktrees or none. A failure keeps the worker alive and shows as `sleepError` in `workers.list`. The hub's `BAND_EPHEMERAL_IDLE_TIMEOUT_MS` is sent to the worker as `lifecycle.policy`.
- Idle clock. RPCs the hub makes on its own schedule (`host.info`, `worktree.list`, `git.exec`, `git.gh`, read-only `fs.*`, `search.listFiles`) hold the worker while they run but do not restart the idle clock (`PASSIVE_METHODS` in `apps/worker/src/context.ts`). A channel the hub opens counts until both sides end it.
- Wake. `ensureAwake(worktreeId)` is called by a chat prompt (`AgentSessionService.ensureSession`), `TerminalService.spawn` and the file calls of `FilesService`. Pollers do not call it, so they do not wake anything. It records a wake worker request (`input.wake`, hidden from `hostRequests.list`) with the labels and environment of the request that made the worker. `RunnerService` starts a worker with the same worker id (`TokenService.issueWorkerBootstrapFor`, the worker row is kept when an attempt fails). When it says hello, `PlacementService.finish` calls `restoreHost`: fetch the snapshot, `git worktree add -B`, `git read-tree -u --reset` plus `git reset` for the uncommitted changes, and `lifecycle.importSessions` for the agent files. The chat then reattaches with `session/resume` or `session/load`.
- `PlacementService` never offers an ephemeral worker to a new worktree (the claim). `repos.list` marks each worktree `lifecycle: "sleeping" | "waking"`, and `WorktreeCard` shows it. `runners/local/spawn.sh` starts a woken worker id from an empty directory.
- Limits: ignored files, running processes and terminals do not survive. The snapshot upload needs a writable origin or a usable `<BAND_HOME>/sleep`.
- Tests: `apps/hub/tests/ephemeral-lifecycle.test.ts` (real hub, real `local` hook and worker, scripted ACP agent), `apps/worker/tests/lifecycle.test.ts`, `apps/web/e2e/sleeping-worktree.spec.ts`.
