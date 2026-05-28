import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolvePendingInput } from "../../services/task-service";
import { publicProcedure, t } from "../trpc";

/**
 * Chat sub-router — migrated out of the legacy `apps/web/src/trpc/router.ts`
 * as part of Phase 8 (issue #319). The single `chat.answer` procedure
 * resolves an outstanding agent-side input request (i.e. a tool that asked
 * the user a question) using the pending-input registry owned by
 * `task-service`.
 *
 * The plural `chats.*` namespace (Phase 5, issue #316) is a completely
 * different sub-router; do not confuse the two. The `chat` key is kept
 * separate to preserve the wire surface every existing client (ChatPane's
 * approval modal handler) already speaks.
 */
export const chatRouter = t.router({
  answer: publicProcedure
    .input(z.object({ approvalId: z.string(), answers: z.record(z.string(), z.string()) }))
    .mutation(({ input }) => {
      const resolved = resolvePendingInput(input.approvalId, input.answers);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No pending input found for this approvalId",
        });
      }
      return { ok: true };
    }),
});

export type ChatRouter = typeof chatRouter;
