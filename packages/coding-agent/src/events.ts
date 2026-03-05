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
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
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

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type AgentEvent =
  | SessionStartEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | SessionResultEvent
  | ErrorEvent;
