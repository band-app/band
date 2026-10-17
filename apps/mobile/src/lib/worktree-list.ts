/**
 * Turns `repos.list` and the status state into the sections the home screen shows. Pure, so the
 * ordering, filtering and badge rules are covered by node:test. They follow the web sidebar
 * (`apps/web/src/dashboard`): a Pinned section first (the pins in their order, each with the
 * worktrees started from it), a Group by choice of Repo, Origin or Host, repos under label headers
 * with a label filter, a PR tag colored by CI state, and the older CI icon for a branch with no PR.
 * The ordering and nesting come from `@band-app/shared/sidebar-tree`, which the web sidebar uses too.
 */

import {
  buildOriginTree,
  buildPinnedTree,
  entriesOf,
  groupReposByLabel,
  type LabelDefinition,
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
}

export interface RepoLike {
  name: string;
  /** A label id the web groups repos by, not a display name; the app shows `name`. */
  label?: string;
  kind?: "git" | "plain";
  defaultBranch?: string;
  /** The GitHub owner's avatar, served by the hub at `src`. */
  avatar?: { src: string; label: string } | null;
  worktrees: WorktreeLike[];
}

export type { LabelDefinition };

export interface HostLike {
  id: string;
  name?: string | null;
}

export type GroupBy = "repo" | "origin" | "host";

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "repo", label: "Repo" },
  { value: "origin", label: "Origin" },
  { value: "host", label: "Host" },
];

export function parseGroupBy(raw: string | null): GroupBy {
  return raw === "origin" || raw === "host" ? raw : "repo";
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
  name: string;
  branch: string;
  hostId: string;
  hostTag: string;
  /** True when the worktree is not on the hub's own host, so the row carries a host tag. */
  remote: boolean;
  pinned: boolean;
  /** The repo's main worktree, which the web marks with a house instead of a branch. */
  main: boolean;
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
  /** Nesting level in the Origin view. */
  depth: number;
}

export interface RepoSection {
  /** Collapse key: the repo name, or `host:<id>` in the Host view; `pinned` for Pinned. */
  name: string;
  title: string;
  kind: "pinned" | "repo" | "host" | "origin";
  /** The repo's name, for its avatar. */
  repo?: string;
  avatar?: { src: string; label: string } | null;
  /** Set on the first repo of a label group: the colored header drawn above it. */
  labelHeader?: { id: string | null; name: string; color: string | null };
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
  groupBy?: GroupBy;
  /** The label definitions (`settings.labels`). */
  labels?: readonly LabelDefinition[];
  /** A label id: only repos with that label show. Null or unset shows every repo. */
  labelFilter?: string | null;
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
    name: worktree.name,
    branch: worktree.branch,
    hostId,
    hostTag: hostLabel(worktree.hostId, hosts),
    remote: hostId !== LOCAL_HOST,
    pinned: worktree.pinned,
    main: repo.kind !== "plain" && worktree.name === repo.defaultBranch,
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
  };
}

/** The second line with the repo in front, for rows listed outside their repo's section. */
function withRepo(row: WorktreeRow): string {
  return [row.repoTitle, row.subtitle].filter(Boolean).join(" · ");
}

function matches(row: WorktreeRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.branch, row.repoTitle, row.hostTag, row.id].some((text) =>
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
  base: Pick<RepoSection, "name" | "title" | "kind" | "repo" | "avatar" | "labelHeader">,
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
  const groupBy = options.groupBy ?? "repo";
  const labels = options.labels ?? [];
  const labelFilter = options.labelFilter ?? null;
  const rowOf = (e: Entry) => toRow(e.repo, e.worktree, options.statuses, options.hosts, now);
  const visible = (row: WorktreeRow) => matches(row, options.query);

  // As on the web, the label filter narrows the pins, the Origin view and the Host view too.
  const kept = labelFilter ? repos.filter((r) => r.label === labelFilter) : [...repos];
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

  if (groupBy === "host") {
    const rows = restEntries.map((e) => rowOf(e));
    const hostIds = [...new Set(rows.map((r) => r.hostId))].sort(
      (a, b) => Number(b === LOCAL_HOST) - Number(a === LOCAL_HOST),
    );
    for (const hostId of hostIds) {
      const mine = rows.filter((r) => r.hostId === hostId);
      const shown = mine.filter(visible).map((r) => ({ ...r, subtitle: withRepo(r) }));
      if (filtering && shown.length === 0) continue;
      const key = `host:${hostId}`;
      sections.push(
        section(
          { name: key, title: hostLabel(hostId, options.hosts), kind: "host" },
          mine,
          shown,
          !filtering && options.collapsed.has(key),
        ),
      );
    }
    return sections;
  }

  if (groupBy === "origin") {
    const tree = buildOriginTree(restEntries);
    const all = treeRows(tree.entries, tree.roots, tree.childrenOf, rowOf).map((r) => ({
      ...r,
      subtitle: withRepo(r),
    }));
    const shown = all.filter(visible);
    if (all.length > 0 && (!filtering || shown.length > 0)) {
      sections.push(
        section({ name: "origin", title: "Origin", kind: "origin" }, all, shown, false),
      );
    }
    return sections;
  }

  const showHeaders = labels.length > 0 && !labelFilter;
  for (const group of groupReposByLabel(rest, labels, labelFilter)) {
    let first = true;
    for (const repo of group.repos) {
      const mine = repo.worktrees.map((worktree) =>
        rowOf({
          worktreeId: toWorktreeId(repo.name, worktree.name, worktree.hostId),
          repo,
          worktree,
        }),
      );
      const shown = mine.filter(visible);
      // A filter shows only the repos it matches, so an empty repo header is noise there.
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
            labelHeader:
              showHeaders && first
                ? {
                    id: group.label?.id ?? null,
                    name: group.label?.name ?? "Unlabeled",
                    color: group.label?.color ?? null,
                  }
                : undefined,
          },
          mine,
          shown,
          !filtering && options.collapsed.has(repo.name),
        ),
      );
      first = false;
    }
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
