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

/** Cycle tabs in the currently active group. */
export function cycleTabsInActiveGroup(
  api: DockviewApi | null,
  direction: Direction,
  refocus?: () => void,
): void {
  const group = api?.activeGroup;
  if (!api || !group) return;
  if (direction === 1) group.model.moveToNext();
  else group.model.moveToPrevious();
  refocus?.();
}

// ---------------------------------------------------------------------------
// Clockwise ordering of grid groups
// ---------------------------------------------------------------------------

export interface GroupRect {
  /** Group id matching `DockviewGroupPanel.id`. */
  id: string;
  /** Pixel position of the group's centre, in viewport coordinates. */
  cx: number;
  cy: number;
}

/**
 * Sort groups in clockwise visual order, starting from whichever panel sits
 * closest to "12 o'clock" relative to the layout's bounding-box centre.
 *
 * The result is a stable cyclic order — `cycleGridGroups` indexes into it
 * with `(currentIdx ± 1) mod n`, so the actual starting element doesn't
 * matter; only the relative ordering does. Concretely, for a 2×2 grid
 * (1=top-left, 2=top-right, 3=bottom-right, 4=bottom-left) the returned
 * order is [2, 3, 4, 1] — pressing Cmd+] from any panel walks the
 * perimeter clockwise (1→2→3→4→1), pressing Cmd+[ walks it counter-
 * clockwise (1→4→3→2→1).
 *
 * ## Why polar angle instead of tree-walking
 *
 * Dockview stores the layout as a tree of nested splits whose depth-first
 * traversal order depends on which axis was split *first*. The same visual
 * 2×2 grid built as "split right then split each side down" vs. "split
 * down then split each side right" produces opposite traversal orders
 * (column-major vs row-major) even though the pixels are identical. To
 * decouple cycling from the user's split history we measure each panel's
 * pixel centre and sort by angle from the layout centre.
 *
 * ## Edge case: 1-D layouts
 *
 * When every panel is colinear (a single row or column), the polar-angle
 * sort produces ties because dx or dy is zero for every panel. We detect
 * this — the spread on one axis is much smaller than the other — and
 * fall back to a linear sort on the other axis: left→right for rows,
 * top→bottom for columns. This matches the only reasonable cycling
 * behaviour for 1-D layouts.
 */
export function sortGroupsClockwise(groups: GroupRect[]): GroupRect[] {
  if (groups.length < 2) return groups.slice();

  const xs = groups.map((g) => g.cx);
  const ys = groups.map((g) => g.cy);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xSpread = maxX - minX;
  const ySpread = maxY - minY;

  // 1-D detection: if one axis has < 10% of the other's spread, the
  // layout is effectively a single row/column and polar angle would
  // produce ties. Sort linearly along the dominant axis instead.
  const ONE_D_RATIO = 0.1;
  if (xSpread < ySpread * ONE_D_RATIO) {
    // Vertical column → top to bottom.
    return [...groups].sort((a, b) => a.cy - b.cy);
  }
  if (ySpread < xSpread * ONE_D_RATIO) {
    // Horizontal row → left to right.
    return [...groups].sort((a, b) => a.cx - b.cx);
  }

  // 2-D layout: sort by clockwise angle from the bounding-box centre.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return [...groups].sort((a, b) => clockwiseAngle(a, cx, cy) - clockwiseAngle(b, cx, cy));
}

/**
 * Angle in radians, measured clockwise from "12 o'clock" (straight up),
 * normalised to `[0, 2π)`. Inputs use screen coordinates where the y
 * axis points downward, so "up" is `cy - py > 0` and we flip dy
 * accordingly inside `atan2`.
 */
function clockwiseAngle(rect: GroupRect, cx: number, cy: number): number {
  const dx = rect.cx - cx;
  const dy = rect.cy - cy;
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += 2 * Math.PI;
  return angle;
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
 * Return the grid groups in clockwise visual order. Floating/popout
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
    // A zero-size rect means the element is detached or display:none. Skip
    // it rather than feed `0,0` coordinates into the sort, which would
    // collapse the layout centre.
    if (r.width === 0 && r.height === 0) continue;
    rects.push({ id: g.id, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  }

  const ordered = sortGroupsClockwise(rects);
  const result: DockviewGroupPanel[] = [];
  for (const rect of ordered) {
    const g = api.getGroup(rect.id);
    if (g) result.push(g as DockviewGroupPanel);
  }
  return result;
}

/** Cycle between split panel groups in clockwise visual order (skips floating/popout). */
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
  const next = groups[(idx + direction + groups.length) % groups.length];
  // Only refocus when we actually activated a different panel; if the next
  // group has no active panel, setActive() is a no-op so re-focusing whatever
  // is already focused would be a confusing flicker.
  if (next?.activePanel) {
    next.activePanel.api.setActive();
    refocus?.();
  }
}

/**
 * Pre-select the left neighbour (or the right neighbour when closing the
 * first tab) of `panelId` inside its group so focus doesn't snap to the
 * leftmost tab after `api.removePanel`. Call this *before* `removePanel`.
 */
export function selectNeighbourBeforeRemove(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  if (!panel) return;
  const groupPanels = panel.group?.panels ?? [];
  if (groupPanels.length <= 1) return;
  const idx = groupPanels.findIndex((p) => p.id === panelId);
  if (idx < 0) return;
  const neighbour = groupPanels[idx === 0 ? 1 : idx - 1];
  neighbour?.api.setActive();
}
