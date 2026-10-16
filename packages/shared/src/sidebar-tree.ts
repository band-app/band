/**
 * The sidebar's ordering and nesting rules for worktrees, shared by the web sidebar and the mobile
 * list so both put the same worktree in the same place. The functions are generic over the repo and
 * worktree shapes each client carries and read only the fields in `SidebarRepo` and
 * `SidebarWorktree`.
 */

import { toWorktreeId } from "./worktree-id.ts";

const LOCAL_HOST = "local";

export interface SidebarWorktree {
  name: string;
  hostId?: string;
  pinned?: boolean;
  sortIndex?: number;
  pinSortIndex?: number;
  origin?: { worktreeId: string; removed?: boolean } | null;
}

export interface SidebarRepo {
  name: string;
  kind?: "git" | "plain";
  defaultBranch?: string;
  worktrees: SidebarWorktree[];
}

/** The worktree type a repo type carries. */
export type WorktreeOf<R extends SidebarRepo> = R["worktrees"][number];

export interface WorktreeEntry<R extends SidebarRepo = SidebarRepo> {
  worktreeId: string;
  repo: R;
  worktree: WorktreeOf<R>;
}

export function hostIdOf(worktree: { hostId?: string }): string {
  return worktree.hostId || LOCAL_HOST;
}

export function entriesOf<R extends SidebarRepo>(repos: R[]): WorktreeEntry<R>[] {
  return repos.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({
      worktreeId: toWorktreeId(repo.name, worktree.name, worktree.hostId),
      repo,
      worktree,
    })),
  );
}

type SortField = "sortIndex" | "pinSortIndex";

/** Orders by the stored index, worktrees with none after those with one. Ties keep their order. */
export function bySortIndex(field: SortField) {
  return (a: { worktree: SidebarWorktree }, b: { worktree: SidebarWorktree }): number => {
    const x = a.worktree[field];
    const y = b.worktree[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  };
}

/** Each repo's worktrees in the order the user dragged them to. Without an index the order stays. */
export function sortRepoWorktrees<R extends SidebarRepo>(repos: R[]): R[] {
  const compare = bySortIndex("sortIndex");
  return repos.map((repo) => {
    const entries = repo.worktrees.map((worktree) => ({ worktree }));
    entries.sort(compare);
    return { ...repo, worktrees: entries.map((e) => e.worktree) };
  });
}

export interface OriginTree<R extends SidebarRepo = SidebarRepo> {
  entries: WorktreeEntry<R>[];
  byId: Map<string, WorktreeEntry<R>>;
  roots: WorktreeEntry<R>[];
  /** Children shown under each worktree, in order. */
  childrenOf: Map<string, WorktreeEntry<R>[]>;
  /** The worktree a row is nested under, or undefined for a top-level row. */
  parentOf: Map<string, string>;
  hasLiveOrigin: (entry: WorktreeEntry<R>) => boolean;
  /** A repo's main worktree: where work with no origin is listed. */
  isMain: (entry: WorktreeEntry<R>) => boolean;
}

/**
 * The Origin tree: each repo's main worktree at the top level, with everything started from it
 * nested under it. A worktree with no origin, or whose origin is gone, nests under its repo's main
 * on the same host. Siblings are ordered by their sort index.
 */
export function buildOriginTree<R extends SidebarRepo>(entries: WorktreeEntry<R>[]): OriginTree<R> {
  const byId = new Map(entries.map((e) => [e.worktreeId, e]));
  const childrenOf = new Map<string, WorktreeEntry<R>[]>();
  const parentOf = new Map<string, string>();
  const addChild = (parentId: string, entry: WorktreeEntry<R>) => {
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), entry]);
    parentOf.set(entry.worktreeId, parentId);
  };
  const hasLiveOrigin = (entry: WorktreeEntry<R>) => {
    const parentId = entry.worktree.origin?.worktreeId;
    return !!parentId && parentId !== entry.worktreeId && byId.has(parentId);
  };
  const isMain = (entry: WorktreeEntry<R>) =>
    entry.repo.kind !== "plain" && entry.worktree.name === entry.repo.defaultBranch;
  const mains = new Map<string, WorktreeEntry<R>>();
  for (const entry of entries) {
    if (isMain(entry) && !hasLiveOrigin(entry)) {
      mains.set(`${entry.repo.name}@${hostIdOf(entry.worktree)}`, entry);
    }
  }
  const roots: WorktreeEntry<R>[] = [];
  for (const entry of entries) {
    const origin = entry.worktree.origin;
    if (origin && hasLiveOrigin(entry)) {
      addChild(origin.worktreeId, entry);
      continue;
    }
    const main = mains.get(`${entry.repo.name}@${hostIdOf(entry.worktree)}`);
    if (main && main !== entry) addChild(main.worktreeId, entry);
    else roots.push(entry);
  }
  const compare = bySortIndex("sortIndex");
  roots.sort(compare);
  for (const list of childrenOf.values()) list.sort(compare);
  return { entries, byId, roots, childrenOf, parentOf, hasLiveOrigin, isMain };
}

