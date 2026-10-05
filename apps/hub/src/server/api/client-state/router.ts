/**
 * `clientState.*` — small UI values the dashboard shares across devices
 * (open center tabs, drafts, panel layout). Thin: validates input and
 * delegates to `ClientStateService`.
 *
 * `list` returns one worktree's entries (or the global ones for
 * `worktreeId: null`) for the caller's device type. `set` and `delete` take
 * the version the client last saw and answer `{ ok: false, entry }` with the
 * current row when it is stale, instead of overwriting it.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ClientStateKeyError,
  ClientStateValueTooLargeError,
  ClientStateWorktreeNotFoundError,
} from "../../errors";
import { clientStateService } from "../../services/client-state-service";
import { publicProcedure, t } from "../trpc";

const key = z.string().min(1).max(512);
const scope = z.enum(["all", "desktop", "mobile"]);
const worktreeId = z.string().min(1).max(512).nullable();

/** Map the service's domain errors to tRPC codes; rethrow anything else. */
function rethrowClientStateError(err: unknown): never {
  if (err instanceof ClientStateValueTooLargeError) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: err.message });
  }
  if (err instanceof ClientStateKeyError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof ClientStateWorktreeNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}
const baseVersion = z.number().int().min(0);
const clientId = z.string().min(1).max(100);

export const clientStateRouter = t.router({
  list: publicProcedure
    .input(z.object({ worktreeId, deviceType: z.enum(["desktop", "mobile"]) }))
    .query(({ input }) => {
      return { entries: clientStateService.list(input.worktreeId, input.deviceType) };
    }),

  set: publicProcedure
    .input(z.object({ key, scope, value: z.unknown(), baseVersion, clientId }))
    .mutation(({ input }) => {
      try {
        return clientStateService.set(input);
      } catch (err) {
        rethrowClientStateError(err);
      }
    }),

  delete: publicProcedure
    .input(z.object({ key, scope, baseVersion, clientId }))
    .mutation(({ input }) => {
      try {
        return clientStateService.delete(input);
      } catch (err) {
        rethrowClientStateError(err);
      }
    }),
});

export type ClientStateRouter = typeof clientStateRouter;
