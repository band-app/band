import { isFolderScope } from "@band-app/shared/scope-id";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toWorktreeId, useRepos } from "@/dashboard";
import { useWorktreeFromPath } from "../lib/parse-worktree";
import { reconcileTerminalWorktrees } from "../lib/terminal-cache";
import { forgetMissingWorktrees } from "../lib/worktree-cold-park";
import { clearPerWorktreeState } from "./per-worktree-state-store";

/**
 * The worktree ids the repos list knows. A project's folder view (`project:<id>`) is no repo
 * worktree, so it counts as known too: it stays mounted and keeps its terminals like a worktree.
 */
class WorktreeIds extends Set<string> {
  override has(id: string): boolean {
    return super.has(id) || isFolderScope(id);
  }
}

// ---------------------------------------------------------------------------
// Keeps every visited worktree's center dockview mounted, so switching back to
// any of them is instant: no remount, no chat replay, no layout restore, no
// refetch. Used by both layouts: `SharedDockviewLayout` (desktop) and
// `MobileWorktreeShell` (mobile). Mirrors
// orca's `mountedWorktreeIdsRef` (use-terminal-worktree-foundation.ts): a
// worktree joins the set on first activation and leaves it only when it stops
// existing (deleted, worktree removed). There is no LRU and no cap. Memory is
// bounded by parking the heavy resources of hidden worktrees instead:
// terminals, LSP clients and file watchers of a cold worktree
// (`worktree-cold-park.ts`), and browser pages beyond a hidden-worktree
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

interface MultiWorktreePanelHostProps {
  /**
   * Rendered when no worktree is selected (index route). Each panel gets a
   * Lucide-icon empty state — see `NoWorktreeMessage` in SharedDockviewLayout.
   */
  emptyState: React.ReactNode;
  /**
   * Per-worktree render callback. Invoked once per mounted worktree; the
   * resulting subtree stays mounted until the worktree is deleted.
   * `wsActive` is `true` only for the currently-active worktree.
   */
  children: (worktreeId: string, wsActive: boolean) => React.ReactNode;
}

/**
 * Keeps the per-worktree center dockview of every visited worktree mounted.
 *
 * Active worktree is derived synchronously from the URL (no useEffect lag)
 * so the correct content is visible from the first paint after a route
 * change — no flash of the previous worktree.
 *
 * Each mounted entry renders inside an absolutely-positioned div that is shown
 * or hidden. The inactive entries keep their React subtrees (chat
 * subscriptions, editor state, dockview layout), which is what makes the
 * switch instant.
 *
 * The swap is a hard cut on purpose. An opacity fade on the incoming entry
 * made every terminal in it blink on each switch.
 */
