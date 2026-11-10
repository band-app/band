/**
 * The client mod API. A mod is the `contributes.mod` of an extension (see `extension-manifest.ts`).
 * Its module is an ES module with a default export that Band calls with the `band` host object:
 *
 *   export default function (band) {
 *     band.override("sidebar.worktreeCard", (props, Default) =>
 *       band.React.createElement("div", null, band.React.createElement(Default), props.branch));
 *   }
 *
 * The module must not import or bundle React. It uses `band.React` so it shares Band's instance.
 * The mod runs in the page with the device token. These props are a public API, versioned with
 * `extensionApi`.
 */

/** Region names a mod may override. */
export const MOD_REGIONS = [
  "sidebar",
  "sidebar.repoGroup",
  "sidebar.worktreeCard",
  "worktree.header",
] as const;
export type ModRegion = (typeof MOD_REGIONS)[number];

export interface SidebarProps {
  /** Number of repos, or null while they load. */
  repoCount: number | null;
}

export interface RepoGroupProps {
  repoName: string;
  kind: "git" | "plain";
  collapsed: boolean;
  worktreeCount: number;
}

export interface WorktreeCardProps {
  worktreeId: string;
  repoName: string;
  /** The worktree's immutable name (its branch at creation). */
  branch: string;
  hostId: string | undefined;
  isActive: boolean;
  pinned: boolean;
  isRoot: boolean;
}

export interface WorktreeHeaderProps {
  /** Which layout the header belongs to. Mods override the center layout's headers only. */
  groupId: string;
  tabs: { id: string; title: string; selected: boolean }[];
}

export interface ModRegionProps {
  sidebar: SidebarProps;
  "sidebar.repoGroup": RepoGroupProps;
  "sidebar.worktreeCard": WorktreeCardProps;
  "worktree.header": WorktreeHeaderProps;
}

/** `(props, Default) => element`. `Default` renders the stock component with the stock props. */
export type ModOverride<R extends ModRegion> = (
  props: ModRegionProps[R],
  // biome-ignore lint/suspicious/noExplicitAny: React types are the host's, not this package's
  Default: any,
) => unknown;

/** The worktree row a `sidebar.items` transform sees. */
export interface SidebarItem {
  name: string;
  branch: string;
  hostId?: string;
  pinned: boolean;
}

/** Receives the worktrees of one repo in stock order and returns the ones to show, in order. */
export type SidebarItemsTransform = (
  items: SidebarItem[],
  context: { repoName: string },
) => SidebarItem[];

export interface BandModHost {
  /** Band's React instance. */
  // biome-ignore lint/suspicious/noExplicitAny: typed by the host
  React: any;
  /** Replaces a region. A later override of the same region wraps the earlier one. */
  override<R extends ModRegion>(region: R, render: ModOverride<R>): void;
  /** Reorders or filters the worktrees of each repo in the sidebar. */
  transformSidebarItems(fn: SidebarItemsTransform): void;
  hooks: {
    /** The agent status of a worktree: `idle`, `running`, `needs-attention` and so on. */
    useAgentStatus(worktreeId: string): string | undefined;
    /** Git branch status of a worktree (ahead, behind, changed files) or undefined. */
    useBranchStatus(worktreeId: string): Record<string, unknown> | undefined;
    /** The worktrees of every repo as `{ repoName, name, branch, hostId }`. */
    useWorktrees(): { repoName: string; name: string; branch: string; hostId?: string }[];
  };
  /** `extensionApi` this Band implements. */
  extensionApi: number;
  /** The extension that owns the mod being registered. */
  extensionId: string;
}
