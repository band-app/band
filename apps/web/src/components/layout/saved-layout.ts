/**
 * Pure helpers over a saved layout blob (`band:dockview-layout-v9:<worktreeId>`
 * and the nested `band:term-split:*`), before it reaches the layout model.
 * They run on the raw JSON, so they also handle shapes older builds wrote.
 */

export function isSavedLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

/** Recursively strip a set of view ids from a dockview grid branch. dockview
 *  serializes a leaf's group as an object in `data` and a branch's children as
 *  an array in `data`. */
function pruneGridViews(node: unknown, removed: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.data)) {
    for (const child of n.data) pruneGridViews(child, removed);
    return;
  }
  const data = n.data as { views?: string[]; activeView?: string } | undefined;
  if (data && Array.isArray(data.views)) {
    data.views = data.views.filter((v) => !removed.has(v));
    if (data.activeView && removed.has(data.activeView)) data.activeView = data.views[0];
  }
}

/** First leaf of a dockview grid branch, depth-first. */
function firstGridLeaf(node: unknown): { views: string[]; activeView?: string } | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as { type?: string; data?: unknown };
  if (n.type === "leaf") {
    const data = n.data as { views?: unknown } | undefined;
    if (data && Array.isArray(data.views)) return data as { views: string[] };
    return undefined;
  }
  if (n.type === "branch" && Array.isArray(n.data)) {
    for (const child of n.data) {
      const leaf = firstGridLeaf(child);
      if (leaf) return leaf;
    }
  }
  return undefined;
}

/** Move the panels of any dockview edge groups (left / right / bottom docked
 *  areas, written by layouts saved before edge panels were removed) into the
 *  first grid group as tabs, then drop `edgeGroups` so loading never
 *  recreates an edge group. only panels a group references are built, so
 *  deleting `edgeGroups` alone would silently lose those panels. */
function moveEdgePanelsIntoGrid(layout: Record<string, unknown>): void {
  const edgeGroups = layout.edgeGroups as
    | Record<string, { group?: { views?: unknown } } | undefined>
    | undefined;
  delete layout.edgeGroups;
  if (!edgeGroups || typeof edgeGroups !== "object") return;
  // Only move views that have a panel entry. the old edge restore skipped a
  // view with no entry, but the grid restore throws on one, which would make
  // loading fail and reset the whole layout to the default.
  const panels = (layout.panels ?? {}) as Record<string, unknown>;
  const moved: string[] = [];
  for (const edge of Object.values(edgeGroups)) {
    const views = edge?.group?.views;
    if (Array.isArray(views)) {
      for (const v of views) if (typeof v === "string" && panels[v]) moved.push(v);
    }
  }
  if (moved.length === 0) return;
  const grid = layout.grid as { root?: unknown } | undefined;
  const leaf = firstGridLeaf(grid?.root);
  if (leaf) {
    leaf.views.push(...moved.filter((v) => !leaf.views.includes(v)));
    if (!leaf.activeView) leaf.activeView = leaf.views[0];
  } else if (grid?.root && typeof grid.root === "object") {
    // A grid with no leaf at all (every grid group closed, panels only at the
    // edges): give the root branch a single leaf holding the moved panels.
    const root = grid.root as { data?: unknown; size?: number };
    root.data = [
      {
        type: "leaf",
        data: { views: moved, activeView: moved[0], id: "edge-panels" },
        size: root.size ?? 0,
      },
    ];
  }
}

/** Drop panels whose `component` isn't a renderable leaf kind (e.g. a stale
 *  `files`/`changes` singleton from an older layout) so loading can't mount
 *  an unregistered component, and fold any legacy edge-group panels into the
 *  grid. Mutates + returns the layout clone. */
export function sanitizeSavedLayout(
  layout: Record<string, unknown>,
  knownComponents: ReadonlySet<string>,
): Record<string, unknown> {
  moveEdgePanelsIntoGrid(layout);
  const panels = layout.panels as Record<string, { contentComponent?: string }> | undefined;
  if (!panels) return layout;
  const removed = new Set<string>();
  for (const [id, panel] of Object.entries(panels)) {
    // the layout serializes each panel's kind as `contentComponent`, NOT `component`. Reading the wrong key here strips
    // EVERY panel as "unknown", which resets the layout on every reload.
    if (!panel?.contentComponent || !knownComponents.has(panel.contentComponent)) {
      removed.add(id);
      delete panels[id];
    }
  }
  if (removed.size > 0) {
    const grid = layout.grid as { root?: unknown } | undefined;
    if (grid?.root) pruneGridViews(grid.root, removed);
    if (typeof layout.activePanel === "string" && removed.has(layout.activePanel)) {
      layout.activePanel = undefined;
    }
  }
  return layout;
}

/** Serialize structure only — runtime params (callbacks, urls) are re-derived
 *  from each panel's `component` + `id` on load. */
export function stripParams(json: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(json));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const panel of Object.values(panels)) panel.params = {};
  }
  return clone;
}
