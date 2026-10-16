/**
 * Theme runtime. A change sets CSS variables and the `dark` class on <html>;
 * nothing re-renders the React tree. Terminals and editors listen for
 * `THEME_CHANGED_EVENT` and reconfigure in place.
 */

import { clientStorage } from "../client-state";
import {
  APPEARANCE_KEY,
  type Appearance,
  DEFAULT_APPEARANCE,
  MODE_KEY,
  parseAppearance,
  parseMode,
  type ResolvedMode,
  resolveVars,
  serializeAppearance,
  type ThemeMode,
  VARS_CACHE_KEY,
} from "./model";

export const THEME_CHANGED_EVENT = "band-theme-changed";

const applied = new Set<string>();
let seeded = false;

export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function loadMode(): ThemeMode {
  try {
    return parseMode(localStorage.getItem(MODE_KEY));
  } catch {
    return "dark";
  }
}

export function loadAppearance(): Appearance {
  try {
    return parseAppearance(clientStorage.getItem(APPEARANCE_KEY));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function setVars(vars: Record<string, string>): void {
  const style = document.documentElement.style;
  if (!seeded) {
    // The pre-paint script set variables from the cache; track them so a
    // variable the new theme doesn't set is removed instead of left behind.
    seeded = true;
    for (let i = 0; i < style.length; i++) {
      const name = style.item(i);
      if (name.startsWith("--")) applied.add(name);
    }
  }
  for (const name of applied) {
    if (!(name in vars)) style.removeProperty(name);
  }
  applied.clear();
  for (const [name, value] of Object.entries(vars)) {
    style.setProperty(name, value);
    applied.add(name);
  }
}

/** Applies the stored mode and appearance to <html> and refreshes the pre-paint cache. */
export function applyTheme(): void {
  const mode = loadMode();
  const appearance = loadAppearance();
  const resolved = resolveMode(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  setVars(resolveVars(appearance, resolved));
  try {
    localStorage.setItem(
      VARS_CACHE_KEY,
      JSON.stringify({
        light: resolveVars(appearance, "light"),
        dark: resolveVars(appearance, "dark"),
      }),
    );
  } catch {}
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { mode: resolved } }));
}

export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
  applyTheme();
}

let frame = 0;

/** At most one `applyTheme` per animation frame, so a color-picker drag doesn't redo it per tick. */
function scheduleApply(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    applyTheme();
  });
}

export function setAppearance(appearance: Appearance): void {
  const next = serializeAppearance(appearance);
  if (clientStorage.getItem(APPEARANCE_KEY) === next) return;
  clientStorage.setItem(APPEARANCE_KEY, next);
  scheduleApply();
}

export function resetAppearance(): void {
  setAppearance(DEFAULT_APPEARANCE);
}

/**
 * Keeps the page in step with the OS (mode System), other tabs and windows
 * (the storage event), and the server's copy arriving after hydration.
 * Returns the cleanup.
 */
export function startThemeRuntime(): () => void {
  applyTheme();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    if (loadMode() === "system") applyTheme();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === MODE_KEY || e.key === APPEARANCE_KEY) applyTheme();
  };
  mq.addEventListener("change", onScheme);
  window.addEventListener("storage", onStorage);
  return () => {
    mq.removeEventListener("change", onScheme);
    window.removeEventListener("storage", onStorage);
  };
}

/** The computed value of a CSS variable on <html>, trimmed. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS color (any format the browser parses, alpha included) as `#rrggbb`,
 * blended over `over` when given. For APIs that only take hex, like xterm's
 * search decorations. Returns `fallback` when the browser can't parse it.
 */
export function cssColorToHex(color: string, over?: string, fallback = "#808080"): string {
  if (probe === undefined) {
    probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (!probe || !color) return fallback;
  probe.clearRect(0, 0, 1, 1);
  if (over) {
    probe.fillStyle = over;
    probe.fillRect(0, 0, 1, 1);
  }
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
