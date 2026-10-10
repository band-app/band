/**
 * Shared domain errors for the server tier.
 *
 * Lives one level above `services/` so the three worktree-owning services
 * (`session-service`, `task-service`, `worktree-service`) can throw the same
 * error class without re-declaring it. Before #317 Phase 6, each service had
 * its own `WorktreeNotFoundError` with `this.name = "WorktreeNotFoundError"`
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
 * Thrown when a worktree can't be resolved by the service tier.
 *
 * Sources:
 * - `SessionService.list` — when `resolveWorktree(worktreeId)` returns null.
 * - `TaskService.submit` — same condition.
 * - `WorktreeService.{rename,pin,unpin,remove}` — when the named branch is
 *   absent from the repo's worktree list.
 *
 * API mapping:
 * - `api/sessions/router.ts` and `api/tasks/router.ts` translate to 404
 *   `NOT_FOUND`.
 * - `api/worktrees/router.ts` deliberately rethrows unchanged (→ 500), to
 *   preserve the legacy wire contract pinned by `apps/hub/tests/trpc.test.ts`
 *   ("worktrees.create returns error for unknown repo" /
 *   "worktrees.remove returns error for unknown branch" both expect 500).
 *   A semantic 404 upgrade can ride a follow-up that updates those tests in
 *   lock-step.
 *
 * The constructor takes the offending worktreeId or branch name and folds
 * it into the error message for log-grep friendliness. The identifier is
 * required: every current caller has one in hand at the throw site, and
 * forcing it keeps log lines diagnostic instead of degrading to the bare
 * `"Worktree not found"` string under future refactors.
 */
export class WorktreeNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Worktree not found: ${identifier}`);
    this.name = "WorktreeNotFoundError";
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
 * Thrown by `ClientStateService` for a write to a key of a worktree that
 * doesn't exist (for example deleted while the writing device was offline).
 * `api/client-state/router.ts` maps it to 404 `NOT_FOUND`.
 */
export class ClientStateWorktreeNotFoundError extends Error {
  constructor(worktreeId: string) {
    super(`Worktree not found: ${worktreeId}`);
    this.name = "ClientStateWorktreeNotFoundError";
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

/**
 * Thrown by `McpProxyService` for input the caller can fix: a bad server name
 * or URL, an unknown vault item, a token for a server that doesn't exist.
 * `api/mcp-servers/router.ts` maps it to 400 `BAD_REQUEST`.
 */
export class McpProxyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProxyInputError";
  }
}

/** Thrown by `McpProxyService` for an unknown server name. Mapped to 404 `NOT_FOUND`. */
export class McpServerNotFoundError extends Error {
  constructor(name: string) {
    super(`MCP server "${name}" not found`);
    this.name = "McpServerNotFoundError";
  }
}

/** Thrown by `RepoService` for input the caller can fix, such as a bad URL or a folder with no repo. Mapped to 400. */
export class RepoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoInputError";
  }
}

/** Thrown by `RepoService` when the repo is already registered. Mapped to 409. */
export class RepoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoConflictError";
  }
}

/**
 * Thrown by `RepoService.addFromWorker` when the picked folder is outside the directories the
 * worker serves. The UI asks the user to confirm and calls again with `addRoot`. Mapped to
 * PRECONDITION_FAILED with the roots in the message.
 */
export class RepoOutsideRootsError extends Error {
  readonly path: string;
  readonly roots: string[];
  constructor(path: string, roots: string[]) {
    super(`${path} is outside the directories this host serves (${roots.join(", ") || "none"}).`);
    this.name = "RepoOutsideRootsError";
    this.path = path;
    this.roots = roots;
  }
}
