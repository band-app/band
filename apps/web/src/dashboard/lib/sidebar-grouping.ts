import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useSyncExternalStore } from "react";
import type { RepoInfo, WorktreeInfo } from "../types";

export type GroupBy = "repo" | "origin" | "host";

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "repo", label: "Repo" },
  { value: "origin", label: "Origin" },
  { value: "host", label: "Host" },
];

/** Per device on purpose: a phone and a desktop may want different views. */
export const GROUP_BY_KEY = "band.sidebar.group-by";
/** Collapsed origin parents (worktree ids) and host groups. */
export const ORIGIN_COLLAPSE_KEY = "band.sidebar.collapsed-origins";
export const HOST_COLLAPSE_KEY = "band.sidebar.collapsed-hosts";

const LOCAL_HOST = "local";

function readGroupBy(): GroupBy {
  try {
    const value = window.localStorage.getItem(GROUP_BY_KEY);
    if (value === "origin" || value === "host" || value === "repo") return value;
  } catch {
    // Storage blocked: fall back to the default.
  }
  return "repo";
}

let current: GroupBy | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): GroupBy {
  if (current === null) current = readGroupBy();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setGroupBy(value: GroupBy): void {
  current = value;
  try {
    window.localStorage.setItem(GROUP_BY_KEY, value);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  for (const listener of listeners) listener();
}

export function useGroupBy(): [GroupBy, (value: GroupBy) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => "repo" as GroupBy);
  return [value, setGroupBy];
}

export interface WorktreeEntry {
  worktreeId: string;
  repo: RepoInfo;
  worktree: WorktreeInfo;
}

export interface HostInfoLite {
  id: string;
  name?: string | null;
  status?: string;
}

/** A row of the Origin or Host view, in display order. */
export type GroupedRow =
  | {
      kind: "worktree";
      key: string;
      entry: WorktreeEntry;
      depth: number;
      /** Number of worktrees started from this one. */
      childCount: number;
      collapsed: boolean;
      /** The worktree names an origin that no longer exists. */
      parentRemoved: boolean;
      /** Set on the rows of the Pinned section. */
      pinned?: boolean;
    }
  | {
      kind: "host";
      key: string;
      hostId: string;
      name: string;
      status: string;
      collapsed: boolean;
      count: number;
    }
  | {
      kind: "repo";
      key: string;
      hostId: string;
      repo: RepoInfo;
      collapsed: boolean;
    };

export type WorktreeRow = Extract<GroupedRow, { kind: "worktree" }>;

export function entriesOf(repos: RepoInfo[]): WorktreeEntry[] {
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
function bySortIndex(field: SortField) {
  return (a: WorktreeEntry, b: WorktreeEntry): number => {
    const x = a.worktree[field];
    const y = b.worktree[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  };
}

/** Each repo's worktrees in the order the user dragged them to. Without an index the order stays. */
export function sortRepoWorktrees(repos: RepoInfo[]): RepoInfo[] {
  const compare = bySortIndex("sortIndex");
  return repos.map((repo) => {
    const entries = repo.worktrees.map((worktree) => ({
      worktreeId: "",
      repo,
      worktree,
    }));
    entries.sort(compare);
    return { ...repo, worktrees: entries.map((e) => e.worktree) };
  });
}

export interface OriginTree {
  entries: WorktreeEntry[];
  byId: Map<string, WorktreeEntry>;
  roots: WorktreeEntry[];
  /** Children shown under each worktree, in order. */
  childrenOf: Map<string, WorktreeEntry[]>;
  /** The worktree a row is nested under, or undefined for a top-level row. */
  parentOf: Map<string, string>;
  hasLiveOrigin: (entry: WorktreeEntry) => boolean;
  /** A repo's main worktree: where work with no origin is listed. */
  isMain: (entry: WorktreeEntry) => boolean;
}

/**
 * The Origin tree: each repo's main worktree at the top level, with everything started from it
 * nested under it. A worktree with no origin, or whose origin is gone, nests under its repo's main
 * on the same host. Siblings are ordered by their sort index.
 */
export function buildOriginTree(entries: WorktreeEntry[]): OriginTree {
  const byId = new Map(entries.map((e) => [e.worktreeId, e]));
  const childrenOf = new Map<string, WorktreeEntry[]>();
  const parentOf = new Map<string, string>();
  const addChild = (parentId: string, entry: WorktreeEntry) => {
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), entry]);
    parentOf.set(entry.worktreeId, parentId);
  };
  const hasLiveOrigin = (entry: WorktreeEntry) => {
    const parentId = entry.worktree.origin?.worktreeId;
    return !!parentId && parentId !== entry.worktreeId && byId.has(parentId);
  };
  const isMain = (entry: WorktreeEntry) =>
    entry.repo.kind !== "plain" && entry.worktree.name === entry.repo.defaultBranch;
  const mains = new Map<string, WorktreeEntry>();
  for (const entry of entries) {
    if (isMain(entry) && !hasLiveOrigin(entry)) {
      mains.set(`${entry.repo.name}@${hostIdOf(entry.worktree)}`, entry);
    }
  }
  const roots: WorktreeEntry[] = [];
  for (const entry of entries) {
    if (hasLiveOrigin(entry)) {
      addChild(entry.worktree.origin!.worktreeId, entry);
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

/** True when `candidate` is `id` itself or sits anywhere below it in the tree. */
export function isInSubtree(
  childrenOf: Map<string, WorktreeEntry[]>,
  id: string,
  candidate: string,
): boolean {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === candidate) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const kid of childrenOf.get(current) ?? []) stack.push(kid.worktreeId);
  }
  return false;
}

