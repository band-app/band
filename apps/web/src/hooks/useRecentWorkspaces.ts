import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";

/**
 * Tracks the two most-recently-visited workspaces (MRU).
 *
 * Exposes `getPrevious()` which returns the workspace ID immediately
 * before the current one — used by Ctrl+Tab to toggle between the
 * current and previous workspace, the way ⌘-Tab toggles between apps.
 *
 * This is distinct from `useNavigationHistory`'s stack: that one models
 * browser-style back/forward with a cursor, this one models a true
 * most-recently-used pair.
 */
export function useRecentWorkspaces(): { getPrevious: () => string | null } {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentRef = useRef<string | null>(null);
  const previousRef = useRef<string | null>(null);

  useEffect(() => {
    const wsId = parseWorkspaceFromPath(pathname);
    if (!wsId) return;
    if (wsId === currentRef.current) return;
    previousRef.current = currentRef.current;
    currentRef.current = wsId;
  }, [pathname]);

  return {
    getPrevious: () => previousRef.current,
  };
}
