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
  withoutPinned,
} from "@band-app/shared/sidebar-tree";
import type { RepoInfo } from "../types";

// The ordering and nesting rules live in shared so the mobile list applies the same ones.
export { buildOriginTree, buildPinnedTree, entriesOf, hostIdOf, sortRepoWorktrees, withoutPinned };
export type WorktreeEntry = SharedWorktreeEntry<RepoInfo>;
export type OriginTree = SharedOriginTree<RepoInfo>;
export type PinnedTree = SharedPinnedTree<RepoInfo>;

/** Collapsed origin parents (worktree ids). */
export const ORIGIN_COLLAPSE_KEY = "band.sidebar.collapsed-origins";

const LOCAL_HOST = "local";

export interface HostInfoLite {
  id: string;
  name?: string | null;
  status?: string;
}

/** A row of the grouped list, in display order. */
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
      /** Set on the rows of the worktrees that are in no group: plain top-level rows. */
      ungrouped?: boolean;
      /**
       * The worktree was started from one in another group, so it is a top-level row
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
    };

export type WorktreeRow = Extract<GroupedRow, { kind: "worktree" }>;

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
  ungrouped = false,
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
      ...(ungrouped ? { ungrouped } : {}),
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

/** A group section's origin tree. A worktree started from one in another group stays at the top. */
function sectionTree(
  section: { entries: WorktreeEntry[] },
  parents: ReadonlyMap<string, WorktreeEntry>,
): OriginTree {
  const inGroup = new Set(section.entries.map((e) => e.worktreeId));
  return buildOriginTree(section.entries, {
    keepAtTop: (entry) => {
      const parentId = entry.worktree.origin?.worktreeId;
      return (
        !!parentId &&
        parentId !== entry.worktreeId &&
        !inGroup.has(parentId) &&
        parents.has(parentId)
      );
    },
  });
}

/**
 * The worktrees with no group come first as plain top-level rows, with no header. Then a header per
 * group in the order the groups are defined, with the group's worktrees as an origin tree under it,
 * so a child nests under its parent when both are in the group. A child whose parent is in another
 * group is a top-level row with a `fromParent` chip. A group filter shows that group alone, laid out
 * exactly as in the full list.
 */
export function buildGroupRows(input: GroupRowsInput): GroupedRow[] {
  const { repos, allRepos, groups, filter, isGroupCollapsed, isOriginCollapsed } = input;
  const parents = new Map(entriesOf(allRepos).map((e) => [e.worktreeId, e]));
  const rows: GroupedRow[] = [];
  const sections = groupEntries(entriesOf(repos), groups, filter);
  const ordered = [...sections.filter((s) => !s.group), ...sections.filter((s) => s.group)];
  for (const section of ordered) {
    const tree = sectionTree(section, parents);
    const group = section.group;
    let collapsed = false;
    if (group) {
      collapsed = isGroupCollapsed(group.id);
      rows.push({
        kind: "group",
        key: `group:${group.id}`,
        groupId: group.id,
        name: group.name,
        color: group.color,
        collapsed,
        count: section.entries.length,
      });
    }
    if (collapsed) continue;
    rows.push(
      ...originTreeRows(
        tree,
        isOriginCollapsed,
        (entry) => {
          const origin = entry.worktree.origin;
          if (!origin || tree.hasLiveOrigin(entry)) return undefined;
          const parent = parents.get(origin.worktreeId);
          return parent ? { worktreeId: parent.worktreeId, name: parent.worktree.name } : undefined;
        },
        !group,
      ),
    );
  }
  return rows;
}

export interface CollapsibleKeys {
  /** The Pinned section has a header to fold. */
  pinned: boolean;
  /** Group ids whose header folds (a group nothing hides). */
  groups: string[];
  /** Worktree ids whose children fold, in the pins and in the group trees. */
  origins: string[];
  /** Repo names, while no group exists. */
  repos: string[];
}

/**
 * What the collapse-all button folds: the same headers and parents `buildGroupRows` lists for the
 * current filter. A group the filter hides keeps its state.
 */
export function collapsibleKeys(
  repos: RepoInfo[],
  groups: readonly GroupDefinition[],
  filter: string | null,
): CollapsibleKeys {
  const sorted = sortRepoWorktrees(repos);
  const visible = filter
    ? sorted
        .map((r) => ({ ...r, worktrees: r.worktrees.filter((wt) => wt.groupId === filter) }))
        .filter((r) => r.worktrees.length > 0)
    : sorted;
  const pinnedTree = buildPinnedTree(visible);
  const origins = new Set<string>();
  for (const [id, kids] of pinnedTree.childrenOf) if (kids.length > 0) origins.add(id);
  const rest = withoutPinned(visible, pinnedTree).repos;
  const result: CollapsibleKeys = {
    pinned: pinnedTree.pins.length > 0,
    groups: [],
    origins: [],
    repos: [],
  };
  if (groups.length === 0) {
    result.repos = rest.filter((r) => r.kind !== "plain").map((r) => r.name);
  } else {
    const parents = new Map(entriesOf(sorted).map((e) => [e.worktreeId, e]));
    for (const section of groupEntries(entriesOf(rest), groups, filter)) {
      if (section.group) result.groups.push(section.group.id);
      const tree = sectionTree(section, parents);
      for (const [id, kids] of tree.childrenOf) if (kids.length > 0) origins.add(id);
    }
  }
  result.origins = [...origins];
  return result;
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

/** The worktree ids keyboard navigation steps through, in display order. */
export function navigableIds(rows: GroupedRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "worktree" ? [r.entry.worktreeId] : []));
}
