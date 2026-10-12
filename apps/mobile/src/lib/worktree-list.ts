/**
 * Turns `repos.list` and the status state into the sections the home screen shows. Pure, so the
 * ordering, filtering and badge rules are covered by node:test. They follow the web sidebar
 * (`apps/web/src/dashboard`): pinned worktrees first, a PR tag colored by CI state, and the older
 * CI icon for a branch with no PR.
 */

import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  type AgentState,
  agentStateOf,
  type BranchStatusLike,
  type CiStatusLike,
  type PullRequestLike,
  type StatusState,
} from "./status-state.ts";

export interface WorktreeLike {
  name: string;
  branch: string;
  pinned: boolean;
  hostId?: string;
  missing?: boolean;
  lifecycle?: "sleeping" | "waking";
}

export interface RepoLike {
  name: string;
  label?: string;
  kind?: "git" | "plain";
  worktrees: WorktreeLike[];
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
  name: string;
  branch: string;
  hostTag: string;
  pinned: boolean;
  missing: boolean;
  lifecycle?: "sleeping" | "waking";
  agent: AgentState;
  pr: PullRequestLike | null;
  prTone: PullRequestTone | null;
  ciTone: CiTone | null;
  dirty: boolean;
}

export interface RepoSection {
  name: string;
  title: string;
  collapsed: boolean;
  /** Rows in the repo before filtering; the header shows it. */
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
  needsMeOnly: boolean;
}

function toRow(
  repo: RepoLike,
  worktree: WorktreeLike,
  statuses: StatusState,
  hosts: readonly HostLike[],
): WorktreeRow {
  const id = toWorktreeId(repo.name, worktree.name, worktree.hostId);
  const branchStatus: BranchStatusLike | undefined = statuses.branches.get(id);
  const ci = branchStatus?.ci;
  const pr = ci?.pr ?? null;
  return {
    id,
    repo: repo.name,
    name: worktree.name,
    branch: worktree.branch,
    hostTag: hostLabel(worktree.hostId, hosts),
    pinned: worktree.pinned,
    missing: worktree.missing === true,
    lifecycle: worktree.lifecycle,
    agent: agentStateOf(statuses.agents.get(id)),
    pr,
    prTone: pr ? pullRequestTone(pr, ci?.state ?? "none") : null,
    ciTone: pr ? null : ciTone(ci),
    dirty: branchStatus?.git?.dirty === true,
  };
}

function matches(row: WorktreeRow, repoTitle: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.branch, repoTitle].some((text) => text.toLowerCase().includes(q));
}

/** Pinned first, then the hub's own order. */
function byPinned(a: WorktreeRow, b: WorktreeRow): number {
  return Number(b.pinned) - Number(a.pinned);
}

export function buildSections(repos: readonly RepoLike[], options: ListOptions): RepoSection[] {
  const filtering = options.query.trim() !== "" || options.needsMeOnly;
  const sections: RepoSection[] = [];
  for (const repo of repos) {
    const title = repo.label?.trim() || repo.name;
    const all = repo.worktrees.map((w) => toRow(repo, w, options.statuses, options.hosts));
    const rows = all
      .filter((row) => matches(row, title, options.query))
      .filter((row) => !options.needsMeOnly || row.agent === "attention")
      .sort(byPinned);
    // A filter shows only the repos it matches, so an empty repo header is noise there.
    if (filtering && rows.length === 0) continue;
    const collapsed = !filtering && options.collapsed.has(repo.name);
    sections.push({
      name: repo.name,
      title,
      collapsed,
      total: all.length,
      attention: all.filter((row) => row.agent === "attention").length,
      data: collapsed ? [] : rows,
    });
  }
  return sections;
}

/** How many worktrees across all repos wait for the user, whatever the filter shows. */
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
        return toRow(repo, worktree, statuses, hosts);
      }
    }
  }
  return null;
}
