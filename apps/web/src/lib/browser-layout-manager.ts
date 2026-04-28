/**
 * Browser layout persistence.
 *
 * Thin wrapper around DockviewLayoutManager for browser tab layouts.
 * Each workspace gets one row in the `panel_states` table with
 * `panelType = "browser_layout"`.
 */

import { DockviewLayoutManager } from "./dockview-layout-manager";

const manager = new DockviewLayoutManager("browser_layout");

export const getBrowserLayout = (workspaceId: string) => manager.get(workspaceId);
export const saveBrowserLayout = (workspaceId: string, tree: unknown) =>
  manager.save(workspaceId, tree);
export const deleteBrowserLayout = (workspaceId: string) => manager.delete(workspaceId);

/**
 * Add a browser panel to the saved dockview layout.
 */
export function addBrowserToLayout(
  workspaceId: string,
  browserId: string,
  opts?: { title?: string; initialUrl?: string },
): void {
  manager.addPanel(workspaceId, {
    id: browserId,
    contentComponent: "browserTab",
    tabComponent: "browserTab",
    title: opts?.title ?? "New Tab",
    params: {
      workspaceId,
      browserId,
      ...(opts?.initialUrl ? { initialUrl: opts.initialUrl } : {}),
    },
  });
}

/**
 * Remove a browser panel from the saved dockview layout.
 */
export function removeBrowserFromLayout(workspaceId: string, browserId: string): void {
  manager.removePanel(workspaceId, browserId);
}
