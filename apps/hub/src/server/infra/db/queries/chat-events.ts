/**
 * The hub's chat event log: `@band-app/chat-runtime`'s queries on the hub's
 * database. A worker that owns its chats runs the same queries on its own
 * database.
 */

import { type ChatLogDb, ChatEventQueries as LogQueries } from "@band-app/chat-runtime/log";

import { getDb } from "../connection";

export type {
  AppendChatEvent,
  ChatEventRow,
  LoggedSessionSummary,
} from "@band-app/chat-runtime/log";

export class ChatEventQueries extends LogQueries {
  constructor() {
    // The package resolves its own copy of drizzle-orm (pnpm keys it by the
    // peers it sees), so the two class types differ although the API is one.
    super(getDb as unknown as () => ChatLogDb);
  }
}
