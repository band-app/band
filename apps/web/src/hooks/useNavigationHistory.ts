import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformCapabilities } from "@/dashboard";
import { useWorktreeFromPath } from "../lib/parse-worktree";

/**
 * Browser-like worktree history powering the title-bar back/forward buttons.
 *
 * Tracks which worktrees the user visits in a stack with a cursor.
 * Navigating back/forward moves the cursor without pushing a new entry.
 * Any normal worktree visit truncates the forward stack — exactly like
 * a browser.
 *
 * Uses `capabilities.getWorktreeHref()` to build the destination URL.
 * Post-#467, that's always the canonical `/worktree/$id` — there is no
 * per-tab sub-path to restore anymore, since tab state lives in the
 * mobile layout's local React state and the desktop dockview renders
 * every panel regardless of URL.
 *
 * Returns the `goBack`/`goForward` actions plus `canGoBack`/`canGoForward`
 * flags so callers can render UI controls (e.g. arrow buttons in the title bar).
 */

export interface NavigationHistoryReturn {
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface HistoryState {
  stack: string[];
  cursor: number;
}

const INITIAL_HISTORY: HistoryState = { stack: [], cursor: -1 };

export function useNavigationHistory(
  routerNavigate: (href: string) => void,
  capabilities: PlatformCapabilities,
): NavigationHistoryReturn {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A project's view (`/project/<name>`) counts as a visit to its scope id.
  const wsId = useWorktreeFromPath(pathname);

  // Stack and cursor live in a single state object so consumers re-render
  // when canGoBack/canGoForward flip (used to enable/disable UI buttons).
  const [history, setHistory] = useState<HistoryState>(INITIAL_HISTORY);
  const navigatingRef = useRef(false);

  // Track worktree changes → push onto the history stack (unless we caused it).
  useEffect(() => {
    // Reset first: a back or forward step onto an entry that no longer resolves (a deleted
    // project) parses to null, and must not swallow the next real visit.
    const caused = navigatingRef.current;
    navigatingRef.current = false;
    if (!wsId || caused) return;

    setHistory((prev) => {
      // Don't push if we're already looking at this worktree.
      if (prev.cursor >= 0 && prev.stack[prev.cursor] === wsId) return prev;
      // Truncate any forward entries and push.
      const stack = [...prev.stack.slice(0, prev.cursor + 1), wsId];
      return { stack, cursor: stack.length - 1 };
    });
  }, [wsId]);

  const goBack = useCallback(() => {
    let didMove = false;
    let targetWsId: string | undefined;
    setHistory((prev) => {
      if (prev.cursor <= 0) return prev;
      didMove = true;
      const cursor = prev.cursor - 1;
      targetWsId = prev.stack[cursor];
      return { stack: prev.stack, cursor };
    });
    if (didMove && targetWsId) {
      navigatingRef.current = true;
      const href = capabilities.getWorktreeHref?.(targetWsId);
      if (href) routerNavigate(href);
    }
  }, [routerNavigate, capabilities]);

  const goForward = useCallback(() => {
    let didMove = false;
    let targetWsId: string | undefined;
    setHistory((prev) => {
      if (prev.cursor >= prev.stack.length - 1) return prev;
      didMove = true;
      const cursor = prev.cursor + 1;
      targetWsId = prev.stack[cursor];
      return { stack: prev.stack, cursor };
    });
    if (didMove && targetWsId) {
      navigatingRef.current = true;
      const href = capabilities.getWorktreeHref?.(targetWsId);
      if (href) routerNavigate(href);
    }
  }, [routerNavigate, capabilities]);

  return {
    goBack,
    goForward,
    canGoBack: history.cursor > 0,
    canGoForward: history.cursor >= 0 && history.cursor < history.stack.length - 1,
  };
}
