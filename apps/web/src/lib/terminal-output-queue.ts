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
// So a parked terminal's output waits in its queue, and one shared drain
// feeds all parked terminals a bounded amount per tick. A queue that grows
// past its cap stops parsing entirely: the terminal is resynced from the
// server's snapshot when it is shown again (see `terminal-cache.ts`).
//
// A visible terminal's output goes through a second, faster drain that keeps
// at most `FOREGROUND_IN_FLIGHT_BYTES` handed to xterm and not yet parsed.
// Handing xterm every frame as it arrived let a flood queue megabytes inside
// xterm's write buffer, and a keystroke's echo parsed only after all of it.
// Each chunk's `onConsumed` fires once xterm has parsed it (or it is
// dropped); the caller acknowledges those bytes to the server, which pauses
// the PTY while too many are unparsed (`api/terminals/output-flow.ts`). The
// visible drain also holds a DEC 2026 synchronized-output frame until its end
// marker arrives, so xterm parses a TUI's redraw in one go instead of across
// several turns.
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
const CHUNK_BYTES = 16 * 1024;
/**
 * Writes per tick across all parked terminals. With the interval above this
 * caps parked parsing at ~2 MB/s, a few percent of one core.
 */
const MAX_WRITES_PER_DRAIN = 6;
/**
 * Writes per turn across all visible terminals. Orca's high-priority drain:
 * 8 x 16 KB is ~1.3 ms of parsing, so the sustained ceiling (~30 MB/s) stays
 * well inside the time budget.
 */
const FOREGROUND_MAX_WRITES_PER_DRAIN = 8;
/** Stop a tick early once it has spent this long, even under the write cap. */
const DRAIN_TIME_BUDGET_MS = 8;
/**
 * Bytes a visible terminal may have handed to xterm but not yet parsed. A
 * keystroke's echo waits behind at most this much of xterm's own queue.
 */
const FOREGROUND_IN_FLIGHT_BYTES = 128 * 1024;
/**
 * Bytes a parked terminal may queue before it stops parsing and waits for a
 * resync. Orca's floor for the same cap.
 */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
/**
 * Longest a visible terminal holds an unfinished DEC 2026 frame, so a lost or
 * missing end marker can't stall output. Orca's values: 250 ms normally, 32 ms
 * right after a keystroke so a split frame never delays echo noticeably.
 */
const SYNC_FRAME_HOLD_MS = 250;
const SYNC_FRAME_HOLD_AFTER_INPUT_MS = 32;
/** How long after a keystroke output counts as its echo (orca's interactive window). */
const INPUT_ECHO_WINDOW_MS = 100;

/** `ESC [ ? 2026 h` / `ESC [ ? 2026 l`: begin / end synchronized update. */
const SYNC_BEGIN = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68];
const SYNC_END_FINAL = 0x6c;
const SYNC_MARKER_BYTES = SYNC_BEGIN.length;

type Chunk = string | Uint8Array;

export interface OutputCallbacks {
  /** Runs once xterm has parsed the whole chunk. */
  onParsed?: () => void;
  /** Runs exactly once, when xterm has parsed the chunk or it was dropped. */
  onConsumed?: () => void;
}

export interface TerminalOutputQueue {
  /**
   * Deliver one chunk of output. Foreground chunks go through the visible
   * terminals' paced drain, and are written at once when xterm has room;
   * background chunks are queued for the parked drain. Byte order is kept
   * either way.
   */
  push(data: Chunk, foreground: boolean, callbacks?: OutputCallbacks): void;
  /**
   * Deliver a client-side notice (an error, `[Process completed]`). It must
   * survive an overflow, so it is written at once when nothing is queued, and
   * otherwise queued behind the output it follows, past the cap, so it drains
   * behind it instead of forcing the whole queue through.
   */
  pushNotice(text: string): void;
  /** The user typed into the terminal; a split frame is held only briefly now. */
  noteInput(): void;
  /**
   * The terminal became visible: write everything parked now. Returns `false`
   * when the queue overflowed and output was dropped, so the caller must
   * resync the terminal instead.
   */
  flush(): boolean;
  /** Drop everything queued and clear the overflow (a reconnect is replaying). */
  clear(): void;
  dispose(): void;
}

interface QueuedChunk {
  data: Chunk;
  callbacks: OutputCallbacks | undefined;
}

