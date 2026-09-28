/**
 * The main window's size, position and maximized / full-screen state, kept
 * in `~/.band/desktop-window.json` so a relaunch (quit, auto-update restart)
 * opens the window where it was.
 *
 * Pure file and geometry helpers: `window.ts` reads the state before it
 * creates the window and saves it as the window moves. Saved bounds are only
 * used when they still overlap a connected display, so a window last shown
 * on a monitor that is now unplugged opens on the primary display instead.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** The window's bounds when neither maximized nor full screen. */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

/** How much of the window must stay on a display for the saved bounds to count. */
const MIN_VISIBLE_PX = 100;

function stateFile(): string {
  return join(bandHome(), "desktop-window.json");
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (r.width as number) > 0 &&
    (r.height as number) > 0
  );
}

/** The saved state, or null when there is none or the file is unreadable. */
export function loadWindowState(): WindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    if (!isRect(parsed.bounds)) return null;
    return {
      bounds: parsed.bounds,
      maximized: parsed.maximized === true,
      fullScreen: parsed.fullScreen === true,
    };
  } catch {
    return null;
  }
}

/** Write the state through a temp file, so a crash mid-write keeps the old one. */
export function saveWindowState(state: WindowState): void {
  const file = stateFile();
  mkdirSync(bandHome(), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * The saved bounds if at least `MIN_VISIBLE_PX` of them, in both directions,
 * is on one of `workAreas`, shrunk to fit that display. Null otherwise.
 */
export function fitToDisplays(bounds: Rect, workAreas: readonly Rect[]): Rect | null {
  for (const area of workAreas) {
    const o = overlap(bounds, area);
    if (o.width < MIN_VISIBLE_PX || o.height < MIN_VISIBLE_PX) continue;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return {
      width,
      height,
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    };
  }
  return null;
}
