/**
 * Back-compat shim — re-exports the chat-service API under the legacy
 * `lib/chat-manager.ts` function-shaped surface so existing callers
 * (`task-service.ts`, `chat-session-summary.ts`, the CLI adapter, the API
 * handlers in `apps/web/src/api/`, …) keep compiling without touching
 * their imports.
 *
 * The real implementation lives in `server/services/chat-service.ts`. New
 * code should import the `chatService` singleton (or the `ChatService`
 * class) directly from there — this file exists only to ease the
 * migration started in issue #316 (Phase 5 of the 3-tier refactor) and
 * will be deleted in a follow-up phase once every call site has moved.
 */

import {
  type ActiveSessionUpdate,
  BAND_CRON_ID_LABEL,
  type ChatSession,
  type ChatStatus,
  type CreateChatOptions,
  chatService,
  InvalidLabelsError,
  type UpdateChatOptions,
} from "../server/services/chat-service";

export type { ChatSession, ChatStatus, CreateChatOptions, UpdateChatOptions, ActiveSessionUpdate };
export { InvalidLabelsError, BAND_CRON_ID_LABEL };

export function createChat(workspaceId: string, options?: CreateChatOptions): ChatSession {
  return chatService.create(workspaceId, options);
}

export function getChat(chatId: string): ChatSession | undefined {
  return chatService.get(chatId);
}

export function listChats(workspaceId: string): ChatSession[] {
  return chatService.list(workspaceId);
}

export function updateChat(chatId: string, updates: UpdateChatOptions): ChatSession | undefined {
  return chatService.update(chatId, updates);
}

export function updateChatStatus(chatId: string, status: ChatStatus): void {
  chatService.updateStatus(chatId, status);
}

export function updateChatActiveSession(
  chatId: string,
  update: string | undefined | ActiveSessionUpdate,
): void {
  chatService.updateActiveSession(chatId, update);
}

export function updateChatSessionSummary(
  chatId: string,
  sessionId: string,
  summary: string | undefined,
  lastModified: number | undefined,
): boolean {
  return chatService.updateSessionSummary(chatId, sessionId, summary, lastModified);
}

export function removeChat(chatId: string): boolean {
  return chatService.remove(chatId);
}

export function removeWorkspaceChats(workspaceId: string): void {
  chatService.removeAllForWorkspace(workspaceId);
}

export function loadChatsFromDb(): number {
  return chatService.loadFromDb();
}

export function findChatByLabels(
  workspaceId: string,
  match: Record<string, string>,
): ChatSession | null {
  return chatService.findByLabels(workspaceId, match);
}

export function getOrCreateDefaultChat(workspaceId: string): ChatSession {
  return chatService.getOrCreateDefault(workspaceId);
}
