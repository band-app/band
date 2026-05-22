import type { DockviewApi } from "dockview";

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

/** Cycle between split panel groups (grid-positioned, skips floating/popout). */
export function cycleGridGroups(
  api: DockviewApi | null,
  direction: Direction,
  refocus?: () => void,
): void {
  if (!api) return;
  const groups = api.groups.filter((g) => g.api.location.type === "grid");
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
