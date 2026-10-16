import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Chat event log (issue #648). One row per event on an agent session: the
// ACP `session/update` notifications the agent sends, the prompts Band
// sends, permission / elicitation requests and their answers, and turn
// boundaries. `id` is the gap-fill cursor the browser holds (the SSE
// `Last-Event-ID`); it only grows, across sessions and revisions.
//
// `revision` changes when Band rebuilds a session's log from an agent's
// `session/load` replay. Readers serve only the highest revision, and a
// client holding an older one gets a full reset instead of a gap-fill.
//
// `message_id` / `tool_call_id` are copied out of the payload so readers can
// merge consecutive text chunks of one message and find a tool call's rows
// without parsing JSON. `turn_start` marks the first row of a turn (a
// prompt, or a replayed user message) for turn-based paging.
export const chatEvents = sqliteTable(
  "chat_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: text("chat_id").notNull(),
    sessionId: text("session_id").notNull(),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    // The `sessionUpdate` discriminator for `kind = 'update'` rows.
    updateKind: text("update_kind"),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id"),
    turnStart: integer("turn_start", { mode: "boolean" }).notNull().default(false),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("chat_events_session_idx").on(t.sessionId, t.revision, t.id),
    // `latest()` lookups by event kind / update kind (session state on
    // every cold subscribe).
    index("chat_events_kind_idx").on(t.sessionId, t.revision, t.kind, t.id),
    index("chat_events_update_kind_idx").on(t.sessionId, t.revision, t.updateKind, t.id),
    // Turn-based paging (`readTurns`) finds the last N turn starts.
    index("chat_events_turn_start_idx").on(t.sessionId, t.revision, t.turnStart, t.id),
    index("chat_events_chat_idx").on(t.chatId),
  ],
);
