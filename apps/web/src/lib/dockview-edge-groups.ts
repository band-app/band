import type { DockviewApi } from "dockview";

/**
 * Shared edge-group helpers for our dockview instances. Each DockviewApi
 * gets the same three cardinal edges (left, right, bottom) so panels can
 * dock there. Top is intentionally omitted — none of our layouts use it,
 * and a stray "top" group restored from an older saved layout is cleaned
 * up by `ensureEdgeGroups` below.
 *
 * The main outer layout (`SharedDockviewLayout`) wires the same pattern
 * inline; these helpers extract the bits the three inner containers
 * (`DockviewTerminalContainer`, `DockviewChatContainer`,
 * `DockviewBrowserContainer`) need so each one can opt-in with two
 * small calls in `onReady` plus a useEffect cleanup.
 */

export const EDGE_GROUP_IDS = {
  left: "edge-left",
  right: "edge-right",
  bottom: "edge-bottom",
} as const;

export type EdgeDirection = keyof typeof EDGE_GROUP_IDS;

/**
 * Add the three cardinal edge groups (left/right/bottom) to `api` if
 * they aren't already present, collapsed and with no panels. Then set
 * each one's visibility based on whether it currently holds panels —
 * so an empty edge group doesn't leak a thin sliver of dockview chrome
 * into the layout on first mount.
 *
 * Idempotent: calling it on an api that was just restored from a saved
 * layout (which already contains the edge groups) is a no-op aside from
 * the visibility refresh.
 *
 * Also defensively removes any persisted "top" edge group — older
 * saved layouts may carry one, but none of our layouts intentionally
 * dock to the top edge.
 *
 * Call this in `onReady` AFTER restoring (or building) the initial
 * layout, BEFORE wiring layout-change persistence listeners. Calling
 * it before listener registration means the synchronous edge-group
 * additions don't trigger a write; the next user-driven change will
 * persist the augmented layout naturally.
 */
export function ensureEdgeGroups(api: DockviewApi): void {
  // Best-effort cleanup of any stale "top" edge group restored from an
  // older saved layout. `getEdgeGroup` returns `undefined` rather than
  // throwing for an absent direction, so the truthy check is the actual
  // guard; the `try/catch` is narrowly scoped around `removeEdgeGroup`
  // alone (it's the only call here that can throw).
  if (api.getEdgeGroup("top")) {
    try {
      api.removeEdgeGroup("top");
    } catch {}
  }

  for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
    const id = EDGE_GROUP_IDS[direction];
    if (!api.groups.some((g) => g.id === id)) {
      try {
        api.addEdgeGroup(direction, { id, collapsed: true });
      } catch {}
    }
  }

  refreshEdgeGroupVisibility(api, false);
}

/**
 * Show each edge group only when it actually holds panels — so empty
 * edges stay hidden rather than rendering an empty strip. When
 * `forceVisible` is true (during a drag), show every edge group
 * regardless so the user has a drop target on every side.
 */
