/**
 * Who a `band` MCP tool call acts for. Over `/mcp-proxy/band` it is always a chat (the session
 * token names it). Through `tools.list | call` it is a chat, or a bare worktree when the caller is a
 * terminal with no chat. Tools that need a chat (they record one as an origin or owner) refuse a
 * worktree scope with `NEEDS_CHAT`.
 */

import { chatService } from "../../services/chat-service";

export interface ToolScope {
  /** The chat the call comes from, or null for a terminal. */
  readonly chatId: string | null;
  /** The worktree the call acts on, read at call time, or null when there is none. */
  worktreeId(): string | null;
}

export const NEEDS_CHAT = "This tool needs a chat. Run it from an agent chat ($BAND_CHAT_ID)";

export function chatScope(chatId: string): ToolScope {
  return { chatId, worktreeId: () => chatService.get(chatId)?.worktreeId ?? null };
}

export function worktreeScope(worktreeId: string): ToolScope {
  return { chatId: null, worktreeId: () => worktreeId };
}
