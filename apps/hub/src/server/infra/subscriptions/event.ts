import { z } from "zod";

/**
 * A normalised event from any source. Sources (webhooks, timers, GitHub
 * polling) map their payloads to this shape and hand it to
 * `SubscriptionService.ingest`; nothing downstream sees raw payloads.
 *
 * `key` names what the event is about and is what subscriptions match on,
 * e.g. `github:pr:owner/repo#123`, `github:ci:owner/repo@branch`,
 * `hook:<subscriptionId>`, `timer:<subscriptionId>`. `id` is the source's
 * own delivery id, so a redelivery of the same event is dropped.
 */
export const subscriptionEventSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  kind: z.string().min(1),
  key: z.string().min(1),
  url: z.string(),
  actor: z.string(),
  summary: z.string(),
  /** When the event happened, in epoch milliseconds. */
  at: z.number().int().min(0).max(8.64e15),
  /** Caused by Band's own action (for example a push from a workspace). */
  self: z.boolean().optional(),
});

export type SubscriptionEvent = z.infer<typeof subscriptionEventSchema>;
