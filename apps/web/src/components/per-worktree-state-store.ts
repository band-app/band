import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Per-worktree cross-panel state store
// ---------------------------------------------------------------------------
//
// Tracks small pieces of state that need to be shared between the panels of
// a SINGLE worktree (currentFile + openFilePath today). Keyed by
// worktreeId so flipping wsA's currentFile doesn't re-render wsB / wsC's
// cached panel children — only subscribers of that worktreeId rerun.
//
// Lifecycle: entries are removed from `states` when
// `MultiWorktreePanelHost` unmounts a deleted worktree
// (`clearPerWorktreeState`), so the map can't grow unbounded over a long
// session. `listeners` self-cleans when the last subscriber unsubscribes.
// ---------------------------------------------------------------------------

export interface PerWorktreeState {
  currentFile?: string;
  openFilePath: string | null;
}

const states = new Map<string, PerWorktreeState>();
const listeners = new Map<string, Set<() => void>>();

// Frozen so accidental mutation of the default leaks across worktrees; also
// a stable reference, which matters: `useSyncExternalStore` re-runs its
// effect on every snapshot inequality, and returning a fresh `{ ... }` here
// would trigger an infinite re-render loop on worktrees that haven't had
// any state set yet.
const EMPTY_STATE: PerWorktreeState = Object.freeze({ openFilePath: null });

export function getPerWorktreeState(worktreeId: string): PerWorktreeState {
  return states.get(worktreeId) ?? EMPTY_STATE;
}

export function setPerWorktreeState(worktreeId: string, patch: Partial<PerWorktreeState>): void {
  const prev = getPerWorktreeState(worktreeId);
  const next: PerWorktreeState = { ...prev, ...patch };
  if (prev.currentFile === next.currentFile && prev.openFilePath === next.openFilePath) return;
  states.set(worktreeId, next);
  const set = listeners.get(worktreeId);
  if (set) for (const cb of set) cb();
}

export function subscribePerWorktreeState(worktreeId: string, cb: () => void): () => void {
  let set = listeners.get(worktreeId);
  if (!set) {
    set = new Set();
    listeners.set(worktreeId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) listeners.delete(worktreeId);
  };
}

/**
 * Drop a worktree's cross-panel state. Called from MultiWorktreePanelHost
 * when a deleted worktree leaves the mounted set — the panel children for
 * that worktree are about to unmount, so their state map entry is dead
 * weight. Without this, `states` grows unbounded over a long session.
 */
export function clearPerWorktreeState(worktreeId: string): void {
  states.delete(worktreeId);
}

/**
 * React hook: subscribe to one worktree's state, re-render only when ITS
 * slot changes. `useSyncExternalStore` closes the tearing window that a
 * naive `useState + useEffect` pattern would leave open under concurrent
 * rendering.
 */
export function usePerWorktreeState(worktreeId: string): PerWorktreeState {
  return useSyncExternalStore(
    (cb) => subscribePerWorktreeState(worktreeId, cb),
    () => getPerWorktreeState(worktreeId),
  );
}
