/**
 * A chat tab's label, the same on the web and the phone: the name a user gave
 * the chat (`chats.update { name }`), else its session's title, else the
 * agent's label, else the agent id. A chat the hub created without a name is
 * named "Chat", which counts as no name.
 */

const DEFAULT_NAME = "Chat";

export interface ChatTabLabelParts {
  name?: string | null;
  /** `activeSessionSummary` of the chat: the session's title or first prompt. */
  summary?: string | null;
  /** The label of the chat's coding agent in settings ("Claude Code"). */
  agentLabel?: string | null;
  /** The chat's agent id, or the default agent's when the chat has none. */
  agentId?: string | null;
}

export function chatTabLabel(parts: ChatTabLabelParts): string {
  const name = parts.name?.trim();
  if (name && name !== DEFAULT_NAME) return name;
  return parts.summary || parts.agentLabel || parts.agentId || DEFAULT_NAME;
}
