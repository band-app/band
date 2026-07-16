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
 * Build a dockview `addPanel` `position` value that pins a new panel
 * to the central area of `api`, regardless of which group happens to
 * be `activeGroup` right now.
 *
 * Background: every inner dockview (Chat / Terminal / Browser) calls
 * `ensureEdgeGroups` in `onReady` to add the three cardinal edge groups
 * (left / right / bottom) collapsed. dockview-core's `addPanel` falls
 * back to `activeGroup` when `position` is omitted, and once edge groups
 * exist `activeGroup` can be one of those collapsed edge groups — which
 * makes the new panel render as a thin collapsed strip docked at the
 * edge instead of filling the center.
 *
 * Strategy:
 * - If any grid-located group exists, return
 *   `{ referenceGroup: <id> }` so the new panel becomes a tab in the
 *   central area.
 * - Otherwise return `{ direction: "within" }`, which routes through
 *   dockview-core's `orthogonalize('center')` → `createGroupAtLocation([0])`
 *   path and creates a fresh central group regardless of what
 *   `activeGroup` happens to be. Passing this direction WITHOUT a
 *   reference (`referencePanel`/`referenceGroup`) is the dockview API
 *   shape that means "create a new central group from scratch" — the
 *   only way to force the create-new-group branch when only edge
 *   groups exist.
 */
export function centralPanelPosition(
  api: DockviewApi,
): { referenceGroup: string } | { direction: "within" } {
  const central = api.groups.find((g) => g.api.location.type === "grid");
  if (central) return { referenceGroup: central.id };
  return { direction: "within" };
}

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

// Tracks the pending class-removal timer per animation root so rapid
// maximize/restore toggles extend the window instead of cutting the
// second toggle's transition short.
const edgeAnimTimers = new WeakMap<HTMLElement, number>();

/**
 * Call IMMEDIATELY BEFORE exiting a maximized group. Any relayout while
 * maximized (panel mounts after a reload, a window resize) re-parks the
 * hidden views at offset 0, so the restore tween would start from the
 * wrong edge. Re-anchor and force a synchronous style flush so the
 * corrected positions are committed as the transition START values before
 * the restore's own style writes land in the same task.
 */
export function prepareMaximizeRestoreAnimation(root: HTMLElement | null): void {
  if (!root) return;
  anchorHiddenGridViews(root);
  void root.offsetWidth;
}

/**
 * dockview's splitview parks a hidden view at offset 0 regardless of which
 * side of the visible (maximized) view it came from. For a view that sits
 * AFTER the maximized group the maximize tween then sweeps its box across
 * the maximized group — and since it is a later DOM sibling it paints on
 * top, so the old panel visibly slides "through" the maximizing one (and
 * back out from under it on restore). Views BEFORE the maximized group are
 * unaffected: offset 0 is already their natural collapse anchor, which is
 * why maximizing the right panel tweens with a clean seam while maximizing
 * the left one ghosted.
 *
 * Re-anchor every hidden view that has a visible sibling before it to the
 * container's far edge so its box collapses (and later re-expands) in
 * place, exactly mirroring the before-side behaviour.
 *
 * Must run synchronously in the same task as the maximize toggle so the new
 * anchor lands in the same style recalc as dockview's own inline-style
 * writes. The far edge is derived from the visible siblings' inline styles
 * rather than clientWidth so the patch never forces a layout flush.
 *
 * The anchor persists as an inline style until dockview's next relayout of
 * that splitview. A relayout while maximized (e.g. a window resize) re-parks
 * hidden views at 0, so the following restore can still ghost for one
 * 200ms tween — accepted; the next maximize re-anchors.
 */
export function anchorHiddenGridViews(root: HTMLElement): void {
  for (const sv of Array.from(
    root.querySelectorAll<HTMLElement>(".dv-branch-node > .dv-split-view-container"),
  )) {
    // Only the outer grid's splitviews participate in the maximize tween —
    // splitviews inside panel content (inner chat/terminal/browser
    // dockviews) are exempted from the animation by the CSS override, so
    // skip them here too rather than writing dead inline styles.
    if (sv.closest(".dv-content-container")) continue;
    const horizontal = sv.classList.contains("dv-horizontal");
    const views = Array.from(
      sv.querySelectorAll<HTMLElement>(":scope > .dv-view-container > .dv-view"),
    );
    let farEdge = 0;
    for (const v of views) {
      if (!v.classList.contains("visible")) continue;
      const start = Number.parseFloat(horizontal ? v.style.left : v.style.top) || 0;
      const size = Number.parseFloat(horizontal ? v.style.width : v.style.height) || 0;
      farEdge = Math.max(farEdge, start + size);
    }
    let seenVisible = false;
    for (const v of views) {
      if (v.classList.contains("visible")) {
        seenVisible = true;
        continue;
      }
      if (!seenVisible) continue;
      if (horizontal) v.style.left = `${farEdge}px`;
      else v.style.top = `${farEdge}px`;
    }
  }
}

/**
 * Collapse (hide) every edge group while a grid group is maximized so the
 * maximized tab gets the full area; on exit, re-derive edge visibility from
 * panel presence.
 *
 * Restore is deliberately state-free: we only ever toggle *visibility* here,
 * never `collapse()`/`expand()`, so each edge's collapsed-vs-expanded strip
 * state is left untouched and comes back exactly as the user left it. Edge
 * visibility is already an ephemeral, derived property (see
 * `refreshEdgeGroupVisibility`), so hiding it for the duration of a maximize
 * and re-deriving on exit is consistent with how the rest of the layout
 * treats it — no separate "prior edge state" bookkeeping is needed.
 */
export function applyMaximizeEdgeVisibility(
  api: DockviewApi,
  maximized: boolean,
  animateRoot?: HTMLElement | null,
): void {
  if (animateRoot) {
    const pending = edgeAnimTimers.get(animateRoot);
    if (pending !== undefined) window.clearTimeout(pending);
    animateRoot.classList.add("dv-edge-anim");
    edgeAnimTimers.set(
      animateRoot,
      window.setTimeout(() => {
        animateRoot.classList.remove("dv-edge-anim");
        edgeAnimTimers.delete(animateRoot);
      }, 300),
    );
  }
  if (maximized) {
    for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
      try {
        api.setEdgeGroupVisible(direction, false);
      } catch {}
    }
  } else {
    refreshEdgeGroupVisibility(api, false);
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
