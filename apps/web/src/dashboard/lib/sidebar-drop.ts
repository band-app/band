import type { OriginTree, PinnedTree, WorktreeEntry } from "./sidebar-grouping";
import { hostIdOf, isInSubtree } from "./sidebar-grouping";

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
  | { type: "move"; worktreeId: string; toHostId: string }
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

/** A worktree dragged in the Host view: onto another host it moves, in its own group it reorders. */
export function planHostViewDrop(
  entries: WorktreeEntry[],
  activeId: string,
  over: { worktreeId?: string; hostId: string },
  zone: DropZone,
): DropPlan {
  const active = entries.find((e) => e.worktreeId === activeId);
  if (!active) return NONE;
  const activeHost = hostIdOf(active.worktree);
  if (over.hostId !== activeHost) {
    return { type: "move", worktreeId: activeId, toHostId: over.hostId };
  }
  const overEntry = over.worktreeId ? entries.find((e) => e.worktreeId === over.worktreeId) : null;
  if (!overEntry || overEntry.repo.name !== active.repo.name || zone === "into") return NONE;
  const group = entries.filter(
    (e) => e.repo.name === active.repo.name && hostIdOf(e.worktree) === activeHost,
  );
  return planRepoViewDrop(group, activeId, overEntry.worktreeId, zone);
}

/**
 * A drop in the Origin view. Onto the middle of a row the dragged worktree becomes its child. In
 * the gap between rows it becomes a sibling at that position, under the parent of that list. A
 * repo's main worktree has no parent to change and only reorders among the top-level rows.
 */
export function planOriginDrop(
  tree: OriginTree,
  pinned: PinnedTree,
  activeId: string,
  overId: string,
  zone: DropZone,
): DropPlan {
  if (activeId === overId) return NONE;
  const byId = new Map<string, WorktreeEntry>(tree.byId);
  for (const entry of pinned.pins) byId.set(entry.worktreeId, entry);
  for (const list of pinned.childrenOf.values()) {
    for (const entry of list) byId.set(entry.worktreeId, entry);
  }
  const active = byId.get(activeId);
  const over = byId.get(overId);
  if (!active || !over) return NONE;

  const childrenOf = new Map<string, WorktreeEntry[]>([...tree.childrenOf, ...pinned.childrenOf]);
  const parentOf = new Map(tree.parentOf);
  for (const [parentId, list] of pinned.childrenOf) {
    for (const entry of list) parentOf.set(entry.worktreeId, parentId);
  }
  const activeIsMain = tree.isMain(active) && !tree.hasLiveOrigin(active);
  const currentOrigin = active.worktree.origin?.worktreeId ?? null;

  const withParent = (
    parent: WorktreeEntry,
    siblings: WorktreeEntry[],
    insert: { before?: string; after?: string } | "end",
  ): DropPlan => {
    // A drop onto the main row names it as the origin. A drop in the gap among its children keeps
    // no origin, which is where work with no origin is listed already.
    const impliedByMain =
      insert !== "end" &&
      tree.isMain(parent) &&
      !tree.hasLiveOrigin(parent) &&
      parent.repo.name === active.repo.name &&
      hostIdOf(parent.worktree) === hostIdOf(active.worktree);
    const origin = impliedByMain ? null : parent.worktreeId;
    if (activeIsMain) {
      return { type: "refuse", reason: "A repo's main worktree can't be moved under another." };
    }
    if (isInSubtree(childrenOf, activeId, parent.worktreeId)) {
      return {
        type: "refuse",
        reason: "A worktree can't become a child of one that was started from it.",
      };
    }
    const ids = siblings.map((e) => e.worktreeId).filter((id) => id !== activeId);
    if (insert === "end") ids.push(activeId);
    else {
      const anchor = insert.before ?? insert.after;
      const at = anchor === undefined ? -1 : ids.indexOf(anchor);
      if (at === -1) return NONE;
      ids.splice(insert.before ? at : at + 1, 0, activeId);
    }
    const plan = planFromIds(byId, ids, "siblings");
    if (plan.type !== "reorder") return plan;
    if (origin !== currentOrigin) plan.reparent = { ...refOf(active), origin };
    return plan;
  };

  if (zone === "into") {
    return withParent(over, childrenOf.get(overId) ?? [], "end");
  }

  const parentId = parentOf.get(overId);
  if (parentId === undefined) {
    // A top-level row: pins and repo mains. Only roots reorder here.
    const isRoot = tree.roots.some((e) => e.worktreeId === overId);
    if (!isRoot) return NONE;
    if (!activeIsMain && !tree.roots.some((e) => e.worktreeId === activeId)) {
      return { type: "refuse", reason: "Only a repo's main worktree sits at the top level." };
    }
    const ids = moveWithin(
      tree.roots.map((e) => e.worktreeId),
      activeId,
      overId,
      zone,
    );
    const plan = planFromIds(byId, ids, "siblings");
    if (plan.type === "reorder" && !activeIsMain && currentOrigin !== null) {
      plan.reparent = { ...refOf(active), origin: null };
    }
    return plan;
  }
  const parent = byId.get(parentId);
  if (!parent) return NONE;
  return withParent(
    parent,
    childrenOf.get(parentId) ?? [],
    zone === "before" ? { before: overId } : { after: overId },
  );
}

export interface MoveContext {
  hosts: { id: string; name?: string | null; status?: string }[];
  isAdmin: boolean;
}

/**
 * Why a worktree can't be moved onto a host, or null when the "Open on another host" dialog may
 * open. The message for a repo limited to one host matches the card's menu.
 */
export function moveRefusal(
  entry: WorktreeEntry,
  toHostId: string,
  context: MoveContext,
): string | null {
  const { worktree, repo } = entry;
  const fromHostId = hostIdOf(worktree);
  const hostName = (id: string) => context.hosts.find((h) => h.id === id)?.name?.trim() || id;
  if (fromHostId === "local" || worktree.supersededBy) {
    return "A worktree on this hub's own machine can't be moved to another worker.";
  }
  if (toHostId === "local") return "A worktree can't be moved onto this hub's own machine.";
  const source = context.hosts.find((h) => h.id === fromHostId);
  if (source && source.status !== "online") {
    return `${hostName(fromHostId)} is offline. Use "Open on another worker" in the worktree's menu.`;
  }
  if (repo.kind === "plain") return "A plain folder can't be moved to another worker.";
  if (repo.allowedHostIds?.every((id) => id === fromHostId)) {
    return `Only available on ${hostName(fromHostId)}`;
  }
  const target = context.hosts.find((h) => h.id === toHostId);
  if (!target || target.status !== "online") return `${hostName(toHostId)} is offline.`;
  const allowed = repo.allowedHostIds ?? null;
  if (allowed !== null && !allowed.includes(toHostId) && !context.isAdmin) {
    return `${repo.name} isn't allowed on ${hostName(toHostId)}, and adding a worker needs an admin.`;
  }
  return null;
}
