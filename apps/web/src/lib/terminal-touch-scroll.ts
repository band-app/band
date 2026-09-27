/**
 * Finger scrolling for a terminal, ported from Orca's mobile terminal
 * (`surface-touch-gestures.ts`, `mouse-report-and-scroll-routing.ts`).
 *
 * xterm 6.1 ships VS Code's gesture helper (`browser/scrollable/touch.ts`),
 * which listens for touches on `document` and, after the finger lifts, keeps
 * dispatching inertia CHANGE events that carry only a translation, no
 * `clientX` / `clientY`. When the running program has wheel mouse tracking on
 * (Claude Code does), xterm turns each one into a wheel report whose
 * coordinates are `undefined - rect.left`, so the program receives text like
 * `NaN;NaNM` as keyboard input.
 *
 * This layer owns every single-finger move on the terminal instead: capture
 * phase listeners on the wrapper call `stopPropagation` on `touchmove`, so
 * xterm's gesture helper never sees a move (no inertia, no NaN), and run their
 * own momentum that keeps reporting the last real finger position. Each
 * scroll step goes through `routeScrollLines`, which picks what xterm would:
 *
 *  - wheel mouse tracking on: wheel reports built from real coordinates, in
 *    the encoding the program asked for; a coordinate that fails validation
 *    sends arrow keys, never a malformed report;
 *  - alternate screen (no scrollback): arrow keys, honouring application
 *    cursor keys mode;
 *  - otherwise: `term.scrollLines` through the scrollback.
 *
 * Report encoding and coordinate validation live in terminal-mouse-report.ts,
 * shared with desktop wheel scrolling.
 */
import type { Terminal } from "@xterm/xterm";
import {
  arrowSequence,
  hasWheelMouseTracking,
  isAlternateBuffer,
  type MouseEncodingTracker,
  screenPoint,
  wheelSequence,
} from "./terminal-mouse-report";

/** Upper bound on reports sent for one frame of scrolling, as in Orca. */
const MAX_LINES_PER_STEP = 32;
/** Momentum decay per animation frame and the speed (px/ms) where it stops. */
const MOMENTUM_FRICTION = 0.972;
const MOMENTUM_MIN_VELOCITY = 0.012;
const FRAME_MS = 16;
/** Fastest fling momentum starts from (px/ms). Without a cap a hard flick
 *  glides for seconds, sending ~1,000 wheel reports a second to the program. */
const MOMENTUM_MAX_VELOCITY = 5;
/** Moves closer together than this give a noisy speed and are left out of it. */
const MIN_VELOCITY_SAMPLE_MS = 4;
/** A finger that rests this long before lifting launches no momentum. */
const MOMENTUM_STALE_MS = 100;

export interface TerminalTouchScroll {
  dispose(): void;
}

