import type { PlatformCapabilities } from "@band-app/dashboard-core";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-like workspace history powering the title-bar back/forward buttons.
 *
 * Tracks which workspaces the user visits in a stack with a cursor.
 * Navigating back/forward moves the cursor without pushing a new entry.
 * Any normal workspace visit truncates the forward stack — exactly like
 * a browser.
 *
 * Uses `capabilities.getWorkspaceHref()` when navigating so the user
 * lands on the last-viewed tab inside each workspace.
 *
 * Returns the `goBack`/`goForward` actions plus `canGoBack`/`canGoForward`
 * flags so callers can render UI controls (e.g. arrow buttons in the title bar).
 */

const WS_PREFIX = "/workspace/";

/** Extract the decoded workspace ID from a pathname, or null if not on a workspace route. */
function extractWorkspaceId(pathname: string): string | null {
  if (!pathname.startsWith(WS_PREFIX)) return null;
  const rest = pathname.slice(WS_PREFIX.length);
  // The workspace ID is the first path segment (URL-encoded)
  const slash = rest.indexOf("/");
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  if (!encoded) return null;
  return decodeURIComponent(encoded);
}

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

  // Stack and cursor live in a single state object so consumers re-render
  // when canGoBack/canGoForward flip (used to enable/disable UI buttons).
  const [history, setHistory] = useState<HistoryState>(INITIAL_HISTORY);
  const navigatingRef = useRef(false);

  // Track workspace changes → push onto the history stack (unless we caused it).
  useEffect(() => {
    const wsId = extractWorkspaceId(pathname);
    if (!wsId) return;

    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }

    setHistory((prev) => {
      // Don't push if we're already looking at this workspace.
      if (prev.cursor >= 0 && prev.stack[prev.cursor] === wsId) return prev;
      // Truncate any forward entries and push.
      const stack = [...prev.stack.slice(0, prev.cursor + 1), wsId];
      return { stack, cursor: stack.length - 1 };
    });
  }, [pathname]);

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
      const href = capabilities.getWorkspaceHref?.(targetWsId);
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
      const href = capabilities.getWorkspaceHref?.(targetWsId);
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
