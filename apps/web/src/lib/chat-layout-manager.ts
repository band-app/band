/**
 * Back-compat shim — re-exports the chat-service's layout API under the
 * legacy `lib/chat-layout-manager.ts` function-shaped surface so existing
 * imports keep compiling.
 *
 * The real implementation lives in `server/services/chat-service.ts`. New
 * code should call `chatService.getLayout(...)` etc. directly — this file
 * exists only to ease the migration started in issue #316 (Phase 5 of the
 * 3-tier refactor) and will be deleted in a follow-up phase once every
 * call site has moved.
 */

import { chatService } from "../server/services/chat-service";

export const getChatLayout = (workspaceId: string): unknown | null =>
  chatService.getLayout(workspaceId);

export const saveChatLayout = (workspaceId: string, tree: unknown): void =>
  chatService.saveLayout(workspaceId, tree);

export const deleteChatLayout = (workspaceId: string): void =>
  chatService.deleteLayout(workspaceId);

export function addChatToLayout(
  workspaceId: string,
  chatId: string,
  opts?: { title?: string },
): void {
  chatService.addToLayout(workspaceId, chatId, opts);
}

export function removeChatFromLayout(workspaceId: string, chatId: string): void {
  chatService.removeFromLayout(workspaceId, chatId);
}
