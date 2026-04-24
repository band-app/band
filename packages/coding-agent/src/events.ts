export interface SessionStartEvent {
  type: "session-start";
  sessionId: string;
}

export interface TextDeltaEvent {
  type: "text-delta";
  text: string;
}

export interface ToolUseEvent {
  type: "tool-use";
  toolCallId: string;
  toolName: string;
  /** Human-readable display title (e.g. "Bash(git status)"). */
  displayTitle?: string;
  input: Record<string, unknown>;
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
  | ToolUseEvent
  | ToolResultEvent
  | FileEvent
  | SessionResultEvent
  | SessionIdResolvedEvent
  | ErrorEvent;
