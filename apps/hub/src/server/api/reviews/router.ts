import type { WorkspaceReview } from "@band-app/plugin-api";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorkspaceNotFoundError } from "../../errors";
import {
  NoOpenReviewError,
  ReviewProviderError,
  reviewService,
} from "../../services/review-service";
import { publicProcedure, t } from "../trpc";

/**
 * Code reviews (pull requests) and checks for a workspace's branch. The data
 * comes from the review provider a plugin registers for the project's
 * `origin` host; see `ReviewService`.
 */
export const reviewsRouter = t.router({
  /**
   * The review for the workspace's branch with its checks, or the branch's
   * CI jobs when there is no review. Provider failures come back as
   * `status: "error"` rather than a thrown error, so the panel can show them.
   */
  forWorkspace: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }): Promise<WorkspaceReview> => {
      try {
        return await reviewService.forWorkspace(input.workspaceId);
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /** Merge the workspace branch's open review. */
  merge: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        method: z.enum(["merge", "squash", "rebase"]),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await reviewService.merge(input.workspaceId, input.method);
        return { ok: true as const };
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
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
