/**
 * Band's chat event log (issue #648).
 *
 * Every chat talks to its coding agent over ACP. This table keeps what
 * crossed that connection, per agent session: `session/update`
 * notifications, prompts Band sent, permission / elicitation requests and
 * their answers, turn boundaries. The chat SSE stream replays it on
 * subscribe and gap-fills from it on reconnect, so the log is the source of
 * truth for a chat's history. `session/load` is only the fallback for
 * sessions Band never recorded.
 *
 * Rows are grouped by `(session_id, revision)`. A session's log has one
 * live revision, the highest; older revisions are superseded logs kept
 * until the chat is removed.
 */

import { HISTORY_PAGE_MAX_ROWS, type LoggedChatEvent } from "@band-app/shared/chat-events";
import { and, asc, desc, eq, gt, inArray, lt, max, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { chatEvents } from "./log-schema";

/** A drizzle database that has the `chat_events` table: the hub's, or an owning worker's. */
export type ChatLogDb = BaseSQLiteDatabase<"sync", unknown>;

export interface ChatEventRow {
  id: number;
  chatId: string;
  sessionId: string;
  revision: number;
  event: LoggedChatEvent;
  /** First row of a turn: a prompt, or a replayed user message. */
  turnStart: boolean;
  createdAt: number;
}

export interface AppendChatEvent {
  chatId: string;
  sessionId: string;
  revision: number;
  event: LoggedChatEvent;
  /** First row of a turn: a prompt, or a replayed user message. */
  turnStart?: boolean;
  /** Epoch ms; defaults to now. */
  createdAt?: number;
  /** The row id, for a writer that holds a block of ids (an owning worker). Else the next one. */
  id?: number;
}

/** A session Band has a log for, as the history dropdown lists it. */
export interface LoggedSessionSummary {
  sessionId: string;
  title: string | undefined;
  updatedAt: number;
}

type DbRow = typeof chatEvents.$inferSelect;

function toRow(r: DbRow): ChatEventRow {
  return {
    id: r.id,
    chatId: r.chatId,
    sessionId: r.sessionId,
    revision: r.revision,
    event: JSON.parse(r.payload) as LoggedChatEvent,
    turnStart: r.turnStart,
    createdAt: r.createdAt,
  };
}

function indexFields(event: LoggedChatEvent): {
  updateKind: string | null;
  messageId: string | null;
  toolCallId: string | null;
} {
  if (event.type !== "update") {
    const toolCallId =
      event.type === "permission"
        ? event.request.toolCall.toolCallId
        : event.type === "elicitation" && "toolCallId" in event.request
          ? ((event.request.toolCallId as string | null | undefined) ?? null)
          : null;
    return { updateKind: null, messageId: null, toolCallId };
  }
  const u = event.update;
  return {
    updateKind: u.sessionUpdate,
    messageId: "messageId" in u ? (u.messageId ?? null) : null,
    toolCallId: "toolCallId" in u ? u.toolCallId : null,
  };
}

export class ChatEventQueries {
  constructor(private readonly db: () => ChatLogDb) {}

  /** The live revision of a session's log, or 0 when Band has none. */
  currentRevision(sessionId: string): number {
    const row = this.db()
      .select({ revision: max(chatEvents.revision) })
      .from(chatEvents)
      .where(eq(chatEvents.sessionId, sessionId))
      .get();
    return row?.revision ?? 0;
  }

  /** Appends one event and returns its id. */
  append(input: AppendChatEvent): number {
    const row = this.db()
      .insert(chatEvents)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        chatId: input.chatId,
        sessionId: input.sessionId,
        revision: input.revision,
        kind: input.event.type,
        ...indexFields(input.event),
        turnStart: input.turnStart ?? false,
        payload: JSON.stringify(input.event),
        createdAt: input.createdAt ?? Date.now(),
      })
      .returning({ id: chatEvents.id })
      .get();
    return row.id;
  }

  /**
   * Inserts rows another log wrote, keeping their ids. A row whose id is
   * already here is skipped, so a resent batch adds nothing twice. Returns
   * the rows that were new.
   */
  insertRows(rows: ChatEventRow[]): ChatEventRow[] {
    const inserted: ChatEventRow[] = [];
    this.db().transaction((tx) => {
      for (const row of rows) {
        const done = tx
          .insert(chatEvents)
          .values({
            id: row.id,
            chatId: row.chatId,
            sessionId: row.sessionId,
            revision: row.revision,
            kind: row.event.type,
            ...indexFields(row.event),
            turnStart: row.turnStart,
            payload: JSON.stringify(row.event),
            createdAt: row.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: chatEvents.id })
          .get();
        if (done) inserted.push(row);
      }
    });
    return inserted;
  }

  /** A chat's rows after `afterId`, every session and revision, oldest first. */
  readChat(chatId: string, afterId: number, limit: number): ChatEventRow[] {
    return this.db()
      .select()
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chatId), gt(chatEvents.id, afterId)))
      .orderBy(asc(chatEvents.id))
      .limit(limit)
      .all()
      .map(toRow);
  }

  /** Rows of every chat with an id in `[from, to]`, oldest first. */
  readIdRange(from: number, to: number, limit: number): ChatEventRow[] {
    return this.db()
      .select()
      .from(chatEvents)
      .where(and(sql`${chatEvents.id} >= ${from}`, sql`${chatEvents.id} <= ${to}`))
      .orderBy(asc(chatEvents.id))
      .limit(limit)
      .all()
      .map(toRow);
  }

  /** The highest row id of a chat, or 0 when it has none. */
  maxChatId(chatId: string): number {
    const row = this.db()
      .select({ id: max(chatEvents.id) })
      .from(chatEvents)
      .where(eq(chatEvents.chatId, chatId))
      .get();
    return row?.id ?? 0;
  }

  /** The highest id this log has used or reserved for another writer. */
  reservedThrough(): number {
    const used = this.db().get<{ seq: number | null }>(
      sql`select max(coalesce((select seq from sqlite_sequence where name = 'chat_events'), 0), coalesce((select max(id) from chat_events), 0)) as seq`,
    );
    return used?.seq ?? 0;
  }

  /**
   * Reserves `size` ids for another writer: the ids after every id this
   * log has used, which its own appends then skip, because SQLite's
   * AUTOINCREMENT continues after the stored sequence. Returns the first id.
   */
  reserveIdBlock(size: number): number {
    return this.db().transaction((tx) => {
      const used = tx.get<{ seq: number | null }>(
        sql`select max(coalesce((select seq from sqlite_sequence where name = 'chat_events'), 0), coalesce((select max(id) from chat_events), 0)) as seq`,
      );
      const start = (used?.seq ?? 0) + 1;
      const last = start + size - 1;
      const updated = tx.run(
        sql`update sqlite_sequence set seq = ${last} where name = 'chat_events'`,
      ) as { changes?: number | bigint };
      if (Number(updated.changes ?? 0) === 0) {
        tx.run(sql`insert into sqlite_sequence (name, seq) values ('chat_events', ${last})`);
      }
      return start;
    });
  }

  /** Events after `afterId` in one revision, oldest first. */
  readAfter(sessionId: string, revision: number, afterId: number): ChatEventRow[] {
    return this.db()
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          gt(chatEvents.id, afterId),
        ),
      )
      .orderBy(chatEvents.id)
      .all()
      .map(toRow);
  }

  /**
   * The last `turns` turns before `beforeId` (the whole revision when
   * `beforeId` is undefined), oldest first, shortened to the newest whole
   * turns that fit `HISTORY_PAGE_MAX_ROWS` (the newest turn is always kept).
   * `hasOlder` says whether rows exist before the returned window.
   */
  readTurns(
    sessionId: string,
    revision: number,
    turns: number,
    beforeId?: number,
  ): { rows: ChatEventRow[]; hasOlder: boolean } {
    const db = this.db();
    const scope = and(
      eq(chatEvents.sessionId, sessionId),
      eq(chatEvents.revision, revision),
      beforeId === undefined ? undefined : lt(chatEvents.id, beforeId),
    );
    const starts = db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(and(scope, eq(chatEvents.turnStart, true)))
      .orderBy(desc(chatEvents.id))
      .limit(turns)
      .all();
    // Keep adding older turns while the page stays within the row bound.
    // One query lists the newest ids of the window; a turn is kept when the
    // rows from its start to the end fit the bound.
    let kept = starts.length;
    if (starts.length > 1) {
      const ids = db
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(and(scope, sql`${chatEvents.id} >= ${starts[starts.length - 1].id}`))
        .orderBy(desc(chatEvents.id))
        .limit(HISTORY_PAGE_MAX_ROWS + 1)
        .all()
        .map((r) => r.id);
      for (let i = 1; i < starts.length; i++) {
        // Rows from starts[i] to the end = ids at or above it.
        const count = ids.findIndex((id) => id < starts[i].id);
        if ((count === -1 ? ids.length : count) > HISTORY_PAGE_MAX_ROWS) {
          kept = i;
          break;
        }
      }
    }
    // Fewer turn starts than asked for, all kept, means the window reaches
    // the start of the log, including any rows before the first turn (a
    // session attach, a commands update).
    const from = kept === starts.length && starts.length < turns ? undefined : starts[kept - 1]?.id;
    const rows = db
      .select()
      .from(chatEvents)
      .where(and(scope, from === undefined ? undefined : sql`${chatEvents.id} >= ${from}`))
      .orderBy(chatEvents.id)
      .all()
      .map(toRow);
    if (from === undefined) return { rows, hasOlder: false };
    const older = db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          lt(chatEvents.id, from),
        ),
      )
      .limit(1)
      .get();
    return { rows, hasOlder: older !== undefined };
  }

  /**
   * The newest row in a revision matching an event kind, or a
   * `session/update` kind (`{ updateKind: "usage_update" }`).
   */
  latest(
    sessionId: string,
    revision: number,
    match: { kind: LoggedChatEvent["type"] } | { updateKind: string },
  ): ChatEventRow | undefined {
    const row = this.db()
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          "kind" in match
            ? eq(chatEvents.kind, match.kind)
            : eq(chatEvents.updateKind, match.updateKind),
        ),
      )
      .orderBy(desc(chatEvents.id))
      .limit(1)
      .get();
    return row ? toRow(row) : undefined;
  }

  /**
   * Sessions the given chats have logged, newest first, titled by their
   * first prompt. Stands in for `session/list` on agents that don't
   * support it.
   */
  listSessions(chatIds: string[]): LoggedSessionSummary[] {
    if (chatIds.length === 0) return [];
    const db = this.db();
    const sessions = db
      .select({
        sessionId: chatEvents.sessionId,
        updatedAt: max(chatEvents.createdAt),
        firstPromptId: sql<
          number | null
        >`min(case when ${chatEvents.kind} = 'prompt' then ${chatEvents.id} end)`,
      })
      .from(chatEvents)
      .where(inArray(chatEvents.chatId, chatIds))
      .groupBy(chatEvents.sessionId)
      .orderBy(desc(max(chatEvents.createdAt)))
      .all();
    const promptIds = sessions.flatMap((s) => (s.firstPromptId == null ? [] : [s.firstPromptId]));
    const prompts = new Map<number, string>();
    if (promptIds.length > 0) {
      for (const row of db
        .select()
        .from(chatEvents)
        .where(inArray(chatEvents.id, promptIds))
        .all()) {
        const event = toRow(row).event;
        if (event.type === "prompt") prompts.set(row.id, event.text);
      }
    }
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.firstPromptId == null ? undefined : prompts.get(s.firstPromptId),
      updatedAt: s.updatedAt ?? 0,
    }));
  }

  /** The first prompt of a session's live revision, used as its title. */
  firstPrompt(sessionId: string): string | undefined {
    const revision = this.currentRevision(sessionId);
    if (revision === 0) return undefined;
    const row = this.db()
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          eq(chatEvents.kind, "prompt"),
        ),
      )
      .orderBy(chatEvents.id)
      .limit(1)
      .get();
    const event = row ? toRow(row).event : undefined;
    return event?.type === "prompt" ? event.text : undefined;
  }

  /** The prompt events of a session's live revision, oldest first. */
  readPrompts(sessionId: string, revision: number): ChatEventRow[] {
    return this.db()
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          eq(chatEvents.kind, "prompt"),
        ),
      )
      .orderBy(chatEvents.id)
      .all()
      .map(toRow);
  }

  /** `session/update` rows of the given kinds after `afterId` in one revision, oldest first. */
  readUpdatesAfter(
    sessionId: string,
    revision: number,
    afterId: number,
    updateKinds: string[],
  ): ChatEventRow[] {
    return this.db()
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          eq(chatEvents.revision, revision),
          gt(chatEvents.id, afterId),
          inArray(chatEvents.updateKind, updateKinds),
        ),
      )
      .orderBy(chatEvents.id)
      .all()
      .map(toRow);
  }

  /** Drops every row a chat wrote. Called when the chat is removed. */
  deleteForChat(chatId: string): void {
    this.db().delete(chatEvents).where(eq(chatEvents.chatId, chatId)).run();
  }
}