export interface PinnedTree<R extends SidebarRepo = SidebarRepo> {
  /** The pins in their own order. */
  pins: WorktreeEntry<R>[];
  /** The worktrees started from each pin or from one of its descendants, in order. */
  childrenOf: Map<string, WorktreeEntry<R>[]>;
  /** Every id the Pinned section shows: the pins and their descendants. */
  ids: Set<string>;
}

/**
 * The Pinned section's contents. A pin keeps the worktrees whose origin is that worktree, all the
 * way down, so they leave the normal tree. A descendant that is pinned itself stays its own pin.
 * Plain repos have no pins.
 */
export function buildPinnedTree<R extends SidebarRepo>(repos: R[]): PinnedTree<R> {
  const entries = entriesOf<R>(repos);
  const byId = new Map(entries.map((e) => [e.worktreeId, e]));
  const pins = entries
    .filter((e) => e.worktree.pinned && e.repo.kind !== "plain")
    .sort(bySortIndex("pinSortIndex"));
  const pinIds = new Set(pins.map((e) => e.worktreeId));
  const childrenOf = new Map<string, WorktreeEntry<R>[]>();
  for (const entry of entries) {
    const parentId = entry.worktree.origin?.worktreeId;
    if (!parentId || parentId === entry.worktreeId || !byId.has(parentId)) continue;
    if (pinIds.has(entry.worktreeId)) continue;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), entry]);
  }
  const compare = bySortIndex("sortIndex");
  for (const list of childrenOf.values()) list.sort(compare);
  const ids = new Set<string>();
  const stack = pins.map((e) => e.worktreeId);
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || ids.has(id)) continue;
    ids.add(id);
    for (const kid of childrenOf.get(id) ?? []) stack.push(kid.worktreeId);
  }
  return { pins, childrenOf, ids };
}

/** The repos without the worktrees the Pinned section shows. Plain repos are left alone. */
export function withoutPinned<R extends SidebarRepo>(
  repos: R[],
  tree: PinnedTree<R>,
): { repos: R[]; reposWithPinned: Set<string> } {
  const reposWithPinned = new Set<string>();
  const result = repos.map((repo) => {
    if (repo.kind === "plain") return repo;
    const kept = repo.worktrees.filter(
      (wt) => !tree.ids.has(toWorktreeId(repo.name, wt.name, wt.hostId)),
    );
    if (kept.length === repo.worktrees.length) return repo;
    reposWithPinned.add(repo.name);
    return { ...repo, worktrees: kept };
  });
  return { repos: result, reposWithPinned };
}

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export interface LabelGroup<R> {
  /** Null for the repos that carry no label (or one that no longer exists). */
  label: LabelDefinition | null;
  repos: R[];
}

/**
 * The repos under label headers, in the order the labels are defined, with unlabeled repos last.
 * With no labels defined there is one group with a null label. `filter` keeps only that label's
 * repos, as the web's label filter does.
 */
export function groupReposByLabel<R extends { label?: string }>(
  repos: R[],
  labels: readonly LabelDefinition[],
  filter: string | null = null,
): LabelGroup<R>[] {
  const known = new Set(labels.map((l) => l.id));
  const pool = filter ? repos.filter((r) => r.label === filter) : repos;
  if (labels.length === 0) return [{ label: null, repos: pool }];
  const groups: LabelGroup<R>[] = [];
  for (const label of labels) {
    const mine = pool.filter((r) => r.label === label.id);
    if (mine.length > 0) groups.push({ label, repos: mine });
  }
  const rest = pool.filter((r) => !r.label || !known.has(r.label));
  if (rest.length > 0) groups.push({ label: null, repos: rest });
  return groups;
}
