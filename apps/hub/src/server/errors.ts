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
 *   preserve the legacy wire contract pinned by `apps/hub/tests/trpc.test.ts`
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

/**
 * Thrown by `BrowserProfileService` for an unknown browser profile id.
 * `api/browser-profiles/router.ts` and `api/browsers/router.ts` map it to
 * 404 `NOT_FOUND`.
 */
export class BrowserProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Browser profile not found: ${profileId}`);
    this.name = "BrowserProfileNotFoundError";
  }
}

/**
 * Thrown by `BrowserProfileService.create` when the requested id or name is
 * taken. `api/browser-profiles/router.ts` maps it to 409 `CONFLICT`.
 */
export class BrowserProfileExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProfileExistsError";
  }
}

/**
 * Thrown by `ClientStateService.set` when a value's JSON is over
 * `CLIENT_STATE_MAX_VALUE_BYTES`. `api/client-state/router.ts` maps it to 413
 * `PAYLOAD_TOO_LARGE`.
 */
export class ClientStateValueTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`Client state value is ${bytes} bytes; the limit is ${limit}`);
    this.name = "ClientStateValueTooLargeError";
  }
}

/**
 * Thrown by `ClientStateService` for a key that isn't a synced client-state
 * key (`shared/client-state-keys.ts`), or a scope the key doesn't use.
 * `api/client-state/router.ts` maps it to 400 `BAD_REQUEST`.
 */
export class ClientStateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientStateKeyError";
  }
}

/**
 * Thrown by `ClientStateService` for a write to a key of a workspace that
 * doesn't exist (for example deleted while the writing device was offline).
 * `api/client-state/router.ts` maps it to 404 `NOT_FOUND`.
 */
export class ClientStateWorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = "ClientStateWorkspaceNotFoundError";
  }
}

/**
 * Thrown by `TokenService.revoke` for an unknown token id.
 * `api/tokens/router.ts` maps it to 404 `NOT_FOUND`.
 */
export class TokenNotFoundError extends Error {
  constructor(tokenId: string) {
    super(`Token not found: ${tokenId}`);
    this.name = "TokenNotFoundError";
  }
}

/**
 * Thrown by `TokenService.revoke` for the shared token, which the desktop
 * app and the CLI read from `settings.json`. `api/tokens/router.ts` maps it
 * to 409 `CONFLICT`.
 */
export class SharedTokenRevokeError extends Error {
  constructor() {
    super(
      "The shared token is the one in settings.json. Rotate it by removing tokenSecret and restarting the hub.",
    );
    this.name = "SharedTokenRevokeError";
  }
}

/**
 * Thrown by `VaultService` for an unknown item id or flow id.
 * `api/vault/router.ts` maps it to 404 `NOT_FOUND`.
 */
export class VaultNotFoundError extends Error {
  constructor(what = "Credential") {
    super(`${what} not found`);
    this.name = "VaultNotFoundError";
  }
}

/**
 * Thrown by `VaultService` for input or state the caller can fix: a bad
 * name, a missing key, an OAuth server that refuses. The message never
 * holds a secret. `api/vault/router.ts` maps it to 400 `BAD_REQUEST`.
 */
export class VaultInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultInputError";
  }
}
