/**
 * Whether the UI should save energy: the machine runs on battery, or the window is blurred or hidden.
 *
 * Battery comes from the desktop shell (Electron `powerMonitor`, over IPC) or, in a plain browser,
 * the Battery Status API where it exists. Focus comes from the window and the page's visibility.
 *
 * `startPowerState` mirrors the state onto `<html>`:
 *   data-power="saver"  battery or blurred or hidden (CSS pauses infinite animations)
 *   data-on-battery     battery only (the desktop window drops its vibrancy, the sidebar goes opaque)
 * Other code reads it through `getPowerState` / `subscribePowerState` / `usePowerState`.
 */

import { useSyncExternalStore } from "react";

import { getElectronBridge } from "./desktop-ipc";

export interface PowerState {
  onBattery: boolean;
  /** The window has focus and the page is visible. */
  focused: boolean;
}

/** The terminals and pollers care about this one: battery, blurred or hidden. */
export function isSaver(state: PowerState): boolean {
  return state.onBattery || !state.focused;
}

interface BatteryManager extends EventTarget {
  charging: boolean;
}

let state: PowerState = {
  onBattery: false,
  focused: typeof document === "undefined" ? true : !document.hidden && document.hasFocus(),
};
const listeners = new Set<() => void>();
let started = false;

function setState(patch: Partial<PowerState>): void {
  const next = { ...state, ...patch };
  if (next.onBattery === state.onBattery && next.focused === state.focused) return;
  state = next;
  applyAttributes(state);
  for (const l of listeners) l();
}

function applyAttributes(s: PowerState): void {
  const root = document.documentElement;
  if (isSaver(s)) root.setAttribute("data-power", "saver");
  else root.removeAttribute("data-power");
  root.toggleAttribute("data-on-battery", s.onBattery);
}

/** Parked terminals stop parsing output on battery or while the page is hidden. */
export function isBackgroundSaver(): boolean {
  return state.onBattery || (typeof document !== "undefined" && document.hidden);
}

export function getPowerState(): PowerState {
  return state;
}

export function subscribePowerState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePowerState(): PowerState {
  return useSyncExternalStore(subscribePowerState, getPowerState, getPowerState);
}

function watchFocus(): void {
  const update = () => setState({ focused: !document.hidden && document.hasFocus() });
  window.addEventListener("focus", () => setState({ focused: !document.hidden }));
  window.addEventListener("blur", () => {
    // Focus moving into a browser pane's <webview> or an iframe blurs the window, but the user is still in Band.
    const active = document.activeElement?.tagName;
    if (active === "WEBVIEW" || active === "IFRAME") return;
    setState({ focused: false });
  });
  document.addEventListener("visibilitychange", update);
  update();
}

function watchDesktopBattery(): boolean {
  const bridge = getElectronBridge();
  if (!bridge) return false;
  bridge
    .invoke("get_power_state")
    .then((s) => setState({ onBattery: (s as { onBattery: boolean }).onBattery === true }))
    .catch(() => {});
  try {
    bridge.on("power-state-changed", (s) =>
      setState({ onBattery: (s as { onBattery: boolean }).onBattery === true }),
    );
  } catch {
    // An older desktop shell without the event: the first reading stands.
  }
  return true;
}

function watchBrowserBattery(): void {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (typeof nav.getBattery !== "function") return;
  nav
    .getBattery()
    .then((battery) => {
      const update = () => setState({ onBattery: !battery.charging });
      battery.addEventListener("chargingchange", update);
      update();
    })
    .catch(() => {});
}

/** Starts watching once per page. Returns nothing to undo: the state lives as long as the page. */
export function startPowerState(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  applyAttributes(state);
  watchFocus();
  if (!watchDesktopBattery()) watchBrowserBattery();
}
