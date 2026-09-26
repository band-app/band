/**
 * ACP client service (issue #648): owns each chat's coding-agent process,
 * the agent session it is attached to, and the chat event log.
 *
 * One agent process per chat pane, started on demand and stopped after it
 * sits idle. Everything the agent sends on the session (`session/update`,
 * permission and elicitation requests) is appended to the `chat_events`
 * table and pushed to the chat's subscribers unchanged. The browser renders
 * ACP payloads directly; there is no Band event vocabulary in between.
 *
 * Reattaching a chat to its session after the process is gone:
 *   - Band has a log for the session: `session/resume` when the agent
 *     supports it, else `session/load` with the replay dropped, because
 *     Band's log already holds the history (and holds it better: agents
 *     only have to replay message chunks).
 *   - Band has no log (a session started outside Band, picked from the
 *     history list): `session/load`, writing the replay as a new log
 *     revision.
 *   - Neither works: a new session, with a notice in the chat.
 * A session with a turn in flight is never loaded.
 *
 * Turn lifecycle (prompt records, queue, workspace status) lives in
 * `task-service`, which calls `ensureSession` / `prompt` / `cancel` here.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { createLogger } from "@band-app/logger";
import type {
  ChatEvent,
  ChatEventPayload,
  LegacyModelState,
  LoggedChatEvent,
  SessionState,
} from "../../shared/chat-events";
import {
  type AcpAgentHandlers,
  AcpAgentProcess,
  type AttachedSession,
  type PermissionOutcome,
} from "../infra/agents/acp-agent-process";
import { type AcpAgentDefinition, resolveAcpLaunch } from "../infra/agents/acp-launch";
import { ChatEventQueries, type ChatEventRow } from "../infra/db/queries/chat-events";
import {
  bandHome,
  type CodingAgentDefinition,
  resolveAgentDefinition,
  SettingsQueries,
} from "../infra/db/queries/settings";
import { rowsToEvents } from "./_utils/chat-log-replay";
import { type ChatSession, chatService } from "./chat-service";
import { workspaceService } from "./workspace-service";

const log = createLogger("agent-sessions");

/** An agent process with no turn running and nothing pending is stopped
 *  after this long. The next prompt reattaches its session. */
const IDLE_TIMEOUT_MS = 15 * 60_000;
/** After `session/cancel`, how long a turn gets to stop before its agent
 *  process is killed. */
const CANCEL_GRACE_MS = 15_000;
/** How long a probe waits after `session/new` for the agent's commands. */
const PROBE_SETTLE_MS = 1_500;

const events = new ChatEventQueries();
const settings = new SettingsQueries();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** What the agent last told us about the live session. */
interface LiveState {
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  models: LegacyModelState | null;
  commands: acp.AvailableCommand[];
  usage: acp.UsageUpdate | null;
  title: string | null;
}

interface PendingRequest {
  workspaceId: string;
  cancel(): void;
  permission?(optionId: string | null): void;
  /** Option ids the agent offered; an answer must be one of them. */
  optionIds?: string[];
  elicitation?(response: acp.CreateElicitationResponse): void;
}

