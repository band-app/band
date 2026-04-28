/**
 * Chat layout persistence.
 *
 * Thin wrapper around DockviewLayoutManager for chat pane layouts.
 * Each workspace gets one row in the `panel_states` table with
 * `panelType = "chat_layout"`.
 */

import { DockviewLayoutManager } from "./dockview-layout-manager";

const manager = new DockviewLayoutManager("chat_layout");

export const getChatLayout = (workspaceId: string) => manager.get(workspaceId);
export const saveChatLayout = (workspaceId: string, tree: unknown) =>
  manager.save(workspaceId, tree);
export const deleteChatLayout = (workspaceId: string) => manager.delete(workspaceId);

/**
 * Add a chat panel to the saved dockview layout.
 */
export function addChatToLayout(
  workspaceId: string,
  chatId: string,
  opts?: { title?: string },
): void {
  manager.addPanel(workspaceId, {
    id: chatId,
    contentComponent: "chatTab",
    tabComponent: "chatTab",
    title: opts?.title ?? "Chat",
    params: {
      workspaceId,
      chatId,
    },
  });
}

/**
 * Remove a chat panel from the saved dockview layout.
 */
export function removeChatFromLayout(workspaceId: string, chatId: string): void {
  manager.removePanel(workspaceId, chatId);
}
