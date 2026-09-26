// ---------------------------------------------------------------------------
// Budget for live browser webviews in hidden workspaces (desktop only).
// Ported from orca's `browser-pane/host-guest/browser-guest-worktree-retention.ts`.
//
// Every visited workspace stays mounted, and so do its browser panes' `<webview>`
// elements, so each one keeps a guest process alive purely for an instant
// revisit. Guest memory would grow linearly
// with workspaces visited (orca hit this as their #12137). So at most 4 hidden
// workspaces keep live guests, chosen by activation order; older ones are
// destroyed and rebuilt from the pane's last URL on the next visit. The active
// workspace never counts and is never evicted.
//
// Orca also vetoes evicting a guest that automation or a mobile client is
// driving, or one mid-download. Band's renderer has no such signal; a guest
// that CLI automation needs again is recreated through the `browserHost`
// ensure-view path (`BrowserHostBridge`).
// ---------------------------------------------------------------------------

export const BROWSER_GUEST_HIDDEN_WORKSPACE_RETENTION_LIMIT = 4;

/**
 * Hidden workspaces whose retained guests fall beyond the budget, LRU-first.
 *
 * `orderedWorkspaceIds` must be most-recently-activated first. Only workspaces
 * that actually hold live guests count toward the limit. `isEvictable` is
 * consulted lazily, only for workspaces beyond the limit; a non-evictable one
 * stays retained over budget.
 */
export function selectBrowserGuestEvictionWorkspaceIds(args: {
  orderedWorkspaceIds: readonly string[];
  activeWorkspaceId: string | null;
  isRetained: (workspaceId: string) => boolean;
  holdsLiveGuests: (workspaceId: string) => boolean;
  isEvictable: (workspaceId: string) => boolean;
  limit?: number;
}): string[] {
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_WORKSPACE_RETENTION_LIMIT;
  const evictedIds: string[] = [];
  const seen = new Set<string>();
  let retained = 0;
  for (const workspaceId of args.orderedWorkspaceIds) {
    if (
      seen.has(workspaceId) ||
      workspaceId === args.activeWorkspaceId ||
      !args.isRetained(workspaceId) ||
      !args.holdsLiveGuests(workspaceId)
    ) {
      seen.add(workspaceId);
      continue;
    }
    seen.add(workspaceId);
    if (retained < limit) {
      retained += 1;
      continue;
    }
    if (args.isEvictable(workspaceId)) evictedIds.push(workspaceId);
  }
  return evictedIds;
}

/** LRU order = workspace activation order; activating moves the id to the front. */
export function touchBrowserGuestWorkspaceRecency(recency: string[], workspaceId: string): void {
  const index = recency.indexOf(workspaceId);
  if (index !== -1) recency.splice(index, 1);
  recency.unshift(workspaceId);
}

// ---------------------------------------------------------------------------
// Registry of live guests. `BrowserPaneComponent` registers while its
// `<webview>` exists and hands over an `evict` callback that removes the
// element (destroying the guest) and flags the pane to recreate it when it is
// next shown.
// ---------------------------------------------------------------------------

type EvictGuest = () => void;

const guestsByWorkspace = new Map<string, Map<string, EvictGuest>>();
const recency: string[] = [];

export function registerBrowserGuest(
  workspaceId: string,
  browserId: string,
  evict: EvictGuest,
): () => void {
  let guests = guestsByWorkspace.get(workspaceId);
  if (!guests) {
    guests = new Map();
    guestsByWorkspace.set(workspaceId, guests);
  }
  guests.set(browserId, evict);
  // A view can finish creating after its workspace was left (and pruned from
  // `recency` for holding no guest yet). Put it back so it counts.
  if (!recency.includes(workspaceId)) recency.unshift(workspaceId);
  return () => {
    const current = guestsByWorkspace.get(workspaceId);
    if (current?.get(browserId) !== evict) return;
    current.delete(browserId);
    if (current.size === 0) guestsByWorkspace.delete(workspaceId);
  };
}

/** Record a workspace activation and evict guests beyond the hidden budget.
 *  Called from the root route whenever the active workspace changes. */
export function activateBrowserGuestWorkspace(activeWorkspaceId: string | null): void {
  if (activeWorkspaceId !== null) touchBrowserGuestWorkspaceRecency(recency, activeWorkspaceId);
  const holdsLiveGuests = (id: string) => (guestsByWorkspace.get(id)?.size ?? 0) > 0;
  // Drop hidden workspaces with no live guest so the list doesn't grow with
  // every workspace ever visited (deleted ones included). Guests are only
  // created while their workspace is active, which re-adds it at the front.
  for (let i = recency.length - 1; i >= 0; i--) {
    const id = recency[i];
    if (id !== activeWorkspaceId && !holdsLiveGuests(id)) recency.splice(i, 1);
  }
  const evicted = selectBrowserGuestEvictionWorkspaceIds({
    orderedWorkspaceIds: recency,
    activeWorkspaceId,
    isRetained: holdsLiveGuests,
    holdsLiveGuests,
    isEvictable: () => true,
  });
  for (const workspaceId of evicted) {
    const guests = guestsByWorkspace.get(workspaceId);
    if (!guests) continue;
    // Copy first: each evict callback unregisters itself.
    for (const evict of [...guests.values()]) evict();
  }
}
