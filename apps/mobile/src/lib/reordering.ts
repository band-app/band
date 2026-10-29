/**
 * The ordering rules behind drag to reorder on the home list. Pure, so node:test covers them.
 * A worktree moves among its siblings only (the rows under the same parent), together with the
 * rows nested under it, and a group header moves among the group sections. This follows the web
 * sidebar (`apps/web/src/dashboard/lib/sidebar-drop.ts`): the request carries the whole list in its
 * new order, and `scope: "pins"` is for the pins of the Pinned section.
 */

/** The fields of a list row the ordering reads. */
export interface OrderRow {
  id: string;
  repo: string;
  name: string;
  hostId: string;
  depth: number;
  parentId: string | null;
}

export interface WorktreeRef {
  repo: string;
  name: string;
  hostId?: string;
}

export interface ReorderRequest {
  order: WorktreeRef[];
  scope: "pins" | "siblings";
}

/** The rows that move as one unit: a worktree and everything nested under it. */
export interface Block {
  /** The sibling's own row id. */
  id: string;
  /** Row ids in display order, the first being `id`. */
  rowIds: string[];
}

/** Moves the item at `from` to `to`; the others keep their order. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  const at = Math.max(0, Math.min(to, next.length));
  next.splice(at, 0, item as T);
  return next;
}

/**
 * The sibling blocks of the row `activeId` in a section's rows, in display order, and the position
 * of the row among them. Siblings share a depth and sit between the same two rows of a lower depth.
 * Returns null when the row is not in `rows`.
 */
export function siblingBlocks(
  rows: readonly OrderRow[],
  activeId: string,
): { blocks: Block[]; index: number } | null {
  const at = rows.findIndex((r) => r.id === activeId);
  const active = rows[at];
  if (!active) return null;
  const depth = active.depth;
  let start = at;
  while (start > 0 && (rows[start - 1] as OrderRow).depth >= depth) start--;
  let end = at + 1;
  while (end < rows.length && (rows[end] as OrderRow).depth >= depth) end++;
  const blocks: Block[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i] as OrderRow;
    if (row.depth !== depth) continue;
    const rowIds = [row.id];
    for (let j = i + 1; j < end && (rows[j] as OrderRow).depth > depth; j++) {
      rowIds.push((rows[j] as OrderRow).id);
    }
    blocks.push({ id: row.id, rowIds });
  }
  return { blocks, index: blocks.findIndex((b) => b.id === activeId) };
}

/**
 * The `worktrees.reorder` request for dragging the row `activeId` to sibling position `to`, or null
 * when it stays where it is. `pinned` is true for the rows of the Pinned section, whose top level
 * is the pins and has its own order.
 */
export function reorderRequest(
  rows: readonly OrderRow[],
  activeId: string,
  to: number,
  pinned: boolean,
): ReorderRequest | null {
  const found = siblingBlocks(rows, activeId);
  const active = rows.find((r) => r.id === activeId);
  if (!found || !active || found.index === to) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = moveItem(
    found.blocks.map((b) => b.id),
    found.index,
    to,
  );
  const order = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        repo: row.repo,
        name: row.name,
        ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
      },
    ];
  });
  if (order.length < 2) return null;
  return { order, scope: pinned && active.depth === 0 ? "pins" : "siblings" };
}

interface SortableRepo {
  name: string;
  worktrees: { name: string; hostId?: string; sortIndex?: number; pinSortIndex?: number }[];
}

/** `repos.list` with the new order stored in the sort indexes, as the hub stores it. */
export function withOrder<R extends SortableRepo>(repos: R[], request: ReorderRequest): R[] {
  const field = request.scope === "pins" ? "pinSortIndex" : "sortIndex";
  const key = (repo: string, name: string, hostId?: string) =>
    `${repo}\n${name}\n${hostId || "local"}`;
  const positions = new Map(
    request.order.map((ref, i) => [key(ref.repo, ref.name, ref.hostId), i]),
  );
  return repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((w) => {
      const position = positions.get(key(repo.name, w.name, w.hostId));
      return position === undefined ? w : { ...w, [field]: position };
    }),
  }));
}

/**
 * Where the dragged block lands. `heights` are the sibling blocks' heights in display order, `from`
 * is the dragged block and `dy` how far it was dragged. The block moves to where its middle
 * passes the middle of the blocks it crossed.
 */
export function dropIndex(heights: readonly number[], from: number, dy: number): number {
  const mids: number[] = [];
  let top = 0;
  for (const h of heights) {
    mids.push(top + h / 2);
    top += h;
  }
  const own = mids[from];
  if (own === undefined) return from;
  const center = own + dy;
  let to = 0;
  mids.forEach((mid, i) => {
    if (i !== from && mid < center) to++;
  });
  return Math.max(0, Math.min(to, heights.length - 1));
}

/** How far block `index` shifts to make room while block `from` is held over position `to`. */
export function shiftFor(
  heights: readonly number[],
  from: number,
  to: number,
  index: number,
): number {
  const held = heights[from] ?? 0;
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -held;
  if (from > to && index >= to && index < from) return held;
  return 0;
}

/**
 * The full group order after the group at `from` moves to `to` among `visible`. A group the filter
 * hides keeps its place; the visible ones fill the places they held, in the new order.
 */
export function groupOrder(
  all: readonly string[],
  visible: readonly string[],
  from: number,
  to: number,
): string[] | null {
  if (from === to) return null;
  const moved = moveItem(visible, from, to);
  const shown = new Set(visible);
  let next = 0;
  return all.map((id) => (shown.has(id) ? (moved[next++] as string) : id));
}

/** `repos.list` groups in the order of `ids`; ids it does not name keep their order after. */
export function withGroupOrder<G extends { id: string }>(groups: G[], ids: readonly string[]): G[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...groups].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
  );
}

/** The alert for a reorder the hub refused. */
export function reorderFailure(error: unknown): { title: string; message: string } {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    title: "Could not save the new order",
    message: `${detail}\n\nThe list is back in its old order.`,
  };
}
