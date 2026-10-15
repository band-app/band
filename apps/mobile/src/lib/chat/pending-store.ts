/**
 * What each mounted chat waits on the user for, by chat id: the permission's tool title or the
 * question's text. A mounted `ChatView` reads it from its transcript and writes it here, so the
 * tab sheet can show the question as the tab's summary and the tab icon can tell a question from
 * a finished turn. A chat that isn't mounted has no entry; the hub's chat status stands in then.
 */

const pending = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function setPending(chatId: string, text: string | null): void {
  if (text === null) {
    if (!pending.delete(chatId)) return;
  } else {
    if (pending.get(chatId) === text) return;
    pending.set(chatId, text);
  }
  version++;
  for (const listener of listeners) listener();
}

export function getPending(chatId: string): string | undefined {
  return pending.get(chatId);
}

export function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes on every write, for `useSyncExternalStore`. */
export function pendingVersion(): number {
  return version;
}
