/**
 * Desktop wheel scrolling over a program with wheel mouse tracking on (Claude
 * Code turns it on), ported from Orca (`pane-terminal-mouse-wheel.ts`,
 * `pane-terminal-tui-wheel-reports.ts`).
 *
 * xterm turns wheel events into reports itself, but it scales trackpad pixel
 * deltas by 0.3 before counting rows, so a two-finger swipe moves a TUI about
 * a third as far as the fingers moved. This handler replaces that conversion
 * whenever the program asked for wheel reports:
 *
 *  - trackpad (pixel deltas): one report per terminal row of travel, with the
 *    fractional remainder carried into the next event;
 *  - discrete mouse wheel (line/page deltas or a whole notch in pixels): the
 *    distance is compressed, then boosted while notches arrive 16-45 ms apart,
 *    up to 9 rows per event;
 *  - Shift held: left to xterm.
 *
 * Reports go through `term.input`, so they reach the socket through `onData`
 * like any other input, built by terminal-mouse-report.ts from the pointer's
 * real position. Without wheel mouse tracking the handler steps aside: xterm
 * sends arrow keys on the alternate screen and scrolls the scrollback
 * otherwise.
 */
import type { Terminal } from "@xterm/xterm";
import {
  arrowSequence,
  hasWheelMouseTracking,
  MOUSE_REPORT_ALT,
  MOUSE_REPORT_CTRL,
  type MouseEncodingTracker,
  screenPoint,
  wheelSequence,
} from "./terminal-mouse-report";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** A pixel delta this large is one notch of a mouse wheel, not a trackpad. */
const DISCRETE_PIXEL_WHEEL_DELTA_MIN = 50;
/** Legacy `wheelDelta` of a mouse wheel notch is ±120; trackpads send less. */
const LEGACY_MOUSE_WHEEL_DELTA_MIN = 100;
const LEGACY_MOUSE_WHEEL_DELTA_UNIT = 120;
const DEFAULT_CELL_HEIGHT = 16;
const ACCELERATED_DISTANCE_GAIN = 1.6;
const COMPRESSED_MAX_ROWS_PER_EVENT = 6;
/** Notches closer together than this get the full burst bonus... */
const BURST_FULL_INTERVAL_MS = 16;
/** ...and notches further apart than this get none. */
const BURST_MAX_INTERVAL_MS = 45;
const BURST_MAX_BONUS_ROWS = 3;
/** Consecutive fast notches before the bonus reaches its maximum. */
const BURST_RAMP_EVENTS = 4;
/** A notch this much shorter than the previous one is a momentum tail. */
const MOMENTUM_TAIL_DECAY_RATIO = 0.85;
const BURST_MAX_ROWS_PER_EVENT = 9;

type WheelInput = Pick<WheelEvent, "deltaY" | "deltaMode" | "timeStamp"> & {
  wheelDelta?: number;
  wheelDeltaY?: number;
};

interface WheelDistanceState {
  fastStreak: number;
  lastDistanceRows: number | null;
  lastInputAt: number | null;
  direction: -1 | 0 | 1;
  /** Fraction of a row carried into the next event. */
  pendingRows: number;
}

function legacyVerticalDelta(event: WheelInput): number | null {
  if (typeof event.wheelDeltaY === "number" && Number.isFinite(event.wheelDeltaY)) {
    return event.wheelDeltaY;
  }
  if (typeof event.wheelDelta === "number" && Number.isFinite(event.wheelDelta)) {
    return event.wheelDelta;
  }
  return null;
}

function hasDiscreteLegacyDelta(event: WheelInput): boolean {
  const legacy = legacyVerticalDelta(event);
  return legacy !== null && Math.abs(legacy) >= LEGACY_MOUSE_WHEEL_DELTA_MIN;
}

function isDiscreteWheel(event: WheelInput): boolean {
  return (
    event.deltaMode !== DOM_DELTA_PIXEL ||
    Math.abs(event.deltaY) >= DISCRETE_PIXEL_WHEEL_DELTA_MIN ||
    hasDiscreteLegacyDelta(event)
  );
}

/** Rows the event travels, before any compression or boost. */
function distanceRows(event: WheelInput, cellHeight: number, rows: number): number {
  const deltaY = Math.abs(event.deltaY);
  const fromDelta =
    event.deltaMode === DOM_DELTA_LINE
      ? deltaY
      : event.deltaMode === DOM_DELTA_PAGE
        ? deltaY * Math.max(1, rows)
        : deltaY / cellHeight;
  const legacy = legacyVerticalDelta(event);
  const fromLegacy = legacy === null ? 0 : Math.abs(legacy) / LEGACY_MOUSE_WHEEL_DELTA_UNIT;
  const distance = Math.max(fromDelta, fromLegacy);
  return isDiscreteWheel(event) ? Math.max(1, distance) : distance;
}

