/**
 * The owning worker's chat store (docs/architecture/chat-ownership.md):
 * `<state dir>/chats.db`, one SQLite file with
 *
 * - `chat_events`: the same table, ids and rows as the hub's log;
 * - `owned_chats`: what the worker knows of each chat it owns, and the last
 *   launch the hub gave it, for starting the agent while the hub is away;
 * - `id_blocks`: the event ids the hub leased the worker;
 * - `queued_messages`: messages waiting for a running turn;
 * - `forwards`: ids of requests the hub forwarded, so a resend runs once;
 * - `meta`: the next event id and the replication ack.
 *
 * `node:sqlite` loads only when the worker owns chats, so a worker on a Node
 * without it still starts.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ChatEventQueries, type ChatLogDb } from "@band-app/chat-runtime/log";
import type { ChatLaunchReply, OwnedChatInfo } from "@band-app/link";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_events (
  id integer PRIMARY KEY AUTOINCREMENT,
  chat_id text NOT NULL,
  session_id text NOT NULL,
  revision integer NOT NULL,
  kind text NOT NULL,
  update_kind text,
  message_id text,
  tool_call_id text,
  turn_start integer DEFAULT false NOT NULL,
  payload text NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_events_session_idx ON chat_events (session_id, revision, id);
CREATE INDEX IF NOT EXISTS chat_events_kind_idx ON chat_events (session_id, revision, kind, id);
CREATE INDEX IF NOT EXISTS chat_events_update_kind_idx ON chat_events (session_id, revision, update_kind, id);
CREATE INDEX IF NOT EXISTS chat_events_turn_start_idx ON chat_events (session_id, revision, turn_start, id);
CREATE INDEX IF NOT EXISTS chat_events_chat_idx ON chat_events (chat_id);
CREATE TABLE IF NOT EXISTS owned_chats (
  chat_id text PRIMARY KEY,
  info text NOT NULL,
  launch text,
  seeded_through integer NOT NULL DEFAULT 0,
  seeded integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS id_blocks (
  start integer PRIMARY KEY,
  size integer NOT NULL
);
CREATE TABLE IF NOT EXISTS queued_messages (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  seq integer NOT NULL,
  payload text NOT NULL
);
CREATE TABLE IF NOT EXISTS forwards (
  forward_id text PRIMARY KEY,
  reply text NOT NULL,
  at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value integer NOT NULL
);
`;

/** A message waiting for the chat's running turn. `files` carry the path the agent reads. */
export interface StoredQueuedMessage {
  id: string;
  text: string;
  files?: { path: string; mediaType: string; url: string; filename?: string }[];
  sessionId?: string;
  mode?: string;
  model?: string;
  codingAgentId?: string;
}

export interface OwnedChatRecord {
  info: OwnedChatInfo;
  launch: ChatLaunchReply | null;
  /** The highest hub row id copied in. */
  seededThrough: number;
  /** Whether the hub's log for the chat is copied in. */
  seeded: boolean;
}

/** Forwarded requests kept for dedup: a resend comes within minutes, so a day is plenty. */
const FORWARD_KEEP_MS = 24 * 60 * 60_000;

export class ChatStore {
  readonly events: ChatEventQueries;

  private constructor(private readonly db: DatabaseSync) {
    this.events = new ChatEventQueries(() => this.drizzle);
  }

  private drizzle!: ChatLogDb;

  static async open(file: string): Promise<ChatStore> {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import("node:sqlite");
    const { drizzle } = await import("drizzle-orm/node-sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    const store = new ChatStore(db);
    store.drizzle = drizzle({ client: db }) as unknown as ChatLogDb;
    store.loadIds();
    db.prepare("DELETE FROM forwards WHERE at < ?").run(Date.now() - FORWARD_KEEP_MS);
    return store;
  }

  close(): void {
    if (this.current()) this.setMeta("next_id", this.next);
    this.db.close();
  }

  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- meta ----------------------------------------------------------------

  private meta(key: string): number | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: number): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** The highest local row id the hub has acked. */
  get ackedThrough(): number {
    return this.meta("acked_through") ?? 0;
  }

  set ackedThrough(id: number) {
    if (id > this.ackedThrough) this.setMeta("acked_through", id);
  }

  // ---- ids -----------------------------------------------------------------

  /** Leased blocks, oldest first, and the next local id. Cached: a turn takes an id per streamed chunk. */
  private leased: { start: number; size: number }[] = [];
  private next = 0;

  private loadIds(): void {
    this.leased = this.db.prepare("SELECT start, size FROM id_blocks ORDER BY start").all() as {
      start: number;
      size: number;
    }[];
    // The ids a crash may have taken without saving `next_id` are in the log.
    const used = this.leased.map((b) => {
      const row = this.db
        .prepare("SELECT max(id) AS id FROM chat_events WHERE id >= ? AND id < ?")
        .get(b.start, b.start + b.size) as { id: number | null };
      return row.id ?? 0;
    });
    this.next = Math.max(this.meta("next_id") ?? 0, ...used.map((id) => (id > 0 ? id + 1 : 0)));
  }

  blocks(): { start: number; size: number }[] {
    return [...this.leased];
  }

  private current(): { start: number; size: number } | undefined {
    return this.leased.find((b) => this.next >= b.start && this.next < b.start + b.size);
  }