interface QueueState {
  write: (data: Chunk, onParsed?: () => void) => void;
  chunks: QueuedChunk[];
  bytes: number;
  overflowed: boolean;
  /** Written to xterm by the foreground drain and not yet parsed. */
  inFlight: number;
  /** An unfinished DEC 2026 frame is queued; don't write until it ends or times out. */
  syncHeld: boolean;
  syncTimer: ReturnType<typeof setTimeout> | null;
  /** Trailing bytes of the last foreground chunk, in case a marker spans two. */
  markerTail: Uint8Array;
  lastInputAt: number;
}

/** Parked queues with pending output, in the order they became pending. */
const pending = new Set<QueueState>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;

/** Visible queues with pending output, drained on posted tasks. */
const foregroundPending = new Set<QueueState>();
let foregroundDrainPosted = false;
let foregroundChannel: MessageChannel | null = null;

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null || pending.size === 0) return;
  drainTimer = setTimeout(drain, delayMs);
}

/**
 * Drain visible output on a posted task: unlike a nested `setTimeout(0)`,
 * Chromium doesn't clamp it to 4 ms, and input and paint still run first.
 */
function scheduleForegroundDrain(): void {
  if (foregroundDrainPosted || foregroundPending.size === 0) return;
  foregroundDrainPosted = true;
  if (!foregroundChannel) {
    foregroundChannel = new MessageChannel();
    foregroundChannel.port1.onmessage = drainForeground;
  }
  foregroundChannel.port2.postMessage(null);
}

function chunkBytes(data: Chunk): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

/**
 * Take up to `CHUNK_BYTES` off the front of a queue. Returns the callbacks
 * to run once that piece is parsed: the chunk's own, on its last piece.
 */
function takeChunk(queue: QueueState): { data: Chunk; done: OutputCallbacks | undefined } {
  const head = queue.chunks[0];
  if (typeof head.data === "string" || head.data.byteLength <= CHUNK_BYTES) {
    queue.chunks.shift();
    queue.bytes -= chunkBytes(head.data);
    return { data: head.data, done: head.callbacks };
  }
  // xterm's UTF-8 decoder carries a split multi-byte sequence across writes,
  // so cutting mid-character is safe.
  const slice = head.data.subarray(0, CHUNK_BYTES);
  head.data = head.data.subarray(CHUNK_BYTES);
  queue.bytes -= CHUNK_BYTES;
  return { data: slice, done: undefined };
}

function writeChunk(queue: QueueState, data: Chunk, done: OutputCallbacks | undefined): void {
  if (!done?.onParsed && !done?.onConsumed) {
    queue.write(data);
    return;
  }
  queue.write(data, () => {
    done.onParsed?.();
    done.onConsumed?.();
  });
}

