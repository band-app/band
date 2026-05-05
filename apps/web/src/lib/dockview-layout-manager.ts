/**
 * Generic dockview layout persistence and mutation.
 *
 * Provides get/save/delete for dockview layout trees stored in the
 * `panel_states` table, plus server-side helpers to add/remove panels
 * without needing a live dockview instance.
 *
 * Usage:
 *   const browserLayouts = new DockviewLayoutManager("browser_layout");
 *   browserLayouts.get(workspaceId);
 *   browserLayouts.addPanel(workspaceId, panelId, { ... });
 */

import {
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStatesForWorkspace,
  updatePanelState,
} from "./panel-state-store";

// ---------------------------------------------------------------------------
// Dockview layout types
//
// The dockview `toJSON()` output has this shape:
//   {
//     grid: {
//       root: GridNode (tree of branch/leaf nodes),
//       height, width, orientation
//     },
//     panels: Record<panelId, PanelState>,
//     activeGroup?: string
//   }
//
// grid.root is a recursive tree:
//   leaf:   { type: "leaf",   data: { id, views: [panelId, ...], activeView? }, size }
//   branch: { type: "branch", data: [child, ...], size }
//
// `views` references panel IDs in the `panels` map.
// ---------------------------------------------------------------------------

export interface DockviewLayout {
  grid: {
    root: GridNode;
    height: number;
    width: number;
    orientation: string;
  };
  panels: Record<string, PanelState>;
  activeGroup?: string;
}

export interface GridNode {
  type: "leaf" | "branch";
  data: LeafData | GridNode[];
  size?: number;
  visible?: boolean;
}

export interface LeafData {
  id: string;
  views: string[];
  activeView?: string;
  [key: string]: unknown;
}

export interface PanelState {
  id: string;
  contentComponent?: string;
  tabComponent?: string;
  title?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Grid tree utilities
// ---------------------------------------------------------------------------

function isLeaf(node: GridNode): node is GridNode & { data: LeafData } {
  return node.type === "leaf" && typeof node.data === "object" && !Array.isArray(node.data);
}

function isBranch(node: GridNode): node is GridNode & { data: GridNode[] } {
  return node.type === "branch" && Array.isArray(node.data);
}

function findFirstLeaf(node: GridNode): LeafData | null {
  if (isLeaf(node)) return node.data;
  if (isBranch(node)) {
    for (const child of node.data) {
      const found = findFirstLeaf(child);
      if (found) return found;
    }
  }
  return null;
}

function findLeafById(node: GridNode, groupId: string): LeafData | null {
  if (isLeaf(node)) return node.data.id === groupId ? node.data : null;
  if (isBranch(node)) {
    for (const child of node.data) {
      const found = findLeafById(child, groupId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Pick the panel a deterministic "default" lookup should target.
 *
 * Preference order:
 *   1. The `activeView` of the layout's `activeGroup` (the panel the user
 *      last had focus on).
 *   2. The `activeView` of the first leaf (first group in the tree).
 *   3. The first entry of `views` in the first leaf.
 *
 * Returns null if no panel can be resolved (empty/invalid layout).
 */
export function defaultPanelIdFromLayout(layout: unknown): string | null {
  if (!layout || !isDockviewLayout(layout)) return null;

  if (layout.activeGroup) {
    const leaf = findLeafById(layout.grid.root, layout.activeGroup);
    if (leaf) {
      if (leaf.activeView && leaf.views.includes(leaf.activeView)) {
        return leaf.activeView;
      }
      if (leaf.views.length > 0) return leaf.views[0];
    }
  }

  const firstLeaf = findFirstLeaf(layout.grid.root);
  if (!firstLeaf) return null;
  if (firstLeaf.activeView && firstLeaf.views.includes(firstLeaf.activeView)) {
    return firstLeaf.activeView;
  }
  return firstLeaf.views[0] ?? null;
}

function removeFromGrid(node: GridNode, panelId: string): void {
  if (isLeaf(node)) {
    const idx = node.data.views.indexOf(panelId);
    if (idx !== -1) {
      node.data.views.splice(idx, 1);
      if (node.data.activeView === panelId) {
        node.data.activeView = node.data.views[0];
      }
    }
  } else if (isBranch(node)) {
    for (const child of node.data) {
      removeFromGrid(child, panelId);
    }
  }
}

export function isDockviewLayout(obj: unknown): obj is DockviewLayout {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

// ---------------------------------------------------------------------------
// DockviewLayoutManager
// ---------------------------------------------------------------------------

export class DockviewLayoutManager {
  constructor(private readonly panelType: string) {}

  private layoutId(workspaceId: string): string {
    return `${this.panelType}_${workspaceId}`;
  }

  /**
   * Get the layout tree for a workspace.
   * Returns the parsed JSON tree or null if no layout is stored.
   */
  get(workspaceId: string): unknown | null {
    const rows = listPanelStatesForWorkspace(workspaceId, this.panelType);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].state);
    } catch {
      return null;
    }
  }

  /**
   * Save (upsert) the layout tree for a workspace.
   */
  save(workspaceId: string, tree: unknown): void {
    const id = this.layoutId(workspaceId);
    const state = JSON.stringify(tree);
    const now = Date.now();

    const rows = listPanelStatesForWorkspace(workspaceId, this.panelType);
    if (rows.length > 0) {
      updatePanelState(id, { state, updatedAt: now });
    } else {
      insertPanelState({
        id,
        workspaceId,
        panelType: this.panelType,
        state,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Delete the layout for a workspace.
   */
  delete(workspaceId: string): void {
    deletePanelStatesForWorkspace(workspaceId, this.panelType);
  }

  /**
   * Add a panel to the saved dockview layout.
   *
   * Appends the panel to the first group's `views` array and adds the panel
   * entry to the `panels` map. If no layout exists, creates a fresh one-tab layout.
   */
  addPanel(workspaceId: string, panel: PanelState): void {
    const raw = this.get(workspaceId);

    if (raw && isDockviewLayout(raw)) {
      raw.panels[panel.id] = panel;

      const leaf = findFirstLeaf(raw.grid.root);
      if (leaf) {
        leaf.views.push(panel.id);
        leaf.activeView = panel.id;
      }

      this.save(workspaceId, raw);
    } else {
      const groupId = `group_${panel.id}`;
      const layout: DockviewLayout = {
        grid: {
          root: {
            type: "leaf",
            data: { id: groupId, views: [panel.id], activeView: panel.id },
            size: 1,
          },
          height: 500,
          width: 500,
          orientation: "HORIZONTAL",
        },
        panels: { [panel.id]: panel },
        activeGroup: groupId,
      };
      this.save(workspaceId, layout);
    }
  }

  /**
   * Remove a panel from the saved dockview layout.
   *
   * Removes the panel from the `panels` map and from any group's `views` array.
   */
  removePanel(workspaceId: string, panelId: string): void {
    const raw = this.get(workspaceId);
    if (!raw || !isDockviewLayout(raw)) return;

    delete raw.panels[panelId];
    removeFromGrid(raw.grid.root, panelId);

    this.save(workspaceId, raw);
  }

  /**
   * List all panel IDs in the saved layout.
   * Useful for reconciling layout with live records.
   */
  listPanelIds(workspaceId: string): string[] {
    const raw = this.get(workspaceId);
    if (!raw || !isDockviewLayout(raw)) return [];
    return Object.keys(raw.panels);
  }
}
