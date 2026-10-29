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
 * Turn lifecycle (prompt records, queue, worktree status) lives in
 * `task-service`, which calls `ensureSession` / `prompt` / `cancel` here.
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  type AcpAgentHandlers,
  AcpAgentProcess,
  AgentProcessError,
  type AttachedSession,
  type PermissionOutcome,
} from "@band-app/chat-runtime/acp-agent-process";
import {
  type ConfigChoice,
  configCategory,
  findOption,
  optionChoices,
  selectValues,
} from "@band-app/chat-runtime/config-options";
import { PendingWork } from "@band-app/chat-runtime/pending-work";
import { rowsToEvents } from "@band-app/chat-runtime/replay";
import { loggedSessionCost, sessionStateFromLog } from "@band-app/chat-runtime/session-state";
import {
  type AcpAgentDefinition,
  type AcpLaunch,
  type ClaudeCliArgs,
  type ClaudeDefaults,
  type Host,
  HostOfflineError,
} from "@band-app/host-api";
import type { ChatLaunchReply, OwnedChatInfo } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { type AgentFailure, classifyFailure } from "@band-app/shared/agent-failure";
import type {
  ChatEvent,
  ChatEventPayload,
  LegacyModelState,
  LoggedChatEvent,
  ResolvedDefaults,
  SessionState,
} from "@band-app/shared/chat-events";
import { ChatEventQueries } from "../infra/db/queries/chat-events";
import {
  bandHome,
  type CodingAgentDefinition,
  resolveAgentDefinition,
  SettingsQueries,
} from "../infra/db/queries/settings";
import { hostRegistry } from "../infra/host/registry";
import { commandFor, launchFailure } from "./_utils/agent-command";
import { agentExtraDirs, openSharedDir } from "./_utils/shared-dir";
// FRAGILE: ESM cycle leg — `chat-ownership-service` imports this file back. Used only in method bodies.
import { agentLoginService } from "./agent-login-service";
import { chatOwnershipService } from "./chat-ownership-service";
import { type ChatSession, chatService } from "./chat-service";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { BUILTIN_BAND_SERVER, MAX_TOKEN_TTL_MS, mcpProxyService } from "./mcp-proxy-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("agent-sessions");

/** After `session/cancel`, how long a turn gets to stop before its agent
 *  process is killed. */
const CANCEL_GRACE_MS = 15_000;
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
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
  worktreeId: string;
  cancel(): void;
  permission?(optionId: string | null): void;
  /** Option ids the agent offered; an answer must be one of them. */
  optionIds?: string[];
  elicitation?(response: acp.CreateElicitationResponse): void;
}

interface Runtime {
  chatId: string;
  worktreeId: string;
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
  /** Work the agent process runs on its own, which holds off the idle stop. */
  work: PendingWork;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Claude Code: flags on the command line of the CLI behind the session,
   *  which a wrapper script may have added. */
  claudeCli: ClaudeCliArgs | null;
  /** `BAND_SERVER_URL` and `BAND_TOKEN` of the host's relay, for an agent on a worker. */
  relayEnv: Record<string, string> | null;
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
  /** Claude Code: what `default` choices resolved to in earlier sessions,
   *  for a chat with no session yet. `effort` is keyed by the model choice
   *  it ran under. */
  learnedDefaults?: { model?: string; effort: Record<string, string> };
}

type Listener = (event: ChatEvent) => void;

// Held on globalThis so every bundle of this module shares one registry
// (same reason as task-service / terminal-pool).
const RUNTIMES_KEY = Symbol.for("band.acp.runtimes");
const LISTENERS_KEY = Symbol.for("band.acp.listeners");
const CATALOG_KEY = Symbol.for("band.acp.catalog");
const DEFAULTS_CHANGED_KEY = Symbol.for("band.acp.defaultsChangedAt");
const g = globalThis as unknown as Record<symbol, unknown>;
g[RUNTIMES_KEY] ??= new Map<string, Runtime>();
g[LISTENERS_KEY] ??= new Map<string, Set<Listener>>();
g[CATALOG_KEY] ??= new Map<string, CatalogEntry>();
g[DEFAULTS_CHANGED_KEY] ??= new Map<string, number>();
const runtimes = g[RUNTIMES_KEY] as Map<string, Runtime>;
const listeners = g[LISTENERS_KEY] as Map<string, Set<Listener>>;
const catalog = g[CATALOG_KEY] as Map<string, CatalogEntry>;
/** chatId → when the chat's model or effort choice last changed. Transcript
 *  records from before then no longer describe what `default` runs. */
const defaultsChangedAt = g[DEFAULTS_CHANGED_KEY] as Map<string, number>;

/** Ids for events broadcast without a log row. Negative, so they never move
 *  a client's gap-fill cursor. */
let transientId = -1_000_000_000;

let pendingObserver: ((chatId: string, worktreeId: string) => void) | null = null;

/** Updates that show the agent working: text, thoughts, tool calls, plans. Titles, usage and
 *  command lists also arrive after a turn ends and say nothing about work. */
const AGENT_WORK_UPDATES = new Set<string>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** What the agent did on its own, outside a turn Band started. */
export type AgentActivityKind =
  /** A `session/update` arrived: the agent runs a turn of its own. */
  | "update"
  /** Background work started or ended (an AIR async task update). */
  | "work";
