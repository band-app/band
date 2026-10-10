import { TRPCError } from "@trpc/server";
import {
  PlainRepoError,
  worktreeCreateInput,
  worktreeGitInput,
  worktreeRemoveInput,
  worktreeRunScriptInput,
  worktreeService,
  worktreeSetPinnedInput,
} from "../../services/worktree-service";
import { publicProcedure, t } from "../trpc";

/**
 * Worktrees sub-router (Phase 3 of the 3-tier migration — issue #314).
 *
 * Same shape as the settings router: the body is thin and delegates to
 * `WorktreeService`. Service-level domain errors are translated into
 * tRPC error codes here (rather than in the service) so the service tier
 * stays framework-agnostic and can be reused by non-tRPC entry points
 * (CLI, scripts, future REST surface) without dragging `TRPCError` along.
 *
 * The legacy worktree lifecycle procedures lived in
 * `apps/web/src/trpc/router.ts` under the `worktreesRouter` key; this
 * router replaces them. The new router is merged into the root `appRouter`
 * in `server/api/router.ts` and the corresponding key is dropped from the
 * legacy router in the same diff per the migration invariant documented
 * there.
 */
export const worktreesRouter = t.router({
  create: publicProcedure.input(worktreeCreateInput).mutation(async ({ input, ctx }) => {
    try {
      return await worktreeService.create(input, {
        worktreeId: ctx.worktreeId,
        chatId: ctx.chatId,
        terminalId: ctx.terminalId,
      });
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),

  remove: publicProcedure.input(worktreeRemoveInput).mutation(async ({ input }) => {
    try {
      return await worktreeService.remove(input);
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),

  setPinned: publicProcedure.input(worktreeSetPinnedInput).mutation(({ input }) => {
    try {
      return worktreeService.setPinned(input);
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),

  gitPull: publicProcedure.input(worktreeGitInput).mutation(async ({ input }) => {
    try {
      return await worktreeService.gitPull(input);
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),

  gitPush: publicProcedure.input(worktreeGitInput).mutation(async ({ input }) => {
    try {
      return await worktreeService.gitPush(input);
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),

  runScript: publicProcedure.input(worktreeRunScriptInput).mutation(async ({ input }) => {
    try {
      return await worktreeService.runScript(input);
    } catch (err) {
      throwAsTrpcError(err);
    }
  }),
});

export type WorktreesRouter = typeof worktreesRouter;

/**
 * Translate `WorktreeService` domain errors into `TRPCError`s and throw.
 *
 * Declared `never` so call sites read as `throwAsTrpcError(err)` (not
 * `throw mapServiceError(err)`): the function never returns, so a future
 * edit can't accidentally capture the result into a local before throwing
 * and the control-flow shape is clear at the call site.
 *
 * Only `PlainRepoError` has an explicit branch here — it maps to a
 * 400 `BAD_REQUEST`, matching the legacy router's
 * `TRPCError({code: "BAD_REQUEST", ...})`. Every other throw
 * (`RepoNotFoundError`, `WorktreeNotFoundError`, plain `Error`,
 * `TRPCError`, …) is rethrown unchanged so tRPC surfaces it as
 * `INTERNAL_SERVER_ERROR` (500) with the original stack — matching how
 * the legacy router behaved (raw throws bubbled out of `mutation`/
 * `query` handlers).
 *
 * `RepoNotFoundError` / `WorktreeNotFoundError` deliberately stay
 * on the 500 path rather than upgrading to 404 — a 4xx flip would
 * change the wire-level contract pinned by `apps/hub/tests/trpc.test.ts`
 * ("worktrees.create returns error for unknown repo" and
 * "worktrees.remove returns error for unknown branch" both
 * `expect(res.status).toBe(500)`). A semantic 404 upgrade can ride a
 * follow-up that updates the tests together.
 */
function throwAsTrpcError(err: unknown): never {
  if (err instanceof PlainRepoError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  // `RepoNotFoundError` and `WorktreeNotFoundError` (and every other
  // throw — `Error`, `TRPCError`, etc.) are rethrown unchanged: tRPC
  // surfaces a bare `Error` as `INTERNAL_SERVER_ERROR` (500), preserving
  // the legacy wire-level contract documented in the header comment.
  throw err;
}
