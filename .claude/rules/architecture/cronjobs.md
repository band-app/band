---
paths:
  - "**/CronjobsPageContent.tsx"
  - "**/cronjobs-worktree-migration.test.ts"
  - "**/cronjobs.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/infra/db/queries/cronjobs.ts"
  - "apps/hub/src/server/services/cronjob-service.ts"
  - "apps/hub/tests/cronjobs-sessions.test.ts"
  - "apps/web/e2e/cronjobs-worktree.spec.ts"
---

# Architecture: cronjobs

A cronjob belongs to one worktree (`cronjobs.worktree_id`, also its `file_key`), never to a repo. For a repo's main branch the job names the default-branch worktree. `services/cronjob-service.ts` owns the scheduler and the dispatch, `infra/db/queries/cronjobs.ts` the rows.

- Fields. `worktreeId` is required on `cronjobs.create` (a repo `scope` or a missing worktree answers 400, and the worktree must exist). Optional `agent` is a `settings.codingAgents[].id` (unknown ids are refused) and `sessionId` is the agent's provider session id, a chat's `activeSessionId`. A `sessionId` with `via: "terminal"` is refused, and so is an `agent` that differs from the agent of the chat that already has the session. `cronjobs.update` takes the same fields (`null` clears `agent` and `sessionId`) and `worktreeId` moves the job. `lastRunMessage` holds the reason of a failed run or of a job the boot migration disabled.
- Dispatch (`dispatchToChat`). Without a `sessionId` the prompt goes to the job's `band:cronId` chat, created with the job's `agent`. With one it goes to the chat in the worktree whose `activeSessionId` matches, whatever its labels. With none, a chat is created with the `band:cronId` label and that active session, and `agentSessionService.ensureSession(chatId, "prompt", { strictSession: true })` attaches it with `session/resume` or `session/load`. Strict mode makes `attach` throw instead of falling back to a fresh session. On failure the run is recorded `failed` with the reason (`CronjobDispatchError`, 412 from `cronjobs.trigger`), a chat created for this fire is removed, and the next fire tries again. A chat that is mid-turn queues the prompt (`submitOrQueueTask`), so a fire is no longer recorded `skipped` for a busy chat. A terminal job that is still running still is.
- Boot migration (`CronjobService.migrateRepoJobs`, called from `runFirstTimeSetup` after the worktree sync and before `cronjobService.start`). Each job still scoped to a repo moves to `toWorktreeId(repo, defaultBranch, listedMainHostOf(repo))` keeping its id, schedule, prompt, `via`, enabled flag and chat. With no listed default-branch worktree, or no repo, it is disabled with `lastRunMessage` set. Nothing is deleted, and a second run changes nothing. The `scope` column stays and reads `worktree` for every job. `rekeyWorktreeRows` moves `file_key` along with `worktree_id`. `removeForRepo` clears the jobs of a repo's worktrees when the repo is removed.
- Surfaces. `band cronjobs create --worktree <id> [--agent] [--session-id]`, `update <key> <id> [--worktree] [--agent] [--session-id | --clear-session]` (`--repo` and `--scope` fail with a message). The UI form is `CronjobsPageContent.tsx` (repo, then worktree with the default branch first, agent, session id).
- Tests: `apps/hub/tests/cronjobs-sessions.test.ts` (ACP stub, request log), `cronjobs-worktree-migration.test.ts` (seeded pre-change DB, then a real boot), `cronjobs.test.ts`, `apps/web/e2e/cronjobs-worktree.spec.ts`, `cronjobs_*` in `apps/cli/tests/integration.rs`.
