/**
 * The outbox of requests for chats a worker owns, and the rows a worker sent
 * for a chat it no longer owns.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { chatEventHolds, chatForwards } from "../schema";

export interface ChatForwardRow {
  id: string;
  chatId: string;
  hostId: string;
  method: string;
  params: unknown;
  createdAt: number;
}

function toRow(r: typeof chatForwards.$inferSelect): ChatForwardRow {
  return {
    id: r.id,
    chatId: r.chatId,
    hostId: r.hostId,
    method: r.method,
    params: JSON.parse(r.params) as unknown,
    createdAt: r.createdAt,
  };
}

export class ChatForwardQueries {
  add(row: ChatForwardRow): void {
    getDb()
      .insert(chatForwards)
      .values({ ...row, params: JSON.stringify(row.params) })
      .run();
  }

  /**
   * The oldest request a host has not answered yet. Ordered by rowid, because two rows of one
   * millisecond have random ids.
   */
  nextPending(hostId: string): ChatForwardRow | undefined {
    const row = getDb()
      .select()
      .from(chatForwards)
      .where(and(eq(chatForwards.hostId, hostId), isNull(chatForwards.deliveredAt)))
      .orderBy(sql`rowid`)
      .limit(1)
      .get();
    return row ? toRow(row) : undefined;
  }

  /** Requests of a chat no host has answered yet, in the order they were added. */
  pendingForChat(chatId: string): ChatForwardRow[] {
    return getDb()
      .select()
      .from(chatForwards)
      .where(and(eq(chatForwards.chatId, chatId), isNull(chatForwards.deliveredAt)))
      .orderBy(sql`rowid`)
      .all()
      .map(toRow);
  }

  /** Replaces the params of a request that has not gone out yet. */
  setParams(id: string, params: unknown): void {
    getDb()
      .update(chatForwards)
      .set({ params: JSON.stringify(params) })
      .where(and(eq(chatForwards.id, id), isNull(chatForwards.deliveredAt)))
      .run();
  }

  /**
   * Drops a request: the worker answered it (its own forward ids keep a resend from running
   * twice), or nobody will run it (its chat was removed, or it went elsewhere).
   */
  remove(id: string): void {
    getDb().delete(chatForwards).where(eq(chatForwards.id, id)).run();
  }

  /** Keeps a row a worker sent for a chat it no longer owns. A resent row is kept once. */
  hold(hostId: string, chatId: string, id: number, row: unknown, at: number): void {
    getDb()
      .insert(chatEventHolds)
      .values({ hostId, chatId, id, row: JSON.stringify(row), receivedAt: at })
      .onConflictDoNothing()
      .run();
  }

  /** Drops the rows held for a removed chat. */
  dropHolds(chatId: string): void {
    getDb().delete(chatEventHolds).where(eq(chatEventHolds.chatId, chatId)).run();
  }

  /** How many rows are held for a chat. */
  heldCount(chatId: string): number {
    return getDb()
      .select({ id: chatEventHolds.id })
      .from(chatEventHolds)
      .where(eq(chatEventHolds.chatId, chatId))
      .all().length;
  }
}
