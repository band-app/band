/**
 * The chats this worker owns.
 *
 * - `chat.own` hands the worker a chat. The worker copies the hub's log for
 *   it (`chat.history`) and from then on runs its turns.
 * - Every row the worker logs is replicated to the hub (`chat.replicate`) in
 *   id order. The hub acks each batch, and after a drop the worker resends
 *   from its last ack. Ids come from blocks the hub leases (`chat.idBlock`).
 * - `chat.forward` brings what other clients ask: messages, stops and
 *   answers. A forward id runs once, however often the hub resends it.
 * - The desktop app on this machine reads and sends through the local
 *   listener (`local-http.ts`), which calls the same methods.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { ChatEventRow } from "@band-app/chat-runtime/log";
import { rowsToEvents } from "@band-app/chat-runtime/replay";
import {
  CHAT_ID_BLOCK_SIZE,
  type ChatEventRowWire,
  type ChatForwardParams,
  type ChatForwardReply,
  type ChatHistoryParams,
  type ChatHistoryReply,
  type ChatIdBlockReply,
  type ChatLaunchParams,
  type ChatLaunchReply,
  type ChatListSessionsReply,
  type ChatLiveState,
  type ChatOwnParams,
  type ChatReleaseParams,
  type ChatReplicateParams,
  type ChatReplicateReply,
  type ChatSetConfigParams,
  METHOD_CHAT_FORWARD,
  METHOD_CHAT_HISTORY,
  METHOD_CHAT_ID_BLOCK,
  METHOD_CHAT_LAUNCH,
  METHOD_CHAT_LIST_SESSIONS,
  METHOD_CHAT_OWN,
  METHOD_CHAT_RELEASE,
  METHOD_CHAT_REPLICATE,
  METHOD_CHAT_SESSION_STATE,
  METHOD_CHAT_SET_CONFIG,
  METHOD_CHAT_VIEW_SESSION,
  NOTIFY_CHAT_ACTIVITY,
  NOTIFY_CHAT_LIVE,
  NOTIFY_CHAT_TRANSIENT,
  RPC_CANCELLED,
  RpcError,
  readPayload,
  sendPayload,
} from "@band-app/link";
import type {
  ChatEvent,
  LoggedChatEvent,
  QueuedChatMessage,
  SessionState,
} from "@band-app/shared/chat-events";
import { agentSpawnEnv } from "../agent-env.ts";
import type { Registrar, WorkerContext } from "../context.ts";
import { ChatRuntime } from "./runtime.ts";
import type { ChatStore } from "./store.ts";
import { Turns } from "./turns.ts";

/** Rows per `chat.history` page and per `chat.replicate` batch. */
const PAGE_ROWS = 500;
/** How long the worker waits before it tries a failed replication again. */
const RETRY_MS = 2_000;
/** A new id block is leased when fewer ids than this are left. */
const LOW_IDS = CHAT_ID_BLOCK_SIZE / 2;

export type ChatListener = (event: ChatEvent) => void;

/** A message as the local listener or the hub hands it in. `files` are saved on this machine. */
export interface ChatMessage {
  text: string;
  files?: { path: string; mediaType: string; url: string; filename?: string }[];
  sessionId?: string;
  mode?: string;
  model?: string;
  codingAgentId?: string;
}

export class ChatOwner {
  private readonly runtimes = new Map<string, ChatRuntime>();
  private readonly listeners = new Map<string, Set<ChatListener>>();
  private readonly seeding = new Map<string, Promise<void>>();
  /** Chats the hub took back that are still replicating their last rows: nothing new runs. */
  private readonly releasing = new Set<string>();
  /** The hub's answer to `chat.sessionState`, per chat with no session yet. */
  private readonly catalogStates = new Map<string, SessionState>();
  private readonly turns: Turns;
  private replicating = false;
  private replicateAgain = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private leasing: Promise<void> | null = null;

  constructor(
    private readonly ctx: WorkerContext,
    readonly store: ChatStore,
  ) {
    this.turns = new Turns({
      store,
      log: ctx.log,
      runtime: (chatId) => this.runtime(chatId),
      subscribe: (chatId, listener) => this.subscribe(chatId, listener),
      sharedUrl: (chatId, filename) => {
        const worktreeId = this.store.ownedChat(chatId)?.info.worktreeId ?? "";
        return `/api/shared/${encodeURIComponent(worktreeId)}/${encodeURIComponent(chatId)}/${encodeURIComponent(filename)}`;
      },
      changed: (chatId) => this.publishLive(chatId),
    });
  }

