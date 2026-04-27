/**
 * Browser layout persistence.
 *
 * Stores the dockview layout tree that describes how browser tabs are
 * arranged within a workspace. One row per workspace in the `panel_states`
 * table with `panelType = "browser_layout"`.
 */

import {
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStatesForWorkspace,
  updatePanelState,
} from "./panel-state-store";

const PANEL_TYPE = "browser_layout";

function layoutId(workspaceId: string): string {
  return `browser_layout_${workspaceId}`;
}

/**
 * Get the browser layout tree for a workspace.
 * Returns the parsed JSON tree or null if no layout is stored.
 */
export function getBrowserLayout(workspaceId: string): unknown | null {
  const rows = listPanelStatesForWorkspace(workspaceId, PANEL_TYPE);
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].state);
  } catch {
    return null;
  }
}

/**
 * Save (upsert) the browser layout tree for a workspace.
 */
export function saveBrowserLayout(workspaceId: string, tree: unknown): void {
  const id = layoutId(workspaceId);
  const state = JSON.stringify(tree);
  const now = Date.now();

  const rows = listPanelStatesForWorkspace(workspaceId, PANEL_TYPE);
  if (rows.length > 0) {
    updatePanelState(id, { state, updatedAt: now });
  } else {
    insertPanelState({
      id,
      workspaceId,
      panelType: PANEL_TYPE,
      state,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/**
 * Delete the browser layout for a workspace.
 * Called when a workspace is removed.
 */
export function deleteBrowserLayout(workspaceId: string): void {
  deletePanelStatesForWorkspace(workspaceId, PANEL_TYPE);
}
