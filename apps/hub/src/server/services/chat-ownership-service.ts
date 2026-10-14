/**
 * Chats a worker owns (docs/architecture/chat-ownership.md).
 *
 * A worker whose hello lists `chatOwnership` runs the chats of its worktrees.
 * The hub then:
 *
 * - hands it each chat at a clean point (no turn, nothing waiting on the
 *   user, no background work, nothing queued on the hub) with `chat.own`,
 *   after stopping its own agent process for the chat;
 * - stores the rows the worker replicates (`chat.replicate`) in `chat_events`
 *   with the worker's ids, and keeps tasks, agent status and checkpoints in
 *   step from them;
 * - forwards what other clients ask (messages, stops, answers, queue edits)
 *   through the `chat_forwards` outbox, which waits while the worker is
 *   offline and runs each request once;
 * - keeps the worker's live state (running turn, queue, open requests) for
 *   clients that read the chat from the hub.
 */

import { randomUUID } from "node:crypto";
import { rowsToEvents } from "@band-app/chat-runtime/replay";
import { FAILED_STOP_REASONS } from "@band-app/chat-runtime/turns";
import {
  CAPABILITY_CHAT_OWNERSHIP,
  CHAT_ID_BLOCK_SIZE,
  type ChatActivityParams,
  type ChatEventRowWire,
  type ChatForwardAction,
  type ChatForwardParams,
  type ChatForwardReply,
  type ChatHistoryParams,
  type ChatHistoryReply,
  type ChatIdBlockReply,
  type ChatLaunchParams,
  type ChatListSessionsReply,
  type ChatLiveState,
  type ChatReplicateParams,
  type ChatReplicateReply,
  type ChatTransientParams,
  type JsonPayload,
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
  NOTIFY_CHAT_ACTIVITY,
  NOTIFY_CHAT_LIVE,
  NOTIFY_CHAT_TRANSIENT,
  RpcError,
  readPayload,
  type ServerSession,
  sendPayload,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import type {
  ChatEvent,
  ChatEventPayload,
  LoggedChatEvent,
  QueuedChatMessage,
  SessionState,
} from "@band-app/shared/chat-events";
import { ChatEventQueries, type ChatEventRow } from "../infra/db/queries/chat-events";
import { ChatForwardQueries, type ChatForwardRow } from "../infra/db/queries/chat-forwards";
import { TaskQueries } from "../infra/db/queries/tasks";
import { hasQueuedMessages } from "./_utils/queued-message-store";
import { emitTurnEnded } from "./_utils/turn-events";
import { agentSessionService, ownedChatInfo } from "./agent-session-service";
import { chatService } from "./chat-service";
import { beginBandTurn, endBandTurn, observeAgentStatus } from "./chat-status-service";
import type { SubmitOrQueueResult, SubmitTaskOptions, TaskInfo } from "./task-service";
import { hasRunningTask, taskService } from "./task-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("chat-ownership");

/** How long the hub waits for a worker to answer one forwarded request. */
const FORWARD_TIMEOUT_MS = 60_000;
/** Rows per `chat.history` page the hub serves. */
const HISTORY_MAX_ROWS = 1000;

interface LiveMirror extends ChatLiveState {
  hostId: string;
}

export class ChatOwnershipService {
  private readonly events = new ChatEventQueries();
  private readonly forwards = new ChatForwardQueries();
  private readonly tasks = new TaskQueries();
  private readonly sessions = new Map<string, ServerSession>();
  private readonly live = new Map<string, LiveMirror>();
  /** Per host, the delivery of its outbox that runs now, and whether another pass is due. */
  private readonly delivering = new Map<string, Promise<void>>();
  private readonly deliverAgain = new Set<string>();
  /** Callers waiting for a forwarded request's answer, by forward id. */
  private readonly waiters = new Map<string, (reply: ChatForwardReply | undefined) => void>();
  /** The prompt of each turn the hub has seen start, by task id, for the task record. */
  private readonly prompts = new Map<string, string>();

  // ---- link ----------------------------------------------------------------

  attach(session: ServerSession): void {
    const hostId = session.workerId;
    this.sessions.set(hostId, session);
    session.handle(METHOD_CHAT_REPLICATE, (p) =>
      this.onReplicate(session, p as ChatReplicateParams),
    );
    session.handle(METHOD_CHAT_ID_BLOCK, (): ChatIdBlockReply => {
      const start = this.events.reserveIdBlock(CHAT_ID_BLOCK_SIZE);
      log.info({ hostId, start, size: CHAT_ID_BLOCK_SIZE }, "leased chat event ids");
      return { start, size: CHAT_ID_BLOCK_SIZE };
    });
    session.handle(METHOD_CHAT_HISTORY, (p) => this.onHistory(session, p as ChatHistoryParams));
    session.handle(METHOD_CHAT_LAUNCH, (p) => {
      const { chatId, agentId } = p as ChatLaunchParams;
      this.assertOwner(chatId, hostId);
      return agentSessionService.launchForOwner(chatId, agentId);
    });
    session.handle(METHOD_CHAT_SESSION_STATE, (p) => {
      const { chatId } = p as { chatId: string };
      this.assertOwner(chatId, hostId);
      return agentSessionService.resolvedSessionState(chatId);
    });
    session.onNotification(NOTIFY_CHAT_LIVE, (p) => this.onLive(hostId, p as ChatLiveState));
    session.onNotification(NOTIFY_CHAT_TRANSIENT, (p) => {
      const { chatId, event } = p as ChatTransientParams;
      if (chatService.get(chatId)?.ownerHostId !== hostId) return;
      const { eventId: _id, createdAt: _at, ...payload } = event as ChatEvent;
      agentSessionService.broadcastTransient(chatId, payload as ChatEventPayload);
    });
    session.onNotification(NOTIFY_CHAT_ACTIVITY, (p) => {
      const { chatId, kind } = p as ChatActivityParams;
      const chat = chatService.get(chatId);
      if (chat?.ownerHostId !== hostId) return;
      agentSessionService.notifyActivity(chatId, chat.worktreeId, kind);
    });
  }

  /** A worker said hello: hand it the chats it can own, then send what waited for it. */
  onConnected(session: ServerSession): void {
    const hostId = session.workerId;
    if (this.canOwn(hostId)) {
      for (const chat of chatService.all()) {
        if (!chat.ownerHostId && worktreeService.resolve(chat.worktreeId)?.host.id === hostId) {
          this.ownerFor(chat.id);
        }
      }
    }
    this.deliver(hostId);
  }

  // ---- who owns a chat -----------------------------------------------------

  /** The worker that runs the chat, or undefined when the hub runs it. */
  ownerOf(chatId: string): string | undefined {
    return chatService.get(chatId)?.ownerHostId;
  }

  isOwned(chatId: string): boolean {
    return this.ownerOf(chatId) !== undefined;
  }

  /** Whether a host is online now with a build that owns chats. */
  canOwn(hostId: string): boolean {
    const session = this.sessions.get(hostId);
    return (
      session?.attached === true && session.hello.capabilities.includes(CAPABILITY_CHAT_OWNERSHIP)
    );
  }

  private assertOwner(chatId: string, hostId: string): void {
    if (this.ownerOf(chatId) !== hostId) {
      throw new RpcError(-32003, `chat ${chatId} is not owned by ${hostId}`);
    }
  }

  /**
   * The chat's owner, handing the chat to its worktree's worker first when
   * that worker owns chats and the chat is at a clean point: no turn on the
   * hub, nothing waiting on the user, no background work, nothing in the hub's queue.
   */
  ownerFor(chatId: string): string | undefined {
    const chat = chatService.get(chatId);
    if (!chat) return undefined;
    if (chat.ownerHostId) return chat.ownerHostId;
    const hostId = worktreeService.resolve(chat.worktreeId)?.host.id;
    if (!hostId || !this.canOwn(hostId)) return undefined;
    // A turn, a request waiting on the user or background work the agent runs (a wakeup, a
    // monitor) would die with the hub's agent process, so the chat stays here until it is idle.
    if (
      taskService.getTask(chatId)?.status === "running" ||
      agentSessionService.isActive(chatId) ||
      hasQueuedMessages(chatId)
    ) {
      return undefined;
    }
    // Exactly one runner: the hub's agent process stops before the worker hears of the chat.
    agentSessionService.stop(chatId);
    chatService.setOwner(chatId, hostId);
    log.info({ chatId, hostId }, "the chat runs on its worker now");
    this.enqueue(chatId, hostId, METHOD_CHAT_OWN, { chatId });
    return hostId;
  }

  /**
   * The chat left its owner: removed (`deleteLog`), or moved to another
   * worktree. The worker replicates what it has, then stops the agent.
   */
  release(chatId: string, hostId: string, deleteLog: boolean): void {
    this.live.delete(chatId);
    void agentSessionService.revokeOwnerLaunch(chatId);
    for (const row of this.forwards.pendingForChat(chatId)) {
      if (row.method === METHOD_CHAT_FORWARD && !deleteLog) continue;
      this.forwards.remove(row.id);
      this.waiters.get(row.id)?.(undefined);
    }
    this.enqueue(chatId, hostId, METHOD_CHAT_RELEASE, { chatId, deleteLog });
    log.info({ chatId, hostId, deleteLog }, "the chat left its worker");
  }

  // ---- outbox --------------------------------------------------------------

  private enqueue(chatId: string, hostId: string, method: string, params: unknown): string {
    const id = `cf-${randomUUID()}`;
    this.forwards.add({ id, chatId, hostId, method, params, createdAt: Date.now() });
    this.deliver(hostId);
    return id;
  }

  /** Sends a host's waiting requests in order while it is online. */
  private deliver(hostId: string): void {
    if (this.delivering.has(hostId)) {
      this.deliverAgain.add(hostId);
      return;
    }
    const run = (async () => {
      do {
        this.deliverAgain.delete(hostId);
        for (const row of this.forwards.pending(hostId)) {
          const session = this.sessions.get(hostId);
          if (!session?.attached) return;
          if (!(await this.deliverOne(session, row))) return;
        }
      } while (this.deliverAgain.has(hostId));
    })();
    this.delivering.set(hostId, run);
    void run
      .catch((err) => log.warn({ hostId, err }, "chat outbox delivery failed"))
      .finally(() => this.delivering.delete(hostId));
  }

  /** Sends one request. False when the link failed, so the rest waits for the next connect. */
  private async deliverOne(session: ServerSession, row: ChatForwardRow): Promise<boolean> {
    let params = row.params;
    if (row.method === METHOD_CHAT_OWN) {
      const chat = chatService.get(row.chatId);
      if (chat?.ownerHostId !== row.hostId) {
        this.forwards.remove(row.id);
        return true;
      }
      params = { chat: ownedChatInfo(chat) };
    } else if (row.method === METHOD_CHAT_FORWARD && this.ownerOf(row.chatId) !== row.hostId) {
      this.reroute(row);
      return true;
    }
    let reply: unknown;
    try {
      const enc = await session.request<JsonPayload>(row.method, params, {
        timeoutMs: FORWARD_TIMEOUT_MS,
      });
      reply = await readPayload(session, enc);
    } catch (err) {
      if (!(err instanceof RpcError)) return false;
      // The worker answered with an error: it will not run, so it is done.
      log.warn({ chatId: row.chatId, method: row.method, err: err.message }, "worker refused");
      reply = { ok: false, error: err.message };
    }
    this.forwards.delivered(row.id, reply, Date.now());
    this.waiters.get(row.id)?.(reply as ChatForwardReply);
    this.waiters.delete(row.id);
    return true;
  }

  /** A request for a chat that left its worker before it was sent goes to the chat's new owner. */
  private reroute(row: ChatForwardRow): void {
    this.forwards.remove(row.id);
    const params = row.params as ChatForwardParams;
    const action = params.action;
    if (action.kind !== "send") {
      this.waiters.get(row.id)?.(undefined);
      return;
    }
    const chat = chatService.get(row.chatId);
    if (!chat) return;
    const { kind: _kind, files, ...rest } = action;
    taskService.submitOrQueueTask({
      worktreeId: chat.worktreeId,
      chatId: chat.id,
      prompt: rest.text,
      sessionId: rest.sessionId,
      mode: rest.mode,
      model: rest.model,
      codingAgentId: rest.codingAgentId,
      attachments: files ?? [],
    });
    this.waiters.get(row.id)?.({ ok: true, queued: true });
  }

  /** Forwards an action to the chat's owner, now or once it reconnects. */
  forward(chatId: string, hostId: string, action: ChatForwardAction, showQueued = true): string {
    const id = `cf-${randomUUID()}`;
    const params: ChatForwardParams = { forwardId: id, chatId, action };
    this.forwards.add({
      id,
      chatId,
      hostId,
      method: METHOD_CHAT_FORWARD,
      params,
      createdAt: Date.now(),
    });
    if (action.kind === "send" && showQueued) this.publishQueue(chatId);
    this.deliver(hostId);
    return id;
  }

  // ---- what the hub asks of an owned chat ----------------------------------

  /**
   * A message for a chat its worker owns: it goes to the worker, which runs
   * it now or queues it. Recorded first, so it runs once the worker is back
   * when it is offline. Undefined when the hub runs the chat itself.
   */
  submit(options: SubmitTaskOptions): SubmitOrQueueResult | undefined {
    const hostId = this.ownerFor(options.chatId);
    if (!hostId) return undefined;
    const chat = chatService.get(options.chatId);
    if (chat && options.codingAgentId && options.codingAgentId !== chat.agent) {
      chatService.update(options.chatId, { agent: options.codingAgentId, model: null, mode: null });
    }
    // Busy means the message waits: the owner is away, runs a turn, or has messages before it.
    const busy =
      !this.sessions.get(hostId)?.attached ||
      this.task(options.chatId) !== null ||
      this.queue(options.chatId).length > 0;
    const id = this.forward(
      options.chatId,
      hostId,
      {
        kind: "send",
        text: options.prompt,
        ...(options.attachments && options.attachments.length > 0
          ? { files: options.attachments }
          : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.codingAgentId ? { codingAgentId: options.codingAgentId } : {}),
      },
      busy,
    );
    log.info({ chatId: options.chatId, hostId, forwardId: id, busy }, "message forwarded");
    if (busy) return { queued: true, queuedMessageId: id };
    return { queued: false, task: forwardedTask(id, options) };
  }

  /** What `taskService.submitTask` returns for a worker-owned chat. */
  submitAsTask(options: SubmitTaskOptions): TaskInfo | undefined {
    const result = this.submit(options);
    if (!result) return undefined;
    return result.queued ? forwardedTask(result.queuedMessageId, options) : result.task;
  }

  /** Stops the owner's turn with this task id, when an owned chat runs it. */
  cancelTask(taskId: string): { cancelled: boolean; worktreeId?: string } | undefined {
    for (const [chatId, live] of this.live) {
      if (live.task?.id !== taskId) continue;
      this.stop(chatId);
      return { cancelled: true, worktreeId: chatService.get(chatId)?.worktreeId };
    }
    return undefined;
  }

  stop(chatId: string): boolean {
    const hostId = this.ownerOf(chatId);
    if (!hostId) return false;
    this.forward(chatId, hostId, { kind: "stop" });
    return true;
  }

  answerPermission(chatId: string, requestId: string, optionId: string | null): boolean {
    const hostId = this.ownerOf(chatId);
    if (!hostId || !this.pending(chatId).includes(requestId)) return false;
    this.forward(chatId, hostId, { kind: "permission", requestId, optionId });
    return true;
  }

  answerElicitation(chatId: string, requestId: string, response: unknown): boolean {
    const hostId = this.ownerOf(chatId);
    if (!hostId || !this.pending(chatId).includes(requestId)) return false;
    this.forward(chatId, hostId, { kind: "elicitation", requestId, response });
    return true;
  }

  removeQueued(chatId: string, queuedMessageId: string): boolean {
    const hostId = this.ownerOf(chatId);
    if (!hostId) return false;
    // A message still in the outbox never reaches the worker.
    const waiting = this.forwards.pendingForChat(chatId).find((r) => r.id === queuedMessageId);
    if (waiting) {
      this.forwards.remove(waiting.id);
      this.publishQueue(chatId);
      return true;
    }
    this.forward(chatId, hostId, { kind: "queue-remove", queuedMessageId });
    return true;
  }

  updateQueued(chatId: string, queuedMessageId: string, text: string): boolean {
    const hostId = this.ownerOf(chatId);
    if (!hostId) return false;
    const waiting = this.forwards.pendingForChat(chatId).find((r) => r.id === queuedMessageId);
    const params = waiting?.params as ChatForwardParams | undefined;
    if (waiting && params?.action.kind === "send") {
      this.forwards.setParams(waiting.id, { ...params, action: { ...params.action, text } });
      this.publishQueue(chatId);
      return true;
    }
    this.forward(chatId, hostId, { kind: "queue-update", queuedMessageId, text });
    return true;
  }

  /** Reorders the owner's queue. Messages still in the outbox keep their order after it. */
  reorderQueue(chatId: string, ids: string[]): void {
    const hostId = this.ownerOf(chatId);
    if (!hostId) return;
    this.forward(chatId, hostId, { kind: "queue-reorder", ids });
  }

  clearQueue(chatId: string): void {
    const hostId = this.ownerOf(chatId);
    if (!hostId) return;
    for (const row of this.forwards.pendingForChat(chatId)) {
      if ((row.params as ChatForwardParams).action?.kind === "send") this.forwards.remove(row.id);
    }
    this.forward(chatId, hostId, { kind: "queue-clear" });
    this.publishQueue(chatId);
  }

  /** Changes a session setting on the owner's live session. Throws while the owner is offline. */
  async setConfigOption(chatId: string, configId: string, value: string): Promise<SessionState> {
    const hostId = this.ownerOf(chatId);
    const session = hostId ? this.sessions.get(hostId) : undefined;
    if (!session?.attached) {
      throw new Error("The machine that runs this chat is offline; try again when it is back.");
    }
    const enc = await session.request<JsonPayload>(
      METHOD_CHAT_SET_CONFIG,
      { chatId, configId, value },
      { timeoutMs: FORWARD_TIMEOUT_MS },
    );
    return readPayload<SessionState>(session, enc);
  }

  /** The agent's own session list on the owner, or null when it can't list or is offline. */
  async listSessions(chatId: string): Promise<ChatListSessionsReply["sessions"]> {
    const hostId = this.ownerOf(chatId);
    const session = hostId ? this.sessions.get(hostId) : undefined;
    if (!session?.attached) return null;
    try {
      const enc = await session.request<JsonPayload>(
        METHOD_CHAT_LIST_SESSIONS,
        { chatId },
        { timeoutMs: FORWARD_TIMEOUT_MS },
      );
      return (await readPayload<ChatListSessionsReply>(session, enc)).sessions;
    } catch (err) {
      log.warn({ chatId, err }, "the owner could not list sessions");
      return null;
    }
  }

  // ---- what the hub reads of an owned chat ---------------------------------

  /** The owner's running turn, as a task. */
  task(chatId: string): TaskInfo | null {
    const live = this.live.get(chatId);
    const chat = chatService.get(chatId);
    if (!live?.task || !chat) return null;
    return {
      id: live.task.id,
      worktreeId: chat.worktreeId,
      chatId,
      status: "running",
      startedAt: live.task.startedAt,
      prompt: live.task.prompt,
    };
  }

  /** The owner's queue, then the messages still waiting in the hub's outbox. */
  queue(chatId: string): QueuedChatMessage[] {
    const waiting = this.forwards.pendingForChat(chatId).flatMap((row) => {
      const action = (row.params as ChatForwardParams).action;
      if (row.method !== METHOD_CHAT_FORWARD || action?.kind !== "send") return [];
      return [
        {
          id: row.id,
          text: action.text,
          ...(action.files && action.files.length > 0
            ? {
                files: action.files.map((f) => ({
                  mediaType: f.mediaType,
                  url: f.url,
                  filename: f.filename,
                })),
              }
            : {}),
        },
      ];
    });
    return [...(this.live.get(chatId)?.queue ?? []), ...waiting];
  }

  pending(chatId: string): string[] {
    return this.live.get(chatId)?.pending ?? [];
  }

  workDeadline(chatId: string): number | null {
    return this.live.get(chatId)?.workDeadline ?? null;
  }

  /** Chats of a worktree whose owner's agent waits on the user. */
  chatsWithPending(worktreeId: string): string[] {
    const out: string[] = [];
    for (const [chatId, live] of this.live) {
      if (live.pending.length > 0 && chatService.get(chatId)?.worktreeId === worktreeId) {
        out.push(chatId);
      }
    }
    return out;
  }

  private publishQueue(chatId: string): void {
    agentSessionService.broadcastTransient(chatId, {
      type: "queue-updated",
      messages: this.queue(chatId),
    });
  }

  private onLive(hostId: string, state: ChatLiveState): void {
    const chat = chatService.get(state.chatId);
    if (chat?.ownerHostId !== hostId) return;
    const before = this.live.get(state.chatId);
    this.live.set(state.chatId, { ...state, hostId });
    this.publishQueue(state.chatId);
    if ((before?.pending ?? []).join() !== state.pending.join()) {
      agentSessionService.notifyPending(state.chatId, chat.worktreeId);
    }
  }

  // ---- replication ---------------------------------------------------------

  private async onHistory(session: ServerSession, p: ChatHistoryParams): Promise<ChatHistoryReply> {
    this.assertOwner(p.chatId, session.workerId);
    const limit = Math.min(Math.max(1, p.limit), HISTORY_MAX_ROWS);
    const rows = this.events.readChat(p.chatId, p.afterId, limit);
    return { rows: sendPayload(session, rows) };
  }

  private async onReplicate(
    session: ServerSession,
    p: ChatReplicateParams,
  ): Promise<ChatReplicateReply> {
    const hostId = session.workerId;
    const rows = await readPayload<ChatEventRowWire[]>(session, p.rows);
    const now = Date.now();
    const owned: ChatEventRow[] = [];
    for (const row of rows) {
      const chat = chatService.get(row.chatId);
      if (chat?.ownerHostId === hostId) {
        owned.push({ ...row, event: row.event as LoggedChatEvent });
      } else if (chat) {
        // The chat moved while this worker kept working: keep its rows apart, never in the log.
        this.forwards.hold(hostId, row.chatId, row.id, row, now);
      }
    }
    for (const row of this.events.insertRows(owned)) this.ingest(row);
    const ackedThrough = rows.reduce((max, r) => Math.max(max, r.id), 0);
    return { ackedThrough };
  }

  /** A row the hub stored for the first time: pass it on and keep the hub's state in step. */
  private ingest(row: ChatEventRow): void {
    const chat = chatService.get(row.chatId);
    if (!chat) return;
    for (const event of rowsToEvents([row])) agentSessionService.deliver(row.chatId, event);
    const event = row.event;
    const worktreeId = chat.worktreeId;
    switch (event.type) {
      case "session-attached":
        if (event.how === "new") {
          chatService.updateActiveSession(row.chatId, {
            activeSessionId: event.sessionId,
            summary: undefined,
            lastModified: row.createdAt,
          });
        } else if (chat.activeSessionId !== event.sessionId) {
          chatService.updateActiveSession(row.chatId, event.sessionId);
        }
        break;
      case "prompt": {
        this.prompts.set(event.taskId, event.text);
        if (event.codingAgentId && event.codingAgentId !== chat.agent) {
          chatService.update(row.chatId, { agent: event.codingAgentId, model: null, mode: null });
        }
        if (event.model) chatService.update(row.chatId, { model: event.model });
        if (event.mode) chatService.update(row.chatId, { mode: event.mode });
        if (!chat.activeSessionSummary || chat.activeSessionId !== row.sessionId) {
          chatService.updateActiveSession(row.chatId, {
            activeSessionId: row.sessionId,
            summary: event.text,
            lastModified: row.createdAt,
          });
        }
        break;
      }
      case "turn-started":
        observeAgentStatus(hasRunningTask);
        this.saveTask(row, event.taskId, "running");
        chatService.updateStatus(row.chatId, "running");
        beginBandTurn(worktreeId, row.chatId);
        break;
      case "turn-ended": {
        const failed =
          event.error !== undefined ||
          (event.stopReason !== undefined && FAILED_STOP_REASONS.has(event.stopReason));
        this.saveTask(row, event.taskId, failed ? "failed" : "completed");
        this.prompts.delete(event.taskId);
        emitTurnEnded(worktreeId);
        chatService.updateStatus(row.chatId, failed ? "error" : "idle");
        endBandTurn(
          worktreeId,
          row.chatId,
          event.stopReason === "cancelled" ? "idle" : failed ? "failed" : "done",
        );
        break;
      }
      case "update":
        if (event.update.sessionUpdate === "session_info_update" && event.update.title) {
          chatService.updateSessionSummary(
            row.chatId,
            row.sessionId,
            event.update.title,
            row.createdAt,
          );
        }
        break;
    }
  }

  private saveTask(row: ChatEventRow, taskId: string, status: TaskInfo["status"]): void {
    const chat = chatService.get(row.chatId);
    if (!chat) return;
    const worktree = worktreeService.resolve(chat.worktreeId);
    const existing = this.tasks.load(taskId);
    try {
      this.tasks.save({
        id: taskId,
        worktreeId: chat.worktreeId,
        repo: worktree?.repo.name ?? "",
        branch: worktree?.worktree.branch ?? "",
        prompt: this.prompts.get(taskId) ?? existing?.prompt ?? "",
        status,
        sessionId: row.sessionId,
        startedAt: existing?.startedAt ?? row.createdAt,
        completedAt: status === "running" ? undefined : row.createdAt,
        chatId: row.chatId,
      });
    } catch (err) {
      log.warn({ taskId, err }, "failed to persist the task of an owned chat");
    }
  }
}

/** The task record a forwarded message stands for until the owner's turn reports its own. */
function forwardedTask(id: string, options: SubmitTaskOptions): TaskInfo {
  return {
    id,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    status: "running",
    startedAt: Date.now(),
    prompt: options.prompt,
    mode: options.mode,
    model: options.model,
    codingAgentId: options.codingAgentId,
  };
}

export const chatOwnershipService = new ChatOwnershipService();