  // ---- link ----------------------------------------------------------------

  register(r: Registrar): void {
    r.json(METHOD_CHAT_OWN, (p) => this.own(p as unknown as ChatOwnParams));
    r.json(METHOD_CHAT_FORWARD, (p) => this.forward(p as unknown as ChatForwardParams));
    r.json(METHOD_CHAT_RELEASE, (p) => this.release(p as unknown as ChatReleaseParams));
    r.json(METHOD_CHAT_SET_CONFIG, (p) => {
      const params = p as unknown as ChatSetConfigParams;
      return this.runtime(this.owned(params.chatId)).setConfigOption(params.configId, params.value);
    });
    r.json(METHOD_CHAT_VIEW_SESSION, async (p) => {
      await this.viewSession(this.owned(String(p.chatId)), p.sessionId as string | undefined);
      return {};
    });
    r.json(METHOD_CHAT_LIST_SESSIONS, async (p): Promise<ChatListSessionsReply> => {
      const chatId = this.owned(String(p.chatId));
      const sessions = await this.runtime(chatId).listSessions();
      return {
        sessions:
          sessions?.map((s) => ({
            sessionId: s.sessionId,
            title: s.title ?? undefined,
            updatedAt: s.updatedAt ?? undefined,
          })) ?? null,
      };
    });
  }

  /** Sends an event the log does not keep to the chat's subscribers. */
  notify(chatId: string, event: Parameters<ChatRuntime["broadcastTransient"]>[0]): void {
    this.runtime(chatId).broadcastTransient(event);
  }

  /**
   * Loads an unlogged session for viewing, then replicates the replayed rows so the hub
   * holds them when this returns.
   */
  async viewSession(chatId: string, sessionId?: string): Promise<void> {
    const record = this.store.ownedChat(chatId);
    // The hub's pick, when it got here before the chat's info did.
    if (
      record &&
      sessionId &&
      record.info.activeSessionId !== sessionId &&
      !this.taskRunning(chatId)
    ) {
      this.store.saveChat({ ...record.info, activeSessionId: sessionId, hasSummary: true });
    }
    await this.runtime(chatId).ensureSession("view");
    await this.flushReplication();
  }

  /** Runs what was queued before the worker last stopped, for chats whose log is copied in. */
  start(): void {
    for (const record of this.store.ownedChats()) {
      // A chat still copying in may hold a hub turn whose end is on a page not copied yet.
      if (!record.seeded) continue;
      this.closeInterruptedTurn(record.info.chatId);
      this.turns.drain(record.info.chatId);
    }
  }

  /**
   * Logs the end of a turn the worker was running when it stopped. Without it the hub, which
   * learns a turn's end only from the log, would show the chat working until the next turn.
   */
  private closeInterruptedTurn(chatId: string): void {
    const sessionId = this.activeSessionId(chatId);
    if (!sessionId) return;
    const revision = this.store.events.currentRevision(sessionId);
    if (revision === 0) return;
    const started = this.store.events.latest(sessionId, revision, { kind: "turn-started" });
    if (!started || started.event.type !== "turn-started") return;
    const ended = this.store.events.latest(sessionId, revision, { kind: "turn-ended" });
    if (ended && ended.id > started.id) return;
    const id = this.store.takeId();
    if (id === null) return;
    this.store.events.append({
      id,
      chatId,
      sessionId,
      revision,
      event: {
        type: "turn-ended",
        taskId: started.event.taskId,
        error: "The worker stopped during the turn",
        durationMs: Date.now() - started.createdAt,
      },
      createdAt: Date.now(),
    });
    this.ctx.log.info({ chatId, taskId: started.event.taskId }, "closed a turn the worker stopped");
  }

  /** The link is up: lease ids, finish copying logs, resend what the hub lacks, report each chat. */
  onConnected(): void {
    void this.ensureIds().catch((err) => this.warn("could not lease event ids", err));
    for (const record of this.store.ownedChats()) {
      if (!record.seeded) void this.seed(record.info.chatId);
      this.publishLive(record.info.chatId);
    }
    this.kickReplication();
  }

