/**
 * Shared domain errors for the server tier.
 *
 * Lives one level above `services/` so the three workspace-owning services
 * (`session-service`, `task-service`, `workspace-service`) can throw the same
 * error class without re-declaring it. Before #317 Phase 6, each service had
 * its own `WorkspaceNotFoundError` with `this.name = "WorkspaceNotFoundError"`
 * — `instanceof` checks were not cross-compatible across modules, and any
 * `catch` block importing the wrong copy silently failed to match. Routers
 * already correctly use `instanceof` (rather than `.name` or message-string)
 * to map to HTTP / tRPC error codes, so consolidating onto a single class
 * removes the latent foot-gun without changing the wire contract.
 *
 * Why a flat module under `server/` instead of `server/services/errors.ts`?
 * Both `api/` and `services/` import from here. Per `docs/web-architecture.md`
 * `api/ → services/ → infra/` is one-directional; a shared module that sits
 * outside `services/` keeps that invariant honest (the API tier can name
 * domain errors without pretending it imports them from the service layer).
 */

/**
 * Thrown when a workspace can't be resolved by the service tier.
 *
 * Sources:
 * - `SessionService.list` — when `resolveWorkspace(workspaceId)` returns null.
 * - `TaskService.submit` — same condition.
 * - `WorkspaceService.{rename,pin,unpin,remove}` — when the named branch is
 *   absent from the project's worktree list.
 *
 * API mapping:
 * - `api/sessions/router.ts` and `api/tasks/router.ts` translate to 404
 *   `NOT_FOUND`.
 * - `api/workspaces/router.ts` deliberately rethrows unchanged (→ 500), to
 *   preserve the legacy wire contract pinned by `apps/web/tests/trpc.test.ts`
 *   ("workspaces.create returns error for unknown project" /
 *   "workspaces.remove returns error for unknown branch" both expect 500).
 *   A semantic 404 upgrade can ride a follow-up that updates those tests in
 *   lock-step.
 *
 * The constructor takes the offending workspaceId or branch name and folds
 * it into the error message for log-grep friendliness. The identifier is
 * required: every current caller has one in hand at the throw site, and
 * forcing it keeps log lines diagnostic instead of degrading to the bare
 * `"Workspace not found"` string under future refactors.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Workspace not found: ${identifier}`);
    this.name = "WorkspaceNotFoundError";
  }
}
