/**
 * Wire schema for the chat event log.
 *
 * The unified `/api/chats/:chatId/events` SSE stream emits these as
 * `event: <type>` + `data: <JSON>` lines. The native SSE `id:` field
 * carries each event's monotonic id so the browser's EventSource auto-
 * populates `Last-Event-ID` on reconnect — no manual cursor on the
 * client.
 *
 * Lives under `apps/web/src/shared/` because both halves of the app
 * (server tier + browser-side components) need the same definitions,
 * and `apps/web/src/lib/` is reserved for browser-only utilities per
 * the 3-tier architecture rules (`docs/web-architecture.md`). Moved out
 * of `lib/` in issue #535, follow-up 4.
 *
 * Source of truth shared by:
 *   • `apps/web/src/api/chat-events.ts`            — emits these events
 *   • `apps/web/src/api/chat-submit.ts`            — round-trip target
 *   • `apps/web/src/server/services/task-service.ts` — broadcasts them
 *   • `apps/web/src/components/chat/*`             — consumes them
 *   • `apps/web/tests/chat-events.test.ts`         — integration tests
 */

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

export interface ChatEventFile {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface ChatEventUsage {
  provider?: "claude" | "codex" | "gemini" | "opencode" | "cursor";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  contextTokens?: number;
  totalProcessedTokens?: number;
  maxContextTokens?: number;
}

export interface QueuedChatMessage {
  id: string;
  text: string;
  files?: ChatEventFile[];
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/** A user-submitted prompt. Emitted by the task runner once the task starts so
 *  every subscriber (including the submitter) sees the same canonical record. */
export interface UserMessageEvent {
  type: "user-message";
  /** The text the user actually typed (no agent-prompt augmentation). */
  text: string;
  files?: ChatEventFile[];
}

/** Lifecycle marker emitted when a task transitions to "running" server-side. */
export interface TaskStartedEvent {
  type: "task-started";
  taskId: string;
  agentType?: string;
  model?: string;
  mode?: string;
}

/** Lifecycle marker emitted when a task completes successfully. */
export interface TaskCompletedEvent {
  type: "task-completed";
  taskId: string;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
}

/** Lifecycle marker emitted when a task fails or is aborted. */
export interface TaskErrorEvent {
  type: "task-error";
  taskId: string;
  message: string;
}

/** The agent reported (or resolved) its session id. */
export interface SessionResolvedEvent {
  type: "session-resolved";
  sessionId: string;
}

/** Begin a streaming text part within the current assistant message. */
export interface TextStartEvent {
  type: "text-start";
  id: string;
}

/** Append text to the current streaming part. */
export interface TextDeltaEvent {
  type: "text-delta";
  id: string;
  delta: string;
}

/** Close the current streaming text part. */
export interface TextEndEvent {
  type: "text-end";
  id: string;
}

/** A tool call's input is available (and possibly still streaming). */
export interface ToolInputAvailableEvent {
  type: "tool-input-available";
  toolCallId: string;
  toolName: string;
  input: unknown;
  displayTitle?: string;
  /** For interactive tools (AskUserQuestion, ExitPlanMode). */
  approvalId?: string;
}

/** A tool call has produced an output. */
export interface ToolOutputAvailableEvent {
  type: "tool-output-available";
  toolCallId: string;
  output: string;
  isError?: boolean;
}

/** Token usage snapshot for the current assistant turn. */
export interface UsageEvent {
  type: "usage";
  data: ChatEventUsage;
}

/** Final-result metadata from the agent (after task-completed). */
export interface ResultEvent {
  type: "result";
  sessionId?: string;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
}

/** Generic agent or runtime error. Distinct from `task-error` (lifecycle). */
export interface ErrorEvent {
  type: "error";
  message: string;
}

/** An assistant-produced file the user can render inline (image, download
 *  link, …). Emitted by `task-service` either when the agent emits a
 *  `file` event explicitly or when a tool call drops a new file into the
 *  workspace shared dir. The client attaches it as a `file` part on the
 *  current assistant message — never a stand-alone bubble. */
export interface FileEvent {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

/** Server pushes the full queue every time it changes. Idempotent — clients
 *  replace their local view wholesale (no need to track per-event mutations). */
export interface QueueUpdatedEvent {
  type: "queue-updated";
  messages: QueuedChatMessage[];
}

/** Heartbeat-equivalent: emitted at subscription open even if there's nothing
 *  to replay, so the client knows the stream is alive and the session is
 *  resolved. */
export interface SubscriptionOpenedEvent {
  type: "subscription-opened";
  sessionId?: string;
  taskRunning: boolean;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type ChatEventPayload =
  | UserMessageEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskErrorEvent
  | SessionResolvedEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolInputAvailableEvent
  | ToolOutputAvailableEvent
  | UsageEvent
  | ResultEvent
  | ErrorEvent
  | FileEvent
  | QueueUpdatedEvent
  | SubscriptionOpenedEvent;

/** A ChatEventPayload tagged with its monotonic event id. The `eventId` lives
 *  on the SSE `id:` line; it's surfaced in the JSON payload too as a
 *  convenience so consumers that don't speak native SSE (curl, tests) can read
 *  it without parsing the framing. */
export type ChatEvent = ChatEventPayload & { eventId: number };

export type ChatEventType = ChatEventPayload["type"];

/** Map of event type → its payload shape. Useful for type-safe handlers. */
export type ChatEventByType = {
  [K in ChatEventType]: Extract<ChatEventPayload, { type: K }>;
};

/**
 * Enumeration of every ChatEvent type. The client's `EventSource` uses
 * `addEventListener(type, ...)` per type because we frame events as
 * `event: <type>` lines — the default `message` event doesn't fire when
 * `event:` is set, so a wildcard listener wouldn't catch anything.
 *
 * Keep in sync with `ChatEventPayload`. The exhaustiveness of
 * `chatEventReducer`'s switch statement guards the server-side mapping;
 * this array guards the client-side dispatch.
 */
export const CHAT_EVENT_TYPES: ReadonlyArray<ChatEventType> = [
  "user-message",
  "task-started",
  "task-completed",
  "task-error",
  "session-resolved",
  "text-start",
  "text-delta",
  "text-end",
  "tool-input-available",
  "tool-output-available",
  "usage",
  "result",
  "error",
  "file",
  "queue-updated",
  "subscription-opened",
] as const;
