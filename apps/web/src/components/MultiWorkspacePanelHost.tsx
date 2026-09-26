import { useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toWorkspaceId, useProjects } from "@/dashboard";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { reconcileTerminalWorkspaces } from "../lib/terminal-cache";
import { forgetMissingWorkspaces } from "../lib/workspace-cold-park";
import { clearPerWorkspaceState } from "./per-workspace-state-store";

// ---------------------------------------------------------------------------
// Keeps every visited workspace's center dockview mounted, so switching back to
// any of them is instant: no remount, no layout restore, no refetch. Mirrors
// orca's `mountedWorktreeIdsRef` (use-terminal-workspace-foundation.ts): a
// workspace joins the set on first activation and leaves it only when it stops
// existing (deleted, worktree removed). There is no LRU and no cap. Memory is
// bounded by parking the heavy resources of hidden workspaces instead:
// terminals, LSP clients and file watchers of a cold workspace
// (`workspace-cold-park.ts`), and browser pages beyond a hidden-workspace
// budget (`browser-guest-retention.ts`).
// ---------------------------------------------------------------------------

// Hoisted style objects so the mounted-entry divs receive
// reference-equal `style` props across renders — React's
// reconciler short-circuits on `===` before walking individual
// CSS properties.
const ACTIVE_ENTRY_STYLE: React.CSSProperties = {
  visibility: "visible",
  contentVisibility: "visible",
};
const HIDDEN_ENTRY_STYLE: React.CSSProperties = {
  visibility: "hidden",
  contentVisibility: "hidden",
  pointerEvents: "none",
};

interface MultiWorkspacePanelHostProps {
  /**
   * Rendered when no workspace is selected (index route). Each panel gets a
   * Lucide-icon empty state — see `NoWorkspaceMessage` in SharedDockviewLayout.
   */
  emptyState: React.ReactNode;
  /**
   * Per-workspace render callback. Invoked once per mounted workspace; the
   * resulting subtree stays mounted until the workspace is deleted.
   * `wsActive` is `true` only for the currently-active workspace.
   */
  children: (workspaceId: string, wsActive: boolean) => React.ReactNode;
}

/**
 * Keeps the per-workspace center dockview of every visited workspace mounted.
 *
 * Active workspace is derived synchronously from the URL (no useEffect lag)
 * so the correct content is visible from the first paint after a route
 * change — no flash of the previous workspace.
 *
 * Each mounted entry renders inside an absolutely-positioned div that is shown
 * or hidden. The inactive entries keep their React subtrees (chat
 * subscriptions, editor state, dockview layout), which is what makes the
 * switch instant.
 */
