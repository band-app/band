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
        if (err instanceof WorktreeNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Merge the worktree branch's open review. */
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
        if (err instanceof WorktreeNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        if (err instanceof NoOpenReviewError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
        }
        if (err instanceof ReviewProviderError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
});