export function MultiWorktreePanelHost({ emptyState, children }: MultiWorktreePanelHostProps) {
  // Insertion-ordered set of mounted worktree ids. Order only keeps the
  // rendered siblings stable; nothing is evicted by age or count.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Derive active worktree synchronously from pathname — no useEffect delay.
  // This ensures the visibility swap happens in the same render as the URL
  // change, eliminating the one-frame flash of the previous worktree.
  const activeWorktreeId = useWorktreeFromPath(pathname);

  // Synchronously mount the active worktree so it renders on the very first
  // paint. Calling setState during render (in response to a derived-value
  // change) is the React 18+ equivalent of getDerivedStateFromProps — React
  // discards the in-progress render and immediately re-renders with the
  // updated state.
  if (activeWorktreeId && !mounted.has(activeWorktreeId)) {
    setMounted((prev) => {
      // Double-check inside updater in case of concurrent renders
      if (prev.has(activeWorktreeId)) return prev;
      return new Set(prev).add(activeWorktreeId);
    });
  }

  // Reconcile the mounted set against the repos query (issue #508). This is
  // the only way a worktree leaves the set. Without it a deleted worktree's
  // chat/file/terminal/browser subtrees stay mounted forever, keeping their
  // tRPC subscriptions, event listeners, stuck "in-progress" tool-call
  // animations, and React state alive against a worktreeId the server no
  // longer recognises (renderer observed at 1.68 GB heap, 167k listeners, 656
  // stuck animate-pulse spans after ~2 days of use).
  //
  // Using the repos query as the source of truth self-heals for ANY
  // disappearance path — dashboard delete button, manual worktree rm, external
  // git operation — not just `useRemoveWorktree`.
  //
  // The `id !== activeWorktreeId` guard is structural, not a UX nicety.
  // `activeWorktreeId` is URL-derived (`parseWorktreeFromPath(pathname)`),
  // so it stays pointing at a deleted worktree until the user navigates
  // away — `useRemoveWorktree.onSuccess` only updates the Zustand store's
  // `activeWorktreeId`, not the URL, so the two diverge during the
  // delete-the-active-worktree window. Without the guard:
  //   1. Effect notices the active worktree isn't in `validIds`, unmounts it.
  //   2. The synchronous "mount the active worktree" branch above re-adds it
  //      on the next render.
  //   3. Effect runs again, unmounts again. Infinite render loop.
  // Consequence: deleting the *currently-active* worktree leaves it mounted
  // until the user navigates somewhere else (clicking any other card in the
  // sidebar unmounts it on the next render).
  //
  // The `isLoading` guard distinguishes "query hasn't resolved yet" from
  // "query resolved to an empty list". `useRepos()` returns the empty
  // array fallback in both cases, so without this guard the initial render
  // before the query resolves would unmount every worktree.
  //
  // The `error` guard covers the same shape but for the FAILURE path:
  // `isLoading: false` + `data: undefined` (e.g. network blip, server
  // not yet ready) also collapses to `repos: EMPTY_REPOS`, which
  // would otherwise unmount every worktree on a transient hiccup.
  // We keep the set as-is until the next successful fetch heals it.
  const { repos, isLoading, error } = useRepos();
  useEffect(() => {
    if (isLoading || error) return;
    const validIds = new WorktreeIds();
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        validIds.add(toWorktreeId(repo.name, worktree.name));
      }
    }
    // Dispose cached terminals for worktrees that no longer exist (deleted /
    // worktree removed), mirroring the mounted-set reconcile below. The active
    // worktree is never disposed even if mid-delete (see the guard inside).
    reconcileTerminalWorktrees(validIds, activeWorktreeId);
    forgetMissingWorktrees(validIds);
    setMounted((prev) => {
      // Steady-state fast-path: the repos query refetches every 30 s,
      // so this effect fires repeatedly with nothing to remove. Scan once to
      // detect a stale id before allocating the new Set.
      let hasStale = false;
      for (const id of prev) {
        if (!validIds.has(id) && id !== activeWorktreeId) {
          hasStale = true;
          break;
        }
      }
      if (!hasStale) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id) || id === activeWorktreeId) next.add(id);
      }
      return next;
    });
  }, [repos, isLoading, error, activeWorktreeId]);

  // Detect unmounts by diffing the set across commits and clear the dropped
  // worktrees' cross-panel state. Lives in an effect (not the setState
  // updater) so React-driven double-invocations don't repeatedly call
  // `clearPerWorktreeState` for the same worktreeId.
  const lastMountedRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    for (const prev of lastMountedRef.current) {
      if (!mounted.has(prev)) clearPerWorktreeState(prev);
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
  // With no worktree selected (index route) every mounted entry stays in the
  // tree, hidden, under the empty state, so navigating back to one remains
  // instant.
  return (
    <div className="relative h-full w-full">
      {!activeWorktreeId && emptyState}
      {Array.from(mounted, (worktreeId) => {
        const isActive = worktreeId === activeWorktreeId;
        return (
          <div
            key={worktreeId}
            // The testid exposes the mounted set to integration tests (see
            // `apps/web/e2e/worktree-cache-eviction.spec.ts` and
            // `worktree-switch-no-remount.spec.ts`): one entry per mounted
            // worktree makes "is this worktree still mounted?" observable
            // through the DOM without exporting internals. Embedding the
            // worktreeId in the attribute lets a test target a specific
            // entry directly. No `data-active` here — `WorktreeCard` already
            // exposes that attribute on the sidebar card, and adding it to
            // these divs would multiply-match the existing
            // `locator('[data-active="true"]')` queries other specs use.
            data-testid={`worktree-panel-host__cached-entry--${worktreeId}`}
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
            // `inert` keeps a hidden worktree from taking focus: without it
            // a focus() call or Tab key could land in a background editor or
            // chat composer. `pointer-events: none` stays as
            // belt-and-suspenders in case a descendant re-asserts visibility.
            // `band-worktree-entry` is the hook for the browser paint
            // retention rule in `globals.css`: a hidden entry holding a
            // browser tab that must keep painting (CDP screencast) drops
            // its `content-visibility` skip.
            className="band-worktree-entry absolute inset-0"
            style={isActive ? ACTIVE_ENTRY_STYLE : HIDDEN_ENTRY_STYLE}
            inert={!isActive}
          >
            {children(worktreeId, isActive)}
          </div>
        );
      })}
    </div>
  );
}
