/**
 * Wheel reports for programs that turn on mouse tracking, shared by finger
 * scrolling (`terminal-touch-scroll.ts`) and desktop wheel scrolling
 * (`terminal-mouse-wheel.ts`). Both build the reports themselves instead of
 * leaving it to xterm, so every report carries a validated coordinate in the
 * encoding the program asked for, and a coordinate that fails validation
 * becomes an arrow key rather than a malformed report.
 *
 * xterm doesn't expose the mouse report encoding (DECSET 1006 / 1016), so
 * `trackMouseEncoding` watches for it with parser hooks that don't consume
 * the sequence.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";

const ESC = "\x1b";

export type MouseEncoding = "default" | "sgr" | "sgr-pixels";

/** Modifier bits a wheel report can carry. Shift never reaches a report:
 *  xterm drops shift+wheel, and so does Band's wheel handler. */
export const MOUSE_REPORT_ALT = 8;
export const MOUSE_REPORT_CTRL = 16;

export interface ScreenPoint {
  /** 0-based viewport cell. */
  col: number;
  row: number;
  /** 0-based CSS pixel inside the screen, for SGR pixel mode (1016). */
  x: number;
  y: number;
}

export interface MouseEncodingTracker {
  current(): MouseEncoding;
  /** Forget the tracked encoding. Call after `term.reset()`, which resets
   *  xterm's own encoding without going through the parser. */
  reset(): void;
  dispose(): void;
}

export function trackMouseEncoding(term: Terminal): MouseEncodingTracker {
  let encoding: MouseEncoding = "default";
  const onDecMode = (enabled: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      if (param === 1006) encoding = enabled ? "sgr" : "default";
      else if (param === 1016) encoding = enabled ? "sgr-pixels" : "default";
    }
    // Let xterm handle the sequence as usual.
    return false;
  };
  const parserHooks: IDisposable[] = [
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, onDecMode(true)),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, onDecMode(false)),
    // RIS (ESC c) resets the encoding along with everything else.
    term.parser.registerEscHandler({ final: "c" }, () => {
      encoding = "default";
      return false;
    }),
  ];
  return {
    current: () => encoding,
    reset() {
      encoding = "default";
    },
    dispose() {
      for (const hook of parserHooks) hook.dispose();
    },
  };
}

function isSafeSgrMouseCoordinate(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 9999;
}

/** Whether the program asked for wheel reports (X10 mode reports no wheel). */
export function hasWheelMouseTracking(term: Terminal): boolean {
  const mode = term.modes.mouseTrackingMode;
  return mode === "vt200" || mode === "drag" || mode === "any";
}

export function isAlternateBuffer(term: Terminal): boolean {
  return term.buffer.active.type === "alternate";
}

export function arrowSequence(term: Terminal, lines: number): string {
  const prefix = term.modes.applicationCursorKeysMode ? "O" : "[";
  return ESC + prefix + (lines < 0 ? "A" : "B");
}

/** One wheel report for `point`, or "" when the encoding can't carry it. */
export function wheelSequence(
  lines: number,
  point: ScreenPoint,
  encoding: MouseEncoding,
  modifiers = 0,
): string {
  const code = (lines < 0 ? 64 : 65) + modifiers;
  if (encoding === "sgr-pixels") {
    if (!isSafeSgrMouseCoordinate(point.x) || !isSafeSgrMouseCoordinate(point.y)) return "";
    return `${ESC}[<${code};${point.x};${point.y}M`;
  }
  // Reports are 1-based; the point is 0-based.
  const col = point.col + 1;
  const row = point.row + 1;
  if (encoding === "sgr") {
    if (!isSafeSgrMouseCoordinate(col) || !isSafeSgrMouseCoordinate(row)) return "";
    return `${ESC}[<${code};${col};${row}M`;
  }
  // X10 bytes past ASCII turn into multi-byte UTF-8 on the socket, so a wide
  // terminal falls back to arrow keys instead.
  const bytes = [code + 32, col + 32, row + 32];
  if (bytes.some((b) => !Number.isInteger(b) || b > 126)) return "";
  return `${ESC}[M${String.fromCharCode(...bytes)}`;
}

/** The cell under (`clientX`, `clientY`), clamped to the grid, or null when
 *  the screen has no size yet or the position isn't a finite number. `rect`
 *  is `screenEl`'s bounding rect, read once by the caller. */
export function screenPoint(
  term: Terminal,
  screenEl: HTMLElement | null,
  clientX: number,
  clientY: number,
  rect: DOMRect,
): ScreenPoint | null {
  if (!screenEl || term.cols <= 0 || term.rows <= 0) return null;
  if (!(rect.width > 0 && rect.height > 0)) return null;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const fx = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1 - 1e-9);
  const fy = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1 - 1e-9);
  return {
    col: Math.floor(fx * term.cols),
    row: Math.floor(fy * term.rows),
    // offsetWidth is the unzoomed layout size, which is what xterm reports
    // in pixel mode.
    x: Math.floor(fx * screenEl.offsetWidth),
    y: Math.floor(fy * screenEl.offsetHeight),
  };
}
