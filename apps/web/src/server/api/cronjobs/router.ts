import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  CronjobNotFoundError,
  CronjobProjectNotFoundError,
  CronjobWorkspaceMissingError,
  cronjobByIdInput,
  cronjobCreateInput,
  cronjobService,
  cronjobUpdateInput,
  InvalidCronExpressionError,
} from "../../services/cronjob-service";
import { TaskConflictError } from "../../services/task-service";
import { publicProcedure, t } from "../trpc";

/**
 * Cronjobs sub-router (issue #315, Phase 4 of the 3-tier migration).
 *
 * Same shape as the settings router: the body is intentionally thin and
 * delegates to `CronjobService`. Service-level domain errors are translated
 * into tRPC error codes here (rather than in the service) so the service
 * tier stays framework-agnostic and can be reused by non-tRPC entry points
 * (CLI, scripts, future REST surface) without dragging `TRPCError` along.
 *
 * The legacy cronjob procedures lived in `apps/web/src/trpc/router.ts`; this
 * router replaces them. The router is merged into the root `appRouter` in
 * `server/api/router.ts` and the corresponding key is dropped from the
 * legacy router in the same diff per the migration invariant documented
 * there.
 */
export const cronjobsRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({
          project: z.string().optional(),
          workspaceId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      return cronjobService.list(input);
    }),

  get: publicProcedure.input(cronjobByIdInput).query(({ input }) => {
    try {
      return cronjobService.get(input.key, input.id);
    } catch (err) {
      throwAsTRPCError(err);
    }
  }),

  create: publicProcedure.input(cronjobCreateInput).mutation(({ input }) => {
    try {
      return cronjobService.create(input);
    } catch (err) {
      throwAsTRPCError(err);
    }
  }),

  update: publicProcedure.input(cronjobUpdateInput).mutation(({ input }) => {
    try {
      return cronjobService.update(input);
    } catch (err) {
      throwAsTRPCError(err);
    }
  }),

  delete: publicProcedure.input(cronjobByIdInput).mutation(({ input }) => {
    try {
      return cronjobService.delete(input.key, input.id);
    } catch (err) {
      throwAsTRPCError(err);
    }
  }),

  trigger: publicProcedure.input(cronjobByIdInput).mutation(async ({ input }) => {
    try {
      // `trigger` is async since #581 — the via="terminal" path resolves the
      // agent adapter and spawns a PTY. `TaskConflictError` (previous terminal
      // run still active, or a running chat task) still maps to 409 below.
      return await cronjobService.trigger(input.key, input.id);
    } catch (err) {
      throwAsTRPCError(err);
    }
  }),
});

export type CronjobsRouter = typeof cronjobsRouter;

/**
 * Translate `CronjobService` errors into `TRPCError`s and throw.
 *
 * Always throws — the `: never` return type lets call sites do
 * `throwAsTRPCError(err)` without a redundant `throw` keyword and forces
 * TypeScript to treat the line as terminal control flow. Returning a
 * `TRPCError | unknown` from a helper that callers wrap in `throw` would
 * silently accept a stray non-throw use because `unknown` is too loose; the
 * `never` signature closes that hole.
 *
 * Each domain error class maps to a specific tRPC code that mirrors the
 * legacy router's behavior:
 *   - `CronjobNotFoundError` / `CronjobProjectNotFoundError` → 404 `NOT_FOUND`
 *   - `InvalidCronExpressionError` / `CronjobWorkspaceMissingError` → 400
 *   - `TaskConflictError` → 409 `CONFLICT` (raised inside `service.trigger`)
 * Anything else is rethrown unchanged so unexpected failures surface as a
 * 500 with the original stack rather than being silently swallowed.
 */
function throwAsTRPCError(err: unknown): never {
  if (err instanceof CronjobNotFoundError || err instanceof CronjobProjectNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof InvalidCronExpressionError || err instanceof CronjobWorkspaceMissingError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof TaskConflictError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Task already running for this chat pane",
    });
  }
  throw err;
}