export interface PinnedTree {
  /** The pins in their own order. */
  pins: WorktreeEntry[];
  /** The worktrees started from each pin or from one of its descendants, in order. */
  childrenOf: Map<string, WorktreeEntry[]>;
  /** Every id the Pinned section shows: the pins and their descendants. */
  ids: Set<string>;
}

/**
 * The Pinned section's contents. A pin keeps the worktrees whose origin is that worktree, all the
 * way down, so they leave the normal tree. A descendant that is pinned itself stays its own pin.
 * Plain repos have no pins.
 */
export function buildPinnedTree(repos: RepoInfo[]): PinnedTree {
  const entries = entriesOf(repos);
  const byId = new Map(entries.map((e) => [e.worktreeId, e]));
  const pins = entries
    .filter((e) => e.worktree.pinned && e.repo.kind !== "plain")
    .sort(bySortIndex("pinSortIndex"));
  const pinIds = new Set(pins.map((e) => e.worktreeId));
  const childrenOf = new Map<string, WorktreeEntry[]>();
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
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const kid of childrenOf.get(id) ?? []) stack.push(kid.worktreeId);
  }
  return { pins, childrenOf, ids };
}

/** The Pinned section's rows, a pin followed by its subtree unless it is collapsed. */
export function buildPinnedRows(
  tree: PinnedTree,
  isCollapsed: (id: string) => boolean,
): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  const seen = new Set<string>();
  const visit = (entry: WorktreeEntry, depth: number) => {
    if (seen.has(entry.worktreeId)) return;
    seen.add(entry.worktreeId);
    const kids = tree.childrenOf.get(entry.worktreeId) ?? [];
    const collapsed = kids.length > 0 && isCollapsed(entry.worktreeId);
    rows.push({
      kind: "worktree",
      key: `pinned/${entry.worktreeId}`,
      entry,
      depth,
      childCount: kids.length,
      collapsed,
      parentRemoved: false,
      pinned: true,
    });
    if (collapsed) return;
    for (const kid of kids) visit(kid, depth + 1);
  };
  for (const pin of tree.pins) visit(pin, 0);
  return rows;
}

