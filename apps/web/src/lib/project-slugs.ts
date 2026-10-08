/**
 * Project names (slugs) for the URL. A project's view is the worktree view of its scope id
 * (`project:<id>`), but its URL is `/project/<name>`, which reads better and survives being shared.
 * This module maps names to ids and back, from the last `projects.list` it saw, kept in
 * localStorage so a reload resolves its URL before the first query answers. The name is the
 * project's id in the CLI and its folder, and a rename changes only the title, so it is stable.
 */

import { projectIdOfScope, projectScopeId } from "@band-app/shared/scope-id";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "band.project-slugs";

let idByName = new Map<string, string>();
let nameById = new Map<string, string>();
let version = 0;
/** Whether a `projects.list` answered in this page load, so the maps are known to be complete. */
let listed = false;
const listeners = new Set<() => void>();

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const pairs: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
        idByName.set(pair[0], pair[1]);
        nameById.set(pair[1], pair[0]);
      }
    }
  } catch {}
}
load();

/** Records the projects a `projects.list` answered with. Re-renders URL readers on a change. */
export function rememberProjects(projects: ReadonlyArray<{ id: string; name: string }>): void {
  const next = new Map(projects.map((p) => [p.name, p.id] as const));
  const same = next.size === idByName.size && [...next].every(([n, id]) => idByName.get(n) === id);
  if (same && listed) return;
  listed = true;
  if (!same) {
    idByName = next;
    nameById = new Map(projects.map((p) => [p.id, p.name] as const));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {}
  }
  version++;
  for (const listener of listeners) listener();
}

/**
 * The project id a `/project/<slug>` names. A slug may also be the id itself (older links); an id
 * no list has named yet is trusted only until the first `projects.list` of this page load answers.
 */
export function projectIdForSlug(slug: string): string | undefined {
  if (idByName.has(slug)) return idByName.get(slug);
  return nameById.has(slug) || (!listed && slug.startsWith("prj-")) ? slug : undefined;
}

/** The URL of a project's view. */
export function projectHref(projectId: string): string {
  return `/project/${encodeURIComponent(nameById.get(projectId) ?? projectId)}`;
}

/** The URL of a worktree's view, or of a project's view for a project scope id. */
export function worktreeHref(worktreeId: string): string {
  const projectId = projectIdOfScope(worktreeId);
  return projectId ? projectHref(projectId) : `/worktree/${encodeURIComponent(worktreeId)}`;
}

/** The scope id a `/project/<slug>` pathname names, or null. */
export function projectScopeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/project\/([^/]+)/);
  if (!match) return null;
  const id = projectIdForSlug(decodeURIComponent(match[1]));
  return id ? projectScopeId(id) : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the caller when the name map changes, for code that reads the URL in render. */
export function useProjectSlugs(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
