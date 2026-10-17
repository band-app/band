import { initTRPC, TRPCError } from "@trpc/server";

import { BranchOnOtherHostError, ContinueGateError } from "../errors";
import type { Context } from "./context";

/**
 * Shared tRPC builder for the 3-tier architecture.
 *
 * Every sub-router under `server/api/*` must import `t` and
 * `publicProcedure` from this module. tRPC's `mergeRouters` only accepts
 * routers built from the same builder instance, so creating a second
 * `initTRPC.context<Context>().create()` anywhere else would silently
 * break the merge in `server/api/router.ts`.
 */
export const t = initTRPC.context<Context>().create({
  // A refusal for a branch that already lives on another host names that worktree, so a client
  // can open it without parsing the message.
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (cause instanceof BranchOnOtherHostError) {
      return {
        ...shape,
        data: { ...shape.data, existingWorktreeId: cause.worktreeId, existingHostId: cause.hostId },
      };
    }
    // A refusal to act on a worktree whose host is offline carries the offer (who could take the
    // work, or why nobody can), so the UI shows its prompt without parsing the message.
    if (cause instanceof ContinueGateError) {
      return { ...shape, data: { ...shape.data, hostOffline: cause.answer } };
    }
    return shape;
  },
});

export const publicProcedure = t.procedure;

/** For procedures that manage credentials: only an admin device token passes. */
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.admin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This token cannot manage tokens or credentials. Use an admin token.",
    });
  }
  return next();
});
