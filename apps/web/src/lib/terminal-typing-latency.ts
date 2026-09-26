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
// was dispatched. Nothing on the keystroke or output path does any work until
// `start()`; the hooks below check `active` first.
// ---------------------------------------------------------------------------

/** Keystrokes with no echo after this long are dropped as unmatched. */
const PENDING_TIMEOUT_MS = 2_000;
/** Most recent samples kept. */
const MAX_SAMPLES = 5_000;

interface Keystroke {
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
    pending.push({ inputAt: event.timeStamp, dispatchAt: null, arrivalAt: null, parsedAt: null });
  };
  wrapper.addEventListener("keydown", onKeyDown, true);
  const render = term.onRender(() => {
    if (!active) return;
    const pending = pendingByTerminal.get(terminalId);
    if (!pending || pending.length === 0 || pending[0].parsedAt === null) return;
    const done = pending.shift() as Keystroke & {
      dispatchAt: number;
      arrivalAt: number;
      parsedAt: number;
    };
    const paintAt = performance.now();
    samples.push({
      inputToDispatch: done.dispatchAt - done.inputAt,
      dispatchToArrival: done.arrivalAt - done.dispatchAt,
      arrivalToParsed: done.parsedAt - done.arrivalAt,
      parsedToPaint: paintAt - done.parsedAt,
      inputToPaint: paintAt - done.inputAt,
    });
    if (samples.length > MAX_SAMPLES) samples.shift();
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
 * Called when an output frame for the terminal comes off its socket. Returns
 * a callback to pass to `term.write` when that frame is the echo of a pending
 * keystroke, `undefined` otherwise.
 */
export function noteTypingLatencyOutput(terminalId: string): (() => void) | undefined {
  if (!active) return undefined;
  const keystroke = pendingByTerminal
    .get(terminalId)
    ?.find((k) => k.dispatchAt !== null && k.arrivalAt === null);
  if (!keystroke) return undefined;
  keystroke.arrivalAt = performance.now();
  return () => {
    keystroke.parsedAt = performance.now();
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
  start(): void {
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
