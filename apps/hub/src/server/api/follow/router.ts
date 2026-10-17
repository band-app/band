/**
 * `follow.*`: continue a worktree on another host when its host is offline, and settle the old
 * copy when its host comes back. Any device token may ask for an offer, continue and settle;
 * deleting the old copy needs `confirm: true`. The MCP endpoint and the worker relay leave the
 * router out, so an agent cannot move work between hosts.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { CheckpointError, ContinueGateError } from "../../errors";
import { followService } from "../../services/follow-service";
import { publicProcedure, t } from "../trpc";

function mapError(err: unknown): never {
  if (err instanceof ContinueGateError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message, cause: err });
  }
  if (err instanceof CheckpointError) {
    const code =
      err.code === "no-checkpoint"
        ? "NOT_FOUND"
        : err.code === "conflict"
          ? "CONFLICT"
          : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return mapError(err);
  }
}

const worktreeId = z.string().min(1);

export const followRouter = t.router({
  /** Who could take the work, what will not carry over, or why it cannot continue. */
  offer: publicProcedure
    .input(z.object({ worktreeId, chatId: z.string().optional() }))
    .query(({ input }) => guard(() => followService.offer(input.worktreeId, input))),

  /** Continues the worktree on `toHostId` (the recommended host when left out) from its latest checkpoint. */
  continue: publicProcedure
    .input(
      z.object({
        worktreeId,
        toHostId: z.string().min(1).optional(),
        chatId: z.string().optional(),
      }),
    )
    .mutation(({ input }) => guard(() => followService.continueOn({ ...input, reason: "manual" }))),

  /** Compares the old copy with the checkpoint the continuation used. */
  divergence: publicProcedure
    .input(z.object({ worktreeId }))
    .query(({ input }) => guard(() => followService.divergence(input.worktreeId))),

  /** The diff of one file the old copy changed since the checkpoint. */
  divergenceDiff: publicProcedure
    .input(z.object({ worktreeId, path: z.string().min(1) }))
    .query(({ input }) => guard(() => followService.divergenceDiff(input.worktreeId, input.path))),

  /** Applies the old copy's newer changes to the new copy as a patch. Conflicts change nothing. */
  bringOver: publicProcedure
    .input(z.object({ worktreeId }))
    .mutation(({ input }) => guard(() => followService.bringOver(input.worktreeId))),

  /** Removes the old copy and its files. Refused unless `confirm` is true, and for a diverged copy unless `discardChanges` is true too. */
  discardOld: publicProcedure
    .input(z.object({ worktreeId, confirm: z.boolean(), discardChanges: z.boolean().optional() }))
    .mutation(({ input }) =>
      guard(() => followService.discardOld(input.worktreeId, input.confirm, input.discardChanges)),
    ),
});

export type FollowRouter = typeof followRouter;
