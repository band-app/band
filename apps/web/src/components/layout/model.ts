/**
 * The layout model: groups of tabbed panels arranged in a tree of splits.
 *
 * Both the center area of a worktree and the split panes of a terminal tab use
 * it. It has no DOM and no React: `LayoutView` renders it, and the unit tests
 * drive it directly. It reads and writes the serialized shape in
 * `./serialized.ts`.
 *
 * The tree mirrors the serialized grid. A branch lays its children out along
 * one axis, and a child branch uses the other axis. Each child has a weight,
 * and the weights of a branch's children split its space in proportion. The
 * serialized pixel sizes are read as weights and written back as pixels of the
 * last known container size.
 */

import {
  parseSerializedLayout,
  type SerializedBranch,
  type SerializedLayout,
  type SerializedNode,
  type SerializedOrientation,
} from "./serialized";

// ---------------------------------------------------------------------------
// Small event helper
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error("[layout] listener threw", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Direction = "left" | "right" | "above" | "below" | "within";
export type PanelRenderer = "always" | "onlyWhenVisible";
// oxlint-disable-next-line typescript/no-explicit-any -- panel params are caller-defined
export type PanelParams = Record<string, any>;

export interface PanelPosition {
  referenceGroup?: string | LayoutGroup;
  referencePanel?: string | LayoutPanel;
  direction?: Direction;
  index?: number;
}

export interface AddPanelOptions<P extends PanelParams = PanelParams> {
  id: string;
  component: string;
  tabComponent?: string;
  title?: string;
  params?: P;
  renderer?: PanelRenderer;
  position?: PanelPosition;
  /** Add the panel without selecting it or activating its group. */
  inactive?: boolean;
}

export interface AddGroupOptions {
  referenceGroup?: string | LayoutGroup;
  direction?: Direction;
  skipSetActive?: boolean;
}

export interface MovePanelOptions {
  group: LayoutGroup;
  /** Where in `group`: a tab (`center`, the default) or a new split beside it. */
  position?: "center" | "left" | "right" | "top" | "bottom";
  index?: number;
  skipSetActive?: boolean;
}

export interface PanelApi {
  readonly id: string;
  readonly component: string;
  readonly title: string;
  /** Selected in its group, and the group is the active one. */
  readonly isActive: boolean;
  /** Selected in its group, and the group is on screen (not hidden by a maximized sibling). */
  readonly isVisible: boolean;
  readonly group: LayoutGroup;
  setTitle(title: string): void;
  getParameters<T extends PanelParams = PanelParams>(): T;
  updateParameters(params: PanelParams): void;
  setActive(): void;
  moveTo(options: MovePanelOptions): void;
  close(): void;
  readonly onDidTitleChange: Event<{ title: string }>;
  readonly onDidParametersChange: Event<PanelParams>;
  readonly onDidActiveChange: Event<{ isActive: boolean }>;
  readonly onDidVisibilityChange: Event<{ isVisible: boolean }>;
}

export interface GroupApi {
  readonly id: string;
  readonly isActive: boolean;
  isMaximized(): boolean;
  maximize(): void;
  exitMaximized(): void;
  setActive(): void;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export class LayoutPanel<P extends PanelParams = PanelParams> {
  readonly id: string;
  readonly contentComponent: string;
  readonly tabComponent: string | undefined;
  readonly renderer: PanelRenderer | undefined;
  readonly api: PanelApi;

  private _title: string;
  private _params: P;
  private _group: LayoutGroup;
  private _element: HTMLElement | undefined;
  /** Last values the model announced, to fire change events once. */
  announcedActive = false;
  announcedVisible = false;

  readonly titleEmitter = new Emitter<{ title: string }>();
  readonly paramsEmitter = new Emitter<PanelParams>();
  readonly activeEmitter = new Emitter<{ isActive: boolean }>();
  readonly visibleEmitter = new Emitter<{ isVisible: boolean }>();

  constructor(
    private readonly owner: LayoutApi,
    group: LayoutGroup,
    init: {
      id: string;
      component: string;
      tabComponent?: string;
      title?: string;
      params?: P;
      renderer?: PanelRenderer;
    },
  ) {
    this.id = init.id;
    this.contentComponent = init.component;
    this.tabComponent = init.tabComponent;
    this.renderer = init.renderer;
    this._title = init.title ?? init.id;
    this._params = (init.params ?? {}) as P;
    this._group = group;
    const panel = this;
    this.api = {
      id: init.id,
      component: init.component,
      get title() {
        return panel._title;
      },
      get isActive() {
        return panel.isActive;
      },
      get isVisible() {
        return panel.isVisible;
      },
      get group() {
        return panel._group;
      },
      setTitle: (title) => panel.setTitle(title),
      getParameters: <T extends PanelParams>() => panel._params as unknown as T,
      updateParameters: (params) => panel.updateParams(params),
      setActive: () => owner.setActivePanel(panel),
      moveTo: (options) => owner.movePanel(panel, options),
      close: () => owner.removePanel(panel),
      onDidTitleChange: panel.titleEmitter.event,
      onDidParametersChange: panel.paramsEmitter.event,
      onDidActiveChange: panel.activeEmitter.event,
      onDidVisibilityChange: panel.visibleEmitter.event,
    };
  }

  get title(): string {
    return this._title;
  }

  get params(): P {
    return this._params;
  }

  get group(): LayoutGroup {
    return this._group;
  }

  /** The element the panel's content renders into. It moves between groups
   *  with the panel, so a moved panel keeps its React state and DOM. */
  get element(): HTMLElement {
    if (!this._element) {
      const el = document.createElement("div");
      el.className = "band-layout-panel";
      el.dataset.panelId = this.id;
      this._element = el;
    }
    return this._element;
  }

  get isActive(): boolean {
    return this._group.activePanel === this && this.owner.activeGroup === this._group;
  }

  get isVisible(): boolean {
    return this._group.activePanel === this && this.owner.isGroupShown(this._group);
  }

  setGroup(group: LayoutGroup): void {
    this._group = group;
  }

  setTitle(title: string): void {
    if (title === this._title) return;
    this._title = title;
    this.titleEmitter.fire({ title });
  }

  updateParams(params: PanelParams): void {
    const next: PanelParams = { ...this._params };
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    this._params = next as P;
    this.paramsEmitter.fire(next);
    this.owner.touch();
  }

  dispose(): void {
    this._element?.remove();
    this._element = undefined;
  }
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class LayoutGroup {
  readonly api: GroupApi;
  readonly model: { moveToNext(): void; moveToPrevious(): void };

  /** Panels in tab order. Changed only through `LayoutApi`. */
  readonly panels: LayoutPanel[] = [];
  /** Most recently used first. Decides which tab takes over when the selected one closes. */
  readonly mru: LayoutPanel[] = [];
  activePanel: LayoutPanel | undefined;
  private _element: HTMLElement | undefined;

  constructor(
    readonly id: string,
    private readonly owner: LayoutApi,
  ) {
    const group = this;
    this.api = {
      id,
      get isActive() {
        return owner.activeGroup === group;
      },
      isMaximized: () => owner.maximizedGroup === group,
      maximize: () => owner.maximizeGroup(group),
      exitMaximized: () => owner.exitMaximized(),
      setActive: () => owner.setActiveGroup(group),
    };
    this.model = {
      moveToNext: () => this.step(1),
      moveToPrevious: () => this.step(-1),
    };
  }

  /** The group's root element, set by the view when it mounts. */
  get element(): HTMLElement {
    if (!this._element) this._element = document.createElement("div");
    return this._element;
  }

  setElement(el: HTMLElement | null): void {
    if (el) this._element = el;
  }

  get size(): number {
    return this.panels.length;
  }

  private step(by: 1 | -1): void {
    const n = this.panels.length;
    if (n === 0) return;
    const i = this.activePanel ? this.panels.indexOf(this.activePanel) : -1;
    const next = this.panels[(i + by + n) % n];
    if (next) this.owner.setActivePanel(next);
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export type Orientation = SerializedOrientation;

export interface BranchNode {
  kind: "branch";
  orientation: Orientation;
  children: GridNode[];
  /** Relative size of each child. */
  weights: number[];
}

export interface LeafNode {
  kind: "leaf";
  group: LayoutGroup;
}

export type GridNode = BranchNode | LeafNode;

export function orthogonal(o: Orientation): Orientation {
  return o === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
}

function orientationOf(direction: Exclude<Direction, "within">): Orientation {
  return direction === "left" || direction === "right" ? "HORIZONTAL" : "VERTICAL";
}

function positionToDirection(position: NonNullable<MovePanelOptions["position"]>): Direction {
  switch (position) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "top":
      return "above";
    case "bottom":
      return "below";
    default:
      return "within";
  }
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function findParent(
  branch: BranchNode,
  target: GridNode,
): { parent: BranchNode; index: number } | null {
  for (let i = 0; i < branch.children.length; i++) {
    const child = branch.children[i];
    if (child === target) return { parent: branch, index: i };
    if (child.kind === "branch") {
      const found = findParent(child, target);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

let nextApiId = 1;

export class LayoutApi {
  readonly id = `layout-${nextApiId++}`;

  private rootNode: BranchNode = {
    kind: "branch",
    orientation: "HORIZONTAL",
    children: [],
    weights: [],
  };
  private readonly groupMap = new Map<string, LayoutGroup>();
  private readonly panelMap = new Map<string, LayoutPanel>();
  private _activeGroup: LayoutGroup | undefined;
  private _maximized: LayoutGroup | undefined;
  private width = 0;
  private height = 0;
  private version = 0;
  private nextGroupId = 1;
  private readonly subscribers = new Set<() => void>();

  private batchDepth = 0;
  private suppressEvents = 0;
  private pending: (() => void)[] = [];
  private layoutDirty = false;
  private lastActivePanel: LayoutPanel | undefined;

  private readonly addPanelEmitter = new Emitter<LayoutPanel>();
  private readonly removePanelEmitter = new Emitter<LayoutPanel>();
  private readonly movePanelEmitter = new Emitter<{ panel: LayoutPanel; from: LayoutGroup }>();
  private readonly addGroupEmitter = new Emitter<LayoutGroup>();
  private readonly removeGroupEmitter = new Emitter<LayoutGroup>();
  private readonly activePanelEmitter = new Emitter<LayoutPanel | undefined>();
  private readonly layoutEmitter = new Emitter<void>();
  private readonly maximizedEmitter = new Emitter<{ group: LayoutGroup; isMaximized: boolean }>();

  readonly onDidAddPanel = this.addPanelEmitter.event;
  readonly onDidRemovePanel = this.removePanelEmitter.event;
  readonly onDidMovePanel = this.movePanelEmitter.event;
  readonly onDidAddGroup = this.addGroupEmitter.event;
  readonly onDidRemoveGroup = this.removeGroupEmitter.event;
  readonly onDidActivePanelChange = this.activePanelEmitter.event;
  readonly onDidLayoutChange = this.layoutEmitter.event;
  readonly onDidMaximizedGroupChange = this.maximizedEmitter.event;

  // ---- reading ----

  get root(): BranchNode {
    return this.rootNode;
  }

  /** Groups in creation order. */
  get groups(): LayoutGroup[] {
    return [...this.groupMap.values()];
  }

  get panels(): LayoutPanel[] {
    const out: LayoutPanel[] = [];
    for (const group of this.groupMap.values()) out.push(...group.panels);
    return out;
  }

  get activeGroup(): LayoutGroup | undefined {
    return this._activeGroup;
  }

  get activePanel(): LayoutPanel | undefined {
    return this._activeGroup?.activePanel;
  }

  get maximizedGroup(): LayoutGroup | undefined {
    return this._maximized;
  }

  getPanel(id: string): LayoutPanel | undefined {
    return this.panelMap.get(id);
  }

  getGroup(id: string): LayoutGroup | undefined {
    return this.groupMap.get(id);
  }

  isGroupShown(group: LayoutGroup): boolean {
    return !this._maximized || this._maximized === group;
  }

  /** Last container size reported to the layout, in px. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  // ---- React subscription ----

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Announce a change that does not go through a batch (title, params). */
  touch(): void {
    this.version++;
    for (const s of [...this.subscribers]) s();
  }

  // ---- batching ----

  private batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.flush();
    }
  }

  private emit(fn: () => void): void {
    if (this.suppressEvents > 0) return;
    this.pending.push(fn);
  }

  private flush(): void {
    const queued = this.pending;
    this.pending = [];
    // Panel active and visible flags, then the active panel.
    if (this.suppressEvents === 0) {
      for (const panel of this.panelMap.values()) {
        const isActive = panel.isActive;
        const isVisible = panel.isVisible;
        if (isActive !== panel.announcedActive) {
          panel.announcedActive = isActive;
          queued.push(() => panel.activeEmitter.fire({ isActive }));
        }
        if (isVisible !== panel.announcedVisible) {
          panel.announcedVisible = isVisible;
          queued.push(() => panel.visibleEmitter.fire({ isVisible }));
        }
      }
      const active = this.activePanel;
      if (active !== this.lastActivePanel) {
        this.lastActivePanel = active;
        queued.push(() => this.activePanelEmitter.fire(active));
      }
      if (this.layoutDirty) {
        this.layoutDirty = false;
        queued.push(() => this.layoutEmitter.fire());
      }
    } else {
      this.layoutDirty = false;
      this.syncAnnounced();
    }
    this.version++;
    for (const s of [...this.subscribers]) s();
    for (const fn of queued) fn();
  }

  private syncAnnounced(): void {
    for (const panel of this.panelMap.values()) {
      panel.announcedActive = panel.isActive;
      panel.announcedVisible = panel.isVisible;
    }
    this.lastActivePanel = this.activePanel;
  }

  // ---- sizing ----

  layout(width: number, height: number, force = false): void {
    if (width <= 0 || height <= 0) return;
    if (!force && width === this.width && height === this.height) return;
    const changed = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    if (changed && this.groupMap.size > 0) {
      this.layoutDirty = true;
      this.batch(() => {});
    }
  }

  /** Change the split between child `index` and the next one. */
  setWeights(branch: BranchNode, weights: number[]): void {
    branch.weights = weights;
    this.layoutDirty = true;
    this.batch(() => {});
  }

  // ---- activation ----

  setActiveGroup(group: LayoutGroup): void {
    if (this._activeGroup === group || !this.groupMap.has(group.id)) return;
    this.batch(() => {
      this._activeGroup = group;
    });
  }

  setActivePanel(panel: LayoutPanel): void {
    const group = panel.group;
    if (!this.panelMap.has(panel.id)) return;
    this.batch(() => {
      group.activePanel = panel;
      this.touchMru(group, panel);
      this._activeGroup = group;
    });
  }

  private touchMru(group: LayoutGroup, panel: LayoutPanel): void {
    const i = group.mru.indexOf(panel);
    if (i >= 0) group.mru.splice(i, 1);
    group.mru.unshift(panel);
  }

  // ---- maximize ----

  maximizeGroup(group: LayoutGroup): void {
    if (this._maximized === group || !this.groupMap.has(group.id)) return;
    this.batch(() => {
      this.exitMaximizedInner();
      this._maximized = group;
      this.emit(() => this.maximizedEmitter.fire({ group, isMaximized: true }));
    });
  }

  exitMaximized(): void {
    if (!this._maximized) return;
    this.batch(() => this.exitMaximizedInner());
  }

  private exitMaximizedInner(): void {
    const group = this._maximized;
    if (!group) return;
    this._maximized = undefined;
    this.emit(() => this.maximizedEmitter.fire({ group, isMaximized: false }));
  }

  // ---- adding ----

  private newGroup(id?: string): LayoutGroup {
    let groupId = id;
    if (groupId === undefined || this.groupMap.has(groupId)) {
      while (this.groupMap.has(String(this.nextGroupId))) this.nextGroupId++;
      groupId = String(this.nextGroupId++);
    } else {
      const n = Number(groupId);
      if (Number.isInteger(n) && n >= this.nextGroupId) this.nextGroupId = n + 1;
    }
    const group = new LayoutGroup(groupId, this);
    this.groupMap.set(groupId, group);
    return group;
  }

  private resolveGroup(ref: string | LayoutGroup | undefined, what: string): LayoutGroup {
    const group = typeof ref === "string" ? this.groupMap.get(ref) : ref;
    if (!group || !this.groupMap.has(group.id)) {
      throw new Error(
        `layout: ${what} '${typeof ref === "string" ? ref : ref?.id}' does not exist`,
      );
    }
    return group;
  }

  addPanel<P extends PanelParams>(options: AddPanelOptions<P>): LayoutPanel<P> {
    if (this.panelMap.has(options.id)) {
      throw new Error(`layout: panel with id ${options.id} already exists`);
    }
    return this.batch(() => {
      const position = options.position;
      let reference: LayoutGroup | undefined;
      if (position?.referencePanel !== undefined) {
        const refPanel =
          typeof position.referencePanel === "string"
            ? this.panelMap.get(position.referencePanel)
            : position.referencePanel;
        if (!refPanel) {
          throw new Error(
            `layout: referencePanel '${String(position.referencePanel)}' does not exist`,
          );
        }
        reference = refPanel.group;
      } else if (position?.referenceGroup !== undefined) {
        reference = this.resolveGroup(position.referenceGroup, "referenceGroup");
      } else if (!position) {
        reference = this._activeGroup;
      }

      let group: LayoutGroup;
      const direction = position?.direction;
      if (!reference) {
        group = this.insertRootGroup();
      } else if (!direction || direction === "within") {
        group = reference;
      } else {
        group = this.splitGroup(reference, direction);
      }

      const panel = new LayoutPanel<P>(this, group, {
        id: options.id,
        component: options.component,
        tabComponent: options.tabComponent,
        title: options.title,
        params: options.params,
        renderer: options.renderer,
      });
      this.panelMap.set(panel.id, panel);
      this.insertPanel(group, panel, position?.index);
      if (!group.activePanel) group.activePanel = panel;
      if (!options.inactive) {
        group.activePanel = panel;
        this.touchMru(group, panel);
        this._activeGroup = group;
      } else if (!this._activeGroup) {
        this._activeGroup = group;
      }
      this.emit(() => this.addPanelEmitter.fire(panel));
      this.layoutDirty = true;
      return panel;
    });
  }

  private insertPanel(group: LayoutGroup, panel: LayoutPanel, index?: number): void {
    const at =
      typeof index === "number" && index >= 0 && index <= group.panels.length
        ? index
        : group.panels.length;
    group.panels.splice(at, 0, panel);
    panel.setGroup(group);
    group.mru.unshift(panel);
  }

  addGroup(options?: AddGroupOptions): LayoutGroup {
    return this.batch(() => {
      let group: LayoutGroup;
      if (options?.referenceGroup !== undefined) {
        const reference = this.resolveGroup(options.referenceGroup, "reference group");
        group =
          options.direction && options.direction !== "within"
            ? this.splitGroup(reference, options.direction)
            : this.splitGroup(reference, "right");
      } else {
        group = this.insertRootGroup();
      }
      if (!options?.skipSetActive) this._activeGroup = group;
      return group;
    });
  }

  /** A new group at the left edge of the root. */
  private insertRootGroup(): LayoutGroup {
    this.exitMaximizedInner();
    const group = this.newGroup();
    const leaf: LeafNode = { kind: "leaf", group };
    const root = this.rootNode;
    if (root.children.length === 0) {
      root.children.push(leaf);
      root.weights.push(1);
    } else {
      const total = sum(root.weights) || root.children.length;
      root.children.unshift(leaf);
      root.weights.unshift(total / root.children.length);
    }
    this.layoutDirty = true;
    this.emit(() => this.addGroupEmitter.fire(group));
    return group;
  }

  /** A new group beside `reference`, taking half of its space. */
  private splitGroup(reference: LayoutGroup, direction: Exclude<Direction, "within">): LayoutGroup {
    this.exitMaximizedInner();
    const refLeaf = this.findLeaf(reference);
    if (!refLeaf) throw new Error(`layout: group ${reference.id} is not in the layout`);
    const found = findParent(this.rootNode, refLeaf);
    if (!found) throw new Error(`layout: group ${reference.id} has no parent`);
    const { parent, index } = found;
    const group = this.newGroup();
    const leaf: LeafNode = { kind: "leaf", group };
    const before = direction === "left" || direction === "above";
    const orientation = orientationOf(direction);
    if (parent.orientation === orientation) {
      const w = parent.weights[index] ?? 1;
      parent.weights[index] = w / 2;
      parent.children.splice(before ? index : index + 1, 0, leaf);
      parent.weights.splice(before ? index : index + 1, 0, w / 2);
    } else {
      const w = parent.weights[index] ?? 1;
      const branch: BranchNode = {
        kind: "branch",
        orientation,
        children: before ? [leaf, refLeaf] : [refLeaf, leaf],
        weights: [1, 1],
      };
      parent.children[index] = branch;
      parent.weights[index] = w;
    }
    this.layoutDirty = true;
    this.emit(() => this.addGroupEmitter.fire(group));
    return group;
  }

  private findLeaf(group: LayoutGroup): LeafNode | null {
    const walk = (node: GridNode): LeafNode | null => {
      if (node.kind === "leaf") return node.group === group ? node : null;
      for (const child of node.children) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.rootNode);
  }

  // ---- removing ----

  removePanel(panelOrId: LayoutPanel | string): void {
    const panel = typeof panelOrId === "string" ? this.panelMap.get(panelOrId) : panelOrId;
    if (!panel || this.panelMap.get(panel.id) !== panel) return;
    this.batch(() => {
      const group = panel.group;
      this.detachPanel(group, panel);
      this.panelMap.delete(panel.id);
      panel.dispose();
      this.emit(() => this.removePanelEmitter.fire(panel));
      if (group.panels.length === 0) this.removeGroup(group);
      this.layoutDirty = true;
    });
  }

  /** Take `panel` out of `group`'s lists, choosing a new selected tab if needed. */
  private detachPanel(group: LayoutGroup, panel: LayoutPanel): void {
    const i = group.panels.indexOf(panel);
    if (i >= 0) group.panels.splice(i, 1);
    const m = group.mru.indexOf(panel);
    if (m >= 0) group.mru.splice(m, 1);
    if (group.activePanel === panel) group.activePanel = group.mru[0] ?? group.panels[0];
  }

  removeGroup(group: LayoutGroup): void {
    if (!this.groupMap.has(group.id)) return;
    this.batch(() => {
      for (const panel of [...group.panels]) {
        this.detachPanel(group, panel);
        this.panelMap.delete(panel.id);
        panel.dispose();
        this.emit(() => this.removePanelEmitter.fire(panel));
      }
      this.exitMaximizedInner();
      this.removeLeaf(group);
      this.groupMap.delete(group.id);
      if (this._activeGroup === group) {
        this._activeGroup = this.groupMap.values().next().value;
      }
      this.layoutDirty = true;
      this.emit(() => this.removeGroupEmitter.fire(group));
    });
  }

  private removeLeaf(group: LayoutGroup): void {
    const leaf = this.findLeaf(group);
    if (!leaf) return;
    const found = findParent(this.rootNode, leaf);
    if (!found) return;
    found.parent.children.splice(found.index, 1);
    found.parent.weights.splice(found.index, 1);
    this.normalize();
  }

  /** Collapse branches left with one or no child. */
  private normalize(): void {
    const prune = (branch: BranchNode): void => {
      for (let i = branch.children.length - 1; i >= 0; i--) {
        const child = branch.children[i];
        if (child.kind !== "branch") continue;
        prune(child);
        if (child.children.length === 0) {
          branch.children.splice(i, 1);
          branch.weights.splice(i, 1);
        } else if (child.children.length === 1) {
          const only = child.children[0];
          const w = branch.weights[i];
          if (only.kind === "leaf") {
            branch.children[i] = only;
          } else {
            // `only` runs along the same axis as `branch`: splice its children in.
            const total = sum(only.weights) || only.children.length;
            const scaled = only.weights.map((x) => (x / total) * w);
            branch.children.splice(i, 1, ...only.children);
            branch.weights.splice(i, 1, ...scaled);
          }
        }
      }
    };
    prune(this.rootNode);
    // A root with one branch child becomes that branch.
    while (this.rootNode.children.length === 1 && this.rootNode.children[0].kind === "branch") {
      this.rootNode = this.rootNode.children[0];
    }
    if (this.rootNode.children.length === 0) {
      this.rootNode = {
        kind: "branch",
        orientation: this.rootNode.orientation,
        children: [],
        weights: [],
      };
    }
  }

  // ---- moving ----

  movePanel(panel: LayoutPanel, options: MovePanelOptions): void {
    if (this.panelMap.get(panel.id) !== panel) return;
    const target = options.group;
    if (!this.groupMap.has(target.id)) return;
    const source = panel.group;
    const direction = positionToDirection(options.position ?? "center");
    // Splitting a group off its own only tab would change nothing.
    if (direction !== "within" && source === target && source.panels.length === 1) return;
    this.batch(() => {
      const wasActiveInSource = source.activePanel === panel;
      let destination = target;
      if (direction !== "within") destination = this.splitGroup(target, direction);

      // Take the panel out of its source group.
      const fromIndex = source.panels.indexOf(panel);
      this.detachPanel(source, panel);

      let index = options.index;
      if (
        destination === source &&
        typeof index === "number" &&
        fromIndex >= 0 &&
        index > fromIndex
      ) {
        index -= 1;
      }
      this.insertPanel(destination, panel, index);
      const select = !options.skipSetActive;
      if (select || !destination.activePanel) {
        destination.activePanel = panel;
        this.touchMru(destination, panel);
      }
      if (destination === source && !select && wasActiveInSource) destination.activePanel = panel;
      if (select) this._activeGroup = destination;

      if (source !== destination && source.panels.length === 0) this.removeGroupKeepPanels(source);
      this.layoutDirty = true;
      this.emit(() => this.movePanelEmitter.fire({ panel, from: source }));
    });
  }

  /** Remove an emptied group from the tree. */
  private removeGroupKeepPanels(group: LayoutGroup): void {
    this.exitMaximizedInner();
    this.removeLeaf(group);
    this.groupMap.delete(group.id);
    if (this._activeGroup === group) {
      this._activeGroup = this.groupMap.values().next().value;
    }
    this.emit(() => this.removeGroupEmitter.fire(group));
  }

  // ---- whole layout ----

  clear(): void {
    this.batch(() => {
      for (const panel of this.panelMap.values()) panel.dispose();
      this.panelMap.clear();
      const removed = [...this.groupMap.values()];
      this.groupMap.clear();
      this.rootNode = { kind: "branch", orientation: "HORIZONTAL", children: [], weights: [] };
      this._activeGroup = undefined;
      this._maximized = undefined;
      this.layoutDirty = true;
      for (const group of removed) this.emit(() => this.removeGroupEmitter.fire(group));
    });
  }

  /** Replace the layout with a saved one. Throws when `data` is not a layout. */
  fromJSON(data: unknown): void {
    const parsed = parseSerializedLayout(data);
    if (!parsed) throw new Error("layout: serialized layout is not valid");
    this.suppressEvents++;
    try {
      this.batch(() => {
        this.clear();
        this.nextGroupId = 1;
        // Keep the container size the view measured; the saved size only
        // stands in until then.
        if (this.width <= 0) this.width = parsed.grid.width;
        if (this.height <= 0) this.height = parsed.grid.height;
        this.rootNode = this.buildBranch(parsed, parsed.grid.root, parsed.grid.orientation);
        const wanted = parsed.activeGroup ? this.groupMap.get(parsed.activeGroup) : undefined;
        this._activeGroup = wanted ?? this.groupMap.values().next().value;
        this.layoutDirty = true;
      });
    } finally {
      this.suppressEvents--;
    }
    this.syncAnnounced();
  }

  private buildBranch(
    layout: SerializedLayout,
    node: SerializedBranch,
    orientation: Orientation,
  ): BranchNode {
    const children: GridNode[] = [];
    const sizes: (number | undefined)[] = [];
    for (const child of node.data) {
      if (child.type === "branch") {
        const branch = this.buildBranch(layout, child, orthogonal(orientation));
        if (branch.children.length === 0) continue;
        children.push(branch);
        sizes.push(child.size);
      } else {
        const group = this.newGroup(child.data.id);
        for (const viewId of child.data.views) {
          if (this.panelMap.has(viewId)) continue;
          const saved = layout.panels[viewId];
          if (!saved) continue;
          const panel = new LayoutPanel(this, group, {
            id: viewId,
            component: saved.contentComponent ?? "unknown",
            tabComponent: saved.tabComponent,
            title: saved.title,
            params: saved.params ?? {},
            renderer: saved.renderer,
          });
          this.panelMap.set(viewId, panel);
          group.panels.push(panel);
          group.mru.unshift(panel);
        }
        if (group.panels.length === 0) {
          this.groupMap.delete(group.id);
          continue;
        }
        const active = child.data.activeView ? this.panelMap.get(child.data.activeView) : undefined;
        group.activePanel =
          active && active.group === group ? active : group.panels[group.panels.length - 1];
        if (group.activePanel) this.touchMru(group, group.activePanel);
        children.push({ kind: "leaf", group });
        sizes.push(child.size);
      }
    }
    return { kind: "branch", orientation, children, weights: normalizeSizes(sizes) };
  }

  toJSON(): SerializedLayout {
    const along = this.rootNode.orientation === "HORIZONTAL" ? this.width : this.height;
    const cross = this.rootNode.orientation === "HORIZONTAL" ? this.height : this.width;
    const root = this.serializeBranch(this.rootNode, along, cross);
    root.size = cross;
    const panels: SerializedLayout["panels"] = {};
    for (const panel of this.panels) {
      panels[panel.id] = {
        id: panel.id,
        contentComponent: panel.contentComponent,
        tabComponent: panel.tabComponent,
        ...(Object.keys(panel.params).length > 0 ? { params: panel.params } : {}),
        title: panel.title,
        ...(panel.renderer ? { renderer: panel.renderer } : {}),
      };
    }
    return {
      grid: {
        root,
        width: this.width,
        height: this.height,
        orientation: this.rootNode.orientation,
      },
      panels,
      ...(this._activeGroup ? { activeGroup: this._activeGroup.id } : {}),
    };
  }

  /** `along` is the branch's pixel extent on its own axis, `cross` on the other. */
  private serializeBranch(branch: BranchNode, along: number, cross: number): SerializedBranch {
    const total = sum(branch.weights) || 1;
    const data: SerializedNode[] = branch.children.map((child, i) => {
      const size = Math.round((branch.weights[i] / total) * along);
      if (child.kind === "leaf") {
        const group = child.group;
        return {
          type: "leaf",
          data: {
            views: group.panels.map((p) => p.id),
            activeView: group.activePanel?.id,
            id: group.id,
          },
          size,
        };
      }
      const inner = this.serializeBranch(child, cross, size);
      inner.size = size;
      return inner;
    });
    return { type: "branch", data, size: cross };
  }
}

/** Sizes read from a file as weights: missing or non-positive ones take the average. */
function normalizeSizes(sizes: (number | undefined)[]): number[] {
  const valid = sizes.filter((s): s is number => typeof s === "number" && s > 0);
  const avg = valid.length > 0 ? sum(valid) / valid.length : 1;
  return sizes.map((s) => (typeof s === "number" && s > 0 ? s : avg));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A rectangle in percent of the layout's box. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SashSpec {
  branch: BranchNode;
  /** The sash sits between child `index` and child `index + 1`. */
  index: number;
  orientation: Orientation;
  /** The branch's rectangle. */
  rect: Rect;
  /** Where the sash sits, in percent of the layout's box along the branch's axis. */
  position: number;
}

export interface Geometry {
  /** Groups in tree order, with their rectangles. */
  groups: { group: LayoutGroup; rect: Rect }[];
  sashes: SashSpec[];
}

/** Rectangles of every group and the sashes between them, from the weights alone. */
export function computeGeometry(root: BranchNode): Geometry {
  const groups: Geometry["groups"] = [];
  const sashes: SashSpec[] = [];
  const walk = (node: GridNode, rect: Rect): void => {
    if (node.kind === "leaf") {
      groups.push({ group: node.group, rect });
      return;
    }
    const total = sum(node.weights) || 1;
    const horizontal = node.orientation === "HORIZONTAL";
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = ((node.weights[i] ?? 0) / total) * (horizontal ? rect.w : rect.h);
      const childRect: Rect = horizontal
        ? { x: rect.x + offset, y: rect.y, w: share, h: rect.h }
        : { x: rect.x, y: rect.y + offset, w: rect.w, h: share };
      offset += share;
      if (i < node.children.length - 1) {
        sashes.push({
          branch: node,
          index: i,
          orientation: node.orientation,
          rect,
          position: (horizontal ? rect.x : rect.y) + offset,
        });
      }
      walk(child, childRect);
    });
  };
  walk(root, { x: 0, y: 0, w: 100, h: 100 });
  return { groups, sashes };
}
