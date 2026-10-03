import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { subscriptionEvents, subscriptions } from "../schema";

type Row = typeof subscriptions.$inferSelect;

export type SubscriptionCreator = Row["createdBy"];

export interface SubscriptionRecord {
  id: string;
  chatId: string;
  workspaceId: string;
  source: string;
  /** Event kinds that match; empty matches every kind. */
  kinds: string[];
  /** Event key the subscription listens to. */
  filterKey: string;
  coalesceSeconds: number;
  maxWakeups: number;
  wakeups: number;
  expiresAt: number;
  createdBy: SubscriptionCreator;
  createdAt: number;
}

export interface SubscriptionEventRecord {
  eventId: string;
  subscriptionId: string;
  receivedAt: number;
  deliveredAt: number | null;
  summary: string;
}

function toRecord(row: Row): SubscriptionRecord {
  let kinds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    kinds = [];
  }
  return { ...row, kinds };
}

export class SubscriptionQueries {
  insert(record: SubscriptionRecord): void {
    getDb()
      .insert(subscriptions)
      .values({ ...record, kinds: JSON.stringify(record.kinds) })
      .run();
  }

  list(): SubscriptionRecord[] {
    return getDb().select().from(subscriptions).all().map(toRecord);
  }

  find(id: string): SubscriptionRecord | undefined {
    const row = getDb().select().from(subscriptions).where(eq(subscriptions.id, id)).get();
    return row ? toRecord(row) : undefined;
  }

  setWakeups(id: string, wakeups: number): void {
    getDb().update(subscriptions).set({ wakeups }).where(eq(subscriptions.id, id)).run();
  }

  /** Deletes the subscription and its event rows. */
  remove(id: string): void {
    getDb().transaction((tx) => {
      tx.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, id)).run();
      tx.delete(subscriptions).where(eq(subscriptions.id, id)).run();
    });
  }

  /** Ids of the subscriptions of a chat, or of a workspace's chats. */
  idsFor(scope: { chatId: string } | { workspaceId: string }): string[] {
    const where =
      "chatId" in scope
        ? eq(subscriptions.chatId, scope.chatId)
        : eq(subscriptions.workspaceId, scope.workspaceId);
    return getDb()
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(where)
      .all()
      .map((r) => r.id);
  }

  /** Records an event for a subscription. Returns false when it was seen before. */
  insertEventIfAbsent(record: SubscriptionEventRecord): boolean {
    const result = getDb().insert(subscriptionEvents).values(record).onConflictDoNothing().run();
    return Number(result.changes ?? 0) > 0;
  }

  markDelivered(eventIds: string[], deliveredAt: number): void {
    if (eventIds.length === 0) return;
    getDb()
      .update(subscriptionEvents)
      .set({ deliveredAt })
      .where(
        and(inArray(subscriptionEvents.eventId, eventIds), isNull(subscriptionEvents.deliveredAt)),
      )
      .run();
  }

  events(subscriptionId: string): SubscriptionEventRecord[] {
    return getDb()
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
      .all();
  }
}
