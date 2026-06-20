import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toWorkspaceId, useProjects, useSettingsQuery } from "@/dashboard";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { clearPerWorkspaceState } from "./per-workspace-state-store";

// ---------------------------------------------------------------------------
// Per-panel LRU cache: keeps the content of recently-visited workspaces alive
// so a workspace switch is instant, while everything *structural* about the
// dockview layout (panel positions, tab order, visibility, the project list)
// stays in the single shared dockview that owns this host.
// ---------------------------------------------------------------------------

interface CachedEntry {
  workspaceId: string;
  lastAccessed: number;
}

// Same defaults the old DockviewInstanceManager used — the only thing we're
// caching today is per-panel content rather than entire dockview instances.
const DEFAULT_MAX_CACHED_WORKSPACES = 3;
const MIN_MAX_CACHED_WORKSPACES = 1;

interface MultiWorkspacePanelHostProps {
  /**
   * Rendered when no workspace is selected (index route). Each panel gets a
   * Lucide-icon empty state — see `NoWorkspaceMessage` in SharedDockviewLayout.
   */
  emptyState: React.ReactNode;
  /**
   * Per-workspace render callback. Invoked once per cached workspace; the
   * resulting subtree stays mounted as long as the workspace is in the cache.
   * `wsActive` is `true` only for the currently-active workspace.
   */
  children: (workspaceId: string, wsActive: boolean) => React.ReactNode;
}

/**
 * Caches the content of a single dockview panel across workspace switches.
 *
 * Replaces the old outer `DockviewInstanceManager`, which cached entire
 * dockview instances and forced a structural-fingerprint eviction dance.
 * One `MultiWorkspacePanelHost` lives inside each per-workspace panel
 * (Chat, Changes, Files, Terminal, Browser); the dockview layout above it
 * is single and shared across all workspaces.
 *
 * Active workspace is derived synchronously from the URL (no useEffect lag)
 * so the correct content is visible from the first paint after a route
 * change — no flash of the previous workspace.
 *
 * Each cached entry renders inside an absolutely-positioned div whose opacity
 * is toggled to show/hide. The inactive entries continue running their React
 * subtrees (chat fetches, terminal scrollback, browser history…), which is
 * what makes the switch feel instant.
 */
