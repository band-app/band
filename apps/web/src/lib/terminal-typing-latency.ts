import type { Terminal } from "@xterm/xterm";

// ---------------------------------------------------------------------------
// Opt-in typing-latency probe (ported in spirit from orca's
// `typing-latency/diagnostic.ts`). From the devtools console:
//
//   __bandTypingLatency.start()   // then type normally for ~20 s
//   __bandTypingLatency.report()  // returns (and logs) percentiles
//   __bandTypingLatency.stop()
//
// Each printable keystroke in a terminal is followed through four stamps:
//   input    the keydown event's own timestamp (when the OS delivered it)
//   dispatch xterm's `onData` handed it to the WebSocket
//   arrival  the terminal's next output frame came off its WebSocket
//   parsed   xterm finished parsing that frame
//   paint    xterm's next render after the parse
// A keystroke is matched with the first output frame that arrives after it
// was dispatched. `start({ matchEcho: true })` instead matches it with the
// first frame after dispatch that contains the typed character, for measuring
// a terminal whose own output never stops (its flood must not contain the
// typed characters). Nothing on the keystroke or output path does any work until
// `start()`; the hooks below check `active` first.
// ---------------------------------------------------------------------------

/** Keystrokes with no echo after this long are dropped as unmatched. */
const PENDING_TIMEOUT_MS = 2_000;
/** Most recent samples kept. */
const MAX_SAMPLES = 5_000;

interface Keystroke {
  /** The typed character's UTF-8 byte (printable ASCII); 0 for anything else. */
  byte: number;
  inputAt: number;
  dispatchAt: number | null;
  arrivalAt: number | null;
  parsedAt: number | null;
}

interface Sample {
  inputToDispatch: number;
  dispatchToArrival: number;
  arrivalToParsed: number;
  parsedToPaint: number;
  inputToPaint: number;
}

interface LatencyPercentiles {
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface TypingLatencyReport {
  running: boolean;
  samples: number;
  unmatched: number;
  inputToDispatchMs: LatencyPercentiles;
  dispatchToArrivalMs: LatencyPercentiles;
  arrivalToParsedMs: LatencyPercentiles;
  parsedToPaintMs: LatencyPercentiles;
  inputToPaintMs: LatencyPercentiles;
}

let active = false;
let matchEcho = false;
let samples: Sample[] = [];
let unmatched = 0;
/** terminalId -> keystrokes not yet painted, oldest first. */
const pendingByTerminal = new Map<string, Keystroke[]>();

function pendingFor(terminalId: string): Keystroke[] {
  let pending = pendingByTerminal.get(terminalId);
  if (!pending) {
    pending = [];
    pendingByTerminal.set(terminalId, pending);
  }
  return pending;
}

function dropStale(pending: Keystroke[], now: number): void {
  while (pending.length > 0 && now - pending[0].inputAt > PENDING_TIMEOUT_MS) {
    pending.shift();
    unmatched++;
  }
}

/**
 * Wire the probe to one terminal: a capture-phase keydown listener on its
 * wrapper (for the input stamp) and a render listener (for the paint stamp).
 * Returns a disposer.
 */
export function registerTypingLatencyTerminal(
  terminalId: string,
  term: Terminal,
  wrapper: HTMLElement,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!active) return;
    // Printable characters only: they are the keystrokes a shell echoes.
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const pending = pendingFor(terminalId);
    dropStale(pending, performance.now());
    const code = event.key.charCodeAt(0);
    pending.push({
      byte: code < 0x80 ? code : 0,
      inputAt: event.timeStamp,
      dispatchAt: null,
      arrivalAt: null,
      parsedAt: null,
    });
  };
  wrapper.addEventListener("keydown", onKeyDown, true);
  const render = term.onRender(() => {
    if (!active) return;
    const pending = pendingByTerminal.get(terminalId);
    if (!pending || !pending.some((k) => k.parsedAt !== null)) return;
    const paintAt = performance.now();
    // Every parsed keystroke was painted by this render. One echo frame can
    // carry several, and with `matchEcho` a later key's echo can overtake an
    // earlier one's.
    for (const done of pending) {
      if (done.dispatchAt === null || done.arrivalAt === null || done.parsedAt === null) continue;
      samples.push({
        inputToDispatch: done.dispatchAt - done.inputAt,
        dispatchToArrival: done.arrivalAt - done.dispatchAt,
        arrivalToParsed: done.parsedAt - done.arrivalAt,
        parsedToPaint: paintAt - done.parsedAt,
        inputToPaint: paintAt - done.inputAt,
      });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }
    pendingByTerminal.set(
      terminalId,
      pending.filter((k) => k.parsedAt === null),
    );
  });
  return () => {
    wrapper.removeEventListener("keydown", onKeyDown, true);
    render.dispose();
    pendingByTerminal.delete(terminalId);
  };
}

