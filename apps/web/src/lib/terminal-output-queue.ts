// ---------------------------------------------------------------------------
// Output scheduling for cached terminals (ported from orca's
// `pane-terminal-output-scheduler`).
//
// Every cached terminal parses its PTY output on the one renderer main thread,
// including terminals parked off-screen (up to 6 tabs in each of 4 warm hidden
// workspaces, see `terminal-park-policy.ts`). A parked terminal that streams
// (an agent redrawing its TUI, a build log) used to call `term.write` per
// WebSocket frame, and each call starts its own xterm parse loop of up to
// 12 ms slices. Measured with the typing-latency probe, three parked
// terminals under unbounded output pushed keystroke echo in the visible
// terminal to ~190 ms p50.
//
// So only attached (visible) terminals write straight to xterm. A parked
// terminal's output waits in its queue, and one shared drain feeds all parked
// terminals a bounded amount per tick. A queue that grows past its cap stops
// parsing entirely: the terminal is resynced from the server's snapshot when
// it is shown again (see `terminal-cache.ts`).
// ---------------------------------------------------------------------------

/** Delay before the first drain after parked output arrives, so bursts coalesce. */
const BACKGROUND_FLUSH_DELAY_MS = 50;
/**
 * Interval between drain ticks while parked output is queued. Each tick
 * touches the parked terminals' DOM, which keeps Chromium producing frames;
 * at 16 ms the visible terminal's echo waited a frame more often (p50 19 ms
 * vs 6.5 ms at 50 ms, same throughput).
 */
const BACKGROUND_DRAIN_INTERVAL_MS = 50;
/** Largest single write handed to xterm from a queue. */
const BACKGROUND_CHUNK_BYTES = 16 * 1024;
/**
 * Writes per tick across all parked terminals. With the interval above this
 * caps parked parsing at ~2 MB/s, a few percent of one core.
 */
const MAX_WRITES_PER_DRAIN = 6;
/** Stop a tick early once it has spent this long, even under the write cap. */
const DRAIN_TIME_BUDGET_MS = 8;
/**
 * Bytes a parked terminal may queue before it stops parsing and waits for a
 * resync. Orca's floor for the same cap.
 */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

type Chunk = string | Uint8Array;

export interface TerminalOutputQueue {
  /**
   * Deliver one chunk of output. Foreground chunks are written at once (after
   * anything still queued, to keep byte order); background chunks are queued
   * for the shared drain.
   */
  push(data: Chunk, foreground: boolean, onParsed?: () => void): void;
  /**
   * Deliver a client-side notice (an error, `[Process completed]`). It must
   * survive an overflow, so it is written at once when nothing is queued, and
   * otherwise queued behind the output it follows, past the cap, so it drains
   * on the shared budget instead of forcing the whole queue through.
   */
  pushNotice(text: string): void;
  /**
   * The terminal became visible: write everything queued now. Returns `false`
   * when the queue overflowed and output was dropped, so the caller must
   * resync the terminal instead.
   */
  flush(): boolean;
  /** Drop everything queued and clear the overflow (a reconnect is replaying). */
  clear(): void;
  dispose(): void;
}

interface QueueState {
  write: (data: Chunk, onParsed?: () => void) => void;
  chunks: Chunk[];
  bytes: number;
  overflowed: boolean;
}

/** Queues with pending output, in the order they became pending. */
const pending = new Set<QueueState>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null || pending.size === 0) return;
  drainTimer = setTimeout(drain, delayMs);
}

/** Take up to `BACKGROUND_CHUNK_BYTES` off the front of a queue. */
function takeChunk(queue: QueueState): Chunk {
  const head = queue.chunks[0];
  if (typeof head === "string" || head.byteLength <= BACKGROUND_CHUNK_BYTES) {
    queue.chunks.shift();
    queue.bytes -= chunkBytes(head);
    return head;
  }
  // xterm's UTF-8 decoder carries a split multi-byte sequence across writes,
  // so cutting mid-character is safe.
  const slice = head.subarray(0, BACKGROUND_CHUNK_BYTES);
  queue.chunks[0] = head.subarray(BACKGROUND_CHUNK_BYTES);
  queue.bytes -= BACKGROUND_CHUNK_BYTES;
  return slice;
}

function drain(): void {
  drainTimer = null;
  const startedAt = performance.now();
  let writes = 0;
  // Round-robin: each queue that writes goes to the back of the line.
  while (writes < MAX_WRITES_PER_DRAIN && pending.size > 0) {
    const queue = pending.values().next().value as QueueState;
    pending.delete(queue);
    queue.write(takeChunk(queue));
    writes++;
    if (queue.chunks.length > 0) pending.add(queue);
    if (performance.now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }
  scheduleDrain(BACKGROUND_DRAIN_INTERVAL_MS);
}

function chunkBytes(data: Chunk): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

export function createTerminalOutputQueue(
  write: (data: Chunk, onParsed?: () => void) => void,
): TerminalOutputQueue {
  const state: QueueState = { write, chunks: [], bytes: 0, overflowed: false };

  const reset = () => {
    pending.delete(state);
    state.chunks = [];
    state.bytes = 0;
  };

  return {
    push(data, foreground, onParsed) {
      if (foreground) {
        if (state.chunks.length > 0) this.flush();
        write(data, onParsed);
        return;
      }
      if (state.overflowed) return;
      state.chunks.push(data);
      state.bytes += chunkBytes(data);
      if (state.bytes > MAX_QUEUED_BYTES) {
        reset();
        state.overflowed = true;
        return;
      }
      pending.add(state);
      scheduleDrain(BACKGROUND_FLUSH_DELAY_MS);
    },
    pushNotice(text) {
      if (state.chunks.length === 0) {
        write(text);
        return;
      }
      state.chunks.push(text);
      state.bytes += text.length;
    },
    flush() {
      if (state.overflowed) return false;
      pending.delete(state);
      const chunks = state.chunks;
      reset();
      for (const chunk of chunks) write(chunk);
      return true;
    },
    clear() {
      reset();
      state.overflowed = false;
    },
    dispose() {
      reset();
    },
  };
}
