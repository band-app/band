/**
 * One owned chat's agent session on the worker.
 *
 * The worker's counterpart of the hub's `agent-session-service.ts`: it starts
 * the chat's agent, attaches its session (`session/new`, `resume` or `load`),
 * logs everything the agent sends into the worker's `chat_events`, and holds
 * the permission and form requests that wait on the user. It leaves out what
 * only the hub needs: agent probes, one-shot calls, the session catalog, the
 * opt-in idle stop and Claude Code's learned defaults.
 *
 * Turn bookkeeping (prompt records, the queue) is in `turns.ts`.
 */

import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import {
  type AcpAgentHandlers,
  AcpAgentProcess,
  type AttachedSession,
  type PermissionOutcome,
} from "@band-app/chat-runtime/acp-agent-process";
import { findOption, selectValues } from "@band-app/chat-runtime/config-options";
import { PendingWork } from "@band-app/chat-runtime/pending-work";
import { loggedSessionCost, sessionStateFromLog } from "@band-app/chat-runtime/session-state";
import type { Host } from "@band-app/host-api";
import type { ChatLaunchReply, OwnedChatInfo } from "@band-app/link";
import type { Logger } from "@band-app/logger";
import type {
  ChatEvent,
  ChatEventPayload,
  LegacyModelState,
  LoggedChatEvent,
  SessionState,
} from "@band-app/shared/chat-events";

import type { ChatStore } from "./store.ts";

/** After `session/cancel`, how long a turn gets to stop before its agent process is killed. */
const CANCEL_GRACE_MS = 15_000;

/** Updates that mean the agent is working on a turn of its own. */
const AGENT_WORK_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

interface LiveState {
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  models: LegacyModelState | null;
  commands: acp.AvailableCommand[];
  usage: acp.UsageUpdate | null;
  title: string | null;
}

interface PendingRequest {
  cancel(): void;
  permission?(optionId: string | null): void;
  optionIds?: string[];
  elicitation?(response: acp.CreateElicitationResponse): void;
}

/** What a runtime needs from the worker around it. */
export interface RuntimeEnv {
  host: Host;
  store: ChatStore;
  log: Logger;
  /** The launch for the chat's agent (or `agentId`'s): from the hub, or the last one it gave. */
  launch(chatId: string, agentId?: string): Promise<ChatLaunchReply>;
  /**
   * Throws when no process may start in `cwd`: the worker lost the hub's lease, or the folder was
   * continued on another host. The same check the hub's `acp.spawn` gets.
   */
  assertMayRun(cwd: string): void;
  /** The environment every agent the worker starts gets: the `band` CLI on PATH, a GitHub token. */
  spawnEnv(env: Record<string, string>): Promise<Record<string, string>>;
  /** An event for the chat's subscribers. Logged events carry their row id. */
  emit(chatId: string, event: ChatEvent): void;
  /** A row was logged: replicate it. */
  logged(): void;
  /** Pending requests or background work changed. */
  stateChanged(chatId: string): void;
  /** The agent acted outside a turn the worker started. */
  activity(chatId: string, kind: "update" | "work"): void;
}

let transientId = -1;

export class ChatRuntime {
  private process: AcpAgentProcess | null = null;
  private generation = 0;
  private starting: Promise<AcpAgentProcess> | null = null;
  private attaching: Promise<void> | null = null;
  /** The session the process is attached to, and the log revision it writes. */
  sessionId: string | null = null;
  private revision = 0;
  private routing: "log" | "buffer" | "drop" = "log";
  private buffered: acp.SessionNotification[] = [];
  private lastUpdateKind: string | null = null;
  private inTurn = false;
  private turnSeq = 0;
  private live: LiveState = emptyLive();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly work = new PendingWork();
  /** The agent the process runs. A different one needs a new process. */
  private agentId: string | null = null;
  private launch: ChatLaunchReply | null = null;

  constructor(
    readonly chatId: string,
    private readonly env: RuntimeEnv,
  ) {}

  private get info(): OwnedChatInfo {
    const record = this.env.store.ownedChat(this.chatId);
    if (!record) throw new Error(`Chat ${this.chatId} is not owned by this worker`);
    return record.info;
  }

  private updateInfo(patch: Partial<OwnedChatInfo>): void {
    this.env.store.saveChat({ ...this.info, ...patch });
  }

  // ---- recording -----------------------------------------------------------

