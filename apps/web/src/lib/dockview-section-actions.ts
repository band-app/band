import type { DockviewApi, DockviewGroupPanel } from "dockview";

/**
 * Shared helpers for the per-section Dockview shortcut handlers in
 * DockviewTerminalContainer, DockviewChatContainer, and DockviewBrowserContainer.
 *
 * Each container owns a sub-Dockview hosting that section's panels (terminal
 * tabs, chat tabs, browser tabs). All three sections need identical group /
 * tab cycling and the same focus-the-left-neighbour behaviour before closing
 * a panel — only the post-action focus target differs (xterm textarea vs.
 * address bar vs. group.focusContent()), so callers pass a `refocus` callback.
 */

export type Direction = 1 | -1;

/** Cycle tabs in the currently active group. No-op (including no refocus
 * call) when the group has only one panel and `moveToNext`/`moveToPrevious`
 * would itself be a no-op — avoids spurious focus thrash on Ctrl+Tab presses
 * in single-panel groups. */
export function cycleTabsInActiveGroup(
  api: DockviewApi | null,
  direction: Direction,
  refocus?: () => void,
): void {
  const group = api?.activeGroup;
  if (!api || !group) return;
  if (group.panels.length <= 1) return;
  if (direction === 1) group.model.moveToNext();
  else group.model.moveToPrevious();
  refocus?.();
}

// ---------------------------------------------------------------------------
// Visual ordering of grid groups
// ---------------------------------------------------------------------------

export interface GroupRect {
  /** Group id matching `DockviewGroupPanel.id`. */
  id: string;
  /** Pixel position of the group's top-left corner, in viewport coordinates. */
  top: number;
  left: number;
}

/**
 * Sort groups in row-major reading order (top→bottom, then left→right within
 * each row). For a 2×2 grid this gives top-left → top-right → bottom-left →
 * bottom-right, matching iTerm's pane-cycling behaviour and the convention
 * most editors use for split navigation.
 *
 * The returned array is a stable cyclic order — `cycleGridGroups` indexes
 * into it with `(currentIdx ± 1) mod n`, so the starting element is
 * incidental; only the relative ordering matters.
 *
 * ## Why a positional sort instead of walking the dockview tree
 *
 * Dockview stores the layout as a tree of nested splits whose depth-first
 * traversal order depends on which axis was split *first*. The same visual
 * 2×2 grid built as "split right then split each side down" vs. "split
 * down then split each side right" produces opposite traversal orders
 * (column-major vs row-major) even though the pixels are identical. To
 * decouple cycling from the user's split history we measure each panel's
 * pixel position and sort by `(top, left)`.
 *
 * ## Row-grouping tolerance
 *
 * Panels in the same visual row sometimes differ by a sub-pixel in their
 * `top` value due to dockview's flex sizing. A naive `(top, left)` sort
 * would treat 199.5 and 200 as different rows and produce the wrong order
 * (e.g., the top-right panel could sort *between* the bottom-left and
 * bottom-right panels). We snap `top` to a 4-pixel grid before comparing
 * so visually-aligned panels are reliably grouped into the same row, then
 * tie-break by `left` within the row.
 */
export function sortGroupsInReadingOrder(groups: GroupRect[]): GroupRect[] {
  if (groups.length < 2) return groups.slice();
  const ROW_SNAP = 4;
  const rowOf = (g: GroupRect) => Math.round(g.top / ROW_SNAP);
  return [...groups].sort((a, b) => {
    const rowDiff = rowOf(a) - rowOf(b);
    if (rowDiff !== 0) return rowDiff;
    return a.left - b.left;
  });
}

/**
 * Subset of `BasePanelView` we actually need at runtime. Dockview's
 * public types stop at `BasePanelViewExported`, which doesn't include
 * `element` — but the concrete `BasePanelView` class (which every
 * `DockviewGroupPanel` instance is) exposes it as a public getter
 * returning the rendered HTMLElement. We declare the runtime shape here
 * and cast through `unknown` so the intent is visible at the call site.
 *
 * Duck-typed (checks for the `getBoundingClientRect` method) rather
 * than `instanceof HTMLElement` so unit tests can pass minimal stubs
 * — the actual runtime guarantee comes from dockview itself, not from
 * a defensive instanceof.
 */
interface ElementBearing {
  readonly element: { getBoundingClientRect: () => DOMRect };
}

function readElement(group: DockviewGroupPanel): ElementBearing["element"] | null {
  const el = (group as unknown as ElementBearing).element;
  return el && typeof el.getBoundingClientRect === "function" ? el : null;
}

