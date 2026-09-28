import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { agentSessionService } from "../../services/agent-session-service";
import { publicProcedure, t } from "../trpc";

/**
 * Chat sub-router: answers to requests the coding agent is blocked on
 * (issue #648). The agent asks over ACP; the request reaches the chat as a
 * `permission` or `elicitation` event carrying a `requestId`.
 *
 * The plural `chats.*` namespace is a different sub-router (pane CRUD).
 */
const elicitationValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const chatRouter = t.router({
  /** Answers `session/request_permission` with one of its options, or
   *  `null` to cancel it. */
  answer: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        requestId: z.string(),
        optionId: z.string().nullable(),
      }),
    )
    .mutation(({ input }) => {
      if (!agentSessionService.answerPermission(input.chatId, input.requestId, input.optionId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No pending request with this id" });
      }
      return { ok: true };
    }),

  /** Answers a form `elicitation/create` (e.g. Claude Code's
   *  AskUserQuestion). */
  answerElicitation: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        requestId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.string(), elicitationValue).optional(),
      }),
    )
    .mutation(({ input }) => {
      const response =
        input.action === "accept"
          ? { action: "accept" as const, content: input.content ?? {} }
          : { action: input.action };
      if (!agentSessionService.answerElicitation(input.chatId, input.requestId, response)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No pending request with this id" });
      }
      return { ok: true };
    }),
});

export type ChatRouter = typeof chatRouter;
