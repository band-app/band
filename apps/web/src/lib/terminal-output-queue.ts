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
// the PTY while too many are unparsed (`api/terminals/output-flow.ts`).
//
// DEC 2026 synchronized output: xterm skips any render that comes while a
// frame is open and tries again on the next animation frame. A TUI redrawing
// back to back (Claude Code scrolling) reaches us as several 1 KB messages per
// frame, so if each were parsed as it came, xterm would be inside a frame at
// nearly every animation frame and paint only in the gaps, or after its 1 s
// timeout. So the visible queue writes everything up to the last end marker
// and holds only the unfinished tail frame until its end arrives. Holding a
// whole chunk whenever it ended inside a frame (the earlier version) held the
// finished frame before it too, and only a timer let those through.
// ---------------------------------------------------------------------------

/** `ESC [ ? 2026`, the start of both the begin (`h`) and end (`l`) markers. */
const SYNC_PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36];
const SYNC_BEGIN_FINAL = 0x68;
const SYNC_END_FINAL = 0x6c;
const SYNC_MARKER_BYTES = SYNC_PREFIX.length + 1;
/**
 * Longest the unfinished tail of a frame waits for its end marker. A TUI
 * writes a frame in one go, so its end follows within a few ms; this only
 * covers a lost end marker or a PTY paused mid-frame.
 */
const SYNC_TAIL_HOLD_MS = 100;
/**
 * A held tail larger than this is written without waiting for its end, so it
 * can never keep the server's unacknowledged-bytes hold (256 KB) from lifting.
 */
const SYNC_TAIL_MAX_BYTES = 64 * 1024;

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
  /**
   * The terminal became visible: move everything parked onto the visible
   * drain, which writes the first part now and paces the rest. Returns `false`
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
  /** Visible output held back: an unfinished DEC 2026 frame, or a marker cut in two. */
  held: { data: Uint8Array; callbacks: OutputCallbacks | undefined }[];
  heldBytes: number;
  /** `held` starts with a frame's begin marker (not just a cut-off marker). */
  frameOpen: boolean;
  holdTimer: ReturnType<typeof setTimeout> | null;
}

/** Where DEC 2026 markers sit in a run of output bytes. */
interface SyncScan {
  /** The last complete marker, or null when there is none. */
  last: "begin" | "end" | null;
  /** Start of the last begin marker, when `last` is "begin". */
  beginAt: number;
  /** Start of a marker cut off by the end of the bytes; the length if none. */
  partialAt: number;
}