/**
 * Return the grid groups in row-major reading order. Floating/popout
 * groups are excluded because they don't participate in the grid.
 *
 * Measurement uses `getBoundingClientRect()`, which means the section's
 * sub-dockview must be in the DOM and laid out at call time. That's
 * true whenever the per-section keydown handler fires, because the
 * handler bails out unless the container has focus — focus requires
 * the element to be visible.
 */
export function getGridGroupsInVisualOrder(api: DockviewApi): DockviewGroupPanel[] {
  const groups = api.groups.filter((g) => g.api.location.type === "grid");
  if (groups.length < 2) return groups;

  const rects: GroupRect[] = [];
  for (const g of groups) {
    const el = readElement(g);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    // A zero-size rect means the element is detached or display:none.
    // Skip it so the sort isn't fed phantom (0, 0) coordinates that
    // would always land first.
    if (r.width === 0 && r.height === 0) continue;
    rects.push({ id: g.id, top: r.top, left: r.left });
  }

  const ordered = sortGroupsInReadingOrder(rects);
  const result: DockviewGroupPanel[] = [];
  for (const rect of ordered) {
    const g = api.getGroup(rect.id);
    if (g) result.push(g as DockviewGroupPanel);
  }
  return result;
}

/** Cycle between split panel groups in row-major reading order (skips floating/popout). */
export function cycleGridGroups(
  api: DockviewApi | null,
  direction: Direction,
  refocus?: () => void,
): void {
  if (!api) return;
  const groups = getGridGroupsInVisualOrder(api);
  if (groups.length < 2) return;
  const current = api.activeGroup;
  const idx = current ? groups.findIndex((g) => g.id === current.id) : -1;
  // When the active group isn't in the cycle (no current active group, or
  // the active group is floating/popout), enter the cycle from the end the
  // user is moving towards: forward → first, backward → last. The naive
  // `(idx + direction + n) % n` with `idx = -1` produces `0` forward but
  // `n - 2` backward, which silently skips the last group.
  const nextIdx =
    idx < 0
      ? direction === 1
        ? 0
        : groups.length - 1
      : (idx + direction + groups.length) % groups.length;
  const next = groups[nextIdx];
  // Only refocus when we actually activated a different panel; if the next
  // group has no active panel, setActive() is a no-op so re-focusing whatever
  // is already focused would be a confusing flicker.
  if (next?.activePanel) {
    next.activePanel.api.setActive();
    refocus?.();
  }
}

/**
 * Pre-select the panel that should take focus *after* `api.removePanel(panelId)`
 * runs. Call this *before* the removal.
 *
 * Two cases:
 *
 *   - **Multi-tab group**: the group survives the close. Pre-activate the
 *     left neighbour in tab order (or the right neighbour when closing the
 *     leftmost tab) so focus moves to an adjacent tab in the same group
 *     instead of snapping to the first tab.
 *
 *   - **Last tab in a group**: dockview removes the entire group after
 *     `removePanel`. Without intervention dockview activates whatever group
 *     it happens to pick (typically the first one in `api.groups`), which
 *     feels arbitrary to the user — close the top-right pane and the
 *     bottom-left lights up, not the top-left next to where you just were.
 *     We pre-activate the *previous* group in reading order, wrapping to
 *     the last group when the closed group was first. After dockview tears
 *     down the now-empty group, that pre-selected group's `activePanel`
 *     keeps focus, so the close feels like a natural step backwards
 *     through the layout.
 */
export function selectNeighbourBeforeRemove(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  if (!panel) return;
  const group = panel.group;
  const groupPanels = group?.panels ?? [];

  if (groupPanels.length > 1) {
    // Multi-tab group: pick the in-group neighbour.
    const idx = groupPanels.findIndex((p) => p.id === panelId);
    if (idx < 0) return;
    const neighbour = groupPanels[idx === 0 ? 1 : idx - 1];
    neighbour?.api.setActive();
    return;
  }

  // Last tab in a group: pre-activate the previous group in reading
  // order, so focus lands next to the closed pane instead of snapping to
  // some arbitrary group.
  if (!group) return;
  const ordered = getGridGroupsInVisualOrder(api);
  if (ordered.length <= 1) return; // no other group to fall back to
  const groupIdx = ordered.findIndex((g) => g.id === group.id);
  if (groupIdx < 0) return;
  const previous = ordered[groupIdx === 0 ? ordered.length - 1 : groupIdx - 1];
  previous?.activePanel?.api.setActive();
}
