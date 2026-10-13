/**
 * Most-recently-used tab order per dockview group, for the Ctrl+Tab switcher.
 * Held in memory only; a reload starts from the strip order again.
 */
export type TabMru = Map<string, string[]>;

/** Ids kept per group, so closed tabs can't grow the order without bound. */
const MAX_PER_GROUP = 50;

/** Move `panelId` to the front of its group's order. */
export function recordActivation(mru: TabMru, groupId: string, panelId: string): void {
  const rest = (mru.get(groupId) ?? []).filter((id) => id !== panelId);
  mru.set(groupId, [panelId, ...rest].slice(0, MAX_PER_GROUP));
}

/**
 * The group's panel ids, most recent first. Ids the group no longer holds
 * (closed or moved tabs) drop out, and panels never activated since load
 * follow in strip order.
 */
export function orderByRecency(
  mru: TabMru,
  groupId: string,
  stripOrder: readonly string[],
  activeId?: string,
): string[] {
  const inGroup = new Set(stripOrder);
  const recent = (mru.get(groupId) ?? []).filter((id) => inGroup.has(id));
  const seen = new Set(recent);
  const ordered = [...recent, ...stripOrder.filter((id) => !seen.has(id))];
  // The active tab is always first, even if its activation was never seen.
  if (activeId && inGroup.has(activeId)) {
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }
  return ordered;
}

/** Highlight after opening: the previous tab, or the last one for Shift. */
export function initialIndex(count: number, backwards: boolean): number {
  return backwards ? count - 1 : Math.min(1, count - 1);
}

export function stepIndex(index: number, count: number, backwards: boolean): number {
  return (index + (backwards ? -1 : 1) + count) % count;
}