/** Called from the terminal's `onData` (keystroke handed to the socket). */
export function noteTypingLatencyDispatch(terminalId: string): void {
  if (!active) return;
  const next = pendingByTerminal.get(terminalId)?.find((k) => k.dispatchAt === null);
  if (next) next.dispatchAt = performance.now();
}

/**
 * The keystrokes whose echo is in `data`: for each typed character in it, the
 * newest waiting keystroke of that character. Older waiting keystrokes of the
 * same character are dropped as unmatched. Their echo never came (a tty
 * drops echo while its output queue is full), and pairing them with this
 * frame would record one trip round the typed alphabet as latency.
 */
function matchEchoes(
  terminalId: string,
  pending: Keystroke[],
  waiting: Keystroke[],
  data: Uint8Array,
): Keystroke[] {
  const newestByByte = new Map<number, Keystroke>();
  for (const keystroke of waiting) {
    if (keystroke.byte !== 0 && data.includes(keystroke.byte)) {
      newestByByte.set(keystroke.byte, keystroke);
    }
  }
  const matched = new Set(newestByByte.values());
  const lost = waiting.filter((k) => newestByByte.has(k.byte) && !matched.has(k));
  if (lost.length > 0) {
    unmatched += lost.length;
    pendingByTerminal.set(
      terminalId,
      pending.filter((k) => !lost.includes(k)),
    );
  }
  return [...matched];
}

/**
 * Called when an output frame for the terminal comes off its socket. Returns
 * a callback to pass to `term.write` when that frame is the echo of a pending
 * keystroke, `undefined` otherwise.
 */
export function noteTypingLatencyOutput(
  terminalId: string,
  data: Uint8Array,
): (() => void) | undefined {
  if (!active) return undefined;
  const pending = pendingByTerminal.get(terminalId) ?? [];
  const waiting = pending.filter((k) => k.dispatchAt !== null && k.arrivalAt === null);
  const matched = matchEcho ? matchEchoes(terminalId, pending, waiting, data) : waiting.slice(0, 1);
  if (matched.length === 0) return undefined;
  const arrivalAt = performance.now();
  for (const keystroke of matched) keystroke.arrivalAt = arrivalAt;
  return () => {
    const parsedAt = performance.now();
    for (const keystroke of matched) keystroke.parsedAt = parsedAt;
  };
}

function percentiles(values: number[]): LatencyPercentiles {
  if (values.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) };
}

function typingLatencyReport(): TypingLatencyReport {
  const pick = (key: keyof Sample) => percentiles(samples.map((s) => s[key]));
  return {
    running: active,
    samples: samples.length,
    unmatched,
    inputToDispatchMs: pick("inputToDispatch"),
    dispatchToArrivalMs: pick("dispatchToArrival"),
    arrivalToParsedMs: pick("arrivalToParsed"),
    parsedToPaintMs: pick("parsedToPaint"),
    inputToPaintMs: pick("inputToPaint"),
  };
}

const api = {
  start(options?: { matchEcho?: boolean }): void {
    matchEcho = options?.matchEcho === true;
    samples = [];
    unmatched = 0;
    pendingByTerminal.clear();
    active = true;
  },
  stop(): TypingLatencyReport {
    active = false;
    pendingByTerminal.clear();
    return typingLatencyReport();
  },
  report(): TypingLatencyReport {
    const report = typingLatencyReport();
    console.table({
      inputToDispatch: report.inputToDispatchMs,
      dispatchToArrival: report.dispatchToArrivalMs,
      arrivalToParsed: report.arrivalToParsedMs,
      parsedToPaint: report.parsedToPaintMs,
      inputToPaint: report.inputToPaintMs,
    });
    return report;
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { __bandTypingLatency?: typeof api }).__bandTypingLatency = api;
}
