import { originDescendants } from "@band-app/shared/sidebar-tree";
import type { PinnedTree, WorktreeEntry } from "./sidebar-grouping";

/** Where a drag ended relative to the row under the pointer. */
export type DropZone = "before" | "after" | "into";

export interface WorktreeRef {
  repo: string;
  name: string;
  hostId?: string;
}

/** What a drop does. `refuse` carries the reason the sidebar shows. */
export type DropPlan =
  | {
      type: "reorder";
      scope: "siblings" | "pins";
      order: WorktreeRef[];
      reparent?: WorktreeRef & { origin: string | null };
    }
  | {
      /** The worktree gets a new parent (null clears it) and moves into `groupId`. */
      type: "parent";
      worktree: WorktreeRef;
      worktreeId: string;
      origin: string | null;
      groupId: string | null;
    }
  | { type: "refuse"; reason: string }
  | { type: "none" };

const NONE: DropPlan = { type: "none" };

const refOf = (entry: WorktreeEntry): WorktreeRef => ({
  repo: entry.repo.name,
  name: entry.worktree.name,
  hostId: entry.worktree.hostId,
});

/**
 * The zone of the pointer inside a row. With `allowInto` the middle half of the row means "drop
 * onto it" and the top and bottom quarters mean the gap above or below. Without it the row splits
 * in two halves.
 */
export function zoneAt(
  rect: { top: number; height: number },
  pointerY: number,
  allowInto: boolean,
): DropZone {
  const ratio = rect.height > 0 ? (pointerY - rect.top) / rect.height : 0.5;
  if (allowInto) {
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "into";
  }
  return ratio < 0.5 ? "before" : "after";
}

/** `ids` with `activeId` taken out and put before or after `overId`. */
function moveWithin(
  ids: string[],
  activeId: string,
  overId: string,
  zone: "before" | "after",
): string[] {
  const without = ids.filter((id) => id !== activeId);
  const at = without.indexOf(overId);
  if (at === -1) return ids;
  without.splice(zone === "before" ? at : at + 1, 0, activeId);
  return without;
}

function planFromIds(
  byId: Map<string, WorktreeEntry>,
  ids: string[],
  scope: "siblings" | "pins",
): DropPlan {
  const order = ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [refOf(entry)] : [];
  });
  return order.length === 0 ? NONE : { type: "reorder", scope, order };
}

/** The group ids with `activeId` moved before or after `overId`, or null when nothing moves. */
export function planGroupReorder(
  ids: string[],
  activeId: string,
  overId: string,
  zone: DropZone,
): string[] | null {
  if (activeId === overId || zone === "into") return null;
  const next = moveWithin(ids, activeId, overId, zone);
  return next.join("|") === ids.join("|") ? null : next;
}

/** Pins reorder among themselves, in every view. */
export function planPinDrop(
  pinned: PinnedTree,
  activeId: string,
  overId: string,
  zone: DropZone,
): DropPlan {
  if (activeId === overId || zone === "into") return NONE;
  const byId = new Map(pinned.pins.map((e) => [e.worktreeId, e]));
  const ids = moveWithin(
    pinned.pins.map((e) => e.worktreeId),
    activeId,
    overId,
    zone,
  );
  return planFromIds(byId, ids, "pins");
}

/** A worktree dragged within its repo in the Repo view: it only reorders. */
export function planRepoViewDrop(
  siblings: WorktreeEntry[],
  activeId: string,
  overId: string,
  zone: DropZone,
): DropPlan {
  if (activeId === overId || zone === "into") return NONE;
  const byId = new Map(siblings.map((e) => [e.worktreeId, e]));
  if (!byId.has(activeId) || !byId.has(overId)) return NONE;
  const ids = moveWithin(
    siblings.map((e) => e.worktreeId),
    activeId,
    overId,
    zone,
  );
  return planFromIds(byId, ids, "siblings");
}

/**
 * A worktree dropped on another row of the group list. Onto the middle of a row it becomes that
 * row's child and joins its group. In the gap above or below a row it becomes a sibling of that
 * row: a top-level row has no parent, so the parent is cleared. Either way it joins the group of
 * the row it was dropped on. Dropping onto itself or onto a worktree started from it is refused,
 * because the hub would refuse the cycle.
 */
export function planParentDrop(
  entries: WorktreeEntry[],
  activeId: string,
  overId: string,
  zone: DropZone,
): DropPlan {
  if (activeId === overId) {
    return { type: "refuse", reason: "A worktree can't become its own parent." };
  }
  const active = entries.find((e) => e.worktreeId === activeId);
  const over = entries.find((e) => e.worktreeId === overId);
  if (!active || !over) return NONE;
  const cycle = new Set([
    activeId,
    ...originDescendants(entries, activeId).map((e) => e.worktreeId),
  ]);
  const refuseCycle: DropPlan = {
    type: "refuse",
    reason: "A worktree can't become a child of one that was started from it.",
  };
  let origin: string | null;
  if (zone === "into") {
    if (cycle.has(overId)) return refuseCycle;
    origin = overId;
  } else {
    const parentId = over.worktree.origin?.worktreeId;
    const live = parentId !== undefined && entries.some((e) => e.worktreeId === parentId);
    origin = live ? (parentId as string) : null;
    if (origin !== null && cycle.has(origin)) return refuseCycle;
  }
  const groupId = over.worktree.groupId ?? null;
  const unchanged =
    (active.worktree.origin?.worktreeId ?? null) === origin &&
    (active.worktree.groupId ?? null) === groupId;
  if (unchanged) return NONE;
  return { type: "parent", worktree: refOf(active), worktreeId: activeId, origin, groupId };
}
