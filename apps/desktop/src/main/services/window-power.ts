import type { Vibrancy } from "./mod-window.js";

/** The parts of a `BrowserWindow` the power handling touches, so tests can pass a plain object. */
export interface WindowPowerTarget {
  setVibrancy(type: Vibrancy | null): void;
  isDestroyed(): boolean;
}

/** The vibrancy a window gets on AC power. A mod's `window.material` sets it; the default is `sidebar`. */
const acVibrancy = new WeakMap<object, Vibrancy | null>();

export function setWindowVibrancy(win: object, vibrancy: Vibrancy | null): void {
  acVibrancy.set(win, vibrancy);
}

/**
 * On battery the macOS vibrancy layer goes: WindowServer re-blends the blurred desktop behind the
 * page on every frame, which is a large share of an idle Band's cost. The renderer paints the
 * sidebar solid at the same time (`data-on-battery`). Plugged in, the window's vibrancy returns
 * (`sidebar` unless a mod chose another material). Electron cannot change `visualEffectState`
 * after creation, so the layer is removed, not frozen.
 */
export function applyPowerToWindow(
  win: WindowPowerTarget,
  onBattery: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin" || win.isDestroyed()) return;
  const ac = acVibrancy.has(win) ? (acVibrancy.get(win) ?? null) : "sidebar";
  win.setVibrancy(onBattery ? null : ac);
}
