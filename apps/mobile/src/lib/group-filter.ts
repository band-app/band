/** The group id the mobile list is filtered to, kept under one client-state key (per device type). */
export const GROUP_FILTER_KEY = "band.mobile.group-filter";

/** A stored value is a group id; an empty or missing one means All. */
export function parseGroupFilter(raw: string | null): string | null {
  const id = raw?.trim();
  return id ? id : null;
}

/** The filter to show: a stored group that no longer exists counts as All. */
export function effectiveGroupFilter(
  stored: string | null,
  groups: readonly { id: string }[],
): string | null {
  return stored && groups.some((g) => g.id === stored) ? stored : null;
}
