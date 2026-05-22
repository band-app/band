import type { DockviewApi, DockviewGroupPanel } from "dockview";
import { walkGridNode } from "./dockview-active-state";

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

/**
 * Walk the dockview's serialized grid tree in spatial reading order
 * (left-to-right, top-to-bottom) and return the live grid groups in
 * that order. Floating / popout groups are skipped because they don't
 * live in the grid tree.
 *
 * We use `api.toJSON().grid.root` instead of `api.groups` because
 * `api.groups` is a creation-order array — splitting right then down
 * yields `[orig, right, down]` regardless of where those splits end up
 * visually. The serialized grid tree, on the other hand, encodes the
 * branch hierarchy where each branch's `data` array is ordered by
 * pixel position (left children first for horizontal branches, top
 * children first for vertical branches). Walking it depth-first
 * produces the same ordering the user sees on screen, so Cmd+] reads
 * like "next panel clockwise" and Cmd+[ reads like "previous panel
 * counter-clockwise".
 *
 * Note: `api.toJSON()` has one documented side effect — when a group
 * is maximized, dockview internally exits then re-enters that group
 * during serialization, which fires `onDidMaximizedGroupChange`
 * events. SharedDockviewLayout's outer dockview guards against that
 * via `inSaveLayoutToJSON`, but the per-section sub-dockviews don't
 * have a maximize button so they can't be in that state during
 * cycling.
 */
export function getGridGroupsInVisualOrder(api: DockviewApi): DockviewGroupPanel[] {
  const json = api.toJSON();
  const ordered: DockviewGroupPanel[] = [];
  const root = json.grid?.root;
  if (!root) return ordered;
  walkGridNode(root, (leaf) => {
    const id = leaf?.data?.id;
    if (typeof id !== "string") return;
    const group = api.getGroup(id);
    if (!group) return;
    // Filter to grid-located groups — `walkGridNode` already only emits
    // leaves of the grid tree (floating / popout / edge groups live in
    // sibling arrays on `SerializedDockview`), but this guards against
    // any future shape change in `toJSON`.
    if (group.api.location.type !== "grid") return;
    ordered.push(group as DockviewGroupPanel);
  });
  return ordered;
}

/** Cycle between split panel groups in visual reading order (skips floating/popout). */
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
