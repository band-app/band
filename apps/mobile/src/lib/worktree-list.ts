/**
 * Turns `repos.list` and the status state into the sections the home screen shows. Pure, so the
 * ordering, filtering and badge rules are covered by node:test. They follow the web sidebar
 * (`apps/web/src/dashboard`): a Pinned section first (the pins in their order, each with the
 * worktrees started from it), one collapsible section per worktree group holding that group's
 * worktrees as an origin tree, a group filter that leaves the layout alone, a PR tag colored by CI
 * state, and the older CI icon for a branch with no PR. While the hub defines no group the
 * worktrees sit under their repos.
 * The ordering and nesting come from `@band-app/shared/sidebar-tree`, which the web sidebar uses too.
 */

import {
  buildOriginTree,
  buildPinnedTree,
  entriesOf,
  groupEntries,
  sortRepoWorktrees,
  type WorktreeEntry,
  withoutPinned,
} from "@band-app/shared/sidebar-tree";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  type AgentState,
  ageLabel,
  agentStateOf,
  type BranchStatusLike,
  type CiStatusLike,
  type PullRequestLike,
  type ShownState,
  type StatusState,
  shownStateOf,
} from "./status-state.ts";

export interface WorktreeLike {
  name: string;
  branch: string;
  pinned: boolean;
  /** Position among the repo's worktrees, set by dragging on the web. */
  sortIndex?: number;
  /** Position inside the Pinned section. */
  pinSortIndex?: number;
  hostId?: string;
  missing?: boolean;
  lifecycle?: "sleeping" | "waking";
  origin?: { worktreeId: string; removed: boolean } | null;
  /** The group the worktree is in; null or unset means Ungrouped. */
  groupId?: string | null;
  /** A custom title shown in place of the name; null or unset means none. */
  title?: string | null;
}

export interface RepoLike {
  name: string;
  kind?: "git" | "plain";
  defaultBranch?: string;
  /** The GitHub owner's avatar, served by the hub at `src`. */
  avatar?: { src: string; label: string } | null;
  worktrees: WorktreeLike[];
}

/** A worktree group as `repos.list` returns it. The color is user data. */
export interface GroupDefinition {
  id: string;
  name: string;
  color: string | null;
}

export interface HostLike {
  id: string;
  name?: string | null;
}

const LOCAL_HOST = "local";

/** The name a host tag shows, as on the web (`hostLabel` in `sidebar-grouping.ts`). */
export function hostLabel(hostId: string | undefined, hosts: readonly HostLike[]): string {
  const id = hostId || LOCAL_HOST;
  if (id === LOCAL_HOST) return "This hub";
  return hosts.find((h) => h.id === id)?.name?.trim() || id;
}

export type PullRequestTone = "failure" | "pending" | "success" | "neutral" | "merged" | "closed";

export function pullRequestTone(pr: PullRequestLike, ciState: string): PullRequestTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  switch (ciState) {
    case "failure":
      return "failure";
    case "running":
    case "pending":
      return "pending";
    case "success":
      return "success";
    default:
      return "neutral";
  }
}

export type CiTone = "failure" | "pending" | "success" | "merged";

/** The CI icon of a branch with no PR; null when there are no checks to show. */
export function ciTone(ci: CiStatusLike | undefined): CiTone | null {
  switch (ci?.state) {
    case "failure":
      return "failure";
    case "running":
    case "pending":
      return "pending";
    case "success":
      return "success";
    case "merged":
      return "merged";
    default:
      return null;
  }
}

