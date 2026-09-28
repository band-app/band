/**
 * The workspace this device type last showed, so a restart (desktop relaunch,
 * auto-update, opening the web build at `/`) lands back on it.
 *
 * The desktop app always loads `/`, and a phone's home-screen icon opens `/`
 * too, so without this every relaunch showed no workspace. The value is kept
 * on the server per device type (`band:last-workspace` in
 * `client-state-keys.ts`); leaving every workspace (the `/` route) removes
 * it, so a device that was last on `/` stays there.
 */

import { LABEL_FILTER_KEY } from "../dashboard/hooks/use-label-filter";
import { readLabelLastWorkspaces } from "../dashboard/hooks/use-label-last-workspace";
import { toWorkspaceId } from "../dashboard/lib/workspace-id";
import type { ProjectInfo } from "../dashboard/types";
import { clientStorage } from "./client-state";

export const LAST_WORKSPACE_KEY = "band:last-workspace";

/**
 * Set by `keepLastWorkspaceOnce` when the start check couldn't tell whether
 * the saved workspace still exists (the project list failed or was slow).
 */
let keepOnce = false;

/**
 * Don't let the next "no workspace on screen" clear the saved one. For a
 * launch that stayed on `/` only because the project list didn't arrive in
 * time: the next launch should still try the saved workspace.
 */
export function keepLastWorkspaceOnce(): void {
  keepOnce = true;
}

/** Record the workspace on screen, or null when none is. */
export function recordLastWorkspace(workspaceId: string | null): void {
  if (keepOnce) {
    keepOnce = false;
    if (!workspaceId) return;
  }
  if (clientStorage.getItem(LAST_WORKSPACE_KEY) === workspaceId) return;
  if (workspaceId) clientStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
  else clientStorage.removeItem(LAST_WORKSPACE_KEY);
}

/**
 * The workspace to open when the app starts on `/`, or null to stay there.
 * Call it after the global client state is hydrated.
 *
 * Starts from this device's last workspace. When a label is selected and the
 * workspace isn't under it (the label filter is shared between devices, so
 * another device may have changed it), the label's own last workspace wins,
 * the same one switching to that label would open; it also stands in when
 * the last workspace was deleted. A device last on `/` stays there.
 */
export function pickStartWorkspace(projects: readonly ProjectInfo[]): string | null {
  const labelOf = new Map<string, string | undefined>();
  for (const project of projects) {
    for (const wt of project.worktrees) {
      labelOf.set(toWorkspaceId(project.name, wt.name), project.label);
    }
  }

  const last = clientStorage.getItem(LAST_WORKSPACE_KEY);
  const label = clientStorage.getItem(LABEL_FILTER_KEY);
  if (!last) return null;
  if (label && labelOf.get(last) !== label) {
    const labelled = readLabelLastWorkspaces()[label];
    if (labelled && labelOf.get(labelled) === label) return labelled;
  }
  return labelOf.has(last) ? last : null;
}
