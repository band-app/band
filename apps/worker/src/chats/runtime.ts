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
  isSessionLostError,
  launchSpecHash,
  type PermissionOutcome,
} from "@band-app/chat-runtime/acp-agent-process";
import { findOption, selectValues } from "@band-app/chat-runtime/config-options";
import { PendingWork } from "@band-app/chat-runtime/pending-work";
import { loggedSessionCost, sessionStateFromLog } from "@band-app/chat-runtime/session-state";
import { type WireRestore, WireTap } from "@band-app/chat-runtime/wire-tap";
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
import type { ChatStore, StoredQueuedMessage, WireState } from "./store.ts";

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
  /**
   * The launch for the chat's agent (or `agentId`'s): from the hub, or the last one it gave. With
   * `fresh` only the hub's answer counts, and it rejects when the hub is not reachable.
   */
  launch(chatId: string, agentId?: string, options?: { fresh?: boolean }): Promise<ChatLaunchReply>;
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

/** How a rebuilt chat stands (see {@link ChatRuntime.rebuild}). */
export type Rebuilt =
  /** No agent was held for the chat, or it could not be taken over. */
  | { kind: "none" }
  /** The agent is taken over and no turn was running. */
  | { kind: "idle" }
  /** A turn was running and carries on: `done` settles when the agent answers the prompt. */
  | {
      kind: "turn";
      turn: { taskId: string; startedAt: number; prompt: string };
      done: Promise<acp.PromptResponse>;
    }
  /** The prompt of the running turn never reached the agent. */
  | { kind: "undelivered"; taskId: string; startedAt: number; message: StoredQueuedMessage | null };