export function MultiWorkspacePanelHost({ emptyState, children }: MultiWorkspacePanelHostProps) {
  const [cache, setCache] = useState<Map<string, CachedEntry>>(new Map());

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Max cached workspaces is user-configurable via settings. Clamp to a
  // sensible floor so a misconfigured value can't break caching entirely.
  const { settings } = useSettingsQuery();
  const maxCachedWorkspaces = Math.max(
    MIN_MAX_CACHED_WORKSPACES,
    settings.maxCachedWorkspaces ?? DEFAULT_MAX_CACHED_WORKSPACES,
  );

  // Derive active workspace synchronously from pathname — no useEffect delay.
  // This ensures the opacity swap happens in the same render as the URL
  // change, eliminating the one-frame flash of the previous workspace.
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  // Synchronously ensure the active workspace is in the cache so it renders
  // on the very first paint. Calling setState during render (in response to
  // a derived-value change) is the React 18 equivalent of
  // getDerivedStateFromProps — React discards the in-progress render and
  // immediately re-renders with the updated state.
  if (activeWorkspaceId && !cache.has(activeWorkspaceId)) {
    setCache((prev) => {
      // Double-check inside updater in case of concurrent renders
      if (prev.has(activeWorkspaceId)) return prev;
      const next = new Map(prev);
      next.set(activeWorkspaceId, {
        workspaceId: activeWorkspaceId,
        lastAccessed: Date.now(),
      });

      // LRU eviction: remove the oldest entry (excluding current). The
      // cross-panel state for the evicted workspace is cleaned up below
      // in a post-commit effect — NOT here in the updater, because React
      // is allowed to invoke the updater multiple times (StrictMode
      // double-invoke, concurrent interruptions) and side effects inside
      // it would fire more than once per actual eviction.
      if (next.size > maxCachedWorkspaces) {
        let oldestKey: string | null = null;
        let oldestTime = Number.POSITIVE_INFINITY;
        for (const [key, entry] of next) {
          if (key !== activeWorkspaceId && entry.lastAccessed < oldestTime) {
            oldestTime = entry.lastAccessed;
            oldestKey = key;
          }
        }
        if (oldestKey) next.delete(oldestKey);
      }

      return next;
    });
  }

  // Bump lastAccessed in an effect (post-commit), so LRU ordering reflects
  // the latest navigation. The global "recent workspaces" picker is now
  // pinged once per navigation by `SharedDockviewLayout` (rather than once
  // per panel host) so it's not duplicated here.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setCache((prev) => {
      const existing = prev.get(activeWorkspaceId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(activeWorkspaceId, { ...existing, lastAccessed: Date.now() });
      return next;
    });
  }, [activeWorkspaceId]);

  // Reconcile the cache against the projects query (issue #508). Capacity-based
  // LRU eviction only fires when a NEW workspace is added — it never notices
  // when a workspace *disappears* from the projects list. Without this effect a
  // deleted workspace's chat/file/terminal/browser subtrees stay mounted
  // forever, keeping their tRPC subscriptions, event listeners, stuck
  // "in-progress" tool-call animations, and React state alive against a
  // workspaceId the server no longer recognises (renderer observed at 1.68 GB
  // heap, 167k listeners, 656 stuck animate-pulse spans after ~2 days of use).
  //
  // Using the projects query as the source of truth self-heals for ANY
  // disappearance path — dashboard delete button, manual worktree rm, external
  // git operation — not just `useRemoveWorkspace`.
  //
  // The `id !== activeWorkspaceId` guard is structural, not a UX nicety.
  // `activeWorkspaceId` is URL-derived (`parseWorkspaceFromPath(pathname)`),
  // so it stays pointing at a deleted workspace until the user navigates
  // away — `useRemoveWorkspace.onSuccess` only updates the Zustand store's
  // `activeWorkspaceId`, not the URL, so the two diverge during the
  // delete-the-active-workspace window. Without the guard:
  //   1. Effect notices the active workspace isn't in `validIds`, evicts.
  //   2. The synchronous "add active workspace to cache" branch above re-
  //      adds it on the next render.
  //   3. Effect runs again, evicts again. Infinite render loop.
  // Consequence: deleting the *currently-active* workspace leaves its
  // cache entry alive until the user navigates somewhere else (clicking
  // any other card in the sidebar fires the eviction on the next render).
  // That's an acceptable trade-off — the original bug was about *non-
  // active* cached workspaces accumulating across days of use; the active
  // case self-heals at the next workspace switch.
  //
  // The `isLoading` guard distinguishes "query hasn't resolved yet" from
  // "query resolved to an empty list". `useProjects()` returns the empty
  // array fallback in both cases, so without this guard the initial render
  // before the query resolves would evict every cached workspace.
  //
  // The `error` guard covers the same shape but for the FAILURE path:
  // `isLoading: false` + `data: undefined` (e.g. network blip, server
  // not yet ready) also collapses to `projects: EMPTY_PROJECTS`, which
  // would otherwise evict every cached workspace on a transient hiccup.
  // We keep the cache as-is until the next successful fetch heals it.
  const { projects, isLoading, error } = useProjects();
  useEffect(() => {
    if (isLoading || error) return;
    const validIds = new Set<string>();
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        validIds.add(toWorkspaceId(project.name, worktree.branch));
      }
    }
    setCache((prev) => {
      // Steady-state fast-path: the projects query refetches every 30 s,
      // so this effect fires repeatedly with no actual eviction work to
      // do. Scan once to detect a stale id before allocating the new Map.
      let hasStale = false;
      for (const id of prev.keys()) {
        if (!validIds.has(id) && id !== activeWorkspaceId) {
          hasStale = true;
          break;
        }
      }
      if (!hasStale) return prev;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!validIds.has(id) && id !== activeWorkspaceId) {
          next.delete(id);
        }
      }
      return next;
    });
  }, [projects, isLoading, error, activeWorkspaceId]);

  // Detect evictions by diffing the cache key set across commits and clear
  // the dropped workspaces' cross-panel state. Lives in an effect (not the
  // setState updater) so React-driven double-invocations don't repeatedly
  // call `clearPerWorkspaceState` for the same workspaceId.
  const lastCacheKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(cache.keys());
    for (const prev of lastCacheKeysRef.current) {
      if (!current.has(prev)) clearPerWorkspaceState(prev);
    }
    lastCacheKeysRef.current = current;
  }, [cache]);

  // No workspace selected: render the empty state. Cached entries stay alive
  // in `cache` so navigating back to a workspace remains instant; they're
  // just visually replaced by the empty state. The wrapper still claims the
  // full panel rect (h-full w-full) so the empty state fills the panel.
  if (!activeWorkspaceId) return <div className="relative h-full w-full">{emptyState}</div>;

  // The outer wrapper is `relative` (not `absolute`) so the inner absolute
  // entries anchor to THIS box — the dockview panel content area we live
  // inside isn't guaranteed to be `position: relative`, so without this
  // wrapper the inner divs would escape to the nearest positioned ancestor
  // (typically the AppShell) and stack on top of each other at the top-left
  // of the layout, on top of the tab strip.
  return (
    <div className="relative h-full w-full">
      {Array.from(cache.values()).map(({ workspaceId }) => {
        const isActive = workspaceId === activeWorkspaceId;
        return (
          <div
            key={workspaceId}
            // The testid exposes the LRU cache shape to integration tests
            // (see `apps/web/e2e/workspace-cache-eviction.spec.ts`): one
            // entry per cached workspace makes "did the cache evict this
            // deleted workspace?" observable through the DOM without
            // exporting internals. Embedding the workspaceId in the
            // attribute lets a test target a specific entry directly.
            // No `data-active` here — `WorkspaceCard` already exposes
            // that attribute on the sidebar card, and adding it to the
            // cached entry divs would multiply-match the existing
            // `locator('[data-active="true"]')` queries other specs use.
            data-testid={`workspace-panel-host__cached-entry--${workspaceId}`}
            // Hide inactive entries with `visibility: hidden` (universal
            // browser support) for the visual effect, AND
            // `content-visibility: hidden` on top as a progressive perf
            // enhancement on browsers that ship it. Safari hadn't yet
            // shipped `content-visibility` as of 18.4, so using it
            // alone would leave every cached panel visible on Safari
            // and stack them on top of each other — flagged as a
            // blocker on PR #562.
            //
            // Why both:
            //   • `visibility: hidden` is the cross-browser way to
            //     hide a subtree while keeping it laid out and its
            //     React state alive. Pointer events are also blocked
            //     on the subtree automatically.
            //   • `content-visibility: hidden` additionally tells the
            //     browser to skip layout + paint work for the subtree
            //     entirely. Where it's supported it's the per-frame
            //     CPU win we originally chased (opacity-0 still paid
            //     the full layout + paint cost). Where it isn't, it's
            //     a harmless no-op.
            //
            // We also keep `pointer-events: none` as belt-and-suspenders.
            // `visibility: hidden` already blocks hit-testing on every
            // browser, but the explicit prop guarantees the same in
            // case a future style override re-asserts visibility on a
            // descendant.
            className="absolute inset-0"
            style={{
              visibility: isActive ? "visible" : "hidden",
              contentVisibility: isActive ? "visible" : "hidden",
              pointerEvents: isActive ? undefined : "none",
            }}
          >
            {children(workspaceId, isActive)}
          </div>
        );
      })}
    </div>
  );
}
