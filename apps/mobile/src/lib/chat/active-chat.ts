/**
 * Which chat the worktree screen opens. The web dashboard shares its center tabs through client
 * state (`band:center-tabs:<ws>`), where a chat tab's id is the chat id. The phone opens the
 * active tab when it is a chat that still exists, else the first chat tab, else the first chat.
 */

import type { CenterTabs } from "@band-app/client/center-tabs";

export function pickActiveChat(
  chats: readonly { id: string }[],
  tabs: CenterTabs | null,
): string | null {
  const ids = new Set(chats.map((c) => c.id));
  if (tabs) {
    const active = tabs.tabs.find((t) => t.id === tabs.active);
    if (active?.kind === "chat" && ids.has(active.id)) return active.id;
    const first = tabs.tabs.find((t) => t.kind === "chat" && ids.has(t.id));
    if (first) return first.id;
  }
  return chats[0]?.id ?? null;
}
