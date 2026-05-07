/**
 * Workspace visibility store.
 *
 * Tracks whether each workspace is active (visible to the user) without
 * using React Context, so changing visibility doesn't cascade re-renders
 * through the entire component tree. Only components that subscribe via
 * `useSyncExternalStore` re-render — typically just the leaf components
 * with desktop side effects (browser_hide/show, terminal attach/detach).
 */

import { useCallback, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface VisibilityState {
  wsActive: boolean;
}

type Listener = () => void;

const state = new Map<string, VisibilityState>();
const listeners = new Map<string, Set<Listener>>();

const DEFAULT: VisibilityState = { wsActive: true };

function notify(workspaceId: string): void {
  const set = listeners.get(workspaceId);
  if (set) {
    for (const cb of set) cb();
  }
}

/**
 * Set the workspace visibility. Call from DockviewInstanceManager when
 * the active workspace changes.
 */
export function setWsActive(workspaceId: string, wsActive: boolean): void {
  const prev = state.get(workspaceId);
  if (prev?.wsActive === wsActive) return; // no-op
  state.set(workspaceId, { wsActive });
  notify(workspaceId);
}

/**
 * Read the current visibility for a workspace (non-reactive).
 */
export function getWsActive(workspaceId: string): boolean {
  return state.get(workspaceId)?.wsActive ?? DEFAULT.wsActive;
}

function subscribe(workspaceId: string, cb: Listener): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to workspace visibility changes. Only re-renders when the
 * wsActive value for this workspace actually changes.
 */
export function useWsActive(workspaceId: string): boolean {
  const sub = useCallback((cb: Listener) => subscribe(workspaceId, cb), [workspaceId]);
  const snap = useCallback(() => getWsActive(workspaceId), [workspaceId]);
  return useSyncExternalStore(sub, snap);
}