export interface WorktreeRow {
  /** The worktree id, as the hub names it. */
  id: string;
  repo: string;
  /** The repo's display title. */
  repoTitle: string;
  /** The repo's avatar, for the worktree screen's header. */
  repoAvatar?: { src: string; label: string } | null;
  /** The worktree's identity, which requests name. `title` is what the list shows. */
  name: string;
  /** The custom title, or null when there is none. */
  title: string | null;
  branch: string;
  hostId: string;
  hostTag: string;
  /** True when the worktree is not on the hub's own host, so the row carries a host tag. */
  remote: boolean;
  pinned: boolean;
  /** The repo's main worktree, which the web and the mobile row mark with a star after its name. */
  main: boolean;
  /** The row is the single folder of a plain (non-git) repo. */
  plain: boolean;
  missing: boolean;
  lifecycle?: "sleeping" | "waking";
  agent: AgentState;
  shown: ShownState;
  /** "Working · 3 m", "Needs you · 12 m", or the branch when the agent never ran. */
  subtitle: string;
  pr: PullRequestLike | null;
  prTone: PullRequestTone | null;
  ciTone: CiTone | null;
  dirty: boolean;
  ahead: number;
  /** Nesting level under the worktree it was started from. */
  depth: number;
  /** The worktree it was started from, when that one exists. */
  parentId: string | null;
  /** The group it is in, or null for Ungrouped. */
  groupId: string | null;
}

export interface RepoSection {
  /** Collapse key: the repo name, `group:<id>` (`group:none` for Ungrouped) or `pinned`. */
  name: string;
  title: string;
  kind: "pinned" | "repo" | "group" | "top";
  /** The repo's name, for its avatar. */
  repo?: string;
  avatar?: { src: string; label: string } | null;
  /** Set on a group section: the dot beside its title. */
  group?: { id: string | null; color: string | null };
  collapsed: boolean;
  /** Rows in the section before filtering; the header shows it. */
  total: number;
  attention: number;
  /** Empty while the section is collapsed. */
  data: WorktreeRow[];
}

export interface ListOptions {
  statuses: StatusState;
  hosts: readonly HostLike[];
  collapsed: ReadonlySet<string>;
  query: string;
  /** The groups from `repos.list`. */
  groups?: readonly GroupDefinition[];
  /** A group id: only that group's worktrees show. Null or unset shows every worktree. */
  groupFilter?: string | null;
  now?: number;
}

const PINNED_KEY = "pinned";

function subtitleOf(
  shown: ShownState,
  age: string | null,
  branch: string,
  name: string,
  extras: string[],
): string {
  let head: string;
  switch (shown) {
    case "working":
      head = age ? `Working · ${age}` : "Working";
      break;
    case "question":
      head = age ? `Needs you · ${age}` : "Needs you";
      break;
    case "done":
      head = age ? `Finished · ${age}` : "Finished";
      break;
    case "failed":
      head = age ? `Failed · ${age}` : "Failed";
      break;
    case "monitoring":
      head = "Monitoring";
      break;
    default:
      head = age ? `Idle · ${age}` : branch !== name ? branch : "";
  }
  return [head, ...extras].filter(Boolean).join(" · ");
}

function toRow(
  repo: RepoLike,
  worktree: WorktreeLike,
  statuses: StatusState,
  hosts: readonly HostLike[],
  now: number,
): WorktreeRow {
  const id = toWorktreeId(repo.name, worktree.name, worktree.hostId);
  const branchStatus: BranchStatusLike | undefined = statuses.branches.get(id);
  const agentStatus = statuses.agents.get(id);
  const ci = branchStatus?.ci;
  const pr = ci?.pr ?? null;
  const hostId = worktree.hostId || LOCAL_HOST;
  const shown = shownStateOf(agentStatus);
  const extras: string[] = [];
  if (worktree.missing) extras.push("folder missing");
  if (worktree.lifecycle) extras.push(worktree.lifecycle);
  return {
    id,
    repo: repo.name,
    repoTitle: repo.name,
    repoAvatar: repo.avatar ?? null,
    name: worktree.name,
    title: worktree.title || null,
    branch: worktree.branch,
    hostId,
    hostTag: hostLabel(worktree.hostId, hosts),
    remote: hostId !== LOCAL_HOST,
    pinned: worktree.pinned,
    main: repo.kind !== "plain" && worktree.name === repo.defaultBranch,
    plain: repo.kind === "plain",
    missing: worktree.missing === true,
    lifecycle: worktree.lifecycle,
    agent: agentStateOf(agentStatus),
    shown,
    subtitle: subtitleOf(
      shown,
      ageLabel(agentStatus?.agent?.lastActivity, now),
      worktree.branch,
      worktree.name,
      extras,
    ),
    pr,
    prTone: pr ? pullRequestTone(pr, ci?.state ?? "none") : null,
    ciTone: pr ? null : ciTone(ci),
    dirty: branchStatus?.git?.dirty === true,
    ahead: branchStatus?.git?.ahead ?? 0,
    depth: 0,
    parentId: worktree.origin && !worktree.origin.removed ? worktree.origin.worktreeId : null,
    groupId: worktree.groupId ?? null,
  };
}

