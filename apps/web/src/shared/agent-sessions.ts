/**
 * Agent session types shared by the server and the dashboard (issue #682).
 *
 * An agent session is one run of a coding agent. Its `mode` says how it is
 * displayed: `gui` in a chat pane, `tui` as the agent's CLI in a terminal.
 * The mode is fixed for the life of the session.
 */

export type AgentMode = "gui" | "tui";

export type AgentSessionState = "starting" | "running" | "ended";

export interface AgentSessionRecord {
  id: string;
  workspaceId: string;
  agentDefinitionId: string;
  /** The agent's own session id (e.g. Claude's `session_id`), null until known. */
  providerSessionId: string | null;
  mode: AgentMode;
  /** Set for `gui` sessions. */
  chatId: string | null;
  /** Set for `tui` sessions. */
  terminalId: string | null;
  state: AgentSessionState;
  createdAt: number;
  updatedAt: number;
}
