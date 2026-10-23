/** The group ids with `id` moved one place up (-1) or down (1), or null at the end of the list. */
export function moveGroupBy(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const at = ids.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** The group ids with `id` moved to the place of `overId`, or null when nothing moves. */
export function moveGroupTo(ids: readonly string[], id: string, overId: string): string[] | null {
  const from = ids.indexOf(id);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
