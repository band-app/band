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

export interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
}

export interface SessionMessageItem {
  role: "user" | "assistant";
  id: string;
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        toolCallId: string;
        toolName: string;
        displayTitle?: string;
        input: unknown;
      }
    | { type: "tool_result"; toolCallId: string; output: string; isError: boolean }
  >;
}

export interface GetSessionMessagesOptions {
  /**
   * Return the most recent `tail` messages. Equivalent to
   * `{ offset: max(0, total - tail), limit: tail }` but doesn't require
   * the caller to know `total` upfront. Takes precedence over
   * `offset` / `limit` when set.
   */
  tail?: number;
  /** Skip the first N messages before applying `limit`. */
  offset?: number;
  /** Return at most this many messages from `offset`. */
  limit?: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export interface RunSessionOptions {
  maxTurns?: number;
  mode?: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
}

export interface CodingAgent {
  readonly name: string;
  readonly supportedFeatures: CodingAgentFeatures;
  onUserInputNeeded?: (request: UserInputRequest) => Promise<Record<string, string>>;
  runSession(
    prompt: string,
    sessionId?: string,
    options?: RunSessionOptions,
  ): AsyncGenerator<AgentEvent>;
  abort?(): void;
  listSessions?(dir: string): Promise<SessionListItem[]>;
  /**
   * Read metadata for a single session by ID. Optimised path that avoids
   * walking the entire project directory — used to populate persisted
   * tab titles without a full `listSessions` call. Returns undefined if
   * the session file isn't found or has no extractable summary.
   */
  getSessionInfo?(sessionId: string, dir: string): Promise<SessionInfo | undefined>;
  /**
   * Find the most-recently-modified session in a project directory.
   * Used as a fallback when no activeSessionId is persisted yet (e.g.
   * a freshly-mounted workspace). Implementations should do an
   * mtime-sorted directory scan + a single `getSessionInfo` rather than
   * loading every session's metadata.
   */
  getLatestSession?(dir: string): Promise<SessionInfo | undefined>;
  /**
   * Read messages from a session's transcript.
   *
   * The router uses two access patterns:
   *
   *   • **First page** (`{ tail: pageSize }`) — return the last `tail`
   *     messages. Equivalent to `{ offset: max(0, total - tail), limit: tail }`
   *     but doesn't require the caller to know `total` upfront.
   *
   *   • **Older page** (`{ offset, limit }`) — skip `offset` messages then
   *     return up to `limit`. Used to walk older pages by the cursor
   *     returned in `firstOffset`.
   *
   * **`hasMore` semantics — "+1 trick"**: implementations should over-fetch
   * by one message (e.g. SDK `limit: limit + 1` or ring buffer of size
   * `tail + 1`) so they can report `hasMore: true` whenever an additional
   * message exists beyond the slice. The extra message is dropped before
   * returning. Callers use `hasMore` to decide whether to show a
   * "load older" affordance — no total count required.
   *
   * `firstOffset` is the absolute index of the slice's first message in
   * the adapter's filtered (user/assistant) message list. Used as the
   * cursor for fetching the next older page (`offset: firstOffset - limit`).
   *
   * `tail`, when set, takes precedence over `offset`/`limit`.
   */
  getSessionMessages?(
    sessionId: string,
    dir: string,
    options?: GetSessionMessagesOptions,
  ): Promise<{ messages: SessionMessageItem[]; hasMore: boolean; firstOffset: number }>;
  listSkills?(): Promise<SkillInfo[]>;
  listModes?(): AgentMode[];
  listModels?(): AgentModel[] | Promise<AgentModel[]>;
}
