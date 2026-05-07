/**
 * Desktop-shell IPC bridge. Wraps Electron's `window.__BAND_DESKTOP__`
 * preload surface so React call sites get a simple `invoke()` / `listen()`
 * pair without touching `ipcRenderer` directly.
 *
 * Channel and event names match the IPC channel registry in
 * `apps/desktop/src/shared/ipc-channels.ts`. Call sites should gate on
 * `isDesktop` before dispatching — invoking outside the shell rejects.
 */

import { isDesktop } from "./is-desktop";

type ListenEvent<T> = { payload: T };
type Unlisten = () => void;

/** Shape of `window.__BAND_DESKTOP__` populated by Electron's preload. */
interface ElectronBridge {
  version: number;
  invoke(channel: string, args?: unknown): Promise<unknown>;
  on(event: string, cb: (payload: unknown) => void): Unlisten;
}

function electronBridge(): ElectronBridge | null {
  if (!isDesktop) return null;
  const bridge = (window as unknown as { __BAND_DESKTOP__?: ElectronBridge }).__BAND_DESKTOP__;
  return bridge ?? null;
}

/**
 * Invoke a main-process command (e.g. `"browser_create"`,
 * `"webserver_start"`). Throws if called outside the desktop shell — call
 * sites should gate on `isDesktop` first.
 */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = electronBridge();
  if (bridge) {
    return (await bridge.invoke(cmd, args)) as T;
  }
  throw new Error(`invoke('${cmd}') called outside the desktop shell`);
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
  throw new Error(`listen('${event}') called outside the desktop shell`);
}