interface Runtime {
  chatId: string;
  workspaceId: string;
  agentDefId: string;
  process: AcpAgentProcess | null;
  /** Bumped per spawned process, so a late exit of an old one is ignored. */
  generation: number;
  starting: Promise<AcpAgentProcess> | null;
  attaching: Promise<void> | null;
  /** The session the process is attached to, and the log revision it writes. */
  sessionId: string | null;
  revision: number;
  /**
   * Where incoming updates go: `log` records them, `buffer` holds them until
   * `session/new` answers with the session id, `drop` swallows a
   * `session/load` replay of history Band already has.
   */
  routing: "log" | "buffer" | "drop";
  buffered: acp.SessionNotification[];
  lastUpdateKind: string | null;
  inTurn: boolean;
  /** Bumped per prompt turn, so a late cancel timer can't hit a newer turn. */
  turnSeq: number;
  live: LiveState;
  pending: Map<string, PendingRequest>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** What an agent offers before a chat has a session: gathered from probes
 *  and from every session attach. */
export interface CatalogEntry {
  agentName: string;
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  models: LegacyModelState | null;
  commands: acp.AvailableCommand[];
  canList: boolean;
  updatedAt: number;
}

type Listener = (event: ChatEvent) => void;

// Held on globalThis so every bundle of this module shares one registry
// (same reason as task-service / terminal-pool).
const RUNTIMES_KEY = Symbol.for("band.acp.runtimes");
const LISTENERS_KEY = Symbol.for("band.acp.listeners");
const CATALOG_KEY = Symbol.for("band.acp.catalog");
const g = globalThis as unknown as Record<symbol, unknown>;
g[RUNTIMES_KEY] ??= new Map<string, Runtime>();
g[LISTENERS_KEY] ??= new Map<string, Set<Listener>>();
g[CATALOG_KEY] ??= new Map<string, CatalogEntry>();
const runtimes = g[RUNTIMES_KEY] as Map<string, Runtime>;
const listeners = g[LISTENERS_KEY] as Map<string, Set<Listener>>;
const catalog = g[CATALOG_KEY] as Map<string, CatalogEntry>;

/** Ids for events broadcast without a log row. Negative, so they never move
 *  a client's gap-fill cursor. */
let transientId = -1_000_000_000;

let pendingObserver: ((workspaceId: string) => void) | null = null;

function emptyLive(): LiveState {
  return { configOptions: [], modes: null, models: null, commands: [], usage: null, title: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}

function definitionFor(chat: Pick<ChatSession, "agent">): CodingAgentDefinition {
  return resolveAgentDefinition(settings.load(), chat.agent);
}

function launchDefinition(def: CodingAgentDefinition): AcpAgentDefinition {
  return { type: def.type, label: def.label, command: def.command };
}

/** A choice of a select-type session config option, groups flattened. */
export interface ConfigChoice {
  id: string;
  name: string;
  description?: string;
}

/** The select option for a category (`model`, `mode`), by ACP category or
 *  by the id agents conventionally give it. */
export function findOption(
  options: acp.SessionConfigOption[],
  category: "model" | "mode",
): acp.SessionConfigOption | undefined {
  return options.find((o) => o.type === "select" && (o.category === category || o.id === category));
}

/** A select option's choices, flat or grouped, as one list. */
export function optionChoices(option: acp.SessionConfigOption): ConfigChoice[] {
  if (option.type !== "select") return [];
  return option.options
    .flatMap((o) => ("group" in o ? o.options : [o]))
    .map((o) => ({ id: o.value, name: o.name, description: o.description ?? undefined }));
}

function selectValues(option: acp.SessionConfigOption): string[] {
  return optionChoices(option).map((c) => c.id);
}

function emit(chatId: string, event: ChatEvent): void {
  const subs = listeners.get(chatId);
  if (!subs) return;
  for (const listener of subs) {
    try {
      listener(event);
    } catch (err) {
      log.warn({ chatId, err }, "chat listener threw");
    }
  }
}

function runtimeFor(chat: ChatSession, def: CodingAgentDefinition): Runtime {
  let rt = runtimes.get(chat.id);
  if (rt && rt.agentDefId !== def.id) {
    // The chat switched agents; the old process can't serve the new one.
    stopRuntime(rt);
    rt = undefined;
  }
  if (!rt) {
    rt = {
      chatId: chat.id,
      workspaceId: chat.workspaceId,
      agentDefId: def.id,
      process: null,
      generation: 0,
      starting: null,
      attaching: null,
      sessionId: null,
      revision: 0,
      routing: "log",
      buffered: [],
      lastUpdateKind: null,
      inTurn: false,
      turnSeq: 0,
      live: emptyLive(),
      pending: new Map(),
      idleTimer: null,
    };
    runtimes.set(chat.id, rt);
  }
  return rt;
}

function stopRuntime(rt: Runtime): void {
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  for (const p of [...rt.pending.values()]) p.cancel();
  rt.process?.close();
  rt.process = null;
  rt.sessionId = null;
  runtimes.delete(rt.chatId);
}

function scheduleIdle(rt: Runtime): void {
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  rt.idleTimer = setTimeout(() => {
    rt.idleTimer = null;
    if (rt.inTurn || rt.pending.size > 0 || rt.attaching) return;
    log.info({ chatId: rt.chatId }, "stopping idle agent");
    rt.process?.close();
    rt.process = null;
    rt.sessionId = null;
    // The next use builds a fresh runtime and reattaches the session.
    if (runtimes.get(rt.chatId) === rt) runtimes.delete(rt.chatId);
  }, IDLE_TIMEOUT_MS);
  rt.idleTimer.unref?.();
}

/** Appends an event to the runtime's session log and broadcasts it. Before
 *  the chat has a session, the event is broadcast without a log row. */
function record(rt: Runtime, event: LoggedChatEvent, turnStart = false): void {
  if (!rt.sessionId) {
    broadcastTransient(rt.chatId, event);
    return;
  }
  const id = events.append({
    chatId: rt.chatId,
    sessionId: rt.sessionId,
    revision: rt.revision,
    event,
    turnStart,
  });
  emit(rt.chatId, { ...event, eventId: id } as ChatEvent);
}

function broadcastTransient(chatId: string, event: ChatEventPayload): void {
  emit(chatId, { ...event, eventId: transientId-- } as ChatEvent);
}

function remember(def: CodingAgentDefinition, patch: Partial<CatalogEntry>): void {
  const prev = catalog.get(def.id);
  catalog.set(def.id, {
    agentName: prev?.agentName ?? def.label,
    configOptions: prev?.configOptions ?? [],
    modes: prev?.modes ?? null,
    models: prev?.models ?? null,
    commands: prev?.commands ?? [],
    canList: prev?.canList ?? false,
    ...patch,
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Incoming traffic
// ---------------------------------------------------------------------------

function applyLive(rt: Runtime, update: acp.SessionUpdate): void {
  const def = { id: rt.agentDefId } as CodingAgentDefinition;
  switch (update.sessionUpdate) {
    case "available_commands_update":
      rt.live.commands = update.availableCommands;
      remember(def, { commands: update.availableCommands });
      break;
    case "config_option_update":
      rt.live.configOptions = update.configOptions;
      break;
    case "current_mode_update":
      if (rt.live.modes) rt.live.modes = { ...rt.live.modes, currentModeId: update.currentModeId };
      break;
    case "usage_update":
      rt.live.usage = { used: update.used, size: update.size, cost: update.cost ?? null };
      break;
    case "session_info_update":
      if (update.title !== undefined) {
        rt.live.title = update.title ?? null;
        if (update.title && rt.sessionId) {
          chatService.updateSessionSummary(rt.chatId, rt.sessionId, update.title, Date.now());
        }
      }
      break;
  }
}

function routeUpdate(rt: Runtime, notification: acp.SessionNotification): void {
  if (rt.routing === "buffer") {
    rt.buffered.push(notification);
    return;
  }
  if (notification.sessionId !== rt.sessionId) {
    log.debug(
      { chatId: rt.chatId, sessionId: notification.sessionId },
      "update for another session",
    );
    return;
  }
  const update = notification.update;
  applyLive(rt, update);
  if (rt.routing === "drop") return;
  if (update.sessionUpdate === "user_message_chunk") {
    // During a turn Band started, the prompt is already logged; an agent
    // echoing it back would show it twice.
    if (rt.inTurn) return;
    const turnStart = rt.lastUpdateKind !== "user_message_chunk";
    rt.lastUpdateKind = update.sessionUpdate;
    record(rt, { type: "update", update }, turnStart);
    return;
  }
  rt.lastUpdateKind = update.sessionUpdate;
  record(rt, { type: "update", update });
}

function openRequest(
  rt: Runtime,
  signal: AbortSignal,
  make: (done: (answer: string) => void) => Omit<PendingRequest, "workspaceId" | "cancel">,
  onCancel: () => void,
): string {
  const requestId = randomUUID();
  let settled = false;
  const done = (answer: string) => {
    if (settled) return;
    settled = true;
    rt.pending.delete(requestId);
    record(rt, { type: "request-resolved", requestId, answer });
    pendingObserver?.(rt.workspaceId);
  };
  const handlers = make(done);
  const cancel = () => {
    if (settled) return;
    done("cancelled");
    onCancel();
  };
  rt.pending.set(requestId, { workspaceId: rt.workspaceId, cancel, ...handlers });
  signal.addEventListener("abort", cancel, { once: true });
  return requestId;
}

function requestPermission(
  rt: Runtime,
  request: acp.RequestPermissionRequest,
  signal: AbortSignal,
): Promise<PermissionOutcome> {
  return new Promise((resolve) => {
    const requestId = openRequest(
      rt,
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
    record(rt, { type: "permission", requestId, request });
    pendingObserver?.(rt.workspaceId);
  });
}

function requestElicitation(
  rt: Runtime,
  request: acp.CreateElicitationRequest,
  signal: AbortSignal,
): Promise<acp.CreateElicitationResponse> {
  if (request.mode !== "form") return Promise.resolve({ action: "decline" });
  return new Promise((resolve) => {
    const requestId = openRequest(
      rt,
      signal,
      (done) => ({
        elicitation: (response) => {
          done(response.action);
          resolve(response);
        },
      }),
      () => resolve({ action: "cancel" }),
    );
    record(rt, { type: "elicitation", requestId, request });
    pendingObserver?.(rt.workspaceId);
  });
}

function handlersFor(rt: Runtime, generation: number): AcpAgentHandlers {
  return {
    onUpdate: (n) => routeUpdate(rt, n),
    onPermission: (req, signal) => requestPermission(rt, req, signal),
    onElicitation: (req, signal) => requestElicitation(rt, req, signal),
    onExit: (code, stderr) => {
      if (rt.generation !== generation) return;
      log.info({ chatId: rt.chatId, code }, "agent exited");
      // stderr can hold auth details; keep it out of info-level logs.
      log.debug({ chatId: rt.chatId, stderr: stderr.slice(-500) }, "agent stderr");
      for (const p of [...rt.pending.values()]) p.cancel();
      // `sessionId` stays: the failed turn still logs its end there. With
      // no process, the next `ensureSession` reattaches.
      rt.process = null;
      rt.starting = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Process and session attach
// ---------------------------------------------------------------------------

async function ensureProcess(
  rt: Runtime,
  def: CodingAgentDefinition,
  cwd: string,
): Promise<AcpAgentProcess> {
  if (rt.process?.alive) return rt.process;
  if (rt.starting) return rt.starting;
  const generation = ++rt.generation;
  rt.starting = (async () => {
    const launch = await resolveAcpLaunch(launchDefinition(def));
    if (typeof launch === "string") throw new Error(launch);
    const proc = await AcpAgentProcess.start(launch, cwd, def.label, handlersFor(rt, generation));
    remember(def, { agentName: proc.agentName, canList: proc.canList });
    return proc;
  })();
  try {
    const proc = await rt.starting;
    rt.process = proc;
    rt.sessionId = null;
    return proc;
  } finally {
    rt.starting = null;
  }
}

function setLive(rt: Runtime, def: CodingAgentDefinition, attached: AttachedSession): void {
  rt.live = {
    ...rt.live,
    configOptions: attached.configOptions,
    modes: attached.modes,
    models: attached.models,
  };
  remember(def, {
    configOptions: attached.configOptions,
    modes: attached.modes,
    models: attached.models,
  });
}

function logAttached(
  rt: Runtime,
  proc: AcpAgentProcess,
  how: "new" | "load" | "resume",
  attached: AttachedSession,
): void {
  record(rt, {
    type: "session-attached",
    sessionId: attached.sessionId,
    how,
    revision: rt.revision,
    agentName: proc.agentName,
    configOptions: attached.configOptions,
    modes: attached.modes,
    models: attached.models,
  });
}

/** Applies the chat's saved model and mode choices to a fresh attach. */
async function applyPreferences(
  rt: Runtime,
  proc: AcpAgentProcess,
  chat: ChatSession,
  def: CodingAgentDefinition,
): Promise<void> {
  const sessionId = rt.sessionId;
  if (!sessionId) return;
  const wanted: Array<["model" | "mode", string | undefined]> = [
    ["model", chat.model ?? def.model],
    ["mode", chat.mode],
  ];
  for (const [category, value] of wanted) {
    if (!value) continue;
    try {
      const option = findOption(rt.live.configOptions, category);
      if (option) {
        if (option.currentValue !== value && selectValues(option).includes(value)) {
          const options = await proc.setConfigOption(sessionId, option.id, value);
          rt.live.configOptions = options;
          record(rt, {
            type: "update",
            update: { sessionUpdate: "config_option_update", configOptions: options },
          });
        }
      } else if (category === "model" && rt.live.models) {
        const models = rt.live.models;
        if (
          models.currentModelId !== value &&
          models.availableModels.some((m) => m.modelId === value)
        ) {
          await proc.setModel(sessionId, value);
          rt.live.models = { ...models, currentModelId: value };
        }
      } else if (category === "mode" && rt.live.modes) {
        const modes = rt.live.modes;
        if (modes.currentModeId !== value && modes.availableModes.some((m) => m.id === value)) {
          await proc.setMode(sessionId, value);
          rt.live.modes = { ...modes, currentModeId: value };
          record(rt, {
            type: "update",
            update: { sessionUpdate: "current_mode_update", currentModeId: value },
          });
        }
      }
    } catch (err) {
      log.warn({ chatId: rt.chatId, category, value, err }, "could not apply saved setting");
    }
  }
}

async function attachNew(
  rt: Runtime,
  proc: AcpAgentProcess,
  chat: ChatSession,
  def: CodingAgentDefinition,
  cwd: string,
): Promise<void> {
  rt.routing = "buffer";
  rt.buffered = [];
  let attached: AttachedSession;
  try {
    attached = await proc.newSession(cwd, [
      join(bandHome(), "uploads"),
      join(bandHome(), "shared"),
    ]);
  } catch (err) {
    rt.routing = "log";
    throw err;
  }
  rt.sessionId = attached.sessionId;
  rt.revision = events.currentRevision(attached.sessionId) + 1;
  rt.routing = "log";
  rt.lastUpdateKind = null;
  setLive(rt, def, attached);
  chatService.updateActiveSession(chat.id, {
    activeSessionId: attached.sessionId,
    summary: undefined,
    lastModified: Date.now(),
  });
  logAttached(rt, proc, "new", attached);
  const buffered = rt.buffered.filter((n) => n.sessionId === attached.sessionId);
  rt.buffered = [];
  for (const n of buffered) routeUpdate(rt, n);
  await applyPreferences(rt, proc, chat, def);
}

async function attachExisting(
  rt: Runtime,
  proc: AcpAgentProcess,
  chat: ChatSession,
  def: CodingAgentDefinition,
  cwd: string,
  sessionId: string,
  how: "load" | "resume",
  writeReplay: boolean,
): Promise<void> {
  const revision = events.currentRevision(sessionId);
  rt.sessionId = sessionId;
  rt.revision = writeReplay || revision === 0 ? revision + 1 : revision;
  rt.routing = how === "load" && !writeReplay ? "drop" : "log";
  rt.lastUpdateKind = null;
  try {
    const attached =
      how === "load"
        ? await proc.loadSession(sessionId, cwd)
        : await proc.resumeSession(sessionId, cwd);
    rt.routing = "log";
    setLive(rt, def, attached);
    logAttached(rt, proc, how, attached);
    await applyPreferences(rt, proc, chat, def);
  } catch (err) {
    rt.routing = "log";
    rt.sessionId = null;
    throw err;
  }
}

/** True when some chat is running a turn on `sessionId`. */
function sessionBusy(sessionId: string): boolean {
  for (const rt of runtimes.values()) {
    if (rt.inTurn && rt.sessionId === sessionId) return true;
  }
  return false;
}

async function attach(
  rt: Runtime,
  chat: ChatSession,
  def: CodingAgentDefinition,
  cwd: string,
  purpose: "prompt" | "view",
): Promise<void> {
  const target = chat.activeSessionId;
  const logged = target ? events.currentRevision(target) > 0 : false;
  // Viewing a session Band has a log for needs no agent at all.
  if (purpose === "view" && (!target || logged)) return;
  if (target && rt.sessionId === target && rt.process?.alive) return;
  if (purpose === "view" && target && sessionBusy(target)) return;

  const proc = await ensureProcess(rt, def, cwd);
  if (!target) {
    await attachNew(rt, proc, chat, def, cwd);
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
      await attachExisting(rt, proc, chat, def, cwd, target, step.how, step.writeReplay);
      return;
    } catch (err) {
      lastError = err;
      log.warn(
        { chatId: rt.chatId, sessionId: target, how: step.how, err },
        "session attach failed",
      );
      if (!proc.alive) throw err;
    }
  }

  if (purpose === "view") {
    const reason =
      lastError instanceof Error ? lastError.message : "the agent can't reopen sessions";
    broadcastTransient(rt.chatId, {
      type: "notice",
      level: "warning",
      text: `This session's history couldn't be loaded: ${reason}`,
    });
    return;
  }
  // Keep the conversation going in a fresh session, and say so.
  await attachNew(rt, proc, chat, def, cwd);
  record(rt, {
    type: "notice",
    level: "warning",
    text:
      lastError instanceof Error
        ? `The previous session couldn't be reopened (${lastError.message}), so this is a new session.`
        : `${proc.agentName} can't reopen past sessions, so this is a new session.`,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SessionListing {
  sessions: { sessionId: string; summary: string; lastModified: number }[];
  supported: boolean;
}

export class AgentSessionService {
  /** Subscribes to a chat's events: logged ones with their row id, and
   *  transient ones with negative ids. */
  subscribe(chatId: string, listener: Listener): () => void {
    let subs = listeners.get(chatId);
    if (!subs) {
      subs = new Set();
      listeners.set(chatId, subs);
    }
    subs.add(listener);
    return () => {
      subs.delete(listener);
      if (subs.size === 0) listeners.delete(chatId);
    };
  }

  /** Called whenever a permission or elicitation request opens or closes,
   *  so task-service can flip the workspace's attention status. */
  observePending(observer: (workspaceId: string) => void): void {
    pendingObserver = observer;
  }

  /**
   * Makes sure the chat's agent process runs and is attached to the chat's
   * session, starting a new session when the chat has none. For `view`,
   * only attaches when the session needs `session/load` to show anything.
   * Returns the attached session id, or null when nothing was attached.
   */
  async ensureSession(chatId: string, purpose: "prompt" | "view"): Promise<string | null> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    const workspace = workspaceService.resolve(chat.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${chat.workspaceId}`);
    const def = definitionFor(chat);
    const rt = runtimeFor(chat, def);
    while (rt.attaching) await rt.attaching.catch(() => undefined);
    const fresh = chatService.get(chatId) ?? chat;
    rt.attaching = attach(rt, fresh, def, workspace.worktree.path, purpose);
    try {
      await rt.attaching;
    } finally {
      rt.attaching = null;
    }
    if (!rt.inTurn && rt.process) scheduleIdle(rt);
    return rt.sessionId;
  }

  /** Prompt capabilities of the chat's running agent. */
  promptCapabilities(chatId: string): acp.PromptCapabilities {
    return runtimes.get(chatId)?.process?.promptCapabilities ?? {};
  }

  /** The id of the model the live session uses, for cost estimates. */
  currentModel(chatId: string): string | undefined {
    const rt = runtimes.get(chatId);
    if (!rt) return undefined;
    const option = findOption(rt.live.configOptions, "model");
    if (option && typeof option.currentValue === "string") return option.currentValue;
    return rt.live.models?.currentModelId;
  }

  /** The agent's own cumulative session cost, when it reports one. */
  reportedCost(chatId: string): number | undefined {
    const cost = runtimes.get(chatId)?.live.usage?.cost;
    return cost && cost.currency === "USD" ? cost.amount : undefined;
  }

  /** Runs one prompt turn on the attached session. */
  async prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const rt = runtimes.get(chatId);
    const proc = rt?.process;
    if (!rt || !proc?.alive || !rt.sessionId) {
      throw new Error("The agent is not running. Send the message again to restart it.");
    }
    if (rt.idleTimer) clearTimeout(rt.idleTimer);
    rt.inTurn = true;
    rt.turnSeq++;
    try {
      return await proc.prompt(rt.sessionId, blocks);
    } finally {
      rt.inTurn = false;
      if (rt.process) scheduleIdle(rt);
    }
  }

  /**
   * Stops the chat's current turn. ACP requires open permission requests to
   * be answered `cancelled` first. If the agent doesn't stop in time, its
   * process is killed, which ends the turn with an error.
   */
  async cancel(chatId: string): Promise<void> {
    const rt = runtimes.get(chatId);
    if (!rt) return;
    for (const p of [...rt.pending.values()]) p.cancel();
    const proc = rt.process;
    if (!proc || !rt.sessionId) return;
    await proc.cancel(rt.sessionId);
    const turn = rt.turnSeq;
    setTimeout(() => {
      if (rt.inTurn && rt.turnSeq === turn && rt.process === proc) {
        log.warn({ chatId }, "agent ignored session/cancel; killing it");
        proc.close();
      }
    }, CANCEL_GRACE_MS).unref?.();
  }

  /** Appends a Band-side event (prompt, turn boundary, file, notice) to the
   *  chat's current session log and broadcasts it. */
  record(chatId: string, event: LoggedChatEvent, turnStart = false): void {
    const rt = runtimes.get(chatId);
    if (!rt) {
      broadcastTransient(chatId, event);
      return;
    }
    record(rt, event, turnStart);
  }

  /** Broadcasts an event that isn't logged (a failure before any session). */
  broadcastTransient(chatId: string, event: ChatEventPayload): void {
    broadcastTransient(chatId, event);
  }

  answerPermission(chatId: string, requestId: string, optionId: string | null): boolean {
    const pending = runtimes.get(chatId)?.pending.get(requestId);
    if (!pending?.permission) return false;
    if (optionId !== null && !pending.optionIds?.includes(optionId)) return false;
    pending.permission(optionId);
    return true;
  }

  answerElicitation(
    chatId: string,
    requestId: string,
    response: acp.CreateElicitationResponse,
  ): boolean {
    const pending = runtimes.get(chatId)?.pending.get(requestId);
    if (!pending?.elicitation) return false;
    pending.elicitation(response);
    return true;
  }

  /** True while any chat in the workspace waits on the user. */
  hasPendingRequest(workspaceId: string): boolean {
    for (const rt of runtimes.values()) {
      for (const p of rt.pending.values()) if (p.workspaceId === workspaceId) return true;
    }
    return false;
  }

  /** True while the chat's agent runs a turn. */
  isInTurn(chatId: string): boolean {
    return runtimes.get(chatId)?.inTurn === true;
  }

  /**
   * Changes a session setting. Saved on the chat row (model and mode, so a
   * later session starts with it) and applied to the live session, if any.
   */
  async setConfigOption(chatId: string, configId: string, value: string): Promise<SessionState> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    const rt = runtimes.get(chatId);
    const state = this.getSessionState(chatId);
    const option = state.configOptions.find((o) => o.id === configId);
    const category =
      option?.category === "model" || configId === "model"
        ? "model"
        : option?.category === "mode" || configId === "mode"
          ? "mode"
          : configId === "__legacy_model"
            ? "model"
            : configId === "__legacy_mode"
              ? "mode"
              : undefined;
    if (category === "model") chatService.update(chatId, { model: value });
    if (category === "mode") chatService.update(chatId, { mode: value });

    const proc = rt?.process;
    if (rt && proc?.alive && rt.sessionId && rt.sessionId === chat.activeSessionId) {
      if (configId === "__legacy_model") {
        await proc.setModel(rt.sessionId, value);
        if (rt.live.models) rt.live.models = { ...rt.live.models, currentModelId: value };
      } else if (configId === "__legacy_mode") {
        await proc.setMode(rt.sessionId, value);
        if (rt.live.modes) rt.live.modes = { ...rt.live.modes, currentModeId: value };
        record(rt, {
          type: "update",
          update: { sessionUpdate: "current_mode_update", currentModeId: value },
        });
      } else {
        const options = await proc.setConfigOption(rt.sessionId, configId, value);
        rt.live.configOptions = options;
        record(rt, {
          type: "update",
          update: { sessionUpdate: "config_option_update", configOptions: options },
        });
      }
    }
    const next = this.getSessionState(chatId);
    broadcastTransient(chatId, { type: "session-state", state: next });
    return next;
  }

  /**
   * Session settings for the chat: from the live agent when it runs the
   * chat's session, else rebuilt from the log, else the agent catalog with
   * the chat's saved choices applied. A chat the server has no row for yet
   * (a new pane, created lazily on its first message) gets the default
   * agent's catalog entry.
   */
  getSessionState(chatId: string): SessionState {
    const chat: Pick<ChatSession, "agent" | "activeSessionId" | "model" | "mode"> = chatService.get(
      chatId,
    ) ?? {
      agent: undefined as unknown as string,
      activeSessionId: undefined,
      model: undefined,
      mode: undefined,
    };
    const def = definitionFor(chat);
    const rt = runtimes.get(chatId);
    const sessionId = chat.activeSessionId;

    if (rt?.process?.alive && rt.sessionId && rt.sessionId === sessionId) {
      return {
        source: "live",
        ...rt.live,
        costUsd: this.reportedCost(chatId) ?? sessionCost(sessionId),
      };
    }

    const revision = sessionId ? events.currentRevision(sessionId) : 0;
    if (sessionId && revision > 0) {
      const latest = (match: Parameters<ChatEventQueries["latest"]>[2]) =>
        events.latest(sessionId, revision, match);
      const attached = latest({ kind: "session-attached" });
      const after = (row: ChatEventRow | undefined) =>
        row && (!attached || row.id > attached.id) ? row.event : undefined;
      const base = attached?.event.type === "session-attached" ? attached.event : undefined;
      const configUpdate = after(latest({ updateKind: "config_option_update" }));
      const modeUpdate = after(latest({ updateKind: "current_mode_update" }));
      const commands = latest({ updateKind: "available_commands_update" })?.event;
      const usage = latest({ updateKind: "usage_update" })?.event;
      const info = latest({ updateKind: "session_info_update" })?.event;
      const modes = base?.modes ?? null;
      const usageUpdate =
        usage?.type === "update" && usage.update.sessionUpdate === "usage_update"
          ? usage.update
          : null;
      return {
        source: "log",
        configOptions:
          configUpdate?.type === "update" &&
          configUpdate.update.sessionUpdate === "config_option_update"
            ? configUpdate.update.configOptions
            : (base?.configOptions ?? []),
        modes:
          modes &&
          modeUpdate?.type === "update" &&
          modeUpdate.update.sessionUpdate === "current_mode_update"
            ? { ...modes, currentModeId: modeUpdate.update.currentModeId }
            : modes,
        models: base?.models ?? null,
        commands:
          commands?.type === "update" &&
          commands.update.sessionUpdate === "available_commands_update"
            ? commands.update.availableCommands
            : (catalog.get(def.id)?.commands ?? []),
        usage: usageUpdate,
        costUsd:
          usageUpdate?.cost?.currency === "USD" ? usageUpdate.cost.amount : sessionCost(sessionId),
        title:
          info?.type === "update" && info.update.sessionUpdate === "session_info_update"
            ? (info.update.title ?? null)
            : null,
      };
    }

    const cached = catalog.get(def.id);
    const withChoice = (options: acp.SessionConfigOption[]) =>
      options.map((o) => {
        const category = o.category === "model" || o.id === "model" ? "model" : o.category;
        const choice =
          category === "model"
            ? (chat.model ?? def.model)
            : category === "mode"
              ? chat.mode
              : undefined;
        return choice && o.type === "select" && selectValues(o).includes(choice)
          ? { ...o, currentValue: choice }
          : o;
      });
    const models = cached?.models ?? null;
    const modes = cached?.modes ?? null;
    const modelChoice = chat.model ?? def.model;
    return {
      source: "cached",
      configOptions: withChoice(cached?.configOptions ?? []),
      modes:
        modes && chat.mode && modes.availableModes.some((m) => m.id === chat.mode)
          ? { ...modes, currentModeId: chat.mode }
          : modes,
      models:
        models && modelChoice && models.availableModels.some((m) => m.modelId === modelChoice)
          ? { ...models, currentModelId: modelChoice }
          : models,
      commands: cached?.commands ?? [],
      usage: null,
      costUsd: null,
      title: null,
    };
  }

  /**
   * Past sessions for the chat's agent in its workspace: the agent's
   * `session/list` when it supports it, with Band's own log filling in
   * titles and covering agents that can't list.
   */
  async listSessions(chatId: string): Promise<SessionListing> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    const workspace = workspaceService.resolve(chat.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${chat.workspaceId}`);
    const def = definitionFor(chat);
    const sameAgent = chatService
      .list(chat.workspaceId)
      .filter((c) => definitionFor(c).id === def.id)
      .map((c) => c.id);
    const logged = events.listSessions(sameAgent);
    const titles = new Map(logged.map((s) => [s.sessionId, s.title]));

    const rt = runtimeFor(chat, def);
    let agentSessions: acp.SessionInfo[] | null = null;
    try {
      const proc = await ensureProcess(rt, def, workspace.worktree.path);
      if (!rt.inTurn) scheduleIdle(rt);
      if (proc.canList) agentSessions = await proc.listSessions(workspace.worktree.path);
    } catch (err) {
      log.warn({ chatId, err }, "session/list failed; using Band's log");
      // Let the idle timer drop a runtime that never got a process.
      if (!rt.inTurn) scheduleIdle(rt);
    }

    if (agentSessions) {
      return {
        supported: true,
        sessions: agentSessions.map((s) => ({
          sessionId: s.sessionId,
          summary: s.title || titles.get(s.sessionId) || s.sessionId,
          lastModified: s.updatedAt ? Date.parse(s.updatedAt) : 0,
        })),
      };
    }
    return {
      supported: true,
      sessions: logged.map((s) => ({
        sessionId: s.sessionId,
        summary: s.title ?? s.sessionId,
        lastModified: s.updatedAt,
      })),
    };
  }

  /** The first prompt of a logged session, used as its title. */
  sessionTitle(sessionId: string): string | undefined {
    return events.firstPrompt(sessionId);
  }

  /** The live revision of a session's log, or 0 when Band has none. */
  logRevision(sessionId: string): number {
    return events.currentRevision(sessionId);
  }

  /** Logged events after `afterId`, text chunks merged. */
  replayAfter(sessionId: string, revision: number, afterId: number): ChatEvent[] {
    return rowsToEvents(events.readAfter(sessionId, revision, afterId));
  }

  /** The last `turns` turns before `beforeId` (or the end), text chunks
   *  merged, whether older turns exist, and the id to page back from. */
  replayTurns(
    sessionId: string,
    revision: number,
    turns: number,
    beforeId?: number,
  ): { events: ChatEvent[]; hasOlder: boolean; oldestEventId: number } {
    const { rows, hasOlder } = events.readTurns(sessionId, revision, turns, beforeId);
    // The page cursor is the first raw row: a merged text run carries its
    // last row's id, and paging from that would repeat the run's head.
    return { events: rowsToEvents(rows), hasOlder, oldestEventId: rows[0]?.id ?? 0 };
  }

  /** Stops the chat's agent. Used when the chat is removed or switches agent. */
  stop(chatId: string): void {
    const rt = runtimes.get(chatId);
    if (rt) stopRuntime(rt);
  }

  /** Drops the chat's event log. */
  deleteLog(chatId: string): void {
    events.deleteForChat(chatId);
  }

  /** Stops every agent. Called on server shutdown. */
  stopAll(): void {
    for (const rt of [...runtimes.values()]) stopRuntime(rt);
  }

  /**
   * Starts an agent in a scratch session to learn what it offers (models,
   * modes, slash commands) without a chat. Feeds the pickers of chats that
   * have no session yet and the settings model cache.
   */
  async probe(def: CodingAgentDefinition, cwd = bandHome()): Promise<CatalogEntry> {
    const launch = await resolveAcpLaunch(launchDefinition(def));
    if (typeof launch === "string") throw new Error(launch);
    let commands: acp.AvailableCommand[] = [];
    const proc = await AcpAgentProcess.start(launch, cwd, def.label, {
      onUpdate: (n) => {
        if (n.update.sessionUpdate === "available_commands_update") {
          commands = n.update.availableCommands;
        }
      },
      onPermission: async () => ({ outcome: "cancelled" }),
      onElicitation: async () => ({ action: "cancel" }),
      onExit: () => undefined,
    });
    try {
      const attached = await proc.newSession(cwd);
      await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
      remember(def, {
        agentName: proc.agentName,
        configOptions: attached.configOptions,
        modes: attached.modes,
        models: attached.models,
        commands,
        canList: proc.canList,
      });
      return catalog.get(def.id) as CatalogEntry;
    } finally {
      proc.close();
    }
  }

  /**
   * The modes an agent offers, from the catalog: its `mode` config option,
   * else its legacy session modes. Empty until a probe or a session has
   * reported them.
   */
  listModes(agentId?: string): ConfigChoice[] {
    const entry = catalog.get(resolveAgentDefinition(settings.load(), agentId).id);
    if (!entry) return [];
    const option = findOption(entry.configOptions, "mode");
    if (option) return optionChoices(option);
    return (entry.modes?.availableModes ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
    }));
  }

  /** What the catalog knows about an agent, if anything. */
  catalogEntry(agentDefId: string): CatalogEntry | undefined {
    return catalog.get(agentDefId);
  }

  /**
   * Runs one prompt in a throwaway session and returns the text of the
   * agent's last message (the prose after its final tool call). Used for
   * one-shot jobs such as writing a commit message, where nobody is there
   * to answer a permission prompt. The prompt reads untrusted repo content,
   * so only read-only calls (`read`, `search`) are approved, once; anything
   * else the agent's rules would ask about is refused. Read-only git
   * commands don't reach this: Claude Code allows them without asking and
   * Codex runs them in its workspace sandbox.
   */
  async oneShot(def: CodingAgentDefinition, cwd: string, prompt: string): Promise<string> {
    const launch = await resolveAcpLaunch(launchDefinition(def));
    if (typeof launch === "string") throw new Error(launch);
    let sessionId: string | null = null;
    let text = "";
    const proc = await AcpAgentProcess.start(launch, cwd, def.label, {
      onUpdate: (n) => {
        if (n.sessionId !== sessionId) return;
        const u = n.update;
        // Narration before a tool call ("Let me check the diff…") is not
        // part of the answer.
        if (u.sessionUpdate === "tool_call") text = "";
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
          text += u.content.text;
        }
      },
      onPermission: async (req) => {
        const kind = req.toolCall.kind;
        const allow =
          kind === "read" || kind === "search"
            ? req.options.find((o) => o.kind === "allow_once")
            : undefined;
        return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
      },
      onElicitation: async () => ({ action: "decline" }),
      onExit: () => undefined,
    });
    try {
      const attached = await proc.newSession(cwd);
      sessionId = attached.sessionId;
      const model = def.model;
      const option = model ? findOption(attached.configOptions, "model") : undefined;
      if (model && option && selectValues(option).includes(model)) {
        await proc.setConfigOption(sessionId, option.id, model).catch(() => undefined);
      }
      const res = await proc.prompt(sessionId, [{ type: "text", text: prompt }]);
      if (res.stopReason !== "end_turn") throw new Error(`the agent stopped: ${res.stopReason}`);
      return text;
    } finally {
      proc.close();
    }
  }
}

/** Band's running cost estimate for a session, from its last finished turn. */
function sessionCost(sessionId: string): number | null {
  const revision = events.currentRevision(sessionId);
  if (revision === 0) return null;
  const row = events.latest(sessionId, revision, { kind: "turn-ended" });
  return row?.event.type === "turn-ended" ? (row.event.usage?.costUsd ?? null) : null;
}

export const agentSessionService = new AgentSessionService();
