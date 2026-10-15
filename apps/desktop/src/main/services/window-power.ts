/** The parts of a `BrowserWindow` the power handling touches, so tests can pass a plain object. */
export interface WindowPowerTarget {
  setVibrancy(type: "sidebar" | null): void;
  isDestroyed(): boolean;
}

/**
 * On battery the macOS vibrancy layer goes: WindowServer re-blends the blurred desktop behind the
 * page on every frame, which is a large share of an idle Band's cost. The renderer paints the
 * sidebar solid at the same time (`data-on-battery`). Plugged in, the `sidebar` vibrancy returns.
 * Electron cannot change `visualEffectState` after creation, so the layer is removed, not frozen.
 */
export function applyPowerToWindow(
  win: WindowPowerTarget,
  onBattery: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin" || win.isDestroyed()) return;
  win.setVibrancy(onBattery ? null : "sidebar");
}
