/** The label id the mobile list is filtered to, kept under one client-state key (per device type). */
export const LABEL_FILTER_KEY = "band.mobile.label-filter";

/** A stored value is a label id; an empty or missing one means All. */
export function parseLabelFilter(raw: string | null): string | null {
  const id = raw?.trim();
  return id ? id : null;
}

/** The filter to show: a stored label that no longer exists counts as All. */
export function effectiveLabelFilter(
  stored: string | null,
  labels: readonly { id: string }[],
): string | null {
  return stored && labels.some((l) => l.id === stored) ? stored : null;
}
