import {
  buildOriginTree,
  buildPinnedTree,
  entriesOf,
  type GroupDefinition,
  groupEntries,
  hostIdOf,
  type OriginTree as SharedOriginTree,
  type PinnedTree as SharedPinnedTree,
  type WorktreeEntry as SharedWorktreeEntry,
  sortRepoWorktrees,
  UNGROUPED_KEY,
  withoutPinned,
} from "@band-app/shared/sidebar-tree";
import { useSyncExternalStore } from "react";
import type { RepoInfo } from "../types";

// The ordering and nesting rules live in shared so the mobile list applies the same ones.
export { buildOriginTree, buildPinnedTree, entriesOf, hostIdOf, sortRepoWorktrees, withoutPinned };
export type WorktreeEntry = SharedWorktreeEntry<RepoInfo>;
export type OriginTree = SharedOriginTree<RepoInfo>;
export type PinnedTree = SharedPinnedTree<RepoInfo>;

export type GroupBy = "groups" | "repo" | "origin" | "host";

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "groups", label: "Groups" },
  { value: "repo", label: "Repo" },
  { value: "origin", label: "Origin" },
  { value: "host", label: "Worker" },
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
    if (value === "groups" || value === "origin" || value === "host" || value === "repo") {
      return value;
    }
  } catch {
    // Storage blocked: fall back to the default.
  }
  return "groups";
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
  const value = useSyncExternalStore(subscribe, getSnapshot, () => "groups" as GroupBy);
  return [value, setGroupBy];
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
      /**
       * Groups view: the worktree was started from one in another group, so it is a top-level row
       * here. The row shows a chip that selects that parent.
       */
      fromParent?: { worktreeId: string; name: string };
    }
  | {
      kind: "group";
      key: string;
      /** Null for the Ungrouped section. */
      groupId: string | null;
      name: string;
      color: string | null;
      collapsed: boolean;
      count: number;
      /** The group filter shows this group alone: its header stays and cannot collapse. */
      filtered: boolean;
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

/** The rows of an origin tree, a worktree followed by its subtree unless it is collapsed. */
function originTreeRows(
  tree: OriginTree,
  isCollapsed: (id: string) => boolean,
  fromParentOf?: (entry: WorktreeEntry) => WorktreeRow["fromParent"],
): WorktreeRow[] {
  const { entries, childrenOf, roots, hasLiveOrigin } = tree;
  const rows: WorktreeRow[] = [];
  const seen = new Set<string>();
  const visit = (entry: WorktreeEntry, depth: number) => {
    if (seen.has(entry.worktreeId)) return;
    seen.add(entry.worktreeId);
    const kids = childrenOf.get(entry.worktreeId) ?? [];
    const collapsed = kids.length > 0 && isCollapsed(entry.worktreeId);
    const fromParent = fromParentOf?.(entry);
    rows.push({
      kind: "worktree",
      key: entry.worktreeId,
      entry,
      depth,
      childCount: kids.length,
      collapsed,
      parentRemoved: !hasLiveOrigin(entry) && entry.worktree.origin?.removed === true,
      ...(fromParent ? { fromParent } : {}),
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

/**
 * The Origin view: each repo's main worktree at the top level, with everything started from it
 * nested under it. A worktree with no origin, or whose origin is gone, nests under its repo's main
 * on the same host. Children are listed in repo order. A collapsed parent hides its subtree.
 */
export function buildOriginRows(
  repos: RepoInfo[],
  isCollapsed: (id: string) => boolean,
): GroupedRow[] {
  return originTreeRows(buildOriginTree(entriesOf(repos)), isCollapsed);
}

export interface GroupRowsInput {
  /** The repos to list: the group filter applied and the pinned worktrees left out. */
  repos: RepoInfo[];
  /** Every repo, to name the parent of a worktree whose parent is in another group or pinned. */
  allRepos: RepoInfo[];
  groups: readonly GroupDefinition[];
  /** The group the filter shows alone, or null for every group. */
  filter: string | null;
  isGroupCollapsed: (id: string) => boolean;
  isOriginCollapsed: (id: string) => boolean;
}

/**
 * The Groups view: a header per group in the order the groups are defined, then Ungrouped. Under
 * each header the group's worktrees as an origin tree, so a child nests under its parent when both
 * are in the group. A child whose parent is in another group is a top-level row with a `fromParent`
 * chip. A group filter shows that group alone, under its header.
 */
export function buildGroupRows(input: GroupRowsInput): GroupedRow[] {
  const { repos, allRepos, groups, filter, isGroupCollapsed, isOriginCollapsed } = input;
  const parents = new Map(entriesOf(allRepos).map((e) => [e.worktreeId, e]));
  const rows: GroupedRow[] = [];
  for (const section of groupEntries(entriesOf(repos), groups, filter)) {
    const inGroup = new Set(section.entries.map((e) => e.worktreeId));
    // A worktree started from one in another group is a top-level row here, not part of its main's.
    const parentElsewhere = (entry: WorktreeEntry) => {
      const parentId = entry.worktree.origin?.worktreeId;
      return !!parentId && parentId !== entry.worktreeId && !inGroup.has(parentId);
    };
    const tree = buildOriginTree(section.entries, {
      keepAtTop: (entry) =>
        parentElsewhere(entry) && parents.has(entry.worktree.origin!.worktreeId),
    });
    const groupKey = section.group?.id ?? UNGROUPED_KEY;
    const collapsed = !filter && isGroupCollapsed(groupKey);
    rows.push({
      kind: "group",
      key: `group:${groupKey}`,
      groupId: section.group?.id ?? null,
      name: section.group?.name ?? "Ungrouped",
      color: section.group?.color ?? null,
      collapsed,
      count: section.entries.length,
      filtered: !!filter,
    });
    if (collapsed) continue;
    rows.push(
      ...originTreeRows(tree, isOriginCollapsed, (entry) => {
        const origin = entry.worktree.origin;
        if (!origin || tree.hasLiveOrigin(entry)) return undefined;
        const parent = parents.get(origin.worktreeId);
        return parent ? { worktreeId: parent.worktreeId, name: parent.worktree.name } : undefined;
      }),
    );
  }
  return rows;
}

/** The name a host tag shows. */
export function hostLabel(hostId: string, hosts: HostInfoLite[]): string {
  if (hostId === LOCAL_HOST) return "This hub";
  return hosts.find((h) => h.id === hostId)?.name?.trim() || "unknown worker";
}

/** True when a repo has worktrees on more than one host. */
export function repoSpansHosts(repo: RepoInfo): boolean {
  return new Set(repo.worktrees.map(hostIdOf)).size > 1;
}

/** The Host view: a group per worker (the hub's own machine first), then a subgroup per repo. */
export function buildHostRows(
  repos: RepoInfo[],
  hosts: HostInfoLite[],
  isCollapsed: (id: string) => boolean,
): GroupedRow[] {
  const entries = entriesOf(repos);
  // The hub's own machine has no row in the host list when it is turned off (BAND_LOCAL_WORKER=off),
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
