/**
 * In-memory store for queued chat messages, keyed by workspaceId.
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

type QueueListener = (workspaceId: string, messages: string[]) => void;

function notify(workspaceId: string): void {
  const messages = [...(store.get(workspaceId) ?? [])];
  for (const listener of queueListeners) {
    try {
      listener(workspaceId, messages);
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

/** Append a queued message for a workspace. */
export function pushQueuedMessage(workspaceId: string, text: string): void {
  const msgs = store.get(workspaceId);
  if (msgs) {
    msgs.push(text);
  } else {
    store.set(workspaceId, [text]);
  }
  notify(workspaceId);
}

/** Replace the entire queue for a workspace. */
export function setQueuedMessages(workspaceId: string, texts: string[]): void {
  if (texts.length === 0) {
    store.delete(workspaceId);
  } else {
    store.set(workspaceId, [...texts]);
  }
  notify(workspaceId);
}

/** Retrieve all queued messages for a workspace (empty array if none). */
export function getQueuedMessages(workspaceId: string): string[] {
  return store.get(workspaceId) ?? [];
}

/**
 * Remove and return the first queued message for a workspace, or null
 * if the queue is empty.
 */
export function shiftQueuedMessage(workspaceId: string): string | null {
  const msgs = store.get(workspaceId);
  if (!msgs || msgs.length === 0) return null;
  const first = msgs.shift()!;
  if (msgs.length === 0) store.delete(workspaceId);
  notify(workspaceId);
  return first;
}

/**
 * Remove the first occurrence of a message matching `text` from the queue.
 * Returns true if a message was removed.
 */
export function removeQueuedMessage(workspaceId: string, text: string): boolean {
  const msgs = store.get(workspaceId);
  if (!msgs) return false;
  const idx = msgs.indexOf(text);
  if (idx === -1) return false;
  msgs.splice(idx, 1);
  if (msgs.length === 0) store.delete(workspaceId);
  notify(workspaceId);
  return true;
}

/** Remove all queued messages for a workspace. */
export function clearQueuedMessages(workspaceId: string): void {
  store.delete(workspaceId);
  notify(workspaceId);
}