  /** Appends an event to the session log and broadcasts it. With no session, only broadcasts. */
  record(event: LoggedChatEvent, turnStart = false): void {
    const id = this.sessionId ? this.env.store.takeId() : null;
    if (!this.sessionId || id === null) {
      if (this.sessionId) {
        this.env.log.error({ chatId: this.chatId }, "no event ids left; the event is not logged");
      }
      this.broadcastTransient(event);
      return;
    }
    const createdAt = Date.now();
    this.env.store.events.append({
      id,
      chatId: this.chatId,
      sessionId: this.sessionId,
      revision: this.revision,
      event,
      turnStart,
      createdAt,
    });
    this.env.emit(this.chatId, { ...event, eventId: id, createdAt } as ChatEvent);
    this.env.logged();
  }

  broadcastTransient(event: ChatEventPayload): void {
    this.env.emit(this.chatId, {
      ...event,
      eventId: transientId--,
      createdAt: Date.now(),
    } as ChatEvent);
  }

  // ---- incoming traffic ----------------------------------------------------

  private applyLive(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.live.commands = update.availableCommands;
        break;
      case "config_option_update":
        this.live.configOptions = update.configOptions;
        break;
      case "current_mode_update":
        if (this.live.modes) {
          this.live.modes = { ...this.live.modes, currentModeId: update.currentModeId };
        }
        break;
      case "usage_update":
        this.live.usage = {
          used: update.used,
          size: update.size,
          cost: update.cost ?? this.live.usage?.cost ?? null,
        };
        break;
      case "session_info_update":
        if (update.title !== undefined) this.live.title = update.title ?? null;
        break;
    }
  }

  private routeUpdate(notification: acp.SessionNotification): void {
    if (this.routing === "buffer") {
      this.buffered.push(notification);
      return;
    }
    if (notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    this.applyLive(update);
    if (!this.attaching) {
      this.work.observeUpdate(update, this.inTurn);
      if (!this.inTurn && this.routing === "log" && AGENT_WORK_UPDATES.has(update.sessionUpdate)) {
        this.env.activity(this.chatId, "update");
      }
    }
    if (this.routing === "drop") return;
    if (update.sessionUpdate === "user_message_chunk") {
      // During a turn the worker started, the prompt is already logged.
      if (this.inTurn) return;
      const turnStart = this.lastUpdateKind !== "user_message_chunk";
      this.lastUpdateKind = update.sessionUpdate;
      this.record({ type: "update", update }, turnStart);
      return;
    }
    this.lastUpdateKind = update.sessionUpdate;
    this.record({ type: "update", update });
  }

  private openRequest(
    signal: AbortSignal,
    make: (done: (answer: string) => void) => Omit<PendingRequest, "cancel">,
    onCancel: () => void,
  ): string {
    const requestId = randomUUID();
    let settled = false;
    const done = (answer: string) => {
      if (settled) return;
      settled = true;
      this.pending.delete(requestId);
      this.record({ type: "request-resolved", requestId, answer });
      this.env.stateChanged(this.chatId);
    };
    const handlers = make(done);
    const cancel = () => {
      if (settled) return;
      done("cancelled");
      onCancel();
    };
    this.pending.set(requestId, { cancel, ...handlers });
    signal.addEventListener("abort", cancel, { once: true });
    return requestId;
  }

  private requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionOutcome> {
    return new Promise((resolve) => {
      const requestId = this.openRequest(
        signal,
        (done) => ({
          optionIds: request.options.map((o) => o.optionId),
          permission: (optionId) => {
            done(optionId ?? "cancelled");
            resolve(optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" });
          },
        }),
        () => resolve({ outcome: "cancelled" }),
      );
      this.record({ type: "permission", requestId, request });
      this.env.stateChanged(this.chatId);
    });
  }

  private requestElicitation(
    request: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> {
    if (request.mode !== "form") return Promise.resolve({ action: "decline" });
    return new Promise((resolve) => {
      const requestId = this.openRequest(
        signal,
        (done) => ({
          elicitation: (response) => {
            done(response.action);
            resolve(response);
          },
        }),
        () => resolve({ action: "cancel" }),
      );
      this.record({ type: "elicitation", requestId, request });
      this.env.stateChanged(this.chatId);
    });
  }

  private handlers(generation: number): AcpAgentHandlers {
    return {
      onUpdate: (n) => this.routeUpdate(n),
      onAsyncTask: (n) => {
        if (n.sessionId !== this.sessionId || this.attaching) return;
        this.work.observeAsyncTask(n.update);
        this.env.activity(this.chatId, "work");
        this.env.stateChanged(this.chatId);
      },
      onPermission: (req, signal) => this.requestPermission(req, signal),
      onElicitation: (req, signal) => this.requestElicitation(req, signal),
      onExit: (code, stderr) => {
        if (this.generation !== generation) return;
        this.env.log.info({ chatId: this.chatId, code }, "agent exited");
        this.env.log.debug({ chatId: this.chatId, stderr: stderr.slice(-500) }, "agent stderr");
        for (const p of [...this.pending.values()]) p.cancel();
        this.work.clear();
        this.process = null;
        this.starting = null;
        this.env.stateChanged(this.chatId);
      },
    };
  }

  // ---- process and session attach ----------------------------------------

  private async ensureProcess(agentId: string): Promise<AcpAgentProcess> {
    if (this.process?.alive && this.agentId === agentId) return this.process;
    if (this.process && this.agentId !== agentId) this.stopProcess();
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    const starting = (async () => {
      const launch = await this.env.launch(this.chatId, agentId);
      this.env.assertMayRun(launch.cwd);
      const resolved = await this.env.host.acp.resolveLaunch({
        type: launch.agent.type,
        label: launch.agent.label,
        command: launch.agent.command,
      });
      if (typeof resolved === "string") throw new Error(resolved);
      const env = await this.env.spawnEnv({ ...resolved.env, ...launch.env });
      const proc = await AcpAgentProcess.start(
        this.env.host.acp,
        { ...resolved, env },
        launch.cwd,
        launch.agent.label,
        this.handlers(generation),
      );
      // Stopped while it started (the chat was released or switched agent): it never runs.
      if (this.generation !== generation) {
        proc.close();
        throw new Error("The agent was stopped while it started");
      }
      this.launch = launch;
      this.agentId = agentId;
      return proc;
    })();
    this.starting = starting;
    try {
      const proc = await starting;
      this.process = proc;
      this.sessionId = null;
      return proc;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private mcpServers(proc: AcpAgentProcess): acp.McpServer[] {
    if (!proc.supportsHttpMcp) return [];
    return (this.launch?.mcpServers ?? []) as acp.McpServer[];
  }

  private setLive(attached: AttachedSession): void {
    this.live = {
      ...this.live,
      configOptions: attached.configOptions,
      modes: attached.modes,
      models: attached.models,
    };
  }

  private logAttached(
    proc: AcpAgentProcess,
    how: "new" | "load" | "resume",
    attached: AttachedSession,
  ): void {
    this.record({
      type: "session-attached",
      sessionId: attached.sessionId,
      how,
      revision: this.revision,
      agentName: proc.agentName,
      configOptions: attached.configOptions,
      modes: attached.modes,
      models: attached.models,
    });
  }

  /** Applies the chat's saved model and mode choices to a fresh attach. */
  private async applyPreferences(proc: AcpAgentProcess): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const info = this.info;
    const wanted: Array<["model" | "mode", string | undefined]> = [
      ["model", info.model ?? this.launch?.agent.model],
      ["mode", info.mode],
    ];
    for (const [category, value] of wanted) {
      if (!value) continue;
      try {
        const option = findOption(this.live.configOptions, category);
        if (option) {
          if (option.currentValue !== value && selectValues(option).includes(value)) {
            const options = await proc.setConfigOption(sessionId, option.id, value);
            this.live.configOptions = options;
            this.record({
              type: "update",
              update: { sessionUpdate: "config_option_update", configOptions: options },
            });
          }
        } else if (category === "model" && this.live.models) {
          const models = this.live.models;
          if (
            models.currentModelId !== value &&
            models.availableModels.some((m) => m.modelId === value)
          ) {
            await proc.setModel(sessionId, value);
            this.live.models = { ...models, currentModelId: value };
          }
        } else if (category === "mode" && this.live.modes) {
          const modes = this.live.modes;
          if (modes.currentModeId !== value && modes.availableModes.some((m) => m.id === value)) {
            await proc.setMode(sessionId, value);
            this.live.modes = { ...modes, currentModeId: value };
            this.record({
              type: "update",
              update: { sessionUpdate: "current_mode_update", currentModeId: value },
            });
          }
        }
      } catch (err) {
        this.env.log.warn({ chatId: this.chatId, category, value, err }, "could not apply setting");
      }
    }
  }

  private async attachNew(proc: AcpAgentProcess): Promise<void> {
    this.routing = "buffer";
    this.buffered = [];
    let attached: AttachedSession;
    try {
      attached = await proc.newSession(
        this.launch?.cwd ?? "",
        this.launch?.additionalDirectories ?? [],
        this.mcpServers(proc),
      );
    } catch (err) {
      this.routing = "log";
      throw err;
    }
    this.sessionId = attached.sessionId;
    this.revision = this.env.store.events.currentRevision(attached.sessionId) + 1;
    this.routing = "log";
    this.lastUpdateKind = null;
    this.setLive(attached);
    this.updateInfo({ activeSessionId: attached.sessionId, hasSummary: false });
    this.logAttached(proc, "new", attached);
    const buffered = this.buffered.filter((n) => n.sessionId === attached.sessionId);
    this.buffered = [];
    for (const n of buffered) this.routeUpdate(n);
    await this.applyPreferences(proc);
  }

  private async attachExisting(
    proc: AcpAgentProcess,
    sessionId: string,
    how: "load" | "resume",
    writeReplay: boolean,
  ): Promise<void> {
    const revision = this.env.store.events.currentRevision(sessionId);
    this.sessionId = sessionId;
    this.revision = writeReplay || revision === 0 ? revision + 1 : revision;
    this.routing = how === "load" && !writeReplay ? "drop" : "log";
    this.lastUpdateKind = null;
    const cwd = this.launch?.cwd ?? "";
    try {
      const attached =
        how === "load"
          ? await proc.loadSession(sessionId, cwd, this.mcpServers(proc))
          : await proc.resumeSession(sessionId, cwd, this.mcpServers(proc));
      this.routing = "log";
      this.setLive(attached);
      this.logAttached(proc, how, attached);
      await this.applyPreferences(proc);
    } catch (err) {
      this.routing = "log";
      this.sessionId = null;
      throw err;
    }
  }

  private async attach(): Promise<void> {
    const info = this.info;
    const target = info.activeSessionId;
    if (target && this.sessionId === target && this.process?.alive) return;
    const proc = await this.ensureProcess(info.agentId);
    if (!target) {
      await this.attachNew(proc);
      return;
    }
    const logged = this.env.store.events.currentRevision(target) > 0;
    const plan: Array<{ how: "load" | "resume"; writeReplay: boolean }> = [];
    if (logged) {
      if (proc.canResume) plan.push({ how: "resume", writeReplay: false });
      if (proc.canLoad) plan.push({ how: "load", writeReplay: false });
    } else {
      if (proc.canLoad) plan.push({ how: "load", writeReplay: true });
      if (proc.canResume) plan.push({ how: "resume", writeReplay: false });
    }
    let lastError: unknown;
    for (const step of plan) {
      try {
        await this.attachExisting(proc, target, step.how, step.writeReplay);
        return;
      } catch (err) {
        lastError = err;
        this.env.log.warn(
          { chatId: this.chatId, sessionId: target, how: step.how, err },
          "session attach failed",
        );
        if (!proc.alive) throw err;
      }
    }
    await this.attachNew(proc);
    this.record({
      type: "notice",
      level: "warning",
      text:
        lastError instanceof Error
          ? `The previous session couldn't be reopened (${lastError.message}), so this is a new session.`
          : `${proc.agentName} can't reopen past sessions, so this is a new session.`,
    });
  }

  /** Starts the agent when needed and attaches the chat's session. Returns the session id. */
  async ensureSession(): Promise<string | null> {
    while (this.attaching) await this.attaching.catch(() => undefined);
    this.attaching = this.attach();
    try {
      await this.attaching;
    } finally {
      this.attaching = null;
    }
    return this.sessionId;
  }

  // ---- turn ----------------------------------------------------------------

  get promptCapabilities(): acp.PromptCapabilities {
    return this.process?.promptCapabilities ?? {};
  }

  currentModel(): string | undefined {
    const option = findOption(this.live.configOptions, "model");
    if (option && typeof option.currentValue === "string") return option.currentValue;
    return this.live.models?.currentModelId;
  }

  reportedCost(): number | undefined {
    const cost = this.live.usage?.cost;
    return cost && cost.currency === "USD" ? cost.amount : undefined;
  }

  sessionCostUsd(): number | null {
    const reported = this.reportedCost();
    if (reported !== undefined) return reported;
    const sessionId = this.info.activeSessionId;
    return sessionId ? loggedSessionCost(this.env.store.events, sessionId) : null;
  }

  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const proc = this.process;
    if (!proc?.alive || !this.sessionId) {
      throw new Error("The agent is not running. Send the message again to restart it.");
    }
    this.inTurn = true;
    this.turnSeq++;
    try {
      return await proc.prompt(this.sessionId, blocks);
    } finally {
      this.inTurn = false;
    }
  }

  /** Stops the current turn: open requests are answered `cancelled`, then `session/cancel`. */
  async cancel(): Promise<void> {
    for (const p of [...this.pending.values()]) p.cancel();
    const proc = this.process;
    if (!proc || !this.sessionId) return;
    await proc.cancel(this.sessionId);
    const turn = this.turnSeq;
    setTimeout(() => {
      if (this.inTurn && this.turnSeq === turn && this.process === proc) {
        this.env.log.warn({ chatId: this.chatId }, "agent ignored session/cancel; killing it");
        proc.close();
      }
    }, CANCEL_GRACE_MS).unref?.();
  }

  answerPermission(requestId: string, optionId: string | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending?.permission) return false;
    if (optionId !== null && !pending.optionIds?.includes(optionId)) return false;
    pending.permission(optionId);
    return true;
  }

  answerElicitation(requestId: string, response: acp.CreateElicitationResponse): boolean {
    const pending = this.pending.get(requestId);
    if (!pending?.elicitation) return false;
    pending.elicitation(response);
    return true;
  }

  pendingRequestIds(): string[] {
    return [...this.pending.keys()];
  }

  workDeadline(): number | null {
    const holds = this.work.outstanding();
    return holds.length > 0 ? Math.min(...holds.map((h) => h.until)) : null;
  }

  /** Changes a session setting on the live session, starting it first unless it is a mode change. */
  async setConfigOption(configId: string, value: string): Promise<SessionState> {
    const attached =
      this.process?.alive && this.sessionId && this.sessionId === this.info.activeSessionId;
    const category =
      configId === "__legacy_mode" ||
      findOption(this.live.configOptions, "mode")?.id === configId ||
      configId === "mode"
        ? "mode"
        : "other";
    if (!attached && category !== "mode") await this.ensureSession();
    const proc = this.process;
    if (proc?.alive && this.sessionId && this.sessionId === this.info.activeSessionId) {
      if (configId === "__legacy_model") {
        await proc.setModel(this.sessionId, value);
        if (this.live.models) this.live.models = { ...this.live.models, currentModelId: value };
      } else if (configId === "__legacy_mode") {
        await proc.setMode(this.sessionId, value);
        if (this.live.modes) this.live.modes = { ...this.live.modes, currentModeId: value };
        this.record({
          type: "update",
          update: { sessionUpdate: "current_mode_update", currentModeId: value },
        });
      } else {
        const options = await proc.setConfigOption(this.sessionId, configId, value);
        this.live.configOptions = options;
        this.record({
          type: "update",
          update: { sessionUpdate: "config_option_update", configOptions: options },
        });
      }
    }
    const state = this.sessionState();
    this.broadcastTransient({ type: "session-state", state });
    return state;
  }

  /** The session's settings: from the live agent, else from the log. */
  sessionState(): SessionState {
    const sessionId = this.info.activeSessionId;
    if (this.process?.alive && this.sessionId && this.sessionId === sessionId) {
      return { source: "live", ...this.live };
    }
    const revision = sessionId ? this.env.store.events.currentRevision(sessionId) : 0;
    if (sessionId && revision > 0) {
      return sessionStateFromLog(this.env.store.events, sessionId, revision, this.live.commands);
    }
    return { source: "cached", ...emptyLive() };
  }

  /** The agent's own `session/list` in the worktree, or null when it can't list. */
  async listSessions(): Promise<acp.SessionInfo[] | null> {
    const proc = await this.ensureProcess(this.info.agentId);
    if (!proc.canList) return null;
    return proc.listSessions(this.launch?.cwd ?? "");
  }

  get running(): boolean {
    return this.inTurn;
  }

  private stopProcess(): void {
    for (const p of [...this.pending.values()]) p.cancel();
    this.process?.close();
    this.process = null;
    this.sessionId = null;
    this.agentId = null;
  }

  /** Stops the agent. Used when the chat switches agent or the worker gives the chat up. */
  stop(): void {
    this.generation++;
    this.starting = null;
    this.stopProcess();
  }
}

function emptyLive(): LiveState {
  return { configOptions: [], modes: null, models: null, commands: [], usage: null, title: null };
}