function scanSyncMarkers(bytes: Uint8Array): SyncScan {
  const scan: SyncScan = { last: null, beginAt: -1, partialAt: bytes.byteLength };
  for (let i = bytes.indexOf(0x1b); i !== -1; i = bytes.indexOf(0x1b, i + 1)) {
    const available = Math.min(SYNC_MARKER_BYTES, bytes.byteLength - i);
    let k = 1;
    while (k < available && k < SYNC_PREFIX.length && bytes[i + k] === SYNC_PREFIX[k]) k++;
    if (k < Math.min(available, SYNC_PREFIX.length)) continue;
    if (available < SYNC_MARKER_BYTES) {
      scan.partialAt = i;
      break;
    }
    const final = bytes[i + SYNC_PREFIX.length];
    if (final === SYNC_BEGIN_FINAL) {
      scan.last = "begin";
      scan.beginAt = i;
    } else if (final === SYNC_END_FINAL) {
      scan.last = "end";
    }
  }
  return scan;
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
  return queue.chunks.length > 0 && queue.inFlight < FOREGROUND_IN_FLIGHT_BYTES;
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
    // A full queue is re-added by its write callback.
    if (!canWriteForeground(queue)) continue;
    writeForeground(queue);
    writes++;
    if (canWriteForeground(queue)) foregroundPending.add(queue);
    if (performance.now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }
  scheduleForegroundDrain();
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
    held: [],
    heldBytes: 0,
    frameOpen: false,
    holdTimer: null,
  };

  const takeHeld = () => {
    if (state.holdTimer !== null) clearTimeout(state.holdTimer);
    state.holdTimer = null;
    const held = state.held;
    state.held = [];
    state.heldBytes = 0;
    state.frameOpen = false;
    return held;
  };

  const reset = () => {
    pending.delete(state);
    foregroundPending.delete(state);
    const dropped = [...state.chunks, ...takeHeld()];
    state.chunks = [];
    state.bytes = 0;
    for (const chunk of dropped) chunk.callbacks?.onConsumed?.();
  };

  const enqueue = (data: Chunk, callbacks: OutputCallbacks | undefined) => {
    state.chunks.push({ data, callbacks });
    state.bytes += chunkBytes(data);
  };

  /** Queue everything held, ahead of whatever is queued next. */
  const releaseHeld = () => {
    for (const piece of takeHeld()) enqueue(piece.data, piece.callbacks);
  };

  const writeWhileRoom = () => {
    // Room in xterm: write now, so a keystroke's echo isn't a task late.
    if (canWriteForeground(state)) writeForeground(state);
    if (canWriteForeground(state)) {
      foregroundPending.add(state);
      scheduleForegroundDrain();
    }
  };

  const hold = (data: Uint8Array, callbacks: OutputCallbacks | undefined) => {
    state.held.push({ data, callbacks });
    state.heldBytes += data.byteLength;
    state.holdTimer ??= setTimeout(() => {
      state.holdTimer = null;
      releaseHeld();
      writeWhileRoom();
    }, SYNC_TAIL_HOLD_MS);
  };

  /**
   * Queue visible output up to the last DEC 2026 end marker, and hold the
   * rest when it is an unfinished frame (or ends in a cut-off marker). The
   * chunk's callbacks go with its last byte, so it is acknowledged once all
   * of it has been parsed.
   */
  const enqueueVisible = (data: Uint8Array, callbacks: OutputCallbacks | undefined) => {
    if (data.byteLength === 0) {
      enqueue(data, callbacks);
      return;
    }
    // The last held bytes, in case a marker started there.
    const last = state.held[state.held.length - 1]?.data;
    const tail = last
      ? last.subarray(Math.max(0, last.byteLength - (SYNC_MARKER_BYTES - 1)))
      : null;
    let bytes = data;
    if (tail && tail.byteLength > 0) {
      bytes = new Uint8Array(tail.byteLength + data.byteLength);
      bytes.set(tail);
      bytes.set(data, tail.byteLength);
    }
    const offset = tail?.byteLength ?? 0;
    const scan = scanSyncMarkers(bytes);
    // Where in `data` the held part starts; `data.byteLength` holds nothing.
    let splitAt: number;
    if (scan.last === "begin") {
      splitAt = Math.max(0, scan.beginAt - offset);
      // Everything before a begin that started in this chunk is complete.
      if (scan.beginAt >= offset) releaseHeld();
      state.frameOpen = true;
    } else if (scan.last === "end" || !state.frameOpen) {
      releaseHeld();
      splitAt = Math.max(0, scan.partialAt - offset);
    } else {
      splitAt = 0;
    }
    if (splitAt > 0)
      enqueue(data.subarray(0, splitAt), splitAt === data.byteLength ? callbacks : undefined);
    if (splitAt < data.byteLength) {
      hold(data.subarray(splitAt), callbacks);
      if (state.heldBytes > SYNC_TAIL_MAX_BYTES) releaseHeld();
    }
  };

  return {
    push(data, foreground, callbacks) {
      if (foreground) {
        // Parked output queued before the terminal was shown goes first.
        if (pending.has(state)) this.flush();
        if (typeof data === "string") {
          releaseHeld();
          enqueue(data, callbacks);
        } else {
          enqueueVisible(data, callbacks);
        }
        writeWhileRoom();
        return;
      }
      // A parked terminal isn't painted: nothing to hold for.
      releaseHeld();
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
      releaseHeld();
      if (state.chunks.length === 0) {
        write(text);
        return;
      }
      enqueue(text, undefined);
    },
    flush() {
      if (state.overflowed) return false;
      // Nothing parked: visible output already queued keeps its pacing.
      if (!pending.delete(state)) return true;
      // Hand the parked backlog to the visible drain: the first 128 KB now, in
      // 16 KB writes, and the rest as xterm parses it. Writing all of it in
      // one loop (up to the 2 MB cap) stalled the reveal and every keystroke
      // echo behind it.
      while (canWriteForeground(state)) writeForeground(state);
      if (state.chunks.length > 0) {
        foregroundPending.add(state);
        scheduleForegroundDrain();
      }
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
