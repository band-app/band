import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { TaskConflictError } from "../../../lib/task-runner";
import {
  CronjobNotFoundError,
  CronjobProjectNotFoundError,
  CronjobWorkspaceMissingError,
  cronjobCreateInput,
  cronjobService,
  cronjobUpdateInput,
  InvalidCronExpressionError,
} from "../../services/cronjob-service";
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

  get: publicProcedure.input(z.object({ key: z.string(), id: z.string() })).query(({ input }) => {
    try {
      return cronjobService.get(input.key, input.id);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  create: publicProcedure.input(cronjobCreateInput).mutation(({ input }) => {
    try {
      return cronjobService.create(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  update: publicProcedure.input(cronjobUpdateInput).mutation(({ input }) => {
    try {
      return cronjobService.update(input);
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  delete: publicProcedure
    .input(z.object({ key: z.string(), id: z.string() }))
    .mutation(({ input }) => {
      try {
        return cronjobService.delete(input.key, input.id);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  trigger: publicProcedure
    .input(z.object({ key: z.string(), id: z.string() }))
    .mutation(({ input }) => {
      try {
        return cronjobService.trigger(input.key, input.id);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),
});

export type CronjobsRouter = typeof cronjobsRouter;

/**
 * Translate `CronjobService` errors into `TRPCError`s.
 *
 * Each domain error class maps to a specific tRPC code that mirrors the
 * legacy router's behavior:
 *   - `CronjobNotFoundError` → 404 `NOT_FOUND`
 *   - `InvalidCronExpressionError` / `CronjobWorkspaceMissingError` → 400
 *   - `CronjobProjectNotFoundError` → 404
 *   - `TaskConflictError` → 409 `CONFLICT` (raised inside `service.trigger`)
 * Anything else is rethrown unchanged so unexpected failures surface as a
 * 500 with the original stack rather than being silently swallowed.
 */
function mapServiceError(err: unknown): unknown {
  if (err instanceof CronjobNotFoundError || err instanceof CronjobProjectNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof InvalidCronExpressionError || err instanceof CronjobWorkspaceMissingError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof TaskConflictError) {
    return new TRPCError({
      code: "CONFLICT",
      message: "Task already running for this chat pane",
    });
  }
  return err;
}