export function attachTerminalTouchScroll(
  wrapper: HTMLElement,
  term: Terminal,
  mouseEncoding: MouseEncodingTracker,
): TerminalTouchScroll {
  // `.xterm-screen` is created once by `term.open()`; renderer switches only
  // rebuild the canvas inside it, so it's cached rather than looked up on
  // every ~60 Hz step.
  const screenEl = wrapper.querySelector(".xterm-screen") as HTMLElement | null;

  const cellHeight = (rect: DOMRect): number =>
    rect.height > 0 && term.rows > 0 ? rect.height / term.rows : 0;

  const sendRepeated = (sequence: string, lines: number) => {
    const count = Math.min(Math.abs(lines), MAX_LINES_PER_STEP);
    term.input(sequence.repeat(count), true);
  };

  /** Scroll `lines` rows (positive = toward the bottom) as xterm would for a
   *  wheel at (`clientX`, `clientY`). Returns false when nothing could move,
   *  so momentum stops at the end of the scrollback. */
  const routeScrollLines = (
    lines: number,
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): boolean => {
    if (lines === 0) return true;
    if (hasWheelMouseTracking(term)) {
      const point = screenPoint(term, screenEl, clientX, clientY, rect);
      const report = point ? wheelSequence(lines, point, mouseEncoding.current()) : "";
      sendRepeated(report || arrowSequence(term, lines), lines);
      return true;
    }
    if (isAlternateBuffer(term)) {
      sendRepeated(arrowSequence(term, lines), lines);
      return true;
    }
    const buffer = term.buffer.active;
    const before = buffer.viewportY;
    term.scrollLines(lines);
    return buffer.viewportY !== before;
  };

  // --- gesture state ---
  let lastX = 0;
  let lastY = 0;
  let lastTime = 0;
  /** Where the current velocity sample started. */
  let sampleY = 0;
  let sampleTime = 0;
  let velocityY = 0;
  let accumulated = 0;
  let tracking = false;
  let momentumId: number | null = null;

  const stopMomentum = () => {
    if (momentumId !== null) {
      cancelAnimationFrame(momentumId);
      momentumId = null;
    }
  };

  /** Add `deltaY` px of finger travel (positive = finger moved up) and scroll
   *  the whole lines it adds up to. */
  const applyDelta = (deltaY: number): boolean => {
    if (!screenEl) return false;
    const rect = screenEl.getBoundingClientRect();
    const cellH = cellHeight(rect);
    if (cellH <= 0) return false;
    accumulated += deltaY;
    const lines = Math.trunc(accumulated / cellH);
    if (lines === 0) return true;
    accumulated -= lines * cellH;
    return routeScrollLines(lines, lastX, lastY, rect);
  };

  const onTouchStart = (e: TouchEvent) => {
    stopMomentum();
    tracking = e.touches.length === 1;
    if (!tracking) return;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    lastTime = e.timeStamp;
    sampleY = lastY;
    sampleTime = lastTime;
    velocityY = 0;
    accumulated = 0;
  };

  const onTouchMove = (e: TouchEvent) => {
    // Every move on the terminal stops here so xterm's gesture helper can't
    // start its own scroll or inertia. Two fingers keep the browser's pinch.
    e.stopPropagation();
    if (e.touches.length !== 1 || !tracking) return;
    e.preventDefault();
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const deltaY = lastY - y;
    const dt = e.timeStamp - sampleTime;
    if (dt >= MIN_VELOCITY_SAMPLE_MS) {
      const instant = (sampleY - y) / dt;
      // touchmove cadence is uneven; blend samples so one spiky frame
      // doesn't decide the momentum.
      if (Number.isFinite(instant)) {
        const blended = velocityY === 0 ? instant : velocityY * 0.55 + instant * 0.45;
        velocityY = Math.min(Math.max(blended, -MOMENTUM_MAX_VELOCITY), MOMENTUM_MAX_VELOCITY);
      }
      sampleY = y;
      sampleTime = e.timeStamp;
    }
    lastX = x;
    lastY = y;
    lastTime = e.timeStamp;
    // At the end of the scrollback there is nothing for momentum to continue.
    if (!applyDelta(deltaY)) velocityY = 0;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!tracking || e.touches.length > 0) return;
    tracking = false;
    let velocity = e.timeStamp - lastTime > MOMENTUM_STALE_MS ? 0 : velocityY;
    if (Math.abs(velocity) <= MOMENTUM_MIN_VELOCITY) return;
    let prevFrame: number | null = null;
    // Friction and travel scale with the real frame time, so a fling lasts
    // as long on a 120 Hz screen as on a 60 Hz one.
    const step = (now: number) => {
      const dt = prevFrame === null ? FRAME_MS : Math.min(now - prevFrame, 4 * FRAME_MS);
      prevFrame = now;
      velocity *= MOMENTUM_FRICTION ** (dt / FRAME_MS);
      if (Math.abs(velocity) < MOMENTUM_MIN_VELOCITY || !applyDelta(velocity * dt)) {
        momentumId = null;
        return;
      }
      momentumId = requestAnimationFrame(step);
    };
    momentumId = requestAnimationFrame(step);
  };

  const onTouchCancel = () => {
    tracking = false;
  };

  wrapper.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  wrapper.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  wrapper.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  wrapper.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });

  return {
    dispose() {
      stopMomentum();
      wrapper.removeEventListener("touchstart", onTouchStart, { capture: true });
      wrapper.removeEventListener("touchmove", onTouchMove, { capture: true });
      wrapper.removeEventListener("touchend", onTouchEnd, { capture: true });
      wrapper.removeEventListener("touchcancel", onTouchCancel, { capture: true });
    },
  };
}
