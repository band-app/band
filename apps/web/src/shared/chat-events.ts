/**
 * Wire schema for the chat event log.
 *
 * Every chat runs one coding agent over the Agent Client Protocol (ACP).
 * The server records what the agent sends (`session/update` notifications,
 * permission and elicitation requests) and what Band sends it (prompts),
 * and streams that log to the browser over
 * `GET /api/chats/:chatId/events` as `event: <type>` + `data: <JSON>` SSE
 * frames. ACP's own schema types are the vocabulary: an `update` event
 * carries the agent's `SessionUpdate` unchanged, so there is no Band copy
 * of message chunks, tool calls or plans to keep in sync with the protocol.
 *
 * The native SSE `id:` field carries each event's id, which for logged
 * events is the row id in the `chat_events` table. Ids only grow, so the
 * browser's `Last-Event-ID` is a gap-fill cursor. Synthetic events the
 * server makes up per subscription (`subscription-opened`,
 * `queue-updated`, `session-state`, `history-meta`) carry negative ids and
 * never move the cursor.
 *
 * Lives under `apps/web/src/shared/` because both the server tier and the
 * browser components import it.
 */

import type {
  AvailableCommand,
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  UsageUpdate,
} from "@agentclientprotocol/sdk";

export type {
  AvailableCommand,
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
};

/**
 * Number of turns in one chat-history page. A turn starts at a prompt Band
 * sent, or at a user message the agent replayed through `session/load`.
 * Shared by the cold-subscribe replay window (`chat-events.ts`), the
 * older-page endpoint (`chat-history.ts`) and the client's `loadOlder`, so
 * the three agree on page boundaries.
 */
export const HISTORY_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

/** Model state from the unstable `session/set_model` API, returned by
 *  agents that have no `model` config option (Gemini CLI). */
