import { TRPCError } from "@trpc/server";
import {
  PlainProjectError,
  workspaceCreateInput,
  workspaceGitInput,
  workspaceRemoveInput,
  workspaceRunScriptInput,
  workspaceService,
  workspaceSetPinnedInput,
} from "../../services/workspace-service";
import { publicProcedure, t } from "../trpc";

/**
 * Workspaces sub-router (Phase 3 of the 3-tier migration — issue #314).
 *
 * Same shape as the settings router: the body is thin and delegates to
 * `WorkspaceService`. Service-level domain errors are translated into
 * tRPC error codes here (rather than in the service) so the service tier
 * stays framework-agnostic and can be reused by non-tRPC entry points
 * (CLI, scripts, future REST surface) without dragging `TRPCError` along.
 *
 * The legacy workspace lifecycle procedures lived in
 * `apps/web/src/trpc/router.ts` under the `workspacesRouter` key; this
 * router replaces them. The new router is merged into the root `appRouter`
 * in `server/api/router.ts` and the corresponding key is dropped from the
 * legacy router in the same diff per the migration invariant documented
 * there.
 */
export const workspacesRouter = t.router({
  create: publicProcedure.input(workspaceCreateInput).mutation(({ input }) => {
    try {
      return workspaceService.create(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  remove: publicProcedure.input(workspaceRemoveInput).mutation(async ({ input }) => {
    try {
      return await workspaceService.remove(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  setPinned: publicProcedure.input(workspaceSetPinnedInput).mutation(({ input }) => {
    try {
      return workspaceService.setPinned(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  gitPull: publicProcedure.input(workspaceGitInput).mutation(async ({ input }) => {
    try {
      return await workspaceService.gitPull(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  gitPush: publicProcedure.input(workspaceGitInput).mutation(async ({ input }) => {
    try {
      return await workspaceService.gitPush(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  runScript: publicProcedure.input(workspaceRunScriptInput).mutation(async ({ input }) => {
    try {
      return await workspaceService.runScript(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),
});

export type WorkspacesRouter = typeof workspacesRouter;

/**
 * Translate `WorkspaceService` domain errors into `TRPCError`s.
 *
 * Each domain error class maps to the legacy router's behaviour:
 *   - `ProjectNotFoundError`        → plain `Error` rethrow (preserves the
 *     pre-migration 500 the dashboard already handles for unknown
 *     projects).
 *   - `WorkspaceNotFoundError`      → plain `Error` rethrow (same — the
 *     legacy `throw new Error("Workspace ... not found")` surfaced as 500).
 *   - `PlainProjectError`           → 400 `BAD_REQUEST` (matched legacy
 *     `TRPCError({code: "BAD_REQUEST", ...})`).
 *
 * Anything else is rethrown unchanged so unexpected failures surface as
 * `INTERNAL_SERVER_ERROR` with the original stack — matches how the
 * legacy router behaved (raw throws bubbled out of `mutation`/`query`
 * handlers).
 *
 * `ProjectNotFoundError` and `WorkspaceNotFoundError` deliberately stay
 * on the 500 path rather than upgrading to 404 — a 4xx flip would change
 * the wire-level contract pinned by `apps/web/tests/trpc.test.ts`
 * ("workspaces.create returns error for unknown project" and
 * "workspaces.remove returns error for unknown branch" both
 * `expect(res.status).toBe(500)`). A semantic 404 upgrade can ride a
 * follow-up that updates the tests together.
 */
function mapServiceError(err: unknown): unknown {
  if (err instanceof PlainProjectError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  // `ProjectNotFoundError` and `WorkspaceNotFoundError` (and every other
  // throw — `Error`, `TRPCError`, etc.) fall through unchanged: tRPC
  // surfaces a bare `Error` as `INTERNAL_SERVER_ERROR` (500), preserving
  // the legacy wire-level contract documented in the header comment.
  return err;
}
