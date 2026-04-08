import type { PlatformCapabilities } from "@band-app/dashboard-core";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

/**
 * Browser-like workspace history for Cmd+[ (back) and Cmd+] (forward).
 *
 * Tracks which workspaces the user visits in a stack with a cursor.
 * Navigating back/forward moves the cursor without pushing a new entry.
 * Any normal workspace visit truncates the forward stack — exactly like
 * a browser.
 *
 * Uses `capabilities.getWorkspaceHref()` when navigating so the user
 * lands on the last-viewed tab inside each workspace.
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

export function useNavigationHistory(
  routerNavigate: (href: string) => void,
  capabilities: PlatformCapabilities,
) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const stackRef = useRef<string[]>([]);
  const cursorRef = useRef(-1);
  const navigatingRef = useRef(false);

  // Track workspace changes → push onto the history stack (unless we caused it).
  useEffect(() => {
    const wsId = extractWorkspaceId(pathname);
    if (!wsId) return;

    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }

    const stack = stackRef.current;
    const cursor = cursorRef.current;

    // Don't push if we're already looking at this workspace.
    if (cursor >= 0 && stack[cursor] === wsId) return;

    // Truncate any forward entries and push.
    stackRef.current = [...stack.slice(0, cursor + 1), wsId];
    cursorRef.current = stackRef.current.length - 1;
  }, [pathname]);

  const goBack = useCallback(() => {
    if (cursorRef.current <= 0) return;
    cursorRef.current -= 1;
    navigatingRef.current = true;
    const wsId = stackRef.current[cursorRef.current];
    const href = capabilities.getWorkspaceHref?.(wsId);
    if (href) routerNavigate(href);
  }, [routerNavigate, capabilities]);

  const goForward = useCallback(() => {
    if (cursorRef.current >= stackRef.current.length - 1) return;
    cursorRef.current += 1;
    navigatingRef.current = true;
    const wsId = stackRef.current[cursorRef.current];
    const href = capabilities.getWorkspaceHref?.(wsId);
    if (href) routerNavigate(href);
  }, [routerNavigate, capabilities]);

  // Global Cmd+[ / Cmd+] listener (capture phase).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "[" && e.key !== "]") return;

      e.preventDefault();
      e.stopPropagation();

      if (e.key === "[") goBack();
      else goForward();
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [goBack, goForward]);
}
