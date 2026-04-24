/**
 * In-memory store for queued chat messages, keyed by chatId.
 *
 * When a user sends a message while the agent is busy, the frontend
 * persists it here so it survives page navigation. When a task
 * completes, the task-runner pops the next message and auto-starts
 * a new task. The frontend only pushes to and renders the queue.
 *
 * Uses the globalThis Symbol pattern (same as task-runner.ts) to
 * ensure a single shared map across multiple bundles.
 */

const QUEUED_KEY = Symbol.for("band.queued-messages");
const LISTENERS_KEY = Symbol.for("band.queued-messages.listeners");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[QUEUED_KEY]) g[QUEUED_KEY] = new Map<string, string[]>();
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Set<QueueListener>();

const store = g[QUEUED_KEY] as Map<string, string[]>;
const queueListeners = g[LISTENERS_KEY] as Set<QueueListener>;

type QueueListener = (chatId: string, messages: string[]) => void;

function notify(chatId: string): void {
  const messages = [...(store.get(chatId) ?? [])];
  for (const listener of queueListeners) {
    try {
      listener(chatId, messages);
    } catch {
      // listener may have been removed
    }
  }
}

/** Subscribe to queue state changes. Returns an unsubscribe function. */
export function subscribeQueue(listener: QueueListener): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

/** Append a queued message for a chat pane. */
export function pushQueuedMessage(chatId: string, text: string): void {
  const msgs = store.get(chatId);
  if (msgs) {
    msgs.push(text);
  } else {
    store.set(chatId, [text]);
  }
  notify(chatId);
}

/** Replace the entire queue for a chat pane. */
export function setQueuedMessages(chatId: string, texts: string[]): void {
  if (texts.length === 0) {
    store.delete(chatId);
  } else {
    store.set(chatId, [...texts]);
  }
  notify(chatId);
}

/** Retrieve all queued messages for a chat pane (empty array if none). */
export function getQueuedMessages(chatId: string): string[] {
  return store.get(chatId) ?? [];
}

/**
 * Remove and return the first queued message for a chat pane, or null
 * if the queue is empty.
 */
export function shiftQueuedMessage(chatId: string): string | null {
  const msgs = store.get(chatId);
  if (!msgs || msgs.length === 0) return null;
  const first = msgs.shift()!;
  if (msgs.length === 0) store.delete(chatId);
  notify(chatId);
  return first;
}

/**
 * Remove the first occurrence of a message matching `text` from the queue.
 * Returns true if a message was removed.
 */
export function removeQueuedMessage(chatId: string, text: string): boolean {
  const msgs = store.get(chatId);
  if (!msgs) return false;
  const idx = msgs.indexOf(text);
  if (idx === -1) return false;
  msgs.splice(idx, 1);
  if (msgs.length === 0) store.delete(chatId);
  notify(chatId);
  return true;
}

/** Remove all queued messages for a chat pane. */
export function clearQueuedMessages(chatId: string): void {
  store.delete(chatId);
  notify(chatId);
}