  close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const rt of this.runtimes.values()) rt.stop();
    this.runtimes.clear();
    this.store.close();
  }

  private warn(msg: string, err: unknown): void {
    this.ctx.log.warn({ message: err instanceof Error ? err.message : String(err) }, msg);
  }

  // ---- ownership -----------------------------------------------------------

  isOwned(chatId: string): boolean {
    return !this.releasing.has(chatId) && this.store.ownedChat(chatId) !== undefined;
  }

  private owned(chatId: string): string {
    if (!this.isOwned(chatId)) throw new Error(`Chat ${chatId} is not owned by this worker`);
    return chatId;
  }

  private own(params: ChatOwnParams): { ok: true } {
    const existing = this.store.ownedChat(params.chat.chatId);
    this.store.saveChat(params.chat);
    // Until the newer rows are in, readers wait and no turn starts on the stale log.
    if (existing) this.store.setSeeded(params.chat.chatId, existing.seededThrough, false);
    this.ctx.log.info({ chatId: params.chat.chatId }, "this worker owns the chat now");
    // A record kept from an earlier ownership (the hub ran the chat in between) misses the rows
    // the hub logged since. Copying resumes after the last copied row and skips rows it has.
    void this.seed(params.chat.chatId);
    if (existing?.seeded) {
      this.ctx.log.info({ chatId: params.chat.chatId }, "owned again: copying newer hub rows");
    }
    this.publishLive(params.chat.chatId);
    return { ok: true };
  }

  /** Copies the hub's rows of the chat, then makes sure this worker's next ids are above them. */
  private seed(chatId: string): Promise<void> {
    const running = this.seeding.get(chatId);
    if (running) return running;
    const work = (async () => {
      for (;;) {
        const record = this.store.ownedChat(chatId);
        if (!record) return;
        const params: ChatHistoryParams = {
          chatId,
          afterId: record.seededThrough,
          limit: PAGE_ROWS,
        };
        const reply = await this.ctx.session.request<ChatHistoryReply>(
          METHOD_CHAT_HISTORY,
          params,
          { timeoutMs: 60_000 },
        );
        const rows = await readPayload<ChatEventRowWire[]>(this.ctx.session, reply.rows);
        this.store.events.insertRows(rows.map(fromWire));
        const through = rows.at(-1)?.id ?? record.seededThrough;
        const done = rows.length < PAGE_ROWS;
        this.store.setSeeded(chatId, through, done);
        if (done) break;
      }
      // The chat's next row must sort after every row the hub has for it.
      if (this.store.peekId() <= this.store.events.maxChatId(chatId)) await this.leaseBlock();
      this.ctx.log.info({ chatId }, "copied the chat's log from the hub");
      this.turns.drain(chatId);
      this.publishLive(chatId);
    })();
    this.seeding.set(chatId, work);
    void work
      .catch((err) => this.warn(`could not copy the log of chat ${chatId}`, err))
      .finally(() => this.seeding.delete(chatId));
    return work;
  }

  /**
   * Whether the chat's log is copied in within `ms`. A reader that gets false goes to the hub,
   * which holds the same log, rather than wait for a long copy. Throws when it is not owned.
   */
  async readyWithin(chatId: string, ms: number): Promise<boolean> {
    this.owned(chatId);
    const record = this.store.ownedChat(chatId);
    if (record?.seeded && this.store.peekId() > 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.ready(chatId).then(() => true), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits until the chat's log is copied in. Rejects when it is not owned. */
  async ready(chatId: string): Promise<void> {
    this.owned(chatId);
    const record = this.store.ownedChat(chatId);
    if (record?.seeded && this.store.peekId() > 0) return;
    await (this.seeding.get(chatId) ?? this.seed(chatId));
    if (!this.store.ownedChat(chatId)?.seeded) {
      throw new Error("The chat's history is not copied from the hub yet");
    }
  }

  private async release(params: ChatReleaseParams): Promise<{ ok: true }> {
    const { chatId } = params;
    if (this.isOwned(chatId)) {
      // From here nothing new runs: no send is accepted and the aborted turn's end drains no
      // queued message, so no agent starts while the last rows replicate.
      this.releasing.add(chatId);
      this.store.clearQueue(chatId);
      this.turns.abort(chatId);
      this.runtimes.get(chatId)?.stop();
      this.runtimes.delete(chatId);
      try {
        await this.flushReplication();
      } finally {
        // A runtime made while the rows replicated (the aborted turn settling) stops too.
        this.runtimes.get(chatId)?.stop();
        this.runtimes.delete(chatId);
        this.store.dropChat(chatId, params.deleteLog === true);
        this.releasing.delete(chatId);
      }
      this.ctx.log.info({ chatId, deleteLog: params.deleteLog === true }, "gave the chat up");
    }
    return { ok: true };
  }

  // ---- ids -----------------------------------------------------------------

  private ensureIds(): Promise<void> {
    if (this.store.idsLeft() >= LOW_IDS) return Promise.resolve();
    return this.leaseBlock();
  }

  private leaseBlock(): Promise<void> {
    this.leasing ??= (async () => {
      try {
        const block = await this.ctx.session.request<ChatIdBlockReply>(METHOD_CHAT_ID_BLOCK, {});
        this.store.addBlock(block.start, block.size);
        this.ctx.log.info({ start: block.start, size: block.size }, "leased event ids");
      } finally {
        this.leasing = null;
      }
    })();
    return this.leasing;
  }

  // ---- replication ---------------------------------------------------------

  /** Local rows the hub has not acked, oldest first. */
  private unacked(limit: number): ChatEventRowWire[] {
    const acked = this.store.ackedThrough;
    const rows: ChatEventRowWire[] = [];
    for (const block of this.store.blocks()) {
      const end = block.start + block.size - 1;
      if (end <= acked) continue;
      const from = Math.max(block.start, acked + 1);
      for (const row of this.store.events.readIdRange(from, end, limit - rows.length)) {
        rows.push(row);
      }
      if (rows.length >= limit) break;
    }
    return rows;
  }

  kickReplication(): void {
    if (!this.ctx.session.attached) return;
    if (this.replicating) {
      this.replicateAgain = true;
      return;
    }
    this.replicating = true;
    void this.replicate().finally(() => {
      this.replicating = false;
      // Rows logged after the last pass looked, while it leased ids or settled, go out now.
      // After a failure the retry timer sends them.
      if (this.replicateAgain && !this.retryTimer) this.kickReplication();
    });
  }

  private async replicate(): Promise<void> {
    try {
      do {
        this.replicateAgain = false;
        for (;;) {
          const rows = this.unacked(PAGE_ROWS);
          if (rows.length === 0) break;
          const params: ChatReplicateParams = { rows: sendPayload(this.ctx.session, rows) };
          const reply = await this.ctx.session.request<ChatReplicateReply>(
            METHOD_CHAT_REPLICATE,
            params,
            { timeoutMs: 60_000 },
          );
          this.store.ackedThrough = reply.ackedThrough;
        }
      } while (this.replicateAgain);
      if (this.store.idsLeft() < LOW_IDS) await this.ensureIds();
    } catch (err) {
      if (!this.ctx.session.attached) return;
      this.warn("chat replication failed; retrying", err);
      this.retryTimer ??= setTimeout(() => {
        this.retryTimer = null;
        this.kickReplication();
      }, RETRY_MS);
    }
  }

  /** Replicates everything logged so far, when the hub is reachable. */
  private async flushReplication(): Promise<void> {
    if (!this.ctx.session.attached) return;
    while (this.replicating) await new Promise((r) => setTimeout(r, 20));
    this.replicating = true;
    try {
      await this.replicate();
    } finally {
      this.replicating = false;
    }
  }

  // ---- runtimes and events -------------------------------------------------

  runtime(chatId: string): ChatRuntime {
    let rt = this.runtimes.get(chatId);
    if (!rt) {
      rt = new ChatRuntime(chatId, {
        host: this.ctx.host,
        store: this.store,
        log: this.ctx.log,
        launch: (id, agentId) => this.launch(id, agentId),
        assertMayRun: (cwd) => this.ctx.lease.assertMayRun(cwd),
        spawnEnv: (env) => agentSpawnEnv(this.ctx, env),
        emit: (id, event) => this.emit(id, event),
        logged: () => this.kickReplication(),
        stateChanged: (id) => this.publishLive(id),
        activity: (id, kind) => {
          if (this.ctx.session.attached) {
            this.ctx.session.notify(NOTIFY_CHAT_ACTIVITY, { chatId: id, kind });
          }
        },
      });
      this.runtimes.set(chatId, rt);
    }
    return rt;
  }

  /** The launch for the chat's agent: a fresh one from the hub, else the last one it gave. */
  private async launch(chatId: string, agentId?: string): Promise<ChatLaunchReply> {
    const cached = this.store.ownedChat(chatId)?.launch ?? null;
    if (this.ctx.session.attached) {
      try {
        const params: ChatLaunchParams = { chatId, ...(agentId ? { agentId } : {}) };
        const launch = await this.ctx.session.request<ChatLaunchReply>(METHOD_CHAT_LAUNCH, params, {
          timeoutMs: 30_000,
        });
        // The cache outlives the login, so it keeps neither the secret nor the variables it clears.
        const { loginEnv: _loginEnv, unsetEnv: _unsetEnv, ...cacheable } = launch;
        this.store.saveLaunch(chatId, cacheable);
        return launch;
      } catch (err) {
        // The hub answered and said no (the chat is no longer this worker's): never run it.
        if (err instanceof RpcError && err.code !== RPC_CANCELLED) throw err;
        if (!cached) throw err;
        this.warn("the hub did not answer chat.launch; using the last launch", err);
      }
    }
    if (cached && (!agentId || cached.agent.id === agentId)) return cached;
    throw new Error(
      "The hub is not reachable, and this chat's agent never started on this machine before.",
    );
  }

  subscribe(chatId: string, listener: ChatListener): () => void {
    let subs = this.listeners.get(chatId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(chatId, subs);
    }
    subs.add(listener);
    return () => {
      subs.delete(listener);
      if (subs.size === 0) this.listeners.delete(chatId);
    };
  }

  private emit(chatId: string, event: ChatEvent): void {
    for (const listener of this.listeners.get(chatId) ?? []) {
      try {
        listener(event);
      } catch (err) {
        this.warn("chat listener threw", err);
      }
    }
    // Events the log does not keep reach the hub's subscribers too.
    if (event.eventId < 0 && this.ctx.session.attached) {
      this.ctx.session.notify(NOTIFY_CHAT_TRANSIENT, { chatId, event });
    }
  }

  // ---- what clients read ---------------------------------------------------

  taskRunning(chatId: string): boolean {
    return this.turns.task(chatId) !== undefined;
  }

  queue(chatId: string): QueuedChatMessage[] {
    return this.store.queue(chatId).map((m) => ({
      id: m.id,
      text: m.text,
      ...(m.files && m.files.length > 0
        ? {
            files: m.files.map((f) => ({
              mediaType: f.mediaType,
              url: f.url,
              filename: f.filename,
            })),
          }
        : {}),
    }));
  }

  /**
   * The chat's session settings: from its session here, else, for a chat with
   * no session yet, the hub's (its agent catalog), kept for when the hub is away.
   */
  async sessionState(chatId: string): Promise<SessionState> {
    const own = this.runtime(chatId).sessionState();
    if (own.source !== "cached") return own;
    if (this.ctx.session.attached) {
      try {
        const state = await this.ctx.session.request<SessionState>(
          METHOD_CHAT_SESSION_STATE,
          { chatId },
          { timeoutMs: 5_000 },
        );
        this.catalogStates.set(chatId, state);
        return state;
      } catch (err) {
        this.warn("could not read the hub's session state", err);
      }
    }
    return this.catalogStates.get(chatId) ?? own;
  }

  activeSessionId(chatId: string): string | undefined {
    return this.store.ownedChat(chatId)?.info.activeSessionId;
  }

  worktreeId(chatId: string): string | undefined {
    return this.store.ownedChat(chatId)?.info.worktreeId;
  }

  logRevision(sessionId: string): number {
    return this.store.events.currentRevision(sessionId);
  }

  replayAfter(sessionId: string, revision: number, afterId: number): ChatEvent[] {
    return rowsToEvents(this.store.events.readAfter(sessionId, revision, afterId));
  }

  replayTurns(
    sessionId: string,
    revision: number,
    turns: number,
    beforeId?: number,
  ): { events: ChatEvent[]; hasOlder: boolean; oldestEventId: number } {
    const { rows, hasOlder } = this.store.events.readTurns(sessionId, revision, turns, beforeId);
    return { events: rowsToEvents(rows), hasOlder, oldestEventId: rows[0]?.id ?? 0 };
  }

  private publishLive(chatId: string): void {
    if (!this.ctx.session.attached || !this.isOwned(chatId)) return;
    const task = this.turns.task(chatId);
    const rt = this.runtimes.get(chatId);
    const state: ChatLiveState = {
      chatId,
      taskRunning: task !== undefined,
      ...(task ? { task: { id: task.id, startedAt: task.startedAt, prompt: task.prompt } } : {}),
      queue: this.queue(chatId),
      pending: rt?.pendingRequestIds() ?? [],
      workDeadline: rt?.workDeadline() ?? null,
    };
    this.ctx.session.notify(NOTIFY_CHAT_LIVE, state);
    for (const listener of this.listeners.get(chatId) ?? []) {
      listener({ type: "queue-updated", messages: state.queue, eventId: -1 });
    }
  }

  // ---- what clients ask ----------------------------------------------------

  /** Runs a message now, or queues it behind the running turn. */
  async send(chatId: string, message: ChatMessage): Promise<{ queued: boolean }> {
    await this.ready(chatId);
    const { queued } = this.turns.submit(chatId, message);
    return { queued };
  }

  stop(chatId: string): boolean {
    this.owned(chatId);
    return this.turns.abort(chatId);
  }

  answerPermission(chatId: string, requestId: string, optionId: string | null): boolean {
    this.owned(chatId);
    return this.runtimes.get(chatId)?.answerPermission(requestId, optionId) ?? false;
  }

  answerElicitation(
    chatId: string,
    requestId: string,
    response: acp.CreateElicitationResponse,
  ): boolean {
    this.owned(chatId);
    return this.runtimes.get(chatId)?.answerElicitation(requestId, response) ?? false;
  }

  /**
   * A request the hub forwarded. A send is queued in the same transaction
   * that records its forward id, so a resend after a lost reply finds the id
   * and runs nothing twice.
   */
  private forward(params: ChatForwardParams): ChatForwardReply {
    const { forwardId, chatId, action } = params;
    const earlier = this.store.forwardReply(forwardId) as ChatForwardReply | undefined;
    if (earlier) return earlier;
    this.owned(chatId);
    let reply: ChatForwardReply;
    switch (action.kind) {
      case "send": {
        const { kind: _kind, ...message } = action;
        // Queued first, so the forward id and the message are stored together.
        const queued = this.turns.task(chatId) !== undefined || this.store.queue(chatId).length > 0;
        this.store.transaction(() => {
          this.store.pushQueued(chatId, { ...message, id: forwardId });
          this.store.recordForward(forwardId, { ok: true, queued });
        });
        if (this.store.ownedChat(chatId)?.seeded) this.turns.drain(chatId);
        this.publishLive(chatId);
        return { ok: true, queued };
      }
      case "stop":
        reply = { ok: this.turns.abort(chatId) };
        break;
      case "permission":
        reply = { ok: this.answerPermission(chatId, action.requestId, action.optionId) };
        break;
      case "elicitation":
        reply = {
          ok: this.answerElicitation(
            chatId,
            action.requestId,
            action.response as acp.CreateElicitationResponse,
          ),
        };
        break;
      case "queue-remove":
        reply = { ok: this.turns.removeQueued(chatId, action.queuedMessageId) };
        break;
      case "queue-update":
        reply = { ok: this.turns.updateQueued(chatId, action.queuedMessageId, action.text) };
        break;
      case "queue-reorder":
        this.turns.reorderQueue(chatId, action.ids);
        reply = { ok: true };
        break;
      case "queue-clear":
        this.turns.clearQueue(chatId);
        reply = { ok: true };
        break;
    }
    this.store.recordForward(forwardId, reply);
    return reply;
  }
}

function fromWire(row: ChatEventRowWire): ChatEventRow {
  return { ...row, event: row.event as LoggedChatEvent };
}