export function MultiWorkspacePanelHost({ emptyState, children }: MultiWorkspacePanelHostProps) {
  // Insertion-ordered set of mounted workspace ids. Order only keeps the
  // rendered siblings stable; nothing is evicted by age or count.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Derive active workspace synchronously from pathname — no useEffect delay.
  // This ensures the visibility swap happens in the same render as the URL
  // change, eliminating the one-frame flash of the previous workspace.
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const prevWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);

  // Synchronously mount the active workspace so it renders on the very first
  // paint. Calling setState during render (in response to a derived-value
  // change) is the React 18+ equivalent of getDerivedStateFromProps — React
  // discards the in-progress render and immediately re-renders with the
  // updated state.
  if (activeWorkspaceId && !mounted.has(activeWorkspaceId)) {
    setMounted((prev) => {
      // Double-check inside updater in case of concurrent renders
      if (prev.has(activeWorkspaceId)) return prev;
      return new Set(prev).add(activeWorkspaceId);
    });
  }

  // Fade-in cue on workspace switch. Content-correctness is synchronous
  // (activeWorkspaceId is derived during render); this only masks the
  // hard cut with a 140ms opacity rise on the incoming content. A CSS
  // transition (not keyframes) so rapid workspace hopping retargets
  // mid-fade instead of restarting. Inactive entries stay
  // content-visibility:hidden — a true two-layer crossfade would force
  // both layers to paint.
  useLayoutEffect(() => {
    const prev = prevWorkspaceIdRef.current;
    prevWorkspaceIdRef.current = activeWorkspaceId;
    if (!prev || !activeWorkspaceId || prev === activeWorkspaceId) return;
    const el = wrapperRef.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.opacity = "0.6";
    const raf = requestAnimationFrame(() => {
      el.style.transition = "opacity 140ms cubic-bezier(0.23, 1, 0.32, 1)";
      el.style.opacity = "1";
    });
    return () => cancelAnimationFrame(raf);
  }, [activeWorkspaceId]);

  // Reconcile the mounted set against the projects query (issue #508). This is
  // the only way a workspace leaves the set. Without it a deleted workspace's
  // chat/file/terminal/browser subtrees stay mounted forever, keeping their
  // tRPC subscriptions, event listeners, stuck "in-progress" tool-call
  // animations, and React state alive against a workspaceId the server no
  // longer recognises (renderer observed at 1.68 GB heap, 167k listeners, 656
  // stuck animate-pulse spans after ~2 days of use).
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
  //   1. Effect notices the active workspace isn't in `validIds`, unmounts it.
  //   2. The synchronous "mount the active workspace" branch above re-adds it
  //      on the next render.
  //   3. Effect runs again, unmounts again. Infinite render loop.
  // Consequence: deleting the *currently-active* workspace leaves it mounted
  // until the user navigates somewhere else (clicking any other card in the
  // sidebar unmounts it on the next render).
  //
  // The `isLoading` guard distinguishes "query hasn't resolved yet" from
  // "query resolved to an empty list". `useProjects()` returns the empty
  // array fallback in both cases, so without this guard the initial render
  // before the query resolves would unmount every workspace.
  //
  // The `error` guard covers the same shape but for the FAILURE path:
  // `isLoading: false` + `data: undefined` (e.g. network blip, server
  // not yet ready) also collapses to `projects: EMPTY_PROJECTS`, which
  // would otherwise unmount every workspace on a transient hiccup.
  // We keep the set as-is until the next successful fetch heals it.
  const { projects, isLoading, error } = useProjects();
  useEffect(() => {
    if (isLoading || error) return;
    const validIds = new Set<string>();
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        validIds.add(toWorkspaceId(project.name, worktree.name));
      }
    }
    // Dispose cached terminals for workspaces that no longer exist (deleted /
    // worktree removed), mirroring the mounted-set reconcile below. The active
    // workspace is never disposed even if mid-delete (see the guard inside).
    reconcileTerminalWorkspaces(validIds, activeWorkspaceId);
    forgetMissingWorkspaces(validIds);
    setMounted((prev) => {
      // Steady-state fast-path: the projects query refetches every 30 s,
      // so this effect fires repeatedly with nothing to remove. Scan once to
      // detect a stale id before allocating the new Set.
      let hasStale = false;
      for (const id of prev) {
        if (!validIds.has(id) && id !== activeWorkspaceId) {
          hasStale = true;
          break;
        }
      }
      if (!hasStale) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id) || id === activeWorkspaceId) next.add(id);
      }
      return next;
    });
  }, [projects, isLoading, error, activeWorkspaceId]);

  // Detect unmounts by diffing the set across commits and clear the dropped
  // workspaces' cross-panel state. Lives in an effect (not the setState
  // updater) so React-driven double-invocations don't repeatedly call
  // `clearPerWorkspaceState` for the same workspaceId.
  const lastMountedRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    for (const prev of lastMountedRef.current) {
      if (!mounted.has(prev)) clearPerWorkspaceState(prev);
    }
    lastMountedRef.current = mounted;
  }, [mounted]);

  // The outer wrapper is `relative` (not `absolute`) so the inner absolute
  // entries anchor to THIS box — the dockview panel content area we live
  // inside isn't guaranteed to be `position: relative`, so without this
  // wrapper the inner divs would escape to the nearest positioned ancestor
  // (typically the AppShell) and stack on top of each other at the top-left
  // of the layout, on top of the tab strip.
  //
  // With no workspace selected (index route) every mounted entry stays in the
  // tree, hidden, under the empty state, so navigating back to one remains
  // instant.
  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      {!activeWorkspaceId && emptyState}
      {Array.from(mounted, (workspaceId) => {
        const isActive = workspaceId === activeWorkspaceId;
        return (
          <div
            key={workspaceId}
            // The testid exposes the mounted set to integration tests (see
            // `apps/web/e2e/workspace-cache-eviction.spec.ts` and
            // `workspace-switch-no-remount.spec.ts`): one entry per mounted
            // workspace makes "is this workspace still mounted?" observable
            // through the DOM without exporting internals. Embedding the
            // workspaceId in the attribute lets a test target a specific
            // entry directly. No `data-active` here — `WorkspaceCard` already
            // exposes that attribute on the sidebar card, and adding it to
            // these divs would multiply-match the existing
            // `locator('[data-active="true"]')` queries other specs use.
            data-testid={`workspace-panel-host__cached-entry--${workspaceId}`}
            // Hide inactive entries with `visibility: hidden` (universal
            // browser support) for the visual effect, AND
            // `content-visibility: hidden` on top as a progressive perf
            // enhancement on browsers that ship it. Safari hadn't yet
            // shipped `content-visibility` as of 18.4, so using it
            // alone would leave every hidden panel visible on Safari
            // and stack them on top of each other — flagged as a
            // blocker on PR #562.
            //
            // Why both, and not `display: none`:
            //   • `visibility: hidden` hides a subtree while keeping it laid
            //     out, so a hidden dockview keeps its size and does not
            //     re-lay-out on reveal. Pointer events are also blocked on
            //     the subtree automatically.
            //   • `content-visibility: hidden` additionally tells the
            //     browser to skip layout + paint work for the subtree
            //     entirely. Where it isn't supported it's a harmless no-op.
            //
            // `inert` keeps a hidden workspace from taking focus: without it
            // a focus() call or Tab key could land in a background editor or
            // chat composer. `pointer-events: none` stays as
            // belt-and-suspenders in case a descendant re-asserts visibility.
            // `band-workspace-entry` is the hook for the browser paint
            // retention rule in `globals.css`: a hidden entry holding a
            // browser tab that must keep painting (CDP screencast) drops
            // its `content-visibility` skip.
            className="band-workspace-entry absolute inset-0"
            style={isActive ? ACTIVE_ENTRY_STYLE : HIDDEN_ENTRY_STYLE}
            inert={!isActive}
          >
            {children(workspaceId, isActive)}
          </div>
        );
      })}
    </div>
  );
}
