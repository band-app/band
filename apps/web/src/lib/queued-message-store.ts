/**
 * In-memory store for queued chat messages, keyed by chatId.
 *
 * When a user sends a message while the agent is busy, the frontend
 * persists it here so it survives page navigation. When a task
 * completes, the task-runner pops the next message and auto-starts
 * a new task. The frontend only pushes to and renders the queue.
 *
 * Each queued message can carry file attachments (images, PDFs, etc.)
 * encoded as base64 data URLs — the same shape the live transport
 * uses when posting to /api/tasks/:chatId/stream. Files are uploaded
 * to disk only when the message is drained and submitted as a real
 * task, mirroring the immediate-submit code path in task-stream.ts.
 *
 * Uses the globalThis Symbol pattern (same as task-runner.ts) to
 * ensure a single shared map across multiple bundles.
 */

import { randomUUID } from "node:crypto";

export interface QueuedFile {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface QueuedMessage {
  /** Stable identifier so the client can cancel a specific entry by id. */
  id: string;
  text: string;
  files?: QueuedFile[];
}

const QUEUED_KEY = Symbol.for("band.queued-messages");
const LISTENERS_KEY = Symbol.for("band.queued-messages.listeners");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[QUEUED_KEY]) g[QUEUED_KEY] = new Map<string, QueuedMessage[]>();
if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Set<QueueListener>();

const store = g[QUEUED_KEY] as Map<string, QueuedMessage[]>;
const queueListeners = g[LISTENERS_KEY] as Set<QueueListener>;

type QueueListener = (chatId: string, messages: QueuedMessage[]) => void;

function notify(chatId: string): void {
  const messages = (store.get(chatId) ?? []).map(cloneMessage);
  for (const listener of queueListeners) {
    try {
      listener(chatId, messages);
    } catch {
      // listener may have been removed
    }
  }
}

function cloneMessage(msg: QueuedMessage): QueuedMessage {
  return {
    id: msg.id,
    text: msg.text,
    files: msg.files ? msg.files.map((f) => ({ ...f })) : undefined,
  };
}

/** Subscribe to queue state changes. Returns an unsubscribe function. */
export function subscribeQueue(listener: QueueListener): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

export interface PushQueuedMessageInput {
  text: string;
  files?: QueuedFile[];
}

/**
 * Append a queued message for a chat pane. Returns the stored message
 * (including the generated id) so callers can reference it later.
 */
export function pushQueuedMessage(chatId: string, input: PushQueuedMessageInput): QueuedMessage {
  const message: QueuedMessage = {
    id: randomUUID(),
    text: input.text,
    files: input.files && input.files.length > 0 ? input.files.map((f) => ({ ...f })) : undefined,
  };
  const msgs = store.get(chatId);
  if (msgs) {
    msgs.push(message);
  } else {
    store.set(chatId, [message]);
  }
  notify(chatId);
  return cloneMessage(message);
}

/**
 * Replace the entire queue for a chat pane. Each input message may
 * provide its own id; otherwise a new one is generated.
 */
export function setQueuedMessages(
  chatId: string,
  messages: (PushQueuedMessageInput & { id?: string })[],
): void {
  if (messages.length === 0) {
    store.delete(chatId);
  } else {
    const stored: QueuedMessage[] = messages.map((m) => ({
      id: m.id ?? randomUUID(),
      text: m.text,
      files: m.files && m.files.length > 0 ? m.files.map((f) => ({ ...f })) : undefined,
    }));
    store.set(chatId, stored);
  }
  notify(chatId);
}

/** Retrieve all queued messages for a chat pane (empty array if none). */
export function getQueuedMessages(chatId: string): QueuedMessage[] {
  return (store.get(chatId) ?? []).map(cloneMessage);
}

/**
 * Remove and return the first queued message for a chat pane, or null
 * if the queue is empty.
 */
export function shiftQueuedMessage(chatId: string): QueuedMessage | null {
  const msgs = store.get(chatId);
  if (!msgs || msgs.length === 0) return null;
  const first = msgs.shift()!;
  if (msgs.length === 0) store.delete(chatId);
  notify(chatId);
  return cloneMessage(first);
}

/**
 * Replace the text of the queued message with the given id. Files
 * (if any) are preserved. Returns true if a message was updated.
 */
export function updateQueuedMessage(chatId: string, id: string, text: string): boolean {
  const msgs = store.get(chatId);
  if (!msgs) return false;
  const idx = msgs.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  msgs[idx] = { ...msgs[idx], text };
  notify(chatId);
  return true;
}

/**
 * Remove the queued message with the given id. Returns true if a
 * message was removed.
 */
export function removeQueuedMessage(chatId: string, id: string): boolean {
  const msgs = store.get(chatId);
  if (!msgs) return false;
  const idx = msgs.findIndex((m) => m.id === id);
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