export function refreshEdgeGroupVisibility(api: DockviewApi, forceVisible: boolean): void {
  for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
    const id = EDGE_GROUP_IDS[direction];
    const group = api.groups.find((g) => g.id === id);
    if (!group) continue;
    const isEmpty = group.panels.length === 0;
    try {
      api.setEdgeGroupVisible(direction, forceVisible || !isEmpty);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Collapse/expand toggle + inner-dockview registry
// ---------------------------------------------------------------------------
//
// VSCode-style sidebar shortcuts (⌘B for left, ⌥⌘B for right, ⌘J for
// bottom) live in `SharedDockviewLayout`'s global keydown handler. To
// make them focus-aware — so ⌘B inside a focused terminal section
// toggles *that* container's left edge when it has panels, falling
// back to the main layout's left edge otherwise — each inner dockview
// (`DockviewTerminalContainer`, `DockviewChatContainer`,
// `DockviewBrowserContainer`) registers its `(containerEl, api)` pair
// here on mount. The global handler then calls `findFocusedInnerDockview`
// to see which inner dockview owns `document.activeElement`, attempts
// `toggleEdgeGroup` on it, and falls back to the main layout's api
// when the toggle reports `false` (no panels to act on).

interface InnerDockviewRegistration {
  containerEl: HTMLElement;
  api: DockviewApi;
}

// Intentionally a per-module-instance singleton — not per React tree.
// Each `DockviewTerminalContainer` / `DockviewChatContainer` /
// `DockviewBrowserContainer` contributes at most one entry while
// mounted. If a future SSR/Playwright setup ever loads this module
// twice in the same process (e.g. `vi.resetModules()` between tests),
// each module copy would have its own registry — that's fine because
// the React trees also bind to the matching module copy.
const innerDockviewRegistrations = new Set<InnerDockviewRegistration>();

/**
 * Register an inner dockview's container element + api so the global
 * sidebar-toggle shortcuts can route to it when focus is inside.
 *
 * Returns a disposer to unregister on unmount. Idempotent: calling the
 * returned disposer twice is safe.
 */
export function registerInnerDockview(containerEl: HTMLElement, api: DockviewApi): () => void {
  const registration: InnerDockviewRegistration = { containerEl, api };
  innerDockviewRegistrations.add(registration);
  return () => {
    innerDockviewRegistrations.delete(registration);
  };
}

/**
 * Find the registered inner dockview that currently contains
 * `document.activeElement`. Returns `null` when no inner dockview has
 * focus (focus is in the main layout, a modal, a webview, or
 * `document.body`). Used by the global sidebar-toggle shortcuts to
 * decide whether to act on an inner container's edge before falling
 * back to the main layout.
 */
export function findFocusedInnerDockview(): DockviewApi | null {
  const active = document.activeElement;
  if (!active) return null;
  for (const reg of innerDockviewRegistrations) {
    if (reg.containerEl.contains(active)) {
      return reg.api;
    }
  }
  return null;
}

/**
 * Toggle the collapsed state of the edge group at `direction` on `api`.
 * Uses dockview's group-level `collapse()`/`expand()` (the thin
 * tab-strip behaviour, matching the existing main-layout shortcut),
 * NOT `setEdgeGroupVisible` — visibility is managed by
 * `refreshEdgeGroupVisibility` based on panel-count and shouldn't be
 * driven by a user shortcut.
 *
 * Returns `true` when the toggle actually acted on a non-empty edge
 * group, `false` otherwise (no edge group at that direction, or it
 * has no panels). Callers use the return value for fallback
 * dispatching — e.g., ⌘B on a focused inner container with an empty
 * left edge returns `false`, prompting the caller to try the main
 * layout's left edge instead.
 */
export function toggleEdgeGroup(api: DockviewApi, direction: EdgeDirection): boolean {
  const id = EDGE_GROUP_IDS[direction];
  const group = api.groups.find((g) => g.id === id);
  if (!group) return false;
  if (group.panels.length === 0) return false;
  try {
    if (group.api.isCollapsed()) group.api.expand();
    else group.api.collapse();
  } catch {
    return false;
  }
  return true;
}

/**
 * Wire up edge-group drag visibility: while the user drags a panel or
 * group, force every edge group visible so it can accept a drop; once
 * the drag ends, hide any edge groups that are still empty.
 *
 * Returns a disposer — call it from a useEffect cleanup (or directly
 * on unmount) to detach the event listeners.
 */
export function attachEdgeGroupDragVisibility(api: DockviewApi): () => void {
  let isDragging = false;

  const refresh = () => {
    refreshEdgeGroupVisibility(api, isDragging);
  };

  const startDrag = () => {
    isDragging = true;
    refresh();
  };
  const endDrag = () => {
    isDragging = false;
    refresh();
  };

  // Initial visibility is `ensureEdgeGroups`' responsibility — every
  // caller in this codebase invokes that helper in `onReady` before
  // this one, and re-running the refresh here would be a redundant
  // round of `setEdgeGroupVisible` for each edge. The next `startDrag`
  // / `endDrag` event fires the refresh as needed.

  const d1 = api.onWillDragPanel(startDrag);
  const d2 = api.onWillDragGroup(startDrag);
  // `onDidMovePanel` / `onDidRemovePanel` are the dockview-level
  // signals for a successful drop. They do NOT fire when the user
  // cancels a drag with Escape or drops outside the dockview — the
  // native `dragend` listener on `document` below is the safety net
  // for those cases, so an unfinished drag can't leave edge groups
  // stuck in force-visible state.
  const d3 = api.onDidMovePanel(endDrag);
  const d4 = api.onDidRemovePanel(endDrag);

  const onDragEndNative = () => endDrag();
  document.addEventListener("drop", onDragEndNative, true);
  document.addEventListener("dragend", onDragEndNative, true);

  return () => {
    d1.dispose();
    d2.dispose();
    d3.dispose();
    d4.dispose();
    document.removeEventListener("drop", onDragEndNative, true);
    document.removeEventListener("dragend", onDragEndNative, true);
  };
}
