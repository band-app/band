/**
 * Client state kept on the Band server, so the phone and the desktop show the
 * same tabs, drafts and panel layout. The store itself lives in
 * `@band-app/client/client-state`; this file binds it to the browser:
 * localStorage as the synchronous read cache, the web tRPC client, and the
 * desktop or mobile device type from the layout breakpoint.
 *
 * Code keeps reading `localStorage` (or `clientStorage.getItem`) at mount, and
 * writes through `clientStorage.setItem` / `removeItem`. Before the first read,
 * the dashboard hydrates: `hydrateGlobal()` before the app shell mounts and
 * `hydrateWorktree(id)` before a worktree's dockview mounts.
 */

import {
  type ClientStateApi,
  type ClientStateChange,
  ClientStateStore,
} from "@band-app/client/client-state";
import { DESKTOP_QUERY } from "../hooks/useIsDesktop";
import { isDesktop } from "./is-desktop";

export type { ClientStateChange };

/** How long a mount waits for hydration before it reads localStorage as it is. */
export const HYDRATE_WAIT_MS = 1500;

const store = new ClientStateStore({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      return keys;
    },
  },
  // Loaded on first use: importing the tRPC client opens its WebSocket, and
  // modules like `zoom.ts` that write through `clientStorage` are also
  // imported by jsdom unit tests with no server.
  getApi: async () => (await import("./trpc-client")).trpc as unknown as ClientStateApi,
  deviceType: () => {
    const wide = typeof window !== "undefined" && window.matchMedia?.(DESKTOP_QUERY)?.matches;
    return isDesktop || wide ? "desktop" : "mobile";
  },
  onStorageWrite: (key, oldValue, newValue) => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue,
        newValue,
        storageArea: localStorage,
        url: location.href,
      }),
    );
  },
});

/** localStorage with server sync for the keys in `client-state-keys.ts`. */
export const clientStorage = {
  getItem: (key: string): string | null => store.getItem(key),
  setItem: (key: string, value: string): void => store.setItem(key, value),
  removeItem: (key: string): void => store.removeItem(key),
};

/** Resolve once the global keys are hydrated, or after `timeoutMs` (offline). */
export function hydrateGlobal(timeoutMs = HYDRATE_WAIT_MS): Promise<void> {
  return withTimeout(store.hydrate(null), timeoutMs);
}

/** Resolve once a worktree's keys are hydrated, or after `timeoutMs` (offline). */
export function hydrateWorktree(worktreeId: string, timeoutMs = HYDRATE_WAIT_MS): Promise<void> {
  return withTimeout(store.hydrate(worktreeId), timeoutMs);
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Changes that came from the server (another device, a refused write, hydration). */
export function subscribeClientState(listener: (change: ClientStateChange) => void): () => void {
  return store.subscribe(listener);
}

let syncStarted = false;

/**
 * Follow other devices' writes on the status stream, re-read after a
 * reconnect, and drop a deleted worktree's keys. Idempotent.
 */
export function startClientStateSync(
  subscribeStatusEvents: (handler: (event: Record<string, unknown>) => void) => () => void,
): void {
  if (syncStarted || typeof window === "undefined") return;
  syncStarted = true;
  store.startSync(subscribeStatusEvents);
  // Writes still pending when the page closes stay in the meta blob and are
  // pushed on the next load.
  window.addEventListener("online", () => store.flushPending());
}
