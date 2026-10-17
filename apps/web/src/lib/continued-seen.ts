/**
 * Whether the clock icon of a continued worktree still shows on its sidebar row.
 * It shows for 24 hours after the continuation, until the user opens the worktree.
 * The record itself stays on the worktree. The seen mark is kept per device type
 * (`band:continued-seen:<worktreeId>` in `client-state-keys.ts`) and holds the
 * `at` of the continuation the user has seen.
 */

import { useEffect, useSyncExternalStore } from "react";

import { clientStorage, subscribeClientState } from "./client-state";

export const CONTINUED_SEEN_PREFIX = "band:continued-seen:";
export const CONTINUED_ICON_WINDOW_MS = 24 * 60 * 60 * 1000;

export function continuedIconVisible(at: number, seenAt: number | null, now: number): boolean {
  if (seenAt !== null && seenAt >= at) return false;
  return now - at < CONTINUED_ICON_WINDOW_MS;
}

function readSeen(worktreeId: string): number | null {
  const raw = clientStorage.getItem(CONTINUED_SEEN_PREFIX + worktreeId);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("storage", listener);
  const unsubscribe = subscribeClientState(listener);
  return () => {
    window.removeEventListener("storage", listener);
    unsubscribe();
  };
}

/**
 * True while the icon should show for a continuation at `at`. While `isActive`,
 * the continuation counts as seen.
 */
export function useContinuedIconVisible(
  worktreeId: string,
  at: number,
  isActive: boolean,
): boolean {
  const seenAt = useSyncExternalStore(
    subscribe,
    () => readSeen(worktreeId),
    () => null,
  );
  useEffect(() => {
    if (!isActive) return;
    if (seenAt !== null && seenAt >= at) return;
    clientStorage.setItem(CONTINUED_SEEN_PREFIX + worktreeId, String(at));
  }, [isActive, worktreeId, at, seenAt]);
  return continuedIconVisible(at, seenAt, Date.now());
}
