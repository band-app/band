import { recordWorkspaceAccess } from "@band-app/dashboard-core";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { setWsActive } from "../lib/workspace-visibility-store";
import { DockviewWorkspaceLayout } from "./DockviewWorkspaceLayout";

// ---------------------------------------------------------------------------
// LRU cache for dockview workspace instances
// ---------------------------------------------------------------------------

interface CachedWorkspace {
  workspaceId: string;
  lastAccessed: number;
}

// Keep recently visited workspaces' dockview instances alive in memory so
// switching between them is instantaneous (no init cost, no layout shift).
// Bumped from 1 → 5 to eliminate flicker on the common A→B→A switch pattern.
const MAX_CACHED_WORKSPACES = 5;

/**
 * Manages multiple DockviewWorkspaceLayout instances with show/hide semantics.
 *
 * Instead of destroying and recreating dockview on workspace switch, this
 * component keeps each visited workspace's dockview alive (hidden via CSS
 * `opacity: 0`) and shows the active one. An LRU strategy evicts the
 * oldest cached instance when the cache exceeds MAX_CACHED_WORKSPACES.
 *
 * IMPORTANT: `activeWorkspaceId` is derived synchronously from pathname (not
 * via useEffect) so the correct workspace is visible from the very first
 * paint — preventing a flash of the previous workspace's content.
 *
 * Must be rendered inside AppShell (in __root.tsx) so it persists across
 * route param changes.
 */
export function DockviewInstanceManager() {
  const [cache, setCache] = useState<Map<string, CachedWorkspace>>(new Map());

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Derive active workspace synchronously from pathname — no useEffect delay.
  // This ensures the CSS display swap happens in the same render as the URL
  // change, eliminating the one-frame flash of the previous workspace.
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  // Synchronously ensure the active workspace is in the cache so it renders
  // on the very first paint.  Calling setState during render (in response to
  // a props/derived-value change) is the React 18 equivalent of
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

      // LRU eviction: remove the oldest entry (excluding current)
      if (next.size > MAX_CACHED_WORKSPACES) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
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

  // Update lastAccessed timestamp in a non-blocking effect (for LRU ordering).
  // This doesn't affect which workspace is visible — just eviction order.
  // Also record the access in localStorage for the workspace picker.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    recordWorkspaceAccess(activeWorkspaceId);
    setCache((prev) => {
      const existing = prev.get(activeWorkspaceId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(activeWorkspaceId, { ...existing, lastAccessed: Date.now() });
      return next;
    });
  }, [activeWorkspaceId]);

  // Ref so the eviction callback always reads the latest activeWorkspaceId
  // without needing it as a useCallback dependency.  This keeps
  // handleLayoutChange referentially stable across workspace switches,
  // preventing unnecessary re-renders of all DockviewWorkspaceLayout
  // instances (only the 2 whose isActive changed need to re-render).
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  // When the active workspace's STRUCTURAL layout changes (panel move,
  // resize, tab reorder), evict all hidden instances.  They'll recreate
  // fresh (loading the updated layout from the global localStorage key)
  // the next time the user navigates to them.
  // NOT called for simple tab activation — that's per-workspace state.
  const handleLayoutChange = useCallback(() => {
    setCache((prev) => {
      const awId = activeWorkspaceIdRef.current;
      if (!awId) return prev;
      const active = prev.get(awId);
      if (!active) return prev;
      if (prev.size === 1) return prev; // nothing to evict
      const next = new Map<string, CachedWorkspace>();
      next.set(awId, active);
      return next;
    });
  }, []);

  if (cache.size === 0 || activeWorkspaceId === null) return null;

  // Sync workspace visibility to the external store so leaf components
  // can subscribe via useWsActive() without Context cascade re-renders.
  // setWsActive is idempotent — safe to call during render.
  for (const { workspaceId } of cache.values()) {
    setWsActive(workspaceId, workspaceId === activeWorkspaceId);
  }

  return (
    <div className="absolute inset-0">
      {Array.from(cache.values()).map(({ workspaceId }) => {
        const isActive = workspaceId === activeWorkspaceId;
        return (
          <div
            key={workspaceId}
            className="absolute inset-0 transition-opacity duration-150 ease-out"
            style={{
              opacity: isActive ? 1 : 0,
              pointerEvents: isActive ? undefined : "none",
            }}
          >
            <DockviewWorkspaceLayout
              workspaceId={workspaceId}
              onLayoutChange={handleLayoutChange}
            />
          </div>
        );
      })}
    </div>
  );
}