/** The second line with the repo in front, for rows listed outside their repo's section. */
function withRepo(row: WorktreeRow): string {
  return [row.repoTitle, row.subtitle].filter(Boolean).join(" · ");
}

function matches(row: WorktreeRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.title ?? "", row.branch, row.repoTitle, row.hostTag, row.id].some((text) =>
    text.toLowerCase().includes(q),
  );
}

type Entry = WorktreeEntry<RepoLike>;

/**
 * The rows of a tree in display order, each with its depth. A cycle among origins would hide its
 * members, so anything not reached from a root is listed at the top level afterwards.
 */
function treeRows(
  entries: Entry[],
  roots: Entry[],
  childrenOf: Map<string, Entry[]>,
  rowOf: (entry: Entry) => WorktreeRow,
): WorktreeRow[] {
  const out: WorktreeRow[] = [];
  const seen = new Set<string>();
  const visit = (entry: Entry, depth: number) => {
    if (seen.has(entry.worktreeId)) return;
    seen.add(entry.worktreeId);
    out.push({ ...rowOf(entry), depth });
    for (const kid of childrenOf.get(entry.worktreeId) ?? []) visit(kid, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const entry of entries) visit(entry, 0);
  return out;
}

function section(
  base: Pick<RepoSection, "name" | "title" | "kind" | "repo" | "avatar" | "group">,
  all: WorktreeRow[],
  shownRows: WorktreeRow[],
  collapsed: boolean,
): RepoSection {
  return {
    ...base,
    collapsed,
    total: all.length,
    attention: all.filter((row) => row.agent === "attention").length,
    data: collapsed ? [] : shownRows,
  };
}

export function buildSections(repos: readonly RepoLike[], options: ListOptions): RepoSection[] {
  const now = options.now ?? Date.now();
  const filtering = options.query.trim() !== "";
  const groups = options.groups ?? [];
  const groupFilter = options.groupFilter ?? null;
  const rowOf = (e: Entry) => toRow(e.repo, e.worktree, options.statuses, options.hosts, now);
  const visible = (row: WorktreeRow) => matches(row, options.query);

  // The group filter narrows the pins too. It works per worktree, so a repo stays with only the
  // worktrees that are in the group.
  const kept = groupFilter
    ? repos
        .map((r) => ({ ...r, worktrees: r.worktrees.filter((w) => w.groupId === groupFilter) }))
        .filter((r) => r.worktrees.length > 0)
    : [...repos];
  const sorted = sortRepoWorktrees(kept);
  const sections: RepoSection[] = [];

  const pinnedTree = buildPinnedTree(sorted);
  if (pinnedTree.pins.length > 0) {
    const all: WorktreeRow[] = [];
    const seen = new Set<string>();
    const visit = (entry: Entry, depth: number) => {
      if (seen.has(entry.worktreeId)) return;
      seen.add(entry.worktreeId);
      const row = rowOf(entry);
      all.push({ ...row, depth, subtitle: withRepo(row) });
      for (const kid of pinnedTree.childrenOf.get(entry.worktreeId) ?? []) visit(kid, depth + 1);
    };
    for (const pin of pinnedTree.pins) visit(pin, 0);
    const shown = all.filter(visible);
    if (shown.length > 0) {
      sections.push(
        section({ name: PINNED_KEY, title: "Pinned", kind: "pinned" }, all, shown, false),
      );
    }
  }

  const { repos: rest, reposWithPinned } = withoutPinned(sorted, pinnedTree);
  const restEntries = entriesOf(rest);

  if (groups.length > 0) {
    // A worktree started from one in another group stays at the top of its own group.
    const known = new Set(entriesOf(repos as RepoLike[]).map((e) => e.worktreeId));
    // Worktrees in no group come last as plain rows with no header.
    const parts = groupEntries(
      restEntries,
      groups.map((g) => ({ ...g, color: g.color ?? "" })),
      groupFilter,
    );
    const ordered = [...parts.filter((p) => p.group), ...parts.filter((p) => !p.group)];
    for (const part of ordered) {
      const inGroup = new Set(part.entries.map((e) => e.worktreeId));
      const tree = buildOriginTree(part.entries, {
        keepAtTop: (entry) => {
          const parentId = entry.worktree.origin?.worktreeId;
          return !!parentId && !inGroup.has(parentId) && known.has(parentId);
        },
      });
      const all = treeRows(tree.entries, tree.roots, tree.childrenOf, rowOf).map((r) => ({
        ...r,
        subtitle: withRepo(r),
      }));
      const shown = all.filter(visible);
      // A search shows only the groups it matches. Plain top-level rows show only while there are some.
      if (filtering && shown.length === 0) continue;
      if (!part.group && all.length === 0) continue;
      const key = `group:${part.group?.id ?? "none"}`;
      sections.push(
        section(
          {
            name: key,
            title: part.group?.name ?? "",
            kind: part.group ? "group" : "top",
            group: { id: part.group?.id ?? null, color: part.group?.color ?? null },
          },
          all,
          shown,
          // Rows with no group have no header to fold.
          part.group !== null && !filtering && options.collapsed.has(key),
        ),
      );
    }
    return sections;
  }

  for (const repo of rest) {
    const mine = repo.worktrees.map((worktree) =>
      rowOf({
        worktreeId: toWorktreeId(repo.name, worktree.name, worktree.hostId),
        repo,
        worktree,
      }),
    );
    const shown = mine.filter(visible);
    // A search shows only the repos it matches, so an empty repo header is noise there.
    if (filtering && shown.length === 0) continue;
    // A repo whose worktrees are all pinned has nothing left to list, so it gets no header.
    if (mine.length === 0 && reposWithPinned.has(repo.name)) continue;
    sections.push(
      section(
        {
          name: repo.name,
          title: repo.name,
          kind: "repo",
          repo: repo.name,
          avatar: repo.avatar ?? null,
        },
        mine,
        shown,
        !filtering && options.collapsed.has(repo.name),
      ),
    );
  }
  return sections;
}

/** How many worktrees across all repos wait for the user. */
export function countAttention(repos: readonly RepoLike[], statuses: StatusState): number {
  let count = 0;
  for (const repo of repos) {
    for (const w of repo.worktrees) {
      const id = toWorktreeId(repo.name, w.name, w.hostId);
      if (agentStateOf(statuses.agents.get(id)) === "attention") count++;
    }
  }
  return count;
}

export function findRow(
  repos: readonly RepoLike[],
  id: string,
  statuses: StatusState,
  hosts: readonly HostLike[],
): WorktreeRow | null {
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      if (toWorktreeId(repo.name, worktree.name, worktree.hostId) === id) {
        return toRow(repo, worktree, statuses, hosts, Date.now());
      }
    }
  }
  return null;
}