  /** Adds a leased block and moves the next id into it when it is above the current one. */
  addBlock(start: number, size: number): void {
    this.db.prepare("INSERT OR IGNORE INTO id_blocks (start, size) VALUES (?, ?)").run(start, size);
    if (!this.leased.some((b) => b.start === start)) {
      this.leased.push({ start, size });
      this.leased.sort((a, b) => a.start - b.start);
    }
    if (start > this.next || !this.current()) {
      this.next = start;
      this.setMeta("next_id", start);
    }
  }

  /** Ids left in the current block. */
  idsLeft(): number {
    const block = this.current();
    return block ? block.start + block.size - this.next : 0;
  }

  /** Takes the next leased id, or null when the worker holds none. */
  takeId(): number | null {
    if (!this.current()) return null;
    return this.next++;
  }

  /** The id the next local row gets, or 0 with none leased. */
  peekId(): number {
    return this.current() ? this.next : 0;
  }

  // ---- owned chats ---------------------------------------------------------

  ownedChats(): OwnedChatRecord[] {
    const rows = this.db.prepare("SELECT * FROM owned_chats").all() as {
      info: string;
      launch: string | null;
      seeded_through: number;
      seeded: number;
    }[];
    return rows.map((r) => ({
      info: JSON.parse(r.info) as OwnedChatInfo,
      launch: r.launch ? (JSON.parse(r.launch) as ChatLaunchReply) : null,
      seededThrough: r.seeded_through,
      seeded: r.seeded === 1,
    }));
  }

  ownedChat(chatId: string): OwnedChatRecord | undefined {
    return this.ownedChats().find((c) => c.info.chatId === chatId);
  }

  saveChat(info: OwnedChatInfo): void {
    this.db
      .prepare(
        "INSERT INTO owned_chats (chat_id, info) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET info = excluded.info",
      )
      .run(info.chatId, JSON.stringify(info));
  }

  saveLaunch(chatId: string, launch: ChatLaunchReply): void {
    this.db
      .prepare("UPDATE owned_chats SET launch = ? WHERE chat_id = ?")
      .run(JSON.stringify(launch), chatId);
  }

  setSeeded(chatId: string, through: number, done: boolean): void {
    this.db
      .prepare("UPDATE owned_chats SET seeded_through = ?, seeded = ? WHERE chat_id = ?")
      .run(through, done ? 1 : 0, chatId);
  }

  /** Forgets the chat. With `deleteLog` its rows go too; otherwise they stay for the record. */
  dropChat(chatId: string, deleteLog: boolean): void {
    this.db.prepare("DELETE FROM owned_chats WHERE chat_id = ?").run(chatId);
    this.db.prepare("DELETE FROM queued_messages WHERE chat_id = ?").run(chatId);
    if (deleteLog) this.events.deleteForChat(chatId);
  }

  // ---- queue ---------------------------------------------------------------

  queue(chatId: string): StoredQueuedMessage[] {
    const rows = this.db
      .prepare("SELECT payload FROM queued_messages WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as StoredQueuedMessage);
  }

  pushQueued(chatId: string, message: StoredQueuedMessage): void {
    const row = this.db
      .prepare("SELECT coalesce(max(seq), 0) AS seq FROM queued_messages WHERE chat_id = ?")
      .get(chatId) as { seq: number };
    this.db
      .prepare("INSERT INTO queued_messages (id, chat_id, seq, payload) VALUES (?, ?, ?, ?)")
      .run(message.id, chatId, row.seq + 1, JSON.stringify(message));
  }

  removeQueued(chatId: string, id: string): boolean {
    const res = this.db
      .prepare("DELETE FROM queued_messages WHERE chat_id = ? AND id = ?")
      .run(chatId, id);
    return Number(res.changes) > 0;
  }

  updateQueued(chatId: string, id: string, text: string): boolean {
    const message = this.queue(chatId).find((m) => m.id === id);
    if (!message) return false;
    this.db
      .prepare("UPDATE queued_messages SET payload = ? WHERE chat_id = ? AND id = ?")
      .run(JSON.stringify({ ...message, text }), chatId, id);
    return true;
  }

  /** Puts the queue in the order of `ids`. Messages it does not name keep their place at the end. */
  reorderQueue(chatId: string, ids: string[]): void {
    const current = this.queue(chatId).map((m) => m.id);
    const order = [
      ...ids.filter((id) => current.includes(id)),
      ...current.filter((id) => !ids.includes(id)),
    ];
    this.transaction(() => {
      order.forEach((id, i) => {
        this.db
          .prepare("UPDATE queued_messages SET seq = ? WHERE chat_id = ? AND id = ?")
          .run(i + 1, chatId, id);
      });
    });
  }

  clearQueue(chatId: string): void {
    this.db.prepare("DELETE FROM queued_messages WHERE chat_id = ?").run(chatId);
  }

  // ---- forwards ------------------------------------------------------------

  /** The reply a forwarded request got, when it ran before. */
  forwardReply(forwardId: string): unknown {
    const row = this.db.prepare("SELECT reply FROM forwards WHERE forward_id = ?").get(forwardId) as
      | { reply: string }
      | undefined;
    return row ? JSON.parse(row.reply) : undefined;
  }

  recordForward(forwardId: string, reply: unknown): void {
    this.db
      .prepare("INSERT OR IGNORE INTO forwards (forward_id, reply, at) VALUES (?, ?, ?)")
      .run(forwardId, JSON.stringify(reply), Date.now());
  }
}
