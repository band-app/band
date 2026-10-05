// ---------------------------------------------------------------------------
// Which hidden worktrees are "cold parked". Orca's worktree-level hidden-view
// parking (`terminal-hidden-view-parking.ts`), applied to every heavy
// per-worktree resource Band holds outside the React tree.
//
// Every visited worktree stays mounted (`MultiWorktreePanelHost`), so nothing
// is freed by unmounting. Instead, once a hidden worktree goes cold, its
// resources release and come back on the next visit:
//   - terminals (`terminal-cache.ts`): xterm + socket disposed, PTY kept, reveal
//     replays;
//   - LSP clients of its file leaves: language server shut down, re-acquired on
//     reveal;
//   - file-change subscriptions of its file leaves: the server-side watcher is
//     released, and the file reloads once on reveal.
//
// A worktree goes cold 30 s after it is hidden if it is not among the 4 most
// recently hidden, or once it has been hidden 5 minutes. The worktree the user
// most recently left never goes cold. Every known worktree counts, whether or
// not it holds any of these resources, as in orca.
// ---------------------------------------------------------------------------

import {
  selectIdsBeyondHotRetain,
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_LIMIT,
  TERMINAL_WORKTREE_HOT_RETAIN_MS,
} from "./terminal-park-policy";

const STATE_KEY = "__bandWorktreeColdPark__";

interface ColdParkState {
  activeWorktreeId: string | null;
  /** Epoch ms each known, non-active worktree was hidden. */
  hiddenSince: Map<string, number>;
  cold: ReadonlySet<string>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

// Stashed on globalThis so a Vite HMR reload keeps the clocks.
function getState(): ColdParkState {
  const store = globalThis as unknown as { [STATE_KEY]?: ColdParkState };
  store[STATE_KEY] ??= {
    activeWorktreeId: null,
    hiddenSince: new Map(),
    cold: new Set(),
    listeners: new Set(),
    timer: null,
  };
  return store[STATE_KEY];
}

/** Record which worktree is on screen (null on a route with none). */
export function setActiveWorktree(worktreeId: string | null): void {
  const state = getState();
  const prev = state.activeWorktreeId;
  if (prev === worktreeId) return;
  if (prev !== null) state.hiddenSince.set(prev, Date.now());
  if (worktreeId !== null) state.hiddenSince.delete(worktreeId);
  state.activeWorktreeId = worktreeId;
  runColdParkPass();
}

/** Stop tracking worktrees that no longer exist (deleted, worktree removed). */
export function forgetMissingWorktrees(validWorktreeIds: ReadonlySet<string>): void {
  const state = getState();
  let changed = false;
  // Deleting the current key while iterating a Map is safe. `cold` is
  // recomputed from `hiddenSince` by the pass below.
  for (const id of state.hiddenSince.keys()) {
    if (!validWorktreeIds.has(id)) {
      state.hiddenSince.delete(id);
      changed = true;
    }
  }
  if (changed) runColdParkPass();
}

export function isWorktreeColdParked(worktreeId: string): boolean {
  return getState().cold.has(worktreeId);
}

/** Notified whenever the cold set changes. Listeners run synchronously inside
 *  the pass, so they must not call `setActiveWorktree` or
 *  `forgetMissingWorktrees` directly; defer that work (as `terminal-cache.ts`
 *  does with a microtask). */
export function subscribeWorktreeColdPark(listener: () => void): () => void {
  const { listeners } = getState();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function runColdParkPass(): void {
  const state = getState();
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const nowMs = Date.now();
  let nextDeadline = Number.POSITIVE_INFINITY;
  const candidates: { id: string; hiddenSinceMs: number }[] = [];
  for (const [id, hiddenSinceMs] of state.hiddenSince) {
    for (const deadline of [
      hiddenSinceMs + TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
      hiddenSinceMs + TERMINAL_WORKTREE_HOT_RETAIN_MS,
    ]) {
      if (deadline > nowMs && deadline < nextDeadline) nextDeadline = deadline;
    }
    if (nowMs - hiddenSinceMs >= TERMINAL_WORKTREE_COLD_PARK_DELAY_MS) {
      candidates.push({ id, hiddenSinceMs });
    }
  }
  const cold = selectIdsBeyondHotRetain(candidates, {
    nowMs,
    hotRetainMs: TERMINAL_WORKTREE_HOT_RETAIN_MS,
    hotRetainLimit: TERMINAL_WORKTREE_HOT_RETAIN_LIMIT,
  });
  if (nextDeadline !== Number.POSITIVE_INFINITY) {
    state.timer = setTimeout(runColdParkPass, nextDeadline - nowMs);
  }
  let changed = cold.size !== state.cold.size;
  for (const id of cold) {
    if (changed) break;
    if (!state.cold.has(id)) changed = true;
  }
  if (!changed) return;
  state.cold = cold;
  for (const listener of [...state.listeners]) listener();
}