let activityObserver:
  | ((chatId: string, worktreeId: string, kind: AgentActivityKind) => void)
  | null = null;

function emptyLive(): LiveState {
  return { configOptions: [], modes: null, models: null, commands: [], usage: null, title: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { type ConfigChoice, findOption, optionChoices };

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}

/** What a worker that owns the chat keeps of it. */
export function ownedChatInfo(chat: ChatSession): OwnedChatInfo {
  return {
    chatId: chat.id,
    worktreeId: chat.worktreeId,
    agentId: definitionFor(chat).id,
    model: chat.model,
    mode: chat.mode,
    activeSessionId: chat.activeSessionId,
    hasSummary: Boolean(chat.activeSessionSummary),
  };
}

function definitionFor(chat: Pick<ChatSession, "agent">): CodingAgentDefinition {
  return resolveAgentDefinition(settings.load(), chat.agent);
}

function launchDefinition(def: CodingAgentDefinition, hostId: string): AcpAgentDefinition {
  return { type: def.type, label: def.label, command: commandFor(hostId, def) };
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
      worktreeId: chat.worktreeId,
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
      work: new PendingWork(),
      idleTimer: null,
      claudeCli: null,
      relayEnv: null,
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
  mcpProxyService.revokeSession(rt.chatId);
}

/** The opt-in idle stop, from `BAND_AGENT_IDLE_TIMEOUT_MS`. Unset (the
 *  default) means an agent process runs until the chat, its worktree, the
 *  agent or the hub ends it, as the same agent does in a terminal. With a
 *  positive value, a process with no turn running, nothing pending and no work
 *  of its own (see `PendingWork`) is stopped after it sends nothing for that
 *  long. The next prompt reattaches its session. */
function idleTimeoutMs(): number | null {
  const override = Number(process.env.BAND_AGENT_IDLE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : null;
}

/** (Re)starts the idle countdown, when the opt-in is set. Every update from
 *  the agent restarts it, so a turn the agent started itself is never cut off. */
function scheduleIdle(rt: Runtime, delayMs?: number): void {
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  rt.idleTimer = null;
  const timeout = idleTimeoutMs();
  if (timeout === null) return;
  const delay = Math.min(delayMs ?? timeout, MAX_TIMER_MS);
  rt.idleTimer = setTimeout(() => {
    rt.idleTimer = null;
    if (rt.inTurn || rt.pending.size > 0 || rt.attaching) return;
    const now = Date.now();
    const holds = rt.work.outstanding(now);
    if (holds.length > 0) {
      // Count down again once the last hold lapses. Work that ends earlier
      // says so in an update, which restarts the countdown then.
      const until = Math.max(...holds.map((h) => h.until));
      log.info(
        {
          chatId: rt.chatId,
          work: holds.map((h) => ({ reason: h.reason, until: new Date(h.until).toISOString() })),
        },
        "idle agent has pending work; not stopping it",
      );
      scheduleIdle(rt, until - now + timeout);
      return;
    }
    log.info({ chatId: rt.chatId }, "stopping idle agent");
    rt.process?.close();
    rt.process = null;
    rt.sessionId = null;
    // The next use builds a fresh runtime and reattaches the session.
    if (runtimes.get(rt.chatId) === rt) runtimes.delete(rt.chatId);
  }, delay);
  rt.idleTimer.unref?.();
}

/** Something arrived from the agent: outside a Band turn (which has its own
 *  end), the idle countdown starts over. An attach re-arms it when done. */
function agentActive(rt: Runtime): void {
  if (!rt.inTurn && !rt.attaching && rt.process) scheduleIdle(rt);
}

/** Appends an event to the runtime's session log and broadcasts it. Before
 *  the chat has a session, the event is broadcast without a log row. */
function record(rt: Runtime, event: LoggedChatEvent, turnStart = false): void {
  if (!rt.sessionId) {
    broadcastTransient(rt.chatId, event);
    return;
  }
  const createdAt = Date.now();
  const id = events.append({
    chatId: rt.chatId,
    sessionId: rt.sessionId,
    revision: rt.revision,
    event,
    turnStart,
    createdAt,
  });
  emit(rt.chatId, { ...event, eventId: id, createdAt } as ChatEvent);
}

function broadcastTransient(chatId: string, event: ChatEventPayload): void {
  emit(chatId, { ...event, eventId: transientId--, createdAt: Date.now() } as ChatEvent);
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
    learnedDefaults: prev?.learnedDefaults,
    ...patch,
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Claude Code defaults
// ---------------------------------------------------------------------------

function findEffortOption(options: acp.SessionConfigOption[]): acp.SessionConfigOption | undefined {
  return options.find(
    (o) => o.type === "select" && (o.category === "thought_level" || o.id === "effort"),
  );
}

/**
 * What a Claude Code chat's `default` model and effort choices run with (see
 * `packages/host-local/src/agents/claude-defaults.ts`): the session's transcript when its last
 * turn ran on them, else config, else what an earlier session of the agent
 * reported. With `learn`, a reported value the config doesn't explain is
 * kept for chats that have no session yet. Undefined for other agents.
 */
async function claudeDefaults(
  chatId: string,
  chat: ChatSession | undefined,
  def: CodingAgentDefinition,
  configOptions: acp.SessionConfigOption[],
  learn = false,
): Promise<ResolvedDefaults | undefined> {
  try {
    return await readClaudeDefaults(chatId, chat, def, configOptions, learn);
  } catch (err) {
    // Showing a chat whose worker is asleep or gone needs no answer from it.
    if (err instanceof HostOfflineError) return undefined;
    throw err;
  }
}

async function readClaudeDefaults(
  chatId: string,
  chat: ChatSession | undefined,
  def: CodingAgentDefinition,
  configOptions: acp.SessionConfigOption[],
  learn: boolean,
): Promise<ResolvedDefaults | undefined> {
  if (def.type !== "claude-code") return undefined;
  const location = chat ? chatLocation(chat) : undefined;
  const cwd = location?.cwd;
  const host = location?.host ?? hostRegistry.local;
  const configured = await host.agentEnv.claudeDefaults(
    cwd,
    runtimes.get(chatId)?.claudeCli ?? undefined,
  );
  const reported: ClaudeDefaults =
    cwd && chat?.activeSessionId
      ? await host.agentEnv.reportedClaudeDefaults({
          cwd,
          sessionId: chat.activeSessionId,
          since: defaultsChangedAt.get(chatId),
        })
      : { model: undefined, effort: undefined };
  const modelOption = findOption(configOptions, "model");
  const modelChoice = modelOption?.type === "select" ? String(modelOption.currentValue) : undefined;
  const effortOption = findEffortOption(configOptions);
  const model = modelChoice === "default" ? reported.model : undefined;
  const effort =
    effortOption?.type === "select" && effortOption.currentValue === "default"
      ? reported.effort
      : undefined;

  const entry = catalog.get(def.id);
  if (learn && entry && ((model && !configured.model) || (effort && !configured.effort))) {
    const learned = entry.learnedDefaults ?? { effort: {} };
    entry.learnedDefaults = {
      model: (!configured.model && model) || learned.model,
      effort:
        effort && !configured.effort && modelChoice
          ? { ...learned.effort, [modelChoice]: effort }
          : learned.effort,
    };
  }
  const learned = entry?.learnedDefaults;
  return {
    model: model ?? configured.model ?? learned?.model,
    effort: effort ?? configured.effort ?? (modelChoice ? learned?.effort[modelChoice] : undefined),
  };
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
      // Keep the last reported cost when an update leaves it out.
      rt.live.usage = {
        used: update.used,
        size: update.size,
        cost: update.cost ?? rt.live.usage?.cost ?? null,
      };
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
  // An attach's replay is history, not work in flight.
  if (!rt.attaching) {
    rt.work.observeUpdate(update, rt.inTurn);
    agentActive(rt);
    if (!rt.inTurn && rt.routing === "log" && AGENT_WORK_UPDATES.has(update.sessionUpdate)) {
      activityObserver?.(rt.chatId, rt.worktreeId, "update");
    }
  }
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
  make: (done: (answer: string) => void) => Omit<PendingRequest, "worktreeId" | "cancel">,
  onCancel: () => void,
): string {
  const requestId = randomUUID();
  let settled = false;
  const done = (answer: string) => {
    if (settled) return;
    settled = true;
    rt.pending.delete(requestId);
    record(rt, { type: "request-resolved", requestId, answer });
    pendingObserver?.(rt.chatId, rt.worktreeId);
  };
  const handlers = make(done);
  const cancel = () => {
    if (settled) return;
    done("cancelled");
    onCancel();
  };
  rt.pending.set(requestId, { worktreeId: rt.worktreeId, cancel, ...handlers });
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
    pendingObserver?.(rt.chatId, rt.worktreeId);
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
    pendingObserver?.(rt.chatId, rt.worktreeId);
  });
}

function handlersFor(rt: Runtime, generation: number): AcpAgentHandlers {
  return {
    onUpdate: (n) => routeUpdate(rt, n),
    onAsyncTask: (n) => {
      if (n.sessionId !== rt.sessionId || rt.attaching) return;
      rt.work.observeAsyncTask(n.update);
      agentActive(rt);
      activityObserver?.(rt.chatId, rt.worktreeId, "work");
    },
    onPermission: (req, signal) => requestPermission(rt, req, signal),
    onElicitation: (req, signal) => requestElicitation(rt, req, signal),
    onExit: (code, stderr) => {
      if (rt.generation !== generation) return;
      log.info({ chatId: rt.chatId, code }, "agent exited");
      // stderr can hold auth details; keep it out of info-level logs.
      log.debug({ chatId: rt.chatId, stderr: stderr.slice(-500) }, "agent stderr");
      for (const p of [...rt.pending.values()]) p.cancel();
      // Whatever the process was running died with it.
      rt.work.clear();
      // `sessionId` stays: the failed turn still logs its end there. With
      // no process, the next `ensureSession` reattaches.
      rt.process = null;
      rt.starting = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Where a chat runs
// ---------------------------------------------------------------------------

/** The directory and host a chat runs on: its worktree. */
function chatLocation(chat: ChatSession): { cwd: string; host: Host } | undefined {
  const worktree = worktreeService.resolve(chat.worktreeId);
  return worktree ? { cwd: worktree.worktree.path, host: worktree.host } : undefined;
}

// ---------------------------------------------------------------------------
// Process and session attach
// ---------------------------------------------------------------------------

/**
 * Adds the Band login that applies to `agentType` to a launch: its variables, and the inherited
 * ones that would compete with it removed. A launch with no login applying comes back unchanged.
 */
async function withAgentLogin(
  launch: AcpLaunch,
  agentType: string,
  scope: { worktreeId?: string; chatLoginId?: string } = {},
): Promise<AcpLaunch> {
  const repo = scope.worktreeId ? worktreeService.resolve(scope.worktreeId)?.repo.name : undefined;
  const login = await agentLoginService.resolve({
    agentType,
    repo,
    chatLoginId: scope.chatLoginId,
  });
  if (!login) return launch;
  return { ...launch, env: { ...launch.env, ...login.env }, unsetEnv: login.unsetEnv };
}

async function ensureProcess(
  rt: Runtime,
  def: CodingAgentDefinition,
  cwd: string,
): Promise<AcpAgentProcess> {
  if (rt.process?.alive) return rt.process;
  if (rt.starting) return rt.starting;
  const generation = ++rt.generation;
  rt.starting = (async () => {
    const host = hostRegistry.hostFor(rt.worktreeId);
    const resolved = await host.acp.resolveLaunch(launchDefinition(def, host.id));
    if (typeof resolved === "string") throw new Error(launchFailure(host.id, resolved));
    const launch = await withAgentLogin(resolved, def.type, {
      worktreeId: rt.worktreeId,
      chatLoginId: chatService.get(rt.chatId)?.loginId,
    });
    // An agent on a remote host reaches the hub through the worker's relay,
    // with a token that works for this chat's host only.
    const grant = await host.relay?.issue({ worktreeId: rt.worktreeId, chatId: rt.chatId });
    // Lets the agent say which chat it runs in, for `subscriptions.create`.
    const withChat = {
      ...launch,
      env: {
        ...launch.env,
        ...grant?.env,
        BAND_CHAT_ID: rt.chatId,
        BAND_WORKTREE_ID: rt.worktreeId,
      },
    };
    const handlers = handlersFor(rt, generation);
    const exited = handlers.onExit;
    handlers.onExit = (code, stderr) => {
      void grant?.revoke();
      // A process stopped for a restart or a host move exits after its replacement issued a token
      // for the same chat id, so only the runtime that is still current may revoke by chat id.
      if (runtimes.get(rt.chatId) === rt && rt.generation === generation) {
        mcpProxyService.revokeSession(rt.chatId);
      }
      exited?.(code, stderr);
    };
    let proc: AcpAgentProcess;
    try {
      proc = await AcpAgentProcess.start(host.acp, withChat, cwd, def.label, handlers);
    } catch (err) {
      await grant?.revoke();
      throw err;
    }
    rt.relayEnv = grant?.env ?? null;
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

/** The hub's own address, for an agent on this machine. */
function localHubUrl(): string {
  return process.env.BAND_SERVER_URL ?? `http://127.0.0.1:${process.env.BAND_PORT ?? "3456"}`;
}

/**
 * The MCP servers a session may use, as ACP `mcpServers` entries that point
 * at the hub's proxy with a fresh per-session token (plan step 4.3). An agent
 * on a worker reaches the proxy through the worker's relay, which needs the
 * relay token as well. A failure here never stops the chat.
 */
function sessionMcpServers(rt: Runtime, proc: AcpAgentProcess): acp.McpServer[] {
  if (!proc.supportsHttpMcp) {
    log.info(
      { chatId: rt.chatId, agent: proc.agentName },
      "agent does not support HTTP MCP servers, so none are passed",
    );
    return [];
  }
  return mcpServerEntries(rt.chatId, rt.worktreeId, rt.relayEnv);
}

/** The `mcpServers` entries for a chat's session, each attach with a new token. */
function mcpServerEntries(
  chatId: string,
  worktreeId: string,
  relayEnv: Record<string, string> | null,
): acp.McpServer[] {
  try {
    const worktree = worktreeService.resolve(worktreeId);
    if (!worktree) return [];
    // Every chat gets the built-in `band` server, so any chat can start linked work.
    const names = [
      BUILTIN_BAND_SERVER,
      ...mcpProxyService.serversForSession(worktree.repo.name, worktree.host.id).map((s) => s.name),
    ];
    if (!relayEnv && hostRegistry.hostFor(worktreeId).id !== hostRegistry.local.id) {
      // The hub's loopback address means nothing on a worker, so no relay grant means no tools.
      log.warn(
        { chatId, scope: worktreeId },
        "the agent runs on a worker but has no relay grant, so no MCP servers are passed",
      );
      return [];
    }
    // A resume or reload gets a new token, and the old one stops working.
    mcpProxyService.revokeSession(chatId);
    const { token } = mcpProxyService.issueSessionToken(
      chatId,
      names,
      // The process can outlive the default hour. Exit and chat removal revoke it.
      MAX_TOKEN_TTL_MS,
    );
    const base = (relayEnv?.BAND_SERVER_URL ?? localHubUrl()).replace(/\/+$/, "");
    const headers = [{ name: "Authorization", value: `Bearer ${token}` }];
    if (relayEnv?.BAND_TOKEN) {
      headers.push({ name: "X-Band-Relay-Token", value: relayEnv.BAND_TOKEN });
    }
    log.info(
      {
        chatId,
        scope: worktreeId,
        servers: names,
        baseUrl: base,
        viaRelay: Boolean(relayEnv?.BAND_TOKEN),
      },
      "MCP servers for the session",
    );
    return names.map((name) => ({
      type: "http" as const,
      name,
      url: `${base}/mcp-proxy/${encodeURIComponent(name)}`,
      headers,
    }));
  } catch (err) {
    log.warn({ chatId, err }, "could not prepare MCP servers for the session");
    return [];
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
    attached = await proc.newSession(
      cwd,
      await agentExtraDirs(rt.worktreeId),
      sessionMcpServers(rt, proc),
    );
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
        ? await proc.loadSession(sessionId, cwd, sessionMcpServers(rt, proc))
        : await proc.resumeSession(sessionId, cwd, sessionMcpServers(rt, proc));
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
  strictSession = false,
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
  // A caller that needs this very session (a cronjob pinned to it) gets the failure.
  if (strictSession) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`${proc.agentName} can't reopen session ${target}`);
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

/** Relay grants of the agents worker-owned chats run, by chat id. A new launch revokes the old one. */
const ownerGrants = new Map<string, { revoke(): Promise<void> }>();

/** The host a worktree runs on. Never throws, because it runs while a failure is reported. */
function hostIdFor(worktreeId: string | undefined): string {
  if (!worktreeId) return "local";
  try {
    return hostRegistry.hostFor(worktreeId).id;
  } catch {
    return "local";
  }
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

  // ---- chats a worker owns ---------

  /**
   * What a worker that owns the chat needs to start its agent: the agent
   * definition, a relay grant and the chat ids in the environment, MCP
   * servers with a fresh token, and the directories. Each call revokes the
   * grant and the MCP token of the previous one.
   */
  async launchForOwner(chatId: string, agentId?: string): Promise<ChatLaunchReply> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    const worktree = worktreeService.resolve(chat.worktreeId);
    if (!worktree) throw new Error(`Worktree not found: ${chat.worktreeId}`);
    const def = resolveAgentDefinition(settings.load(), agentId ?? chat.agent);
    await ownerGrants.get(chatId)?.revoke();
    ownerGrants.delete(chatId);
    const grant = await worktree.host.relay?.issue({ worktreeId: chat.worktreeId, chatId });
    if (grant) ownerGrants.set(chatId, grant);
    const shared = await openSharedDir(chat.worktreeId, chatId).catch(() => null);
    const login = await agentLoginService.resolve({
      agentType: def.type,
      repo: worktree.repo.name,
      chatLoginId: chat.loginId,
    });
    return {
      chat: ownedChatInfo(chat),
      agent: {
        id: def.id,
        type: def.type,
        label: def.label,
        command: commandFor(worktree.host.id, def),
        model: def.model,
      },
      cwd: worktree.worktree.path,
      env: {
        ...grant?.env,
        BAND_CHAT_ID: chatId,
        BAND_WORKTREE_ID: chat.worktreeId,
      },
      // Kept apart from `env` because the worker caches `env` on disk and must not cache a secret.
      ...(login ? { loginEnv: login.env } : {}),
      ...(login?.unsetEnv.length ? { unsetEnv: login.unsetEnv } : {}),
      mcpServers: mcpServerEntries(chatId, chat.worktreeId, grant?.env ?? null),
      additionalDirectories: await agentExtraDirs(chat.worktreeId),
      sharedDir: shared?.path ?? null,
    };
  }

  /** Ends what `launchForOwner` handed out for the chat: its relay grant and MCP token. */
  async revokeOwnerLaunch(chatId: string): Promise<void> {
    await ownerGrants.get(chatId)?.revoke();
    ownerGrants.delete(chatId);
    mcpProxyService.revokeSession(chatId);
  }

  /** Hands an event of a worker-owned chat to the hub's subscribers. */
  deliver(chatId: string, event: ChatEvent): void {
    emit(chatId, event);
  }

  /** A worker-owned chat's open requests changed. */
  notifyPending(chatId: string, worktreeId: string): void {
    pendingObserver?.(chatId, worktreeId);
  }

  /** A worker-owned chat's agent acted outside a turn. */
  notifyActivity(chatId: string, worktreeId: string, kind: AgentActivityKind): void {
    activityObserver?.(chatId, worktreeId, kind);
  }

  /** Called whenever a permission or elicitation request opens or closes,
   *  so task-service can flip the chat's attention status. */
  observePending(observer: (chatId: string, worktreeId: string) => void): void {
    pendingObserver = observer;
  }

  /** Called when the agent acts outside a turn Band started: an update from
   *  a turn of its own, or a background task starting or ending. */
  observeActivity(
    observer: (chatId: string, worktreeId: string, kind: AgentActivityKind) => void,
  ): void {
    activityObserver = observer;
  }

  /** The soonest time one of the chat's pending-work holds lapses, or null with none. */
  nextWorkDeadline(chatId: string): number | null {
    if (chatOwnershipService.isOwned(chatId)) return chatOwnershipService.workDeadline(chatId);
    const holds = runtimes.get(chatId)?.work.outstanding() ?? [];
    return holds.length > 0 ? Math.min(...holds.map((h) => h.until)) : null;
  }

  /**
   * Makes sure the chat's agent process runs and is attached to the chat's
   * session, starting a new session when the chat has none. For `view`,
   * only attaches when the session needs `session/load` to show anything.
   * Returns the attached session id, or null when nothing was attached.
   * With `strictSession`, a session that can't be reopened throws instead of
   * being replaced by a fresh one.
   */
  async ensureSession(
    chatId: string,
    purpose: "prompt" | "view",
    options: { strictSession?: boolean } = {},
  ): Promise<string | null> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    // A chat its worker owns runs there only, never in a second process here.
    if (chat.ownerHostId) {
      if (purpose === "view") await chatOwnershipService.viewSession(chatId);
      return null;
    }
    // A message to a sleeping worktree brings its worker back first.
    if (purpose === "prompt") await ephemeralLifecycleService.ensureAwake(chat.worktreeId);
    const worktree = worktreeService.resolve(chat.worktreeId);
    if (!worktree) throw new Error(`Worktree not found: ${chat.worktreeId}`);
    const cwd = worktree.worktree.path;
    const def = definitionFor(chat);
    const rt = runtimeFor(chat, def);
    while (rt.attaching) await rt.attaching.catch(() => undefined);
    const fresh = chatService.get(chatId) ?? chat;
    const attachedBefore = rt.sessionId;
    rt.attaching = attach(rt, fresh, def, cwd, purpose, options.strictSession);
    try {
      await rt.attaching;
    } finally {
      rt.attaching = null;
    }
    if (def.type === "claude-code" && rt.sessionId && rt.sessionId !== attachedBefore) {
      rt.claudeCli = null;
      void this.readClaudeCli(rt).catch((err) => log.debug({ chatId, err }, "no CLI flags"));
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

  /** The session's cumulative cost in USD so far: the agent's own figure
   *  when it reports one, else Band's estimate from the last finished turn.
   *  The next turn's estimate builds on it. */
  sessionCostUsd(chatId: string): number | null {
    const reported = this.reportedCost(chatId);
    if (reported !== undefined) return reported;
    const sessionId = chatService.get(chatId)?.activeSessionId;
    return sessionId ? loggedSessionCost(events, sessionId) : null;
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
      // Never let a failed push replace the turn's result.
      try {
        await this.pushClaudeDefaults(chatId, true);
      } catch (err) {
        log.debug({ chatId, err }, "could not push Claude defaults");
      }
    }
  }

  /** Sends a Claude Code chat's session state again once the turn wrote what
   *  its `default` choices ran with, or the CLI's flags are known. */
  private async pushClaudeDefaults(chatId: string, learn: boolean): Promise<void> {
    const chat = chatService.get(chatId);
    if (!chat) return;
    const def = definitionFor(chat);
    if (def.type !== "claude-code") return;
    const state = this.getSessionState(chatId);
    const resolvedDefaults = await claudeDefaults(chatId, chat, def, state.configOptions, learn);
    broadcastTransient(chatId, { type: "session-state", state: { ...state, resolvedDefaults } });
  }

  /** Reads the Claude Code CLI's command line once per attached session, for
   *  a `--settings` file or flags a wrapper script added. */
  private async readClaudeCli(rt: Runtime): Promise<void> {
    const pid = rt.process?.pid;
    const sessionId = rt.sessionId;
    if (!pid || !sessionId) return;
    const args = await hostRegistry.hostFor(rt.worktreeId).agentEnv.claudeCliArgs(pid, sessionId);
    if (!args || rt.sessionId !== sessionId) return;
    rt.claudeCli = args;
    await this.pushClaudeDefaults(rt.chatId, false);
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

  /** Describes why a chat's agent failed: the exit, the cause and what the
   *  agent printed, for the error card. `turnStartedAt` is epoch ms. */
  failureFor(chatId: string, err: unknown, turnStartedAt?: number): AgentFailure {
    const message = err instanceof Error ? err.message : String(err);
    const chat = chatService.get(chatId);
    const rt = runtimes.get(chatId);
    const details = err instanceof AgentProcessError ? err.details : null;
    const input = {
      exitCode: details?.exitCode ?? null,
      signal: details?.signal ?? null,
      stderr: details?.stderr ?? "",
      message,
      timedOut: details?.timedOut ?? false,
    };
    const at = Date.now();
    return {
      ...classifyFailure(input),
      exitCode: input.exitCode,
      signal: input.signal,
      host: hostIdFor(rt?.worktreeId ?? chat?.worktreeId),
      sessionId: rt?.sessionId ?? chat?.activeSessionId ?? null,
      agent: chat ? definitionFor(chat).label : "The agent",
      at,
      stderrTail: input.stderr,
      message,
      ...(turnStartedAt !== undefined && { turnMs: at - turnStartedAt }),
    };
  }

  /** Broadcasts an event that isn't logged (a failure before any session). */
  broadcastTransient(chatId: string, event: ChatEventPayload): void {
    broadcastTransient(chatId, event);
  }

  answerPermission(chatId: string, requestId: string, optionId: string | null): boolean {
    if (chatOwnershipService.isOwned(chatId)) {
      return chatOwnershipService.answerPermission(chatId, requestId, optionId);
    }
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
    if (chatOwnershipService.isOwned(chatId)) {
      return chatOwnershipService.answerElicitation(chatId, requestId, response);
    }
    const pending = runtimes.get(chatId)?.pending.get(requestId);
    if (!pending?.elicitation) return false;
    pending.elicitation(response);
    return true;
  }

  /** True while the chat's agent waits on the user. */
  hasPendingRequest(chatId: string): boolean {
    if (chatOwnershipService.isOwned(chatId))
      return chatOwnershipService.pending(chatId).length > 0;
    return (runtimes.get(chatId)?.pending.size ?? 0) > 0;
  }

  /** Chats of the worktree whose agent waits on the user. */
  chatsWithPendingRequest(worktreeId: string): string[] {
    const chatIds: string[] = chatOwnershipService.chatsWithPending(worktreeId);
    for (const rt of runtimes.values()) {
      for (const p of rt.pending.values()) {
        if (p.worktreeId === worktreeId) {
          chatIds.push(rt.chatId);
          break;
        }
      }
    }
    return chatIds;
  }

  /** True while the chat's agent runs a turn. */
  isInTurn(chatId: string): boolean {
    return runtimes.get(chatId)?.inTurn === true;
  }

  /** True while the hub starts the chat's agent or attaches its session. */
  isStarting(chatId: string): boolean {
    const rt = runtimes.get(chatId);
    return Boolean(rt?.starting || rt?.attaching);
  }

  /** Chats with an agent process, started or starting, and whether each is mid-work. A host restart ends them. */
  liveAgents(): { chatId: string; worktreeId: string; busy: boolean }[] {
    return [...runtimes.values()]
      .filter((rt) => rt.process !== null || rt.starting !== null)
      .map((rt) => ({
        chatId: rt.chatId,
        worktreeId: rt.worktreeId,
        busy: rt.inTurn || rt.pending.size > 0 || rt.work.outstanding().length > 0,
      }));
  }

  /**
   * True while the chat's agent has something Band must not cut off: a turn,
   * a request waiting on the user, or work the agent started on its own.
   */
  isActive(chatId: string): boolean {
    if (chatOwnershipService.isOwned(chatId)) {
      return (
        chatOwnershipService.task(chatId) !== null ||
        chatOwnershipService.pending(chatId).length > 0 ||
        chatOwnershipService.workDeadline(chatId) !== null
      );
    }
    const rt = runtimes.get(chatId);
    if (!rt) return false;
    return rt.inTurn || rt.pending.size > 0 || rt.work.outstanding().length > 0;
  }

  /**
   * Changes a session setting. Saved on the chat row (model and mode, so a
   * later session starts with it) and applied to the agent's session. A
   * chat with no live session gets one first (a new chat starts it, an idle
   * one reattaches), except for a mode change: only the agent keeps options
   * like effort and fast mode, and it reshapes the option list when the
   * model changes (fast mode only exists on some models).
   *
   * With `worktreeId`, a chat that has no row yet (a new pane, created
   * lazily like on its first message) gets one with the default agent.
   */
  async setConfigOption(
    chatId: string,
    configId: string,
    value: string,
    worktreeId?: string,
  ): Promise<SessionState> {
    const chat =
      chatService.get(chatId) ??
      (worktreeId ? chatService.create(worktreeId, { id: chatId, name: "Chat" }) : undefined);
    if (!chat) throw new ChatNotFoundError(chatId);
    const options = this.getSessionState(chatId).configOptions;
    const option = options.find((o) => o.id === configId);
    const category = configCategory(options, configId);
    if (category === "model") chatService.update(chatId, { model: value });
    if (category === "mode") chatService.update(chatId, { mode: value });
    const isEffort = option?.category === "thought_level" || configId === "effort";
    if (category === "model" || isEffort) defaultsChangedAt.set(chatId, Date.now());
    if (chat.ownerHostId) return chatOwnershipService.setConfigOption(chatId, configId, value);

    const live = runtimes.get(chatId);
    const attached =
      live?.process?.alive && live.sessionId && live.sessionId === chat.activeSessionId;
    if (!attached && category !== "mode") {
      try {
        await this.ensureSession(chatId, "prompt");
      } catch (err) {
        // A saved model choice still applies when the session starts.
        if (category !== "model") throw err;
        log.warn({ chatId, err }, "could not start a session to apply the model");
      }
    }
    const rt = runtimes.get(chatId);

    const proc = rt?.process;
    const activeSessionId = chatService.get(chatId)?.activeSessionId;
    if (rt && proc?.alive && rt.sessionId && rt.sessionId === activeSessionId) {
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
    const next = await this.resolvedSessionState(chatId);
    broadcastTransient(chatId, { type: "session-state", state: next });
    return next;
  }

  /**
   * Session settings for the chat: from the live agent when it runs the
   * chat's session, else rebuilt from the log, else the agent catalog with
   * the chat's saved choices applied. A chat the server has no row for yet
   * (a new pane, created lazily on its first message) gets the default
   * agent's catalog entry. It does not resolve what a Claude Code chat's
   * `default` choices run with. `resolvedSessionState` does, by reading
   * Claude's settings files and transcript on the chat's host.
   */
  getSessionState(chatId: string): SessionState {
    const saved = chatService.get(chatId);
    const chat: Pick<ChatSession, "agent" | "activeSessionId" | "model" | "mode"> = saved ?? {
      agent: undefined as unknown as string,
      activeSessionId: undefined,
      model: undefined,
      mode: undefined,
    };
    const def = definitionFor(chat);
    return this.baseSessionState(chatId, chat, def);
  }

  /** `getSessionState` plus what a Claude Code chat's `default` choices run with. */
  async resolvedSessionState(chatId: string): Promise<SessionState> {
    const state = this.getSessionState(chatId);
    const saved = chatService.get(chatId);
    const def = definitionFor(saved ?? { agent: undefined as unknown as string });
    const resolvedDefaults = await claudeDefaults(chatId, saved, def, state.configOptions);
    return resolvedDefaults ? { ...state, resolvedDefaults } : state;
  }

  private baseSessionState(
    chatId: string,
    chat: Pick<ChatSession, "agent" | "activeSessionId" | "model" | "mode">,
    def: CodingAgentDefinition,
  ): SessionState {
    const rt = runtimes.get(chatId);
    const sessionId = chat.activeSessionId;

    if (rt?.process?.alive && rt.sessionId && rt.sessionId === sessionId) {
      return { source: "live", ...rt.live };
    }

    const revision = sessionId ? events.currentRevision(sessionId) : 0;
    if (sessionId && revision > 0) {
      return sessionStateFromLog(events, sessionId, revision, catalog.get(def.id)?.commands ?? []);
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
      title: null,
    };
  }

  /**
   * Past sessions for the chat's agent in its worktree: the agent's
   * `session/list` when it supports it, with Band's own log filling in
   * titles and covering agents that can't list.
   */
  async listSessions(chatId: string): Promise<SessionListing> {
    const chat = chatService.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    const location = chatLocation(chat);
    if (!location) throw new Error(`Worktree not found: ${chat.worktreeId}`);
    const def = definitionFor(chat);
    if (chat.ownerHostId) return this.listOwnedSessions(chat, def);
    const sameAgent = chatService
      .list(chat.worktreeId)
      .filter((c) => definitionFor(c).id === def.id)
      .map((c) => c.id);
    const logged = events.listSessions(sameAgent);
    const titles = new Map(logged.map((s) => [s.sessionId, s.title]));

    const rt = runtimeFor(chat, def);
    let agentSessions: acp.SessionInfo[] | null = null;
    try {
      const proc = await ensureProcess(rt, def, location.cwd);
      if (!rt.inTurn) scheduleIdle(rt);
      if (proc.canList) agentSessions = await proc.listSessions(location.cwd);
    } catch (err) {
      log.warn({ chatId, err }, "session/list failed; using Band's log");
      // With the opt-in idle stop set, its timer drops a runtime that never got a process.
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

  /** `listSessions` for a chat its worker owns: the agent's list from the worker, else the log. */
  private async listOwnedSessions(
    chat: ChatSession,
    def: CodingAgentDefinition,
  ): Promise<SessionListing> {
    const sameAgent = chatService
      .list(chat.worktreeId)
      .filter((c) => definitionFor(c).id === def.id)
      .map((c) => c.id);
    const logged = events.listSessions(sameAgent);
    const titles = new Map(logged.map((s) => [s.sessionId, s.title]));
    const listed = await chatOwnershipService.listSessions(chat.id);
    if (listed) {
      return {
        supported: true,
        sessions: listed.map((s) => ({
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
    defaultsChangedAt.delete(chatId);
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
  async probe(
    def: CodingAgentDefinition,
    host: Host = hostRegistry.local,
    cwd = bandHome(),
  ): Promise<CatalogEntry> {
    const resolved = await host.acp.resolveLaunch(launchDefinition(def, host.id));
    if (typeof resolved === "string") throw new Error(launchFailure(host.id, resolved));
    const launch = await withAgentLogin(resolved, def.type);
    let commands: acp.AvailableCommand[] = [];
    const proc = await AcpAgentProcess.start(host.acp, launch, cwd, def.label, {
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
   * Codex runs them in its worktree sandbox.
   */
  async oneShot(
    def: CodingAgentDefinition,
    cwd: string,
    prompt: string,
    host: Host = hostRegistry.local,
  ): Promise<string> {
    const resolved = await host.acp.resolveLaunch(launchDefinition(def, host.id));
    if (typeof resolved === "string") throw new Error(launchFailure(host.id, resolved));
    const launch = await withAgentLogin(resolved, def.type);
    let sessionId: string | null = null;
    let text = "";
    const proc = await AcpAgentProcess.start(host.acp, launch, cwd, def.label, {
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

export const agentSessionService = new AgentSessionService();
