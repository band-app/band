import type { AgentEvent } from "./events.js";

export interface UserInputRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface CodingAgentFeatures {
  costTracking: boolean;
  sessionListing: boolean;
}

export interface SessionListItem {
  sessionId: string;
  summary: string;
  lastModified: number;
  firstPrompt?: string;
  gitBranch?: string;
}

export interface SessionMessageItem {
  role: "user" | "assistant";
  id: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; toolCallId: string; toolName: string; input: unknown }
    | { type: "tool_result"; toolCallId: string; output: string; isError: boolean }
  >;
}

export interface CodingAgent {
  readonly name: string;
  readonly supportedFeatures: CodingAgentFeatures;
  onUserInputNeeded?: (request: UserInputRequest) => Promise<Record<string, string>>;
  runSession(prompt: string, sessionId?: string): AsyncGenerator<AgentEvent>;
  listSessions?(dir: string): Promise<SessionListItem[]>;
  getSessionMessages?(
    sessionId: string,
    dir: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SessionMessageItem[]>;
}
