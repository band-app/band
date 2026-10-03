import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { chatService } from "../../services/chat-service";
import {
  InvalidTimerError,
  type Subscription,
  SubscriptionChatNotFoundError,
  subscriptionService,
} from "../../services/subscription-service";
import { publicProcedure, t } from "../trpc";

/** A subscription as the API shows it: no webhook secret hash. */
function present(sub: Subscription) {
  const { config, ...rest } = sub;
  return {
    ...rest,
    ...(config.at !== undefined && { at: config.at }),
    ...(config.cron && { cron: config.cron }),
  };
}

const agentTarget = {
  chatId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
};

// One flat object rather than a union: the MCP endpoint turns each input
// schema into tool parameters and needs an object.
const createInput = z.object({
  source: z.enum(["webhook", "timer"]),
  ...agentTarget,
  coalesceSeconds: z.number().int().min(0).max(3600).optional(),
  maxWakeups: z.number().int().min(1).optional(),
  /** Epoch milliseconds. Defaults to, and is capped at, 180 days from now. */
  expiresAt: z.number().int().optional(),
  createdBy: z.enum(["agent", "coordinator", "user"]).optional(),
  /** Timer only: fire once at this time, in epoch milliseconds. */
  at: z.number().int().optional(),
  /**
   * Timer only: recurring cron expression. A timer needs exactly one of `at` and `cron`.
   * A cron timer ends after `maxWakeups` fires (default 10).
   */
  cron: z.string().min(1).optional(),
});

/**
 * Subscriptions sub-router (plan step S.2). `create` fills `chatId` and
 * `workspaceId` from the caller when it is an agent (the `x-band-chat-id`
 * and `x-band-workspace-id` headers), so an agent only names the source.
 */
export const subscriptionsRouter = t.router({
  create: publicProcedure.input(createInput).mutation(({ input, ctx }) => {
    const chatId = input.chatId ?? ctx.chatId;
    if (!chatId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "chatId is required when the call does not come from an agent's chat",
      });
    }
    const workspaceId =
      input.workspaceId ?? ctx.workspaceId ?? chatService.get(chatId)?.workspaceId;
    if (!workspaceId) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Chat ${chatId} not found` });
    }
    try {
      const { source, at, cron, ...common } = input;
      if (source === "webhook") {
        if (at !== undefined || cron !== undefined) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "`at` and `cron` apply to timers only",
          });
        }
        const { subscription, token } = subscriptionService.createWebhook({
          ...common,
          chatId,
          workspaceId,
        });
        return {
          ...present(subscription),
          // Shown once. Send it as `X-Band-Webhook-Token` or `Authorization: Bearer`.
          webhook: { path: `/api/hooks/${subscription.id}`, token },
        };
      }
      return present(subscriptionService.createTimer({ ...common, at, cron, chatId, workspaceId }));
    } catch (err) {
      if (err instanceof SubscriptionChatNotFoundError) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
      if (err instanceof z.ZodError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.issues.map((i) => i.message).join("; "),
        });
      }
      if (err instanceof InvalidTimerError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
      throw err;
    }
  }),

  list: publicProcedure.input(z.object(agentTarget).optional()).query(({ input, ctx }) => {
    return subscriptionService
      .list({
        chatId: input?.chatId ?? (input?.workspaceId ? undefined : ctx.chatId),
        workspaceId: input?.workspaceId,
      })
      .map(present);
  }),

  remove: publicProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ input }) => {
    if (!subscriptionService.remove(input.id)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Subscription ${input.id} not found` });
    }
    return { ok: true as const };
  }),

  events: publicProcedure.input(z.object({ id: z.string().min(1) })).query(({ input }) => {
    return subscriptionService.listEvents(input.id);
  }),
});

export type SubscriptionsRouter = typeof subscriptionsRouter;
