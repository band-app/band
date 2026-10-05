// ---------------------------------------------------------------------------
// Budget for live browser webviews in hidden worktrees (desktop only).
// Ported from orca's `browser-pane/host-guest/browser-guest-worktree-retention.ts`.
//
// Every visited worktree stays mounted, and so do its browser panes' `<webview>`
// elements, so each one keeps a guest process alive purely for an instant
// revisit. Guest memory would grow linearly
// with worktrees visited (orca hit this as their #12137). So at most 4 hidden
// worktrees keep live guests, chosen by activation order; older ones are
// destroyed and rebuilt from the pane's last URL on the next visit. The active
// worktree never counts and is never evicted.
//
// Orca also vetoes evicting a guest that automation or a mobile client is
// driving, or one mid-download. Band's renderer has no such signal; a guest
// that CLI automation needs again is recreated through the `browserHost`
// ensure-view path (`BrowserHostBridge`).
// ---------------------------------------------------------------------------

export const BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT = 4;

/**
 * Hidden worktrees whose retained guests fall beyond the budget, LRU-first.
 *
 * `orderedWorktreeIds` must be most-recently-activated first. Only worktrees
 * that actually hold live guests count toward the limit. `isEvictable` is
 * consulted lazily, only for worktrees beyond the limit; a non-evictable one
 * stays retained over budget.
 */
export function selectBrowserGuestEvictionWorktreeIds(args: {
  orderedWorktreeIds: readonly string[];
  activeWorktreeId: string | null;
  isRetained: (worktreeId: string) => boolean;
  holdsLiveGuests: (worktreeId: string) => boolean;
  isEvictable: (worktreeId: string) => boolean;
  limit?: number;
}): string[] {
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT;
  const evictedIds: string[] = [];
  const seen = new Set<string>();
  let retained = 0;
  for (const worktreeId of args.orderedWorktreeIds) {
    if (
      seen.has(worktreeId) ||
      worktreeId === args.activeWorktreeId ||
      !args.isRetained(worktreeId) ||
      !args.holdsLiveGuests(worktreeId)
    ) {
      seen.add(worktreeId);
      continue;
    }
    seen.add(worktreeId);
    if (retained < limit) {
      retained += 1;
      continue;
    }
    if (args.isEvictable(worktreeId)) evictedIds.push(worktreeId);
  }
  return evictedIds;
}

/** LRU order = worktree activation order; activating moves the id to the front. */
export function touchBrowserGuestWorktreeRecency(recency: string[], worktreeId: string): void {
  const index = recency.indexOf(worktreeId);
  if (index !== -1) recency.splice(index, 1);
  recency.unshift(worktreeId);
}

// ---------------------------------------------------------------------------
// Registry of live guests. `BrowserPaneComponent` registers while its
// `<webview>` exists and hands over an `evict` callback that removes the
// element (destroying the guest) and flags the pane to recreate it when it is
// next shown.
// ---------------------------------------------------------------------------

type EvictGuest = () => void;

const guestsByWorktree = new Map<string, Map<string, EvictGuest>>();
const recency: string[] = [];

export function registerBrowserGuest(
  worktreeId: string,
  browserId: string,
  evict: EvictGuest,
): () => void {
  let guests = guestsByWorktree.get(worktreeId);
  if (!guests) {
    guests = new Map();
    guestsByWorktree.set(worktreeId, guests);
  }
  guests.set(browserId, evict);
  // A view can finish creating after its worktree was left (and pruned from
  // `recency` for holding no guest yet). Put it back so it counts.
  if (!recency.includes(worktreeId)) recency.unshift(worktreeId);
  return () => {
    const current = guestsByWorktree.get(worktreeId);
    if (current?.get(browserId) !== evict) return;
    current.delete(browserId);
    if (current.size === 0) guestsByWorktree.delete(worktreeId);
  };
}

/** Record a worktree activation and evict guests beyond the hidden budget.
 *  Called from the root route whenever the active worktree changes. */
export function activateBrowserGuestWorktree(activeWorktreeId: string | null): void {
  if (activeWorktreeId !== null) touchBrowserGuestWorktreeRecency(recency, activeWorktreeId);
  const holdsLiveGuests = (id: string) => (guestsByWorktree.get(id)?.size ?? 0) > 0;
  // Drop hidden worktrees with no live guest so the list doesn't grow with
  // every worktree ever visited (deleted ones included). Guests are only
  // created while their worktree is active, which re-adds it at the front.
  for (let i = recency.length - 1; i >= 0; i--) {
    const id = recency[i];
    if (id !== activeWorktreeId && !holdsLiveGuests(id)) recency.splice(i, 1);
  }
  const evicted = selectBrowserGuestEvictionWorktreeIds({
    orderedWorktreeIds: recency,
    activeWorktreeId,
    isRetained: holdsLiveGuests,
    holdsLiveGuests,
    isEvictable: () => true,
  });
  for (const worktreeId of evicted) {
    const guests = guestsByWorktree.get(worktreeId);
    if (!guests) continue;
    // Copy first: each evict callback unregisters itself.
    for (const evict of [...guests.values()]) evict();
  }
}