export interface LegacyModelState {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

export interface ChatEventFile {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface QueuedChatMessage {
  id: string;
  text: string;
  files?: ChatEventFile[];
}

/**
 * Token usage for one finished turn, from `PromptResponse.usage` (or
 * Gemini's `_meta.quota`). `costUsd` is the session's cumulative cost:
 * the agent's own figure from `usage_update.cost` when it reports one,
 * otherwise computed by Band from these tokens and `MODEL_PRICING`.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
}

/**
 * Session settings and capabilities a chat can offer before any turn
 * streams: the model and mode pickers, slash commands, the context meter.
 *
 * Sent as a synthetic `session-state` event on every subscribe, because the
 * `config_option_update` / `available_commands_update` / `usage_update`
 * events that carry the same data can sit outside the replayed window.
 * After that the client applies those updates itself.
 */
export interface SessionState {
  /** `live` when an agent process holds the session, `log` when read back
   *  from Band's event log, `cached` when taken from the agent catalog
   *  before the chat has a session. */
  source: "live" | "log" | "cached";
  configOptions: SessionConfigOption[];
  /** Legacy mode state, for agents that expose modes without a `mode`
   *  config option (Gemini CLI, Cursor CLI). */
  modes: SessionModeState | null;
  /** Legacy model state (`session/set_model`), for agents without a
   *  `model` config option (Gemini CLI). */
  models: LegacyModelState | null;
  commands: AvailableCommand[];
  usage: UsageUpdate | null;
  /** Cumulative session cost in USD: `usage.cost` when the agent reports
   *  one, else Band's estimate from the last turn's tokens. */
  costUsd: number | null;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Logged events. Persisted in `chat_events` and replayed on reconnect.
// ---------------------------------------------------------------------------

/** One ACP `session/update`, forwarded unchanged. */
export interface UpdateEvent {
  type: "update";
  update: SessionUpdate;
}

/** A prompt Band sent to the agent. `text` is what the user typed, without
 *  the attachment and file-sharing context Band adds to the ACP blocks. */
export interface PromptEvent {
  type: "prompt";
  taskId: string;
  text: string;
  files?: ChatEventFile[];
}

/** A prompt turn started (`session/prompt` sent). */
export interface TurnStartedEvent {
  type: "turn-started";
  taskId: string;
}

/** A prompt turn ended. `stopReason` is the agent's; `error` is set when
 *  the request failed or the agent process exited mid-turn. */
export interface TurnEndedEvent {
  type: "turn-ended";
  taskId: string;
  stopReason?: StopReason;
  error?: string;
  durationMs?: number;
  usage?: TurnUsage;
}

/** The agent asked `session/request_permission`. Answered by
 *  `chat.answer({ requestId, optionId })`. */
export interface PermissionEvent {
  type: "permission";
  requestId: string;
  request: RequestPermissionRequest;
}

/** The agent asked `elicitation/create` in form mode (Claude Code's
 *  `AskUserQuestion`). Answered by `chat.answerElicitation`. */
export interface ElicitationEvent {
  type: "elicitation";
  requestId: string;
  request: CreateElicitationRequest;
}

/** A permission or elicitation request got its answer. `answer` is the
 *  picked option id, an elicitation action (`accept` / `decline`), or
 *  `cancelled` when the turn stopped first. */
export interface RequestResolvedEvent {
  type: "request-resolved";
  requestId: string;
  answer: string;
}

/** The chat attached to an agent session (`session/new`, `session/load` or
 *  `session/resume`), with the settings the agent answered with. Logged so
 *  the pickers can be rebuilt from the log while no agent runs. */
export interface SessionAttachedEvent {
  type: "session-attached";
  sessionId: string;
  how: "new" | "load" | "resume";
  /** The log revision this session writes from now on. A client adopts it,
   *  so its next reconnect gap-fills rather than resets. */
  revision: number;
  agentName?: string;
  configOptions: SessionConfigOption[];
  modes: SessionModeState | null;
  models: LegacyModelState | null;
}

/** A file the agent wrote into the workspace's shared directory, rendered
 *  as a download card. */
export interface FileEvent {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

/** Something Band itself wants to tell the user, such as an agent that
 *  failed to start or a session that could not be reopened. */
export interface NoticeEvent {
  type: "notice";
  level: "info" | "warning" | "error";
  text: string;
}

export type LoggedChatEvent =
  | UpdateEvent
  | PromptEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | PermissionEvent
  | ElicitationEvent
  | RequestResolvedEvent
  | SessionAttachedEvent
  | FileEvent
  | NoticeEvent;

// ---------------------------------------------------------------------------
// Synthetic events. Made up per subscription, never persisted.
// ---------------------------------------------------------------------------

/** First event on every subscription. `revision` identifies the log the
 *  replay comes from; a client holding a different revision must drop its
 *  state (`reset: true`) because the log was rebuilt by `session/load`. */
export interface SubscriptionOpenedEvent {
  type: "subscription-opened";
  sessionId?: string;
  revision: number;
  taskRunning: boolean;
  reset: boolean;
}

/** The server's queue of messages waiting for the running turn. Sent whole
 *  on every change. */
export interface QueueUpdatedEvent {
  type: "queue-updated";
  messages: QueuedChatMessage[];
}

/** Current session settings. See {@link SessionState}. */
export interface SessionStateEvent {
  type: "session-state";
  state: SessionState;
}

/** Sent after a cold replay: whether older turns exist, and the event id
 *  to pass as `before` to `GET /api/chats/:id/history` to fetch them. */
export interface HistoryMetaEvent {
  type: "history-meta";
  hasOlder: boolean;
  oldestEventId: number;
}

export type SyntheticChatEvent =
  | SubscriptionOpenedEvent
  | QueueUpdatedEvent
  | SessionStateEvent
  | HistoryMetaEvent;

export type ChatEventPayload = LoggedChatEvent | SyntheticChatEvent;

/** A payload tagged with its event id (also on the SSE `id:` line). */
export type ChatEvent = ChatEventPayload & { eventId: number };

export type ChatEventType = ChatEventPayload["type"];

/**
 * Every event type. The client's `EventSource` listens per type, because
 * frames carry `event: <type>` and the default `message` event never fires
 * for named events.
 */
export const CHAT_EVENT_TYPES: ReadonlyArray<ChatEventType> = [
  "update",
  "prompt",
  "turn-started",
  "turn-ended",
  "permission",
  "elicitation",
  "request-resolved",
  "session-attached",
  "file",
  "notice",
  "subscription-opened",
  "queue-updated",
  "session-state",
  "history-meta",
] as const;
