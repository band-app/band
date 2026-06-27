export interface SessionStartEvent {
  type: "session-start";
  sessionId: string;
}

export interface TextDeltaEvent {
  type: "text-delta";
  text: string;
}

/**
 * Emitted by adapters that stream individual tokens to mark a text-block
 * boundary — for example when an assistant message is `text → tool_use → text`
 * and the partial-message stream finishes the first text block before the
 * tool_use begins.
 *
 * Adapters that don't stream tokens never emit this; the task-runner's
 * existing side-effect endText() (called on tool-use / file / session-result)
 * keeps closing bubbles in the legacy non-streaming flow.
 */
export interface TextEndEvent {
  type: "text-end";
}

export interface ToolUseEvent {
  type: "tool-use";
  toolCallId: string;
  toolName: string;
  /** Human-readable display title (e.g. "Bash(git status)"). */
  displayTitle?: string;
  input: Record<string, unknown>;
  /**
   * Set by the adapter when this tool blocks on the user and its
   * tool-input-available broadcast is owned by the adapter's
   * `onUserInputNeeded` path (which enriches the input). The agent-agnostic
   * task-runner reads this to suppress its own generic broadcast, rather than
   * hard-coding any single agent's interactive tool names. Adapters with no
   * interactive tools leave it unset (falsy → broadcast normally).
   */
  interactive?: boolean;
}

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  toolName?: string;
  output: string;
  isError: boolean;
}

export interface SessionResultEvent {
  type: "session-result";
  success: boolean;
  sessionId: string;
  durationMs: number;
  numTurns: number;
  costUsd: number;
  errors: string[];
}

export interface FileEvent {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

/** Identifies which provider produced a UsageEvent so consumers can apply
 * provider-aware semantics without sniffing optional fields. */
export type UsageProvider = "claude" | "codex" | "gemini" | "opencode" | "cursor";

/**
 * Token usage for the most recent turn. Adapters emit this when usage info
 * is available so the UI can show context-window pressure.
 *
 * Provider semantics differ:
 *   • Claude — on `result` events `inputTokens` is the *uncached* prompt
 *     portion of the latest API round-trip; cached portions appear in
 *     `cacheReadTokens` / `cacheCreationTokens`, and total context ≈ sum of
 *     all three. Mid-turn (per-assistant) emissions freeze input/output/cache
 *     at the *previous* turn's cumulative totals so tooltip values stay
 *     coherent while `contextTokens` ticks live from the SDK.
 *   • Codex / OpenAI Responses API — `inputTokens` is the *full* prompt size
 *     for the turn (already inclusive of cached content). `cacheReadTokens`
 *     reports the cached subset for tooltip display only; do not sum. Codex
 *     also populates `reasoningOutputTokens`, `contextTokens`, and
 *     `totalProcessedTokens`.
 *
 * Adapters MUST set `contextTokens` to the computed context size for their
 * provider so the UI can render the meter without knowing per-provider
 * arithmetic. UIs should prefer `contextTokens` and only fall back to the
 * legacy summation (driven by `provider`) for snapshots that predate that
 * field.
 */
export interface UsageEvent {
  type: "usage";
  /**
   * Provider that produced this snapshot. Drives provider-aware UI logic
   * (legacy context summation, tooltip rendering). Optional for backward
   * compatibility with snapshots persisted before this field existed; new
   * adapters MUST set it.
   */
  provider?: UsageProvider;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /**
   * Claude-only: tokens written into the prompt cache on this round-trip.
   * Non-Claude adapters MUST leave this `undefined`.
   */
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  /** Total tokens currently in the model's context window (provider-aware). */
  contextTokens?: number;
  /**
   * Cumulative tokens processed by this session/thread when available.
   * Monotonic across `runSession` boundaries within a single process —
   * adapters persist running totals keyed by session id so a continuing
   * conversation never resets to zero. Not durable across server restarts.
   *
   * For Codex/OpenAI this approximates billed prompt+output tokens (each
   * turn's full prompt is counted, so prior history is recounted across
   * turns by design); for Claude it is the API-reported cumulative.
   */
  totalProcessedTokens?: number;
  /**
   * Effective max context window the agent is operating against. When set,
   * the UI should prefer this over a hard-coded model→window map (e.g.
   * Claude SDK's `getContextUsage().maxTokens` reflects the auto-compact
   * threshold).
   */
  maxContextTokens?: number;
}

/**
 * Emitted when the agent resolves the real session ID after a run.
 * Some agents (e.g. OpenCode) create their own session IDs internally.
 * The adapter emits session-start with a temporary ID early (so the UI
 * can show the user message), then emits this event once the real ID is known.
 */
export interface SessionIdResolvedEvent {
  type: "session-id-resolved";
  /** The temporary/placeholder session ID that was used in session-start. */
  previousSessionId: string;
  /** The agent's real session ID. */
  resolvedSessionId: string;
}

export type AgentEvent =
  | SessionStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolUseEvent
  | ToolResultEvent
  | FileEvent
  | SessionResultEvent
  | SessionIdResolvedEvent
  | UsageEvent
  | ErrorEvent;