/** How long a rebuilt client waits for its connection to re-issue the open prompt. */
const ADOPT_TIMEOUT_MS = 10_000;

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
  /** The tap on the current process's JSON-RPC lines. */
  private tap: WireTap | null = null;
  /** The hash of the launch the current process started with. */
  private specHash: string | null = null;
  /** The turn the agent is working on, for the stored client state. */
  private turn: WireState["turn"] = null;
  private heldAgentId: string | null = null;
  private persistScheduled = false;
  /** The agent's `initialize` answer, stored so a rebuilt client knows its capabilities. */
  private initResponse: acp.InitializeResponse | null = null;
  /** A rebuilt client has not yet compared a fresh launch from the hub with the running agent's. */
  private launchCheckPending = false;
  private checkingLaunch = false;
  /** A fresh launch differs from the running agent's: restart it at the next clean point. */
  private restartPending = false;

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
    // Replication reads committed rows only: the row may sit in a batch that is still open.
    this.env.store.afterCommit(() => this.env.logged());
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
    this.persistSoon();
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
    requestId: string = randomUUID(),
  ): string {
    let settled = false;
    const done = (answer: string) => {
      if (settled) return;
      settled = true;
      this.pending.delete(requestId);
      this.record({ type: "request-resolved", requestId, answer });
      this.persistSoon();
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
      this.tap?.claimAgentRequest("session/request_permission", requestId);
      this.record({ type: "permission", requestId, request });
      this.persistSoon();
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
      this.tap?.claimAgentRequest("elicitation/create", requestId);
      this.record({ type: "elicitation", requestId, request });
      this.persistSoon();
      this.env.stateChanged(this.chatId);
    });
  }

  private handlers(generation: number): AcpAgentHandlers {
    return {
      onUpdate: (n) => this.routeUpdate(n),
      onAsyncTask: (n) => {
        if (n.sessionId !== this.sessionId || this.attaching) return;
        this.work.observeAsyncTask(n.update);
        this.persistSoon();
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
        this.dropWireState();
        this.process = null;
        this.starting = null;
        this.env.stateChanged(this.chatId);
      },
    };
  }

  // ---- durable client state ------------------------------------------------

  /**
   * The tap whose batches commit in one transaction with the events parsed from them. After the
   * commit the daemon may drop those bytes.
   */
  private newTap(
    base: { stdoutBase?: number; nextRequestId?: number; restore?: WireRestore } = {},
  ): WireTap {
    const store = this.env.store;
    const tap: WireTap = new WireTap(
      {
        begin: () => store.beginBatch(),
        commit: (snapshot) => {
          let saved = true;
          try {
            if (this.tap === tap) this.saveWire(tap, snapshot);
          } catch (err) {
            // The events still commit, but the stored offset is now behind them: keep the daemon's
            // bytes until a later batch stores the state.
            saved = false;
            this.env.log.error({ chatId: this.chatId, err }, "could not store the client state");
          }
          try {
            store.commitBatch();
          } catch (err) {
            // Not committed, so the daemon keeps the bytes and a rebuilt client reads them again.
            this.env.log.error({ chatId: this.chatId, err }, "could not commit the chat batch");
            return;
          }
          if (saved && this.tap === tap) tap.acknowledge();
        },
        // Before the message reaches the agent, so a restart finds a request it was written for.
        changed: () => {
          if (this.tap !== tap) return;
          try {
            this.saveWire(tap);
          } catch (err) {
            this.env.log.warn({ chatId: this.chatId, err }, "could not store the client state");
          }
        },
      },
      base.stdoutBase ?? 0,
      base.nextRequestId ?? 1,
      (line, err) => this.env.log.warn({ chatId: this.chatId, line, err }, "bad line from agent"),
      base.restore,
    );
    return tap;
  }

  private saveWire(tap: WireTap, snapshot = tap.snapshot()): void {
    const prompt = snapshot.openClientRequests.find((r) => r.method === "session/prompt");
    const state: WireState = {
      agentId: this.heldAgentId,
      sessionId: this.sessionId,
      specHash: this.specHash,
      stdoutOffset: snapshot.stdoutOffset,
      stderrOffset: tap.stderrOffset(),
      stdinOffset: snapshot.stdinOffset,
      nextRequestId: snapshot.nextRequestId,
      promptRequestId: prompt?.id ?? null,
      openClientRequests: snapshot.openClientRequests,
      openAgentRequests: snapshot.openAgentRequests.map((r) => {
        const optionIds = r.requestId ? this.pending.get(r.requestId)?.optionIds : undefined;
        return optionIds ? { ...r, optionIds } : r;
      }),
      init: this.initResponse ?? undefined,
      turn: this.inTurn && this.turn ? this.turn : null,
      revision: this.revision,
      work: this.work.snapshot(),
      live: this.live,
    };
    this.env.store.saveWireState(this.chatId, state);
  }

  /** The agent is gone for good: nothing is left to rebuild a client for. */
  private dropWireState(): void {
    const tap = this.tap;
    this.tap = null;
    // Commits the open batch's events (without state); the tap no longer matches, so it saves none.
    tap?.dispose();
    this.env.store.clearWireState(this.chatId);
  }

  /** Stores the client state after the code that changed it has run. Joins a batch that is open. */
  persistSoon(): void {
    if (this.persistScheduled || !this.tap) return;
    this.persistScheduled = true;
    setImmediate(() => {
      this.persistScheduled = false;
      const tap = this.tap;
      if (!tap) return;
      try {
        this.saveWire(tap);
      } catch (err) {
        this.env.log.warn({ chatId: this.chatId, err }, "could not store the client state");
      }
    });
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
      const baseEnv = { ...resolved.env, ...launch.env, ...launch.loginEnv };
      // What a rebuilt client compares a fresh launch with. Taken before the worker adds its own
      // variables (its CLI path, a GitHub token), and stored as a hash only.
      // Like the hub's own hash: the chat's variables (relay grant, chat ids) differ per launch by design.
      const specHash = launchSpecHash({
        ...resolved,
        env: { ...resolved.env, ...launch.loginEnv },
        unsetEnv: launch.unsetEnv,
      });
      this.launchCheckPending = false;
      this.restartPending = false;
      const env = await this.env.spawnEnv(baseEnv);
      // Held by the agent daemon when the worker has one, so the agent outlives a worker restart.
      // `owned` tells the daemon the chat works without the hub.
      const hostAcp = this.env.host.acp;
      const tap = this.newTap();
      this.tap = tap;
      this.specHash = specHash;
      this.heldAgentId = null;
      let proc: AcpAgentProcess;
      try {
        proc = await AcpAgentProcess.start(
          {
            resolveLaunch: (def) => hostAcp.resolveLaunch(def),
            spawn: async (spawnLaunch, spawnCwd) => {
              const child = await hostAcp.spawn({ ...spawnLaunch, specHash }, spawnCwd, {
                held: true,
                owned: true,
              });
              this.heldAgentId = child.held?.agentId ?? null;
              return child;
            },
          },
          { ...resolved, env, unsetEnv: launch.unsetEnv },
          launch.cwd,
          launch.agent.label,
          this.handlers(generation),
          tap,
        );
      } catch (err) {
        if (this.tap === tap) this.tap = null;
        throw err;
      }
      // Stopped while it started (the chat was released or switched agent): it never runs.
      if (this.generation !== generation) {
        proc.close();
        throw new Error("The agent was stopped while it started");
      }
      this.launch = launch;
      this.agentId = agentId;
      this.initResponse = proc.init;
      return proc;
    })();
    this.starting = starting;
    try {
      const proc = await starting;
      this.process = proc;
      this.sessionId = null;
      this.persistSoon();
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
    this.persistSoon();
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

  private async attach(
    purpose: "prompt" | "view" = "prompt",
    strictSession = false,
  ): Promise<void> {
    const info = this.info;
    const target = info.activeSessionId;
    const logged = target ? this.env.store.events.currentRevision(target) > 0 : false;
    // Viewing a session this worker has a log for needs no agent at all, and a session
    // with a turn in flight is never loaded.
    if (purpose === "view" && (!target || logged || this.inTurn)) return;
    if (target && this.sessionId === target && this.process?.alive) return;
    const proc = await this.ensureProcess(info.agentId);
    if (!target) {
      await this.attachNew(proc);
      return;
    }
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
    if (purpose === "view") {
      const reason =
        lastError instanceof Error ? lastError.message : "the agent can't reopen sessions";
      this.broadcastTransient({
        type: "notice",
        level: "warning",
        text: `This session's history couldn't be loaded: ${reason}`,
      });
      return;
    }
    // A caller that needs this very session gets the failure.
    if (strictSession) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`${proc.agentName} can't reopen session ${target}`);
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
  async ensureSession(
    purpose: "prompt" | "view" = "prompt",
    options: { strictSession?: boolean } = {},
  ): Promise<string | null> {
    while (this.attaching) await this.attaching.catch(() => undefined);
    if (purpose === "prompt") this.restartIfClean();
    this.attaching = this.attach(purpose, options.strictSession);
    try {
      await this.attaching;
    } finally {
      this.attaching = null;
    }
    return this.sessionId;
  }

  // ---- rebuilding after a worker restart -----------------------------------

  /**
   * Takes over the agent this chat's former client (the worker before it restarted) left running in
   * the agent daemon. The stored state says where the former client stood in the agent's output,
   * which requests were open in each direction and which turn ran. The daemon replays what the
   * agent said since the last committed line, so the events of those lines are logged once.
   */
  async rebuild(state: WireState): Promise<Rebuilt> {
    const none = (): Rebuilt => {
      this.env.store.clearWireState(this.chatId);
      return { kind: "none" };
    };
    const acpHost = this.env.host.acp;
    if (!state.agentId || !state.sessionId || !state.init || !acpHost.reattach) {
      this.env.log.warn(
        {
          chatId: this.chatId,
          agentId: state.agentId ?? null,
          hasSession: Boolean(state.sessionId),
          hasInit: Boolean(state.init),
          canReattach: Boolean(acpHost.reattach),
        },
        "the stored client state cannot be rebuilt; the chat's agent is not reattached",
      );
      return none();
    }
    const child = await acpHost.reattach(state.agentId, {
      stdout: state.stdoutOffset,
      stderr: state.stderrOffset,
    });
    if (!child) {
      this.env.log.warn(
        { chatId: this.chatId, agentId: state.agentId },
        "the agent could not be reattached; the chat starts a new one",
      );
      return none();
    }

    const info = this.info;
    const promptRequest = state.openClientRequests.find((r) => r.method === "session/prompt");
    const written = child.held?.stdinWritten;
    // The daemon counts the bytes it wrote to the agent. A prompt that ends past that count never arrived.
    const undelivered =
      state.turn !== null &&
      promptRequest !== undefined &&
      promptRequest.stdinEnd !== undefined &&
      written !== undefined &&
      written < promptRequest.stdinEnd;
    const adoptPromptId = promptRequest && !undelivered ? promptRequest.id : undefined;

    const generation = ++this.generation;
    const tap = this.newTap({
      stdoutBase: state.stdoutOffset,
      nextRequestId: state.nextRequestId,
      restore: {
        openClientRequests: state.openClientRequests,
        openAgentRequests: state.openAgentRequests,
        stdinBase: written ?? state.stdinOffset ?? 0,
        adoptPromptId,
      },
    });
    this.tap = tap;
    this.launch = this.env.store.ownedChat(this.chatId)?.launch ?? null;
    this.specHash = state.specHash;
    this.heldAgentId = state.agentId;
    this.agentId = info.agentId;
    this.initResponse = state.init as acp.InitializeResponse;
    this.sessionId = state.sessionId;
    this.revision = state.revision;
    this.routing = "log";
    this.lastUpdateKind = null;
    if (state.live) this.live = { ...emptyLive(), ...(state.live as Partial<LiveState>) };
    this.work.restore(state.work);
    const proc = AcpAgentProcess.reattach(
      child,
      this.initResponse,
      this.launch?.agent.label ?? info.agentId,
      this.handlers(generation),
      tap,
    );
    this.process = proc;
    this.launchCheckPending = true;
    this.restoreRequests(tap, state.openAgentRequests);

    let done: Promise<acp.PromptResponse> | null = null;
    if (state.turn && !undelivered) {
      this.inTurn = true;
      this.turnSeq++;
      this.turn = { ...state.turn, seq: this.turnSeq };
      if (adoptPromptId !== undefined) {
        // The connection re-issues the prompt; the tap keeps that request back and hands the
        // agent's reply to the old id to it.
        const request = proc.prompt(state.sessionId, []);
        request.catch(() => undefined);
        const adopted = await Promise.race([
          tap.adopted.then(() => true),
          // The request failed before it left (the agent's exit closed the connection): that is
          // the turn's outcome, with no reason to wait.
          request.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), ADOPT_TIMEOUT_MS).unref?.(),
          ),
        ]);
        if (!adopted) {
          // The agent's reply to the old id would be dropped, so the turn would never end.
          this.env.log.warn({ chatId: this.chatId }, "could not re-issue the prompt");
          done = Promise.reject(new Error("The worker could not take over the running turn"));
        } else {
          done = request;
        }
      } else {
        // The agent answered before the restart and the answer was committed: only the end of the
        // turn was never logged.
        done = Promise.resolve({ stopReason: "end_turn" } as acp.PromptResponse);
      }
      done = done.finally(() => {
        this.inTurn = false;
        this.turn = null;
        this.persistSoon();
      });
    }
    tap.release();
    this.persistSoon();
    this.env.stateChanged(this.chatId);
    this.env.log.info(
      { chatId: this.chatId, agentId: state.agentId, turn: state.turn?.taskId, undelivered },
      "rebuilt the chat's client",
    );
    // The link may be up already (the hub's connect came while this ran): check now, else on connect.
    void this.checkLaunch();
    if (state.turn && undelivered) {
      this.turn = null;
      return {
        kind: "undelivered",
        taskId: state.turn.taskId,
        startedAt: state.turn.startedAt,
        message: state.turn.message ?? null,
      };
    }
    if (state.turn && done) {
      return {
        kind: "turn",
        turn: {
          taskId: state.turn.taskId,
          startedAt: state.turn.startedAt,
          prompt: state.turn.message?.text ?? "",
        },
        done,
      };
    }
    return { kind: "idle" };
  }

  /** Reopens the permission and form requests the former client left waiting, under their ids. */
  private restoreRequests(tap: WireTap, open: WireState["openAgentRequests"]): void {
    const never = new AbortController().signal;
    for (const r of open) {
      const permission = r.method === "session/request_permission";
      const cancelled = permission ? { outcome: { outcome: "cancelled" } } : { action: "cancel" };
      const send = (result: unknown) => void tap.respond(r.id, result).catch(() => undefined);
      if (!r.requestId) {
        // The request reached the client but was never logged: nobody can answer it.
        send(cancelled);
        continue;
      }
      this.openRequest(
        never,
        (done) =>
          permission
            ? {
                optionIds: r.optionIds,
                permission: (optionId) => {
                  done(optionId ?? "cancelled");
                  send({
                    outcome: optionId
                      ? { outcome: "selected", optionId }
                      : { outcome: "cancelled" },
                  });
                },
              }
            : {
                elicitation: (response) => {
                  done(response.action);
                  send(response);
                },
              },
        () => send(cancelled),
        r.requestId,
      );
    }
  }

  /**
   * Compares a fresh launch from the hub with the one the running agent started with. A different
   * one is applied at the next clean point. Waits for the hub: with the link down it does nothing
   * and the caller tries again when the link is up.
   */
  async checkLaunch(): Promise<void> {
    if (!this.launchCheckPending || this.checkingLaunch || !this.process?.alive) return;
    const agentId = this.agentId;
    if (!agentId) return;
    this.checkingLaunch = true;
    try {
      const launch = await this.env.launch(this.chatId, agentId, { fresh: true });
      const resolved = await this.env.host.acp.resolveLaunch({
        type: launch.agent.type,
        label: launch.agent.label,
        command: launch.agent.command,
      });
      if (typeof resolved === "string") return;
      const hash = launchSpecHash({
        ...resolved,
        env: { ...resolved.env, ...launch.loginEnv },
        unsetEnv: launch.unsetEnv,
      });
      this.launchCheckPending = false;
      if (hash !== this.specHash) {
        this.env.log.info(
          { chatId: this.chatId },
          "the agent's launch changed since it started; restarting it at the next clean point",
        );
        this.restartPending = true;
        this.restartIfClean();
      }
    } catch (err) {
      this.env.log.debug({ chatId: this.chatId, err }, "launch check waits for the hub");
    } finally {
      this.checkingLaunch = false;
    }
  }

  /** Stops the agent when a newer launch is waiting and nothing runs on it: no turn, request or background work. */
  restartIfClean(): void {
    if (!this.restartPending) return;
    if (this.inTurn || this.attaching || this.pending.size > 0) return;
    if (this.work.outstanding().length > 0) return;
    this.restartPending = false;
    if (!this.process?.alive) return;
    this.env.log.info({ chatId: this.chatId }, "restarting the agent with its new launch");
    this.generation++;
    this.starting = null;
    this.stopProcess();
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

  async prompt(
    blocks: acp.ContentBlock[],
    turn?: { taskId: string; startedAt: number; message?: StoredQueuedMessage },
  ): Promise<acp.PromptResponse> {
    const proc = this.process;
    if (!proc?.alive || !this.sessionId) {
      throw new Error("The agent is not running. Send the message again to restart it.");
    }
    this.inTurn = true;
    this.turnSeq++;
    this.turn = turn ? { seq: this.turnSeq, ...turn } : null;
    try {
      try {
        return await proc.prompt(this.sessionId, blocks);
      } catch (err) {
        if (!isSessionLostError(err) || this.process !== proc) throw err;
        // The adapter lost its session but still runs. Start a new one, reattach the saved
        // session and send the prompt once more.
        this.env.log.warn({ chatId: this.chatId, err }, "agent session lost; restarting the agent");
        this.stopProcess();
        await this.ensureSession("prompt", { strictSession: true });
        const next = this.process;
        if (!next?.alive || !this.sessionId) throw err;
        return await next.prompt(this.sessionId, blocks);
      }
    } finally {
      this.inTurn = false;
      this.turn = null;
      this.persistSoon();
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
    this.dropWireState();
    this.process?.close();
    this.process = null;
    this.sessionId = null;
    this.agentId = null;
  }

  /**
   * Lets go of the agent without stopping it, for a worker that is shutting down: an agent the
   * agent daemon holds keeps running. An agent that is the worker's own child is stopped.
   */
  release(): void {
    this.generation++;
    this.starting = null;
    for (const p of [...this.pending.values()]) p.cancel();
    // Commits the open batch with its state, so the stored offset matches the logged events.
    this.tap?.dispose();
    this.tap = null;
    this.process?.release();
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
