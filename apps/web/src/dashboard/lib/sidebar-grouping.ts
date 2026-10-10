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

function entriesOf(repos: RepoInfo[]): WorktreeEntry[] {
  return repos.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({
      worktreeId: toWorktreeId(repo.name, worktree.name),
      repo,
      worktree,
    })),
  );
}

/**
 * The Origin view: worktrees with no origin (or whose origin is gone) at the top level, each
 * one's children nested under it, in repo order. A collapsed parent hides its subtree.
 */
export function buildOriginRows(
  repos: RepoInfo[],
  isCollapsed: (id: string) => boolean,
): GroupedRow[] {
  const entries = entriesOf(repos);
  const byId = new Map(entries.map((e) => [e.worktreeId, e]));
  const childrenOf = new Map<string, WorktreeEntry[]>();
  const roots: WorktreeEntry[] = [];
  for (const entry of entries) {
    const parentId = entry.worktree.origin?.worktreeId;
    if (parentId && parentId !== entry.worktreeId && byId.has(parentId)) {
      childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), entry]);
    } else {
      roots.push(entry);
    }
  }
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
      parentRemoved: depth === 0 && entry.worktree.origin?.removed === true,
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
  const hostIds: string[] = [];
  for (const entry of entries) {
    const id = hostIdOf(entry.worktree);
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
