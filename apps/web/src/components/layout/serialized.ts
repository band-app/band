/**
 * The serialized layout format.
 *
 * Band stores a worktree's center layout (`band:dockview-layout-v9:<worktreeId>`)
 * and each terminal tab's nested split (`band:term-split:<worktreeId>:<leafId>`)
 * in the JSON shape dockview's `toJSON()` produced. Layouts users already have
 * saved, and older Band builds on the same device, read this shape, so it stays
 * as it is. These types and `parseSerializedLayout` are now Band's own
 * definition of it: the parser ignores fields it does not know and tolerates
 * the shapes older builds wrote.
 */

export type SerializedOrientation = "HORIZONTAL" | "VERTICAL";

export interface SerializedGroupData {
  /** Panel ids, in tab order. */
  views: string[];
  activeView?: string;
  id: string;
}

export interface SerializedLeaf {
  type: "leaf";
  data: SerializedGroupData;
  /** Size along the parent's orientation, in px. */
  size?: number;
}

export interface SerializedBranch {
  type: "branch";
  data: SerializedNode[];
  size?: number;
}

export type SerializedNode = SerializedLeaf | SerializedBranch;

export interface SerializedPanel {
  id: string;
  contentComponent?: string;
  tabComponent?: string;
  title?: string;
  renderer?: "always" | "onlyWhenVisible";
  params?: Record<string, unknown>;
}

export interface SerializedLayout {
  grid: {
    root: SerializedBranch;
    width: number;
    height: number;
    orientation: SerializedOrientation;
  };
  panels: Record<string, SerializedPanel>;
  activeGroup?: string;
  /** Band's own addition: the group that was maximized. */
  maximizedGroup?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseNode(raw: unknown): SerializedNode | null {
  if (!isRecord(raw)) return null;
  const size = finiteNumber(raw.size);
  if (raw.type === "branch") {
    if (!Array.isArray(raw.data)) return null;
    const children: SerializedNode[] = [];
    for (const child of raw.data) {
      const parsed = parseNode(child);
      if (parsed) children.push(parsed);
    }
    return { type: "branch", data: children, size };
  }
  if (raw.type === "leaf") {
    const data = raw.data;
    if (!isRecord(data) || typeof data.id !== "string" || !Array.isArray(data.views)) return null;
    const views = data.views.filter((v): v is string => typeof v === "string");
    const activeView = typeof data.activeView === "string" ? data.activeView : undefined;
    return { type: "leaf", data: { views, activeView, id: data.id }, size };
  }
  return null;
}

function parsePanel(id: string, raw: unknown): SerializedPanel | null {
  if (!isRecord(raw)) return null;
  const renderer =
    raw.renderer === "always" || raw.renderer === "onlyWhenVisible" ? raw.renderer : undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : id,
    contentComponent: typeof raw.contentComponent === "string" ? raw.contentComponent : undefined,
    tabComponent: typeof raw.tabComponent === "string" ? raw.tabComponent : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    renderer,
    params: isRecord(raw.params) ? raw.params : undefined,
  };
}

/**
 * Read a saved layout. Returns null when the value has no usable `grid` and
 * `panels`. Unknown fields (floating and popout groups, edge groups, size
 * limits, a `maximizedNode`) are dropped. A view with no panel entry is
 * dropped from its group, and a group left with no views is dropped.
 */
export function parseSerializedLayout(raw: unknown): SerializedLayout | null {
  if (!isRecord(raw) || !isRecord(raw.grid) || !isRecord(raw.panels)) return null;
  const root = parseNode(raw.grid.root);
  if (!root || root.type !== "branch") return null;
  const orientation: SerializedOrientation =
    raw.grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const panels: Record<string, SerializedPanel> = {};
  for (const [id, value] of Object.entries(raw.panels)) {
    const panel = parsePanel(id, value);
    if (panel) panels[id] = panel;
  }
  const grid = {
    root: pruneBranch(root, panels),
    width: finiteNumber(raw.grid.width) ?? 0,
    height: finiteNumber(raw.grid.height) ?? 0,
    orientation,
  };
  return {
    grid,
    panels,
    activeGroup: typeof raw.activeGroup === "string" ? raw.activeGroup : undefined,
    maximizedGroup: typeof raw.maximizedGroup === "string" ? raw.maximizedGroup : undefined,
  };
}

function pruneBranch(branch: SerializedBranch, panels: Record<string, SerializedPanel>) {
  const children: SerializedNode[] = [];
  for (const child of branch.data) {
    if (child.type === "branch") {
      const pruned = pruneBranch(child, panels);
      if (pruned.data.length > 0) children.push(pruned);
      continue;
    }
    const views = child.data.views.filter((v) => panels[v] != null);
    if (views.length === 0) continue;
    const activeView =
      child.data.activeView && views.includes(child.data.activeView)
        ? child.data.activeView
        : undefined;
    children.push({ ...child, data: { ...child.data, views, activeView } });
  }
  return { ...branch, data: children };
}
