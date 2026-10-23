/** The collapsed repo names, kept in client state under one key (scope `mobile`, per device type). */

export const COLLAPSED_REPOS_KEY = "band.mobile.collapsed-repos";

export function parseCollapsed(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/** The raw value with every name in `names` collapsed or expanded; null when nothing is collapsed. */
export function setCollapsedMany(
  raw: string | null,
  names: readonly string[],
  collapsed: boolean,
): string | null {
  const next = new Set(parseCollapsed(raw));
  for (const name of names) {
    if (collapsed) next.add(name);
    else next.delete(name);
  }
  return next.size === 0 ? null : JSON.stringify([...next].sort());
}

/** True when every name is collapsed. An empty list counts as not collapsed. */
export function allCollapsed(collapsed: ReadonlySet<string>, names: readonly string[]): boolean {
  return names.length > 0 && names.every((n) => collapsed.has(n));
}

/** The raw value after flipping `repo`; null (no key) when nothing is collapsed. */
export function toggleCollapsed(raw: string | null, repo: string): string | null {
  const next = new Set(parseCollapsed(raw));
  if (!next.delete(repo)) next.add(repo);
  return next.size === 0 ? null : JSON.stringify([...next].sort());
}
