/**
 * Renderer-side queue for mobile workspace actions (tab switch + optional file
 * open) that arrive before the target `MobileWorkspaceLayout` has mounted its
 * listener.
 *
 * Why this exists: post-route-unification (issue #467), the mobile workspace
 * no longer carries the active tab or selected file in its URL. The
 * `band open <path>` SSE handler in `__root.tsx` needs to navigate the user
 * to `/workspace/$id` AND tell the layout to switch to the Files tab — but
 * the workspace route component doesn't mount until React's next commit,
 * so a window-event dispatch in the microtask queue races against mount
 * and gets silently dropped.
 *
 * Design: a module-level Map<workspaceId, MobilePendingAction> with a
 * subscriber set. The dispatcher writes into the queue BEFORE navigating.
 * `MobileWorkspaceLayout` drains its slot synchronously on mount (in the
 * same `useEffect` that subscribes), so the pre-mount payload is delivered
 * before any subsequent action the layout might miss. Subsequent calls
 * while the layout is mounted reach it through the subscriber callback.
 *
 * Same shape as `pending-external-open.ts` — Map + listener Set — which is
 * the established codebase pattern for cross-component renderer state.
 */

import type { WorkspaceTab } from "@/dashboard";

export interface MobilePendingAction {
  /** Tab to activate when the layout mounts / receives the signal. */
  tab: WorkspaceTab;
  /**
   * Optional in-workspace file path to display in the Files tab. Omitted for
   * external paths (the actual file lives in `pending-external-open` and is
   * drained inside `CodeBrowserView`'s own mount effect).
   */
  filePath?: string;
}

// Lifecycle note: the map is only purged on consume, never on a timer.
// If a CLI client targets a workspace that the dashboard has no mobile
// layout mounted for (and the user never navigates there), the entry sits
// indefinitely. For a single-user dev tool this leak is negligible —
// at most one stale entry per workspace ID. The per-workspace keying
// also makes it safe across `MobileWorkspaceLayout` instances: a layout
// for workspace B will not consume a stale entry for workspace A.
const pending = new Map<string, MobilePendingAction>();
const listeners = new Set<() => void>();

/**
 * Queue a mobile workspace action. Replaces any existing pending action for
 * the same workspace — the most recent call wins, matching the user's intent.
 */
export function setMobilePendingAction(workspaceId: string, action: MobilePendingAction): void {
  pending.set(workspaceId, action);
  for (const cb of listeners) cb();
}

/**
 * Read-and-remove the pending action for a workspace. Idempotent: calling
 * twice in a row returns `undefined` the second time. Callers should invoke
 * this once on mount (to catch pre-mount writes) and again inside their
 * subscriber callback (to catch writes while mounted).
 */
export function consumeMobilePendingAction(workspaceId: string): MobilePendingAction | undefined {
  const value = pending.get(workspaceId);
  if (value === undefined) return undefined;
  pending.delete(workspaceId);
  return value;
}

export function subscribeMobilePendingActions(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
