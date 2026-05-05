/**
 * Unified desktop-shell IPC bridge. Wraps Tauri (`@tauri-apps/api`) and
 * Electron (`window.__BAND_DESKTOP__`) under one signature so React call
 * sites don't need to branch on which shell is hosting them.
 *
 * The interface intentionally mirrors Tauri's:
 *   - `invoke<T>(cmd, args)` returns `Promise<T>`
 *   - `listen<T>(event, cb)` returns `Promise<() => void>` (the unlisten fn)
 *   - `startDragging()` resolves to `void`
 *
 * That keeps the diff minimal: existing Tauri call sites swap their imports
 * from `@tauri-apps/api/core` to `@/lib/desktop-ipc` and otherwise look
 * identical. See issue #306 for the migration plan.
 *
 * Channel and event names match Tauri's snake-case command names exactly,
 * which is also what the Electron main process registers (see
 * `apps/desktop/src/shared/ipc-channels.ts`).
 */

import { isElectron, isTauri } from "./is-tauri";

type ListenEvent<T> = { payload: T };
type Unlisten = () => void;

/** Shape of `window.__BAND_DESKTOP__` populated by Electron's preload. */
interface ElectronBridge {
  version: number;
  invoke(channel: string, args?: unknown): Promise<unknown>;
  on(event: string, cb: (payload: unknown) => void): Unlisten;
  startDragging(): Promise<void>;
}

function electronBridge(): ElectronBridge | null {
  if (!isElectron) return null;
  const bridge = (window as unknown as { __BAND_DESKTOP__?: ElectronBridge }).__BAND_DESKTOP__;
  return bridge ?? null;
}

/**
 * Invoke a main-process command. Channel names are the Tauri command names
 * (e.g. `"browser_create"`, `"webserver_start"`). Args are the same camel/
 * snake hybrid Tauri uses; the Electron handlers expect the same shapes.
 *
 * Throws if called outside any desktop shell — call sites should gate on
 * `isDesktop` first.
 */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = electronBridge();
  if (bridge) {
    return (await bridge.invoke(cmd, args)) as T;
  }
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  throw new Error(`invoke('${cmd}') called outside a desktop shell`);
}

/**
 * Subscribe to a main-process event (e.g. `"browser-url-changed"`,
 * `"browser-title-changed"`). Returns an unlisten function.
 */
export async function listen<T = unknown>(
  event: string,
  cb: (e: ListenEvent<T>) => void,
): Promise<Unlisten> {
  const bridge = electronBridge();
  if (bridge) {
    return bridge.on(event, (payload) => cb({ payload: payload as T }));
  }
  if (isTauri) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<T>(event, cb);
  }
  throw new Error(`listen('${event}') called outside a desktop shell`);
}

/**
 * Start a native window drag (mirrors Tauri's
 * `getCurrentWindow().startDragging()`). On Electron this is a no-op
 * server-side; the title bar uses CSS `-webkit-app-region: drag` instead
 * (wired up in Phase 5). The bridge still exposes the verb so call sites
 * don't need to branch.
 */
export async function startDragging(): Promise<void> {
  const bridge = electronBridge();
  if (bridge) {
    await bridge.startDragging();
    return;
  }
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  }
}
