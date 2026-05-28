import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorkspaceNotFoundError } from "../../errors";
import type { ListSessionsResponse } from "../../services/session-service";
import { sessionService } from "../../services/session-service";
import { publicProcedure, t } from "../trpc";

/**
 * Sessions sub-router (Phase 6 of the 3-tier migration — issue #317).
 *
 * Thin façade over `SessionService` — same shape as the cronjobs / tasks
 * routers. Service-level domain errors are translated to tRPC error codes
 * here so the service tier stays framework-agnostic.
 *
 * The legacy `sessionsRouter` in `apps/web/src/trpc/router.ts` is replaced
 * by this file and the corresponding key is dropped from the legacy router
 * in the same diff per the migration invariant in
 * `server/api/router.ts`.
 *
 * Why this surface is small (and why most "session" reads don't go through
 * here): the chat-events stream (`apps/web/src/api/chat-events.ts`) covers
 * JSONL backfill, gap-fill replay, and live tail in a single subscription.
 * The legacy `sessions.messages` query was deleted with the chat-event-log
 * refactor (see `docs/experiments/chat-event-log.md`). All that remains
 * here is the explicit "list past sessions for this chat pane" read.
 */
export const sessionsRouter = t.router({
  list: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(async ({ input }): Promise<ListSessionsResponse> => {
      // Explicit return-type annotation pins the wire contract even though
      // TypeScript infers it correctly today (the `never` from
      // `throwAsTrpcError` is propagated out of the catch, so the inferred
      // type is `Promise<ListSessionsResponse>` — not nullable). Pinning the
      // annotation guards against a future edit that adds an unguarded code
      // path (e.g. a fall-through `return undefined`) silently widening the
      // procedure's return union. Same pattern below for `tasks.submit` and
      // `tasks.rerun` mutation handlers.
      try {
        return await sessionService.list(input);
      } catch (err) {
        throwAsTrpcError(err);
      }
    }),
});

export type SessionsRouter = typeof sessionsRouter;

/**
 * Translate `SessionService` errors into `TRPCError`s and throw.
 *
 * `: never` so callers can `throwAsTrpcError(err)` without a redundant
 * `throw` keyword (same convention as cronjobs / tasks routers).
 *
 *   - `WorkspaceNotFoundError` → 404 `NOT_FOUND`
 *
 * Anything else is rethrown unchanged so unexpected failures surface as
 * a 500 with the original stack.
 */
function throwAsTrpcError(err: unknown): never {
  if (err instanceof WorkspaceNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}
