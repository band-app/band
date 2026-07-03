import { useMemo } from "react";
import { toWorkspaceId } from "../lib/workspace-id";
import type { ProjectKind } from "../types";
import { useProjects } from "./use-projects";

/**
 * Lookup table mapping every known `workspaceId` to its parent project's
 * `kind`. Built once from `useProjects()` and memoized — callers do a
 * constant-time `map.get(id)` instead of the O(projects × worktrees) scan
 * each `DiffView` (or other workspace-scoped consumer) would have to run
 * on its own.
 *
 * Returns `undefined` for the lookup result while `useProjects()` is still
 * loading, or when the `workspaceId` doesn't match any tracked workspace.
 * Callers should treat `undefined` as "not yet known" rather than guessing
 * a default — the projects query refetches periodically and the value
 * will resolve on the next render.
 */
export function useProjectKindMap(): Map<string, ProjectKind> {
  const { projects } = useProjects();
  return useMemo(() => {
    const map = new Map<string, ProjectKind>();
    for (const p of projects) {
      for (const wt of p.worktrees) {
        map.set(toWorkspaceId(p.name, wt.name), p.kind);
      }
    }
    return map;
  }, [projects]);
}

/**
 * Convenience wrapper over `useProjectKindMap` for the common single-
 * workspace case. Returns `undefined` while `useProjects()` is still
 * loading or when the workspace isn't tracked.
 */
export function useProjectKindForWorkspace(workspaceId: string): ProjectKind | undefined {
  const map = useProjectKindMap();
  return map.get(workspaceId);
}
