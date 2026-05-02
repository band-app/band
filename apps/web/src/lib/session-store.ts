import { getSessionBuffer, type StreamChunk } from "./task-runner";

/**
 * A buffered session event.
 *
 * Buffered chunks are kept as already-parsed objects so that callers don't
 * pay a JSON.stringify/parse cost on every read. With ring buffers up to
 * MAX_BUFFER_SIZE (2000) entries this loop dominated workspace-switch
 * latency for active sessions.
 */
export interface SessionEventRecord {
  id: number;
  sessionId: string;
  chunkType: string;
  /** The parsed stream chunk. Treat as read-only. */
  chunk: StreamChunk;
  createdAt: number;
}

function chunkToRecord(sessionId: string, chunk: StreamChunk): SessionEventRecord {
  return {
    id: chunk.eventId ?? 0,
    sessionId,
    chunkType: chunk.type,
    chunk,
    createdAt: Date.now(),
  };
}

/**
 * Get the most recent N events for a session (for initial page load).
 * Returns events in ascending id order (oldest first).
 */
export function getSessionEventsTail(sessionId: string, limit: number): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  const start = Math.max(0, buf.events.length - limit);
  return buf.events.slice(start).map((c) => chunkToRecord(sessionId, c));
}

/**
 * Get events before a given eventId for scroll-up pagination.
 * Returns events in ascending id order (oldest first).
 */
export function getSessionEventsBefore(
  sessionId: string,
  beforeEventId: number,
  limit: number,
): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  // Find the index of the first event with id >= beforeEventId
  const cutoff = buf.events.findIndex((e) => (e.eventId ?? 0) >= beforeEventId);
  if (cutoff <= 0) return [];
  const start = Math.max(0, cutoff - limit);
  return buf.events.slice(start, cutoff).map((c) => chunkToRecord(sessionId, c));
}

/**
 * Get events after a given eventId (for gap-fill replay).
 * Returns events in ascending id order.
 */
export function getSessionEventsAfter(
  sessionId: string,
  afterEventId: number,
): SessionEventRecord[] {
  const buf = getSessionBuffer(sessionId);
  if (!buf) return [];
  return buf.events
    .filter((e) => (e.eventId ?? 0) > afterEventId)
    .map((c) => chunkToRecord(sessionId, c));
}
