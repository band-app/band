/**
 * The worktree this device type last showed, so a restart (desktop relaunch,
 * auto-update, opening the web build at `/`) lands back on it.
 *
 * The desktop app always loads `/`, and a phone's home-screen icon opens `/`
 * too, so without this every relaunch showed no worktree. The value is kept
 * on the server per device type (`band:last-worktree` in
 * `client-state-keys.ts`); leaving every worktree (the `/` route) removes
 * it, so a device that was last on `/` stays there.
 */

import { projectIdOfScope } from "@band-app/shared/scope-id";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { LABEL_FILTER_KEY } from "../dashboard/hooks/use-label-filter";
import { readLabelLastWorktrees } from "../dashboard/hooks/use-label-last-worktree";
import type { RepoInfo } from "../dashboard/types";
import { clientStorage } from "./client-state";

export const LAST_WORKTREE_KEY = "band:last-worktree";

/**
 * Set by `keepLastWorktreeOnce` when the start check couldn't tell whether
 * the saved worktree still exists (the repo list failed or was slow).
 */
let keepOnce = false;

/**
 * Don't let the next "no worktree on screen" clear the saved one. For a
 * launch that stayed on `/` only because the repo list didn't arrive in
 * time: the next launch should still try the saved worktree.
 */
export function keepLastWorktreeOnce(): void {
  keepOnce = true;
}

/** Record the worktree on screen, or null when none is. */
export function recordLastWorktree(worktreeId: string | null): void {
  if (keepOnce) {
    keepOnce = false;
    if (!worktreeId) return;
  }
  if (clientStorage.getItem(LAST_WORKTREE_KEY) === worktreeId) return;
  if (worktreeId) clientStorage.setItem(LAST_WORKTREE_KEY, worktreeId);
  else clientStorage.removeItem(LAST_WORKTREE_KEY);
}

/**
 * The worktree to open when the app starts on `/`, or null to stay there.
 * Call it after the global client state is hydrated.
 *
 * Starts from this device's last worktree. When a label is selected and the
 * worktree isn't under it (the label filter is shared between devices, so
 * another device may have changed it), the label's own last worktree wins,
 * the same one switching to that label would open; it also stands in when
 * the last worktree was deleted. A device last on `/` stays there. A project's
 * folder view is reopened while `projectIds` lists its project (or when the
 * project list could not be read).
 */
export function pickStartWorktree(
  repos: readonly RepoInfo[],
  projectIds: ReadonlySet<string> | null = null,
): string | null {
  const labelOf = new Map<string, string | undefined>();
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      labelOf.set(toWorktreeId(repo.name, wt.name), repo.label);
    }
  }

  const last = clientStorage.getItem(LAST_WORKTREE_KEY);
  const label = clientStorage.getItem(LABEL_FILTER_KEY);
  if (!last) return null;
  // A project's folder view has no label and is not in the repos list.
  const projectId = projectIdOfScope(last);
  if (projectId !== undefined) return !projectIds || projectIds.has(projectId) ? last : null;
  if (label && labelOf.get(last) !== label) {
    const labelled = readLabelLastWorktrees()[label];
    if (labelled && labelOf.get(labelled) === label) return labelled;
  }
  return labelOf.has(last) ? last : null;
}