/** The repos without the worktrees the Pinned section shows. Plain repos are left alone. */
export function withoutPinned(
  repos: RepoInfo[],
  tree: PinnedTree,
): { repos: RepoInfo[]; reposWithPinned: Set<string> } {
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

/**
 * The Origin view: each repo's main worktree at the top level, with everything started from it
 * nested under it. A worktree with no origin, or whose origin is gone, nests under its repo's main
 * on the same host. Children are listed in repo order. A collapsed parent hides its subtree.
 */
export function buildOriginRows(
  repos: RepoInfo[],
  isCollapsed: (id: string) => boolean,
): GroupedRow[] {
  const tree = buildOriginTree(entriesOf(repos));
  const { entries, childrenOf, roots, hasLiveOrigin } = tree;
  const rows: GroupedRow[] = [];
  const seen = new Set<string>();
  const visit = (entry: WorktreeEntry, depth: number) => {
    if (seen.has(entry.worktreeId)) return;
    seen.add(entry.worktreeId);
    const kids = childrenOf.get(entry.worktreeId) ?? [];
    const collapsed = kids.length > 0 && isCollapsed(entry.worktreeId);
    rows.push({
      kind: "worktree",
      key: entry.worktreeId,
      entry,
      depth,
      childCount: kids.length,
      collapsed,
      parentRemoved: !hasLiveOrigin(entry) && entry.worktree.origin?.removed === true,
    });
    if (collapsed) {
      hide(entry.worktreeId);
      return;
    }
    for (const kid of kids) visit(kid, depth + 1);
  };
  // A collapsed parent's subtree stays hidden, so the cycle fallback below must not list it.
  const hide = (id: string) => {
    for (const kid of childrenOf.get(id) ?? []) {
      if (seen.has(kid.worktreeId)) continue;
      seen.add(kid.worktreeId);
      hide(kid.worktreeId);
    }
  };
  for (const root of roots) visit(root, 0);
  // A cycle among origins would hide its members: show anything left at the top level.
  for (const entry of entries) visit(entry, 0);
  return rows;
}

/** The name a host tag shows. */
export function hostLabel(hostId: string, hosts: HostInfoLite[]): string {
  if (hostId === LOCAL_HOST) return "This hub";
  return hosts.find((h) => h.id === hostId)?.name?.trim() || "unknown host";
}

/** True when a repo has worktrees on more than one host. */
export function repoSpansHosts(repo: RepoInfo): boolean {
  return new Set(repo.worktrees.map(hostIdOf)).size > 1;
}

export function hostIdOf(worktree: WorktreeInfo): string {
  return worktree.hostId || LOCAL_HOST;
}

/** The Host view: a group per worker (the hub's own machine first), then a subgroup per repo. */
export function buildHostRows(
  repos: RepoInfo[],
  hosts: HostInfoLite[],
  isCollapsed: (id: string) => boolean,
): GroupedRow[] {
  const entries = entriesOf(repos);
  // The hub's own machine has no row in the host list when it is turned off (BAND_LOCAL_HOST=off),
  // so it gets no group either.
  const localOff = hosts.length > 0 && !hosts.some((h) => h.id === LOCAL_HOST);
  const hostIds: string[] = [];
  for (const entry of entries) {
    const id = hostIdOf(entry.worktree);
    if (localOff && id === LOCAL_HOST) continue;
    if (!hostIds.includes(id)) hostIds.push(id);
  }
  hostIds.sort((a, b) => (a === LOCAL_HOST ? -1 : b === LOCAL_HOST ? 1 : 0));
  const rows: GroupedRow[] = [];
  for (const hostId of hostIds) {
    const hostEntries = entries.filter((e) => hostIdOf(e.worktree) === hostId);
    const host = hosts.find((h) => h.id === hostId);
    const hostKey = `host:${hostId}`;
    const hostCollapsed = isCollapsed(hostKey);
    rows.push({
      kind: "host",
      key: hostKey,
      hostId,
      name: hostId === LOCAL_HOST ? "This hub" : host?.name?.trim() || hostId,
      status: hostId === LOCAL_HOST ? "online" : (host?.status ?? "offline"),
      collapsed: hostCollapsed,
      count: hostEntries.length,
    });
    if (hostCollapsed) continue;
    const repoNames: string[] = [];
    for (const entry of hostEntries) {
      if (!repoNames.includes(entry.repo.name)) repoNames.push(entry.repo.name);
    }
    for (const repoName of repoNames) {
      const repoEntries = hostEntries.filter((e) => e.repo.name === repoName);
      const repoKey = `host:${hostId}/${repoName}`;
      const repoCollapsed = isCollapsed(repoKey);
      rows.push({
        kind: "repo",
        key: repoKey,
        hostId,
        repo: repoEntries[0].repo,
        collapsed: repoCollapsed,
      });
      if (repoCollapsed) continue;
      for (const entry of repoEntries) {
        rows.push({
          kind: "worktree",
          key: `${hostKey}/${entry.worktreeId}`,
          entry,
          depth: 0,
          childCount: 0,
          collapsed: false,
          parentRemoved: false,
        });
      }
    }
  }
  return rows;
}

/** The worktree ids keyboard navigation steps through, in display order. */
export function navigableIds(rows: GroupedRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "worktree" ? [r.entry.worktreeId] : []));
}
