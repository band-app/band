import type { WorktreeReview } from "@band-app/plugin-api";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorktreeNotFoundError } from "../../errors";
import {
  NoOpenReviewError,
  ReviewProviderError,
  reviewService,
} from "../../services/review-service";
import { publicProcedure, t } from "../trpc";

function toTrpcError(err: unknown): unknown {
  if (err instanceof WorktreeNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof NoOpenReviewError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  if (err instanceof ReviewProviderError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return err;
}

/**
 * Code reviews (pull requests) and checks for a worktree's branch. The data
 * comes from the review provider a plugin registers for the repo's
 * `origin` host; see `ReviewService`.
 */
export const reviewsRouter = t.router({
  /**
   * The review for the worktree's branch with its checks, or the branch's
   * CI jobs when there is no review. Provider failures come back as
   * `status: "error"` rather than a thrown error, so the panel can show them.
   */
  forWorktree: publicProcedure
    .input(z.object({ worktreeId: z.string() }))
    .query(async ({ input }): Promise<WorktreeReview> => {
      try {
        return await reviewService.forWorktree(input.worktreeId);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The provider that serves the worktree's repo, or null. Runs no forge command, so it is cheap to ask. */
  provider: publicProcedure.input(z.object({ worktreeId: z.string() })).query(async ({ input }) => {
    try {
      return await reviewService.providerFor(input.worktreeId);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Run one of the actions the provider listed in the review's `actions`. */
  runAction: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        actionId: z.string().min(1).max(100),
        args: z
          .record(z.union([z.string().max(500), z.number(), z.boolean()]))
          .refine((o) => Object.keys(o).length <= 10, "Too many arguments.")
          .default({}),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await reviewService.runAction(input.worktreeId, input.actionId, input.args);
        return { ok: true as const };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Merge the worktree branch's open review. Wraps the `merge` action. */
  merge: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        method: z.enum(["merge", "squash", "rebase"]),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await reviewService.merge(input.worktreeId, input.method);
        return { ok: true as const };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Run CI jobs of the worktree's branch again. */
  rerunChecks: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        targets: z
          .array(
            z.object({
              runId: z.string().regex(/^\d+$/),
              jobId: z.string().regex(/^\d+$/).optional(),
              failedOnly: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await reviewService.rerunChecks(input.worktreeId, input.targets);
        return { ok: true as const };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});
