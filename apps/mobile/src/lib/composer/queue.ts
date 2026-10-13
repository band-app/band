/** The queue's order changes, as the web's drag-to-reorder makes them. */

import type { QueuedChatMessage } from "@band-app/shared/chat-events";

/** `list` with the item at `from` moved to `to`. Out-of-range indexes leave it unchanged. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** The body of `queue.set`: ids, texts and attachments, with no empty `files` array. */
export function queueSetPayload(messages: QueuedChatMessage[]) {
  return messages.map((m) => ({
    id: m.id,
    text: m.text,
    ...(m.files && m.files.length > 0 ? { files: m.files } : {}),
  }));
}