function compressRows(rows: number): number {
  if (rows <= 1) return rows;
  return Math.min(COMPRESSED_MAX_ROWS_PER_EVENT, 1 + Math.log2(rows) * ACCELERATED_DISTANCE_GAIN);
}

function resetBurst(state: WheelDistanceState): void {
  state.fastStreak = 0;
  state.lastDistanceRows = null;
  state.lastInputAt = null;
}

/** Extra rows for a notch that follows the previous one quickly. */
function burstBonusRows(event: WheelInput, state: WheelDistanceState, rows: number): number {
  const notch = event.deltaMode !== DOM_DELTA_PIXEL || hasDiscreteLegacyDelta(event);
  if (!notch || !Number.isFinite(event.timeStamp)) {
    resetBurst(state);
    return 0;
  }
  const elapsed = state.lastInputAt === null ? null : event.timeStamp - state.lastInputAt;
  const momentumTail =
    state.lastDistanceRows !== null && rows < state.lastDistanceRows * MOMENTUM_TAIL_DECAY_RATIO;
  state.lastDistanceRows = rows;
  state.lastInputAt = event.timeStamp;
  if (momentumTail || elapsed === null || elapsed < 0 || elapsed > BURST_MAX_INTERVAL_MS) {
    state.fastStreak = 0;
    return 0;
  }
  const cadence =
    elapsed <= BURST_FULL_INTERVAL_MS
      ? 1
      : (BURST_MAX_INTERVAL_MS - elapsed) / (BURST_MAX_INTERVAL_MS - BURST_FULL_INTERVAL_MS);
  state.fastStreak = Math.min(BURST_RAMP_EVENTS, state.fastStreak + 1);
  return BURST_MAX_BONUS_ROWS * cadence * (state.fastStreak / BURST_RAMP_EVENTS);
}

/** Whole reports to send for `event`; the fraction left over carries on. */
function wheelReportCount(
  event: WheelInput,
  state: WheelDistanceState,
  cellHeight: number,
  rows: number,
): number {
  const direction = event.deltaY < 0 ? -1 : 1;
  if (state.direction !== direction) {
    resetBurst(state);
    state.pendingRows = 0;
  }
  state.direction = direction;

  const distance = distanceRows(event, cellHeight, rows);
  // Trackpads map 1:1: one report per row of travel, uncapped, so inertial
  // scrolling moves the program as far as the page would have moved.
  const travelled =
    event.deltaMode === DOM_DELTA_PIXEL && !hasDiscreteLegacyDelta(event)
      ? distance
      : Math.min(
          BURST_MAX_ROWS_PER_EVENT,
          compressRows(distance) + burstBonusRows(event, state, distance),
        );
  const total = state.pendingRows + travelled;
  const reports = Math.trunc(total);
  state.pendingRows = total - reports;
  return reports;
}

export function attachTerminalMouseWheel(
  wrapper: HTMLElement,
  term: Terminal,
  mouseEncoding: MouseEncodingTracker,
): void {
  // Created once by `term.open()`, like in terminal-touch-scroll.ts.
  const screenEl = wrapper.querySelector(".xterm-screen") as HTMLElement | null;
  const state: WheelDistanceState = {
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    direction: 0,
    pendingRows: 0,
  };

  // xterm calls this for every wheel event on the terminal. Returning false
  // stops xterm's own handling; while wheel tracking is on, xterm then still
  // cancels the event, so the page doesn't scroll either.
  term.attachCustomWheelEventHandler((event) => {
    if (!hasWheelMouseTracking(term) || event.shiftKey) return true;
    if (event.deltaY === 0 || !Number.isFinite(event.deltaY)) return true;
    const rect = screenEl?.getBoundingClientRect();
    const cellHeight =
      rect && rect.height > 0 && term.rows > 0 ? rect.height / term.rows : DEFAULT_CELL_HEIGHT;
    const reports = wheelReportCount(event, state, cellHeight, term.rows);
    if (reports === 0) return false;
    const lines = event.deltaY < 0 ? -reports : reports;
    const point = rect ? screenPoint(term, screenEl, event.clientX, event.clientY, rect) : null;
    const modifiers =
      (event.altKey ? MOUSE_REPORT_ALT : 0) | (event.ctrlKey ? MOUSE_REPORT_CTRL : 0);
    const report = point ? wheelSequence(lines, point, mouseEncoding.current(), modifiers) : "";
    term.input((report || arrowSequence(term, lines)).repeat(reports), true);
    return false;
  });
}