function drain(): void {
  drainTimer = null;
  const startedAt = performance.now();
  let writes = 0;
  // Round-robin: each queue that writes goes to the back of the line.
  while (writes < MAX_WRITES_PER_DRAIN && pending.size > 0) {
    const queue = pending.values().next().value as QueueState;
    pending.delete(queue);
    const { data, done } = takeChunk(queue);
    writeChunk(queue, data, done);
    writes++;
    if (queue.chunks.length > 0) pending.add(queue);
    if (performance.now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }
  scheduleDrain(BACKGROUND_DRAIN_INTERVAL_MS);
}

function canWriteForeground(queue: QueueState): boolean {
  return queue.chunks.length > 0 && !queue.syncHeld && queue.inFlight < FOREGROUND_IN_FLIGHT_BYTES;
}

/** Hand one piece of a visible queue to xterm, counting it until it parses. */
function writeForeground(queue: QueueState): void {
  const { data, done } = takeChunk(queue);
  const bytes = chunkBytes(data);
  queue.inFlight += bytes;
  queue.write(data, () => {
    queue.inFlight -= bytes;
    done?.onParsed?.();
    done?.onConsumed?.();
    // xterm has room again: keep the queue moving at parse speed.
    if (canWriteForeground(queue)) {
      foregroundPending.add(queue);
      scheduleForegroundDrain();
    }
  });
}

function drainForeground(): void {
  foregroundDrainPosted = false;
  const startedAt = performance.now();
  let writes = 0;
  while (writes < FOREGROUND_MAX_WRITES_PER_DRAIN && foregroundPending.size > 0) {
    const queue = foregroundPending.values().next().value as QueueState;
    foregroundPending.delete(queue);
    // A held or full queue is re-added by its timer or its write callback.
    if (!canWriteForeground(queue)) continue;
    writeForeground(queue);
    writes++;
    if (canWriteForeground(queue)) foregroundPending.add(queue);
    if (performance.now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }
  scheduleForegroundDrain();
}

/**
 * Whether a DEC 2026 frame is still open after `data`: the last begin marker
 * comes after the last end marker. `tail` is the end of the previous chunk,
 * so a marker split across two frames is still seen. Returns `null` when the
 * chunk contains no marker at all.
 */
function syncFrameOpenAfter(tail: Uint8Array, data: Uint8Array): boolean | null {
  let bytes = data;
  if (tail.byteLength > 0) {
    bytes = new Uint8Array(tail.byteLength + data.byteLength);
    bytes.set(tail);
    bytes.set(data, tail.byteLength);
  }
  let open: boolean | null = null;
  for (let i = bytes.indexOf(0x1b); i !== -1; i = bytes.indexOf(0x1b, i + 1)) {
    if (i + SYNC_MARKER_BYTES > bytes.byteLength) break;
    let prefix = true;
    for (let k = 1; k < SYNC_MARKER_BYTES - 1; k++) {
      if (bytes[i + k] !== SYNC_BEGIN[k]) {
        prefix = false;
        break;
      }
    }
    if (!prefix) continue;
    const final = bytes[i + SYNC_MARKER_BYTES - 1];
    if (final === SYNC_BEGIN[SYNC_MARKER_BYTES - 1]) open = true;
    else if (final === SYNC_END_FINAL) open = false;
  }
  return open;
}

export function createTerminalOutputQueue(
  write: (data: Chunk, onParsed?: () => void) => void,
): TerminalOutputQueue {
  const state: QueueState = {
    write,
    chunks: [],
    bytes: 0,
    overflowed: false,
    inFlight: 0,
    syncHeld: false,
    syncTimer: null,
    markerTail: new Uint8Array(0),
    lastInputAt: Number.NEGATIVE_INFINITY,
  };

  const releaseSyncHold = () => {
    if (state.syncTimer !== null) clearTimeout(state.syncTimer);
    state.syncTimer = null;
    state.syncHeld = false;
  };

  const reset = () => {
    pending.delete(state);
    foregroundPending.delete(state);
    releaseSyncHold();
    state.markerTail = new Uint8Array(0);
    const dropped = state.chunks;
    state.chunks = [];
    state.bytes = 0;
    for (const chunk of dropped) chunk.callbacks?.onConsumed?.();
  };

  /** Track DEC 2026 frames in visible output; true while one is unfinished. */
  const updateSyncHold = (data: Chunk) => {
    if (typeof data === "string") return;
    const open = syncFrameOpenAfter(state.markerTail, data);
    const tailFrom = Math.max(0, data.byteLength - (SYNC_MARKER_BYTES - 1));
    state.markerTail = data.slice(tailFrom);
    if (open === false) {
      releaseSyncHold();
      return;
    }
    if (open !== true || state.syncHeld) return;
    state.syncHeld = true;
    const recentInput = performance.now() - state.lastInputAt < INPUT_ECHO_WINDOW_MS;
    state.syncTimer = setTimeout(
      () => {
        // The end marker never came: write what we have, the rest as it arrives.
        state.syncTimer = null;
        state.syncHeld = false;
        foregroundPending.add(state);
        scheduleForegroundDrain();
      },
      recentInput ? SYNC_FRAME_HOLD_AFTER_INPUT_MS : SYNC_FRAME_HOLD_MS,
    );
  };

  const enqueue = (data: Chunk, callbacks: OutputCallbacks | undefined) => {
    state.chunks.push({ data, callbacks });
    state.bytes += chunkBytes(data);
  };

  return {
    push(data, foreground, callbacks) {
      if (foreground) {
        // Parked output queued before the terminal was shown goes first.
        if (pending.has(state)) this.flush();
        enqueue(data, callbacks);
        updateSyncHold(data);
        // Room in xterm: write now, so a keystroke's echo isn't a task late.
        if (canWriteForeground(state)) writeForeground(state);
        if (canWriteForeground(state)) {
          foregroundPending.add(state);
          scheduleForegroundDrain();
        }
        return;
      }
      if (state.overflowed) {
        callbacks?.onConsumed?.();
        return;
      }
      enqueue(data, callbacks);
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
      enqueue(text, undefined);
    },
    noteInput() {
      state.lastInputAt = performance.now();
    },
    flush() {
      if (state.overflowed) return false;
      // Nothing parked: visible output already queued keeps its pacing.
      if (!pending.delete(state)) return true;
      const chunks = state.chunks;
      state.chunks = [];
      state.bytes = 0;
      for (const chunk of chunks) writeChunk(state, chunk.data, chunk.callbacks);
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
