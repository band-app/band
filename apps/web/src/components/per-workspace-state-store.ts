import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Per-workspace cross-panel state store
// ---------------------------------------------------------------------------
//
// Tracks small pieces of state that need to be shared between the panels of
// a SINGLE workspace (currentFile + openFilePath today). Keyed by
// workspaceId so flipping wsA's currentFile doesn't re-render wsB / wsC's
// cached panel children — only subscribers of that workspaceId rerun.
//
// Lifecycle: entries are removed from `states` when
// `MultiWorkspacePanelHost` evicts the workspace from its LRU cache
// (`clearPerWorkspaceState`), so the map can't grow unbounded over a long
// session. `listeners` self-cleans when the last subscriber unsubscribes.
// ---------------------------------------------------------------------------

export interface PerWorkspaceState {
  currentFile?: string;
  openFilePath: string | null;
}

const states = new Map<string, PerWorkspaceState>();
const listeners = new Map<string, Set<() => void>>();

// Frozen so accidental mutation of the default leaks across workspaces; also
// a stable reference, which matters: `useSyncExternalStore` re-runs its
// effect on every snapshot inequality, and returning a fresh `{ ... }` here
// would trigger an infinite re-render loop on workspaces that haven't had
// any state set yet.
const EMPTY_STATE: PerWorkspaceState = Object.freeze({ openFilePath: null });

export function getPerWorkspaceState(workspaceId: string): PerWorkspaceState {
  return states.get(workspaceId) ?? EMPTY_STATE;
}

export function setPerWorkspaceState(workspaceId: string, patch: Partial<PerWorkspaceState>): void {
  const prev = getPerWorkspaceState(workspaceId);
  const next: PerWorkspaceState = { ...prev, ...patch };
  if (prev.currentFile === next.currentFile && prev.openFilePath === next.openFilePath) return;
  states.set(workspaceId, next);
  const set = listeners.get(workspaceId);
  if (set) for (const cb of set) cb();
}

export function subscribePerWorkspaceState(workspaceId: string, cb: () => void): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) listeners.delete(workspaceId);
  };
}

/**
 * Drop a workspace's cross-panel state. Called from MultiWorkspacePanelHost
 * when a workspace is evicted from the LRU cache — the panel children for
 * that workspace are about to unmount, so their state map entry is dead
 * weight. Without this, `states` grows unbounded over a long session.
 */
export function clearPerWorkspaceState(workspaceId: string): void {
  states.delete(workspaceId);
}

/**
 * React hook: subscribe to one workspace's state, re-render only when ITS
 * slot changes. `useSyncExternalStore` closes the tearing window that a
 * naive `useState + useEffect` pattern would leave open under concurrent
 * rendering.
 */
export function usePerWorkspaceState(workspaceId: string): PerWorkspaceState {
  return useSyncExternalStore(
    (cb) => subscribePerWorkspaceState(workspaceId, cb),
    () => getPerWorkspaceState(workspaceId),
  );
}
