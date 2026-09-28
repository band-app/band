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

import { and, desc, eq, gt, inArray, lt, max, sql } from "drizzle-orm";
import type { LoggedChatEvent } from "../../../../shared/chat-events";
import { getDb } from "../connection";
import { chatEvents } from "../schema";

export interface ChatEventRow {
  id: number;
  chatId: string;
  sessionId: string;
  revision: number;
  event: LoggedChatEvent;
  createdAt: number;
}

export interface AppendChatEvent {
  chatId: string;
  sessionId: string;
  revision: number;
  event: LoggedChatEvent;
  /** First row of a turn: a prompt, or a replayed user message. */
  turnStart?: boolean;
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
  /** The live revision of a session's log, or 0 when Band has none. */
  currentRevision(sessionId: string): number {
    const row = getDb()
      .select({ revision: max(chatEvents.revision) })
      .from(chatEvents)
      .where(eq(chatEvents.sessionId, sessionId))
      .get();
    return row?.revision ?? 0;
  }

  /** Appends one event and returns its id. */
  append(input: AppendChatEvent): number {
    const row = getDb()
      .insert(chatEvents)
      .values({
        chatId: input.chatId,
        sessionId: input.sessionId,
        revision: input.revision,
        kind: input.event.type,
        ...indexFields(input.event),
        turnStart: input.turnStart ?? false,
        payload: JSON.stringify(input.event),
        createdAt: Date.now(),
      })
      .returning({ id: chatEvents.id })
      .get();
    return row.id;
  }

  /** Events after `afterId` in one revision, oldest first. */
  readAfter(sessionId: string, revision: number, afterId: number): ChatEventRow[] {
    return getDb()
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
   * `beforeId` is undefined), oldest first. `hasOlder` says whether rows
   * exist before the returned window.
   */
  readTurns(
    sessionId: string,
    revision: number,
    turns: number,
    beforeId?: number,
  ): { rows: ChatEventRow[]; hasOlder: boolean } {
    const db = getDb();
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
    // Fewer turn starts than asked for means the window reaches the start
    // of the log, including any rows before the first turn (a session
    // attach, a commands update).
    const from = starts.length < turns ? undefined : starts[starts.length - 1].id;
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
    const row = getDb()
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
    const db = getDb();
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
    const row = getDb()
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

  /** Drops every row a chat wrote. Called when the chat is removed. */
  deleteForChat(chatId: string): void {
    getDb().delete(chatEvents).where(eq(chatEvents.chatId, chatId)).run();
  }
}
