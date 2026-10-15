import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  MouseSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type ComponentType,
  createContext,
  memo,
  Component as ReactComponent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { beginLayoutResize, endLayoutResize } from "../../lib/layout-resizing";
import {
  type BranchNode,
  computeGeometry,
  type GroupApi,
  LayoutApi,
  type LayoutGroup,
  type LayoutPanel,
  type PanelApi,
  type PanelParams,
  type Rect,
  type SashSpec,
} from "./model";

// ---------------------------------------------------------------------------
// Props handed to the components a layout renders
// ---------------------------------------------------------------------------

export interface LayoutPanelProps<P extends PanelParams = PanelParams> {
  params: P;
  api: PanelApi;
  containerApi: LayoutApi;
}

export interface LayoutTabProps<P extends PanelParams = PanelParams> {
  params: P;
  api: PanelApi;
  containerApi: LayoutApi;
}

export interface LayoutHeaderActionsProps {
  api: GroupApi;
  containerApi: LayoutApi;
  group: LayoutGroup;
  panels: LayoutPanel[];
  activePanel: LayoutPanel | undefined;
  isGroupActive: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: components are registered by name with caller-defined params
type AnyComponent<Props> = ComponentType<Props & { params: any }>;

export interface LayoutReactProps {
  components: Record<string, AnyComponent<Omit<LayoutPanelProps, "params">>>;
  tabComponents?: Record<string, AnyComponent<Omit<LayoutTabProps, "params">>>;
  defaultTabComponent: AnyComponent<Omit<LayoutTabProps, "params">>;
  prefixHeaderActionsComponent?: ComponentType<LayoutHeaderActionsProps>;
  leftHeaderActionsComponent?: ComponentType<LayoutHeaderActionsProps>;
  rightHeaderActionsComponent?: ComponentType<LayoutHeaderActionsProps>;
  /** Classes on the layout's root element. */
  className?: string;
  /** Marks the root (`data-layout-kind`) so a test or a style can tell the
   *  center area from a terminal tab's split panes. */
  kind?: string;
  /** No tab dragging: tabs only select. */
  disableDnd?: boolean;
  /**
   * One panel per group: the tab is a pane header that fills its group. A drop
   * always splits (never joins the group's tabs) and the header overlays the
   * content.
   */
  paneMode?: boolean;
  /** Smallest size of a group on either axis, in px. */
  minGroupSize?: number;
  onReady: (api: LayoutApi) => void;
}

interface LayoutContextValue extends Omit<LayoutReactProps, "onReady"> {
  api: LayoutApi;
  minGroupSize: number;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

function useLayoutContext(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("layout: used outside a layout");
  return ctx;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

type DropZone = "center" | "left" | "right" | "top" | "bottom" | "tabs";

interface DropTarget {
  groupId: string;
  zone: DropZone;
  /** Insertion index among the group's tabs, for the `tabs` zone. */
  index?: number;
  /** The indicator's box in CSS px relative to the layout root. */
  box: { left: number; top: number; width: number; height: number };
}

const EDGE_RATIO = 0.25;

export function LayoutReact(props: LayoutReactProps) {
  const {
    onReady,
    components,
    tabComponents,
    defaultTabComponent,
    prefixHeaderActionsComponent,
    leftHeaderActionsComponent,
    rightHeaderActionsComponent,
    className,
    kind,
    disableDnd,
    paneMode,
    minGroupSize = 100,
  } = props;
  const [api] = useState(() => new LayoutApi());
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onReadyRef.current(api);
  }, [api]);

  const version = useSyncExternalStore(api.subscribe, api.getVersion, api.getVersion);

  // Tell the model the container's size, so it can write pixel sizes.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => api.layout(Math.round(w), Math.round(h));
    apply(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [api]);

  const ctx = useMemo<LayoutContextValue>(
    () => ({
      api,
      minGroupSize,
      components,
      tabComponents,
      defaultTabComponent,
      prefixHeaderActionsComponent,
      leftHeaderActionsComponent,
      rightHeaderActionsComponent,
      className,
      kind,
      disableDnd,
      paneMode,
    }),
    [
      api,
      minGroupSize,
      components,
      tabComponents,
      defaultTabComponent,
      prefixHeaderActionsComponent,
      leftHeaderActionsComponent,
      rightHeaderActionsComponent,
      className,
      kind,
      disableDnd,
      paneMode,
    ],
  );

  const geometry = computeGeometry(api.root);
  const maximized = api.maximizedGroup;

  const dnd = useTabDrag(api, rootRef, ctx);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));

  return (
    <LayoutContext.Provider value={ctx}>
      <div
        ref={rootRef}
        className={`band-layout${paneMode ? " band-layout--panes" : ""}${className ? ` ${className}` : ""}`}
        data-testid="layout-root"
        data-layout-root=""
        data-layout-id={api.id}
        data-layout-kind={kind}
        data-dragging={dnd.dragging ? "" : undefined}
      >
        <DndContext
          sensors={disableDnd ? [] : sensors}
          autoScroll={false}
          collisionDetection={() => []}
          onDragStart={dnd.onDragStart}
          onDragMove={dnd.onDragMove}
          onDragEnd={dnd.onDragEnd}
          onDragCancel={dnd.onDragCancel}
        >
          {geometry.groups.map(({ group, rect }) => {
            const isMaximized = maximized === group;
            const hidden = maximized !== undefined && !isMaximized;
            return (
              <GroupView
                key={group.id}
                group={group}
                rect={isMaximized ? FULL : rect}
                hidden={hidden}
                version={version}
              />
            );
          })}
          {maximized === undefined &&
            geometry.sashes.map((sash) => (
              <SashView
                key={`${branchUid(sash.branch)}:${sash.index}`}
                sash={sash}
                rootRef={rootRef}
              />
            ))}
          {dnd.target && (
            <div
              className="band-layout-drop"
              data-testid="layout-drop-indicator"
              data-zone={dnd.target.zone}
              style={{
                left: dnd.target.box.left,
                top: dnd.target.box.top,
                width: dnd.target.box.width,
                height: dnd.target.box.height,
              }}
            />
          )}
          {dnd.ghost && (
            <div className="band-layout-ghost" style={{ left: dnd.ghost.x, top: dnd.ghost.y }}>
              {dnd.ghost.title}
            </div>
          )}
        </DndContext>
        {api.panels.map((panel) =>
          createPortal(
            <PanelBoundary panelId={panel.id}>
              <PanelHost panel={panel} params={panel.params} />
            </PanelBoundary>,
            panel.element,
            panel.id,
          ),
        )}
      </div>
    </LayoutContext.Provider>
  );
}

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

const branchIds = new WeakMap<BranchNode, number>();
let nextBranchId = 1;
function branchUid(branch: BranchNode): number {
  let id = branchIds.get(branch);
  if (id === undefined) {
    id = nextBranchId++;
    branchIds.set(branch, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Panel content
// ---------------------------------------------------------------------------

class PanelBoundary extends ReactComponent<
  { panelId: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[layout] panel ${this.props.panelId} failed to render`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const PanelHost = memo(function PanelHost({
  panel,
  params,
}: {
  panel: LayoutPanel;
  params: PanelParams;
}) {
  const { components, api } = useLayoutContext();
  const Content = components[panel.contentComponent];
  if (!Content) return null;
  return <Content params={params} api={panel.api} containerApi={api} />;
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const GroupView = memo(function GroupView({
  group,
  rect,
  hidden,
}: {
  group: LayoutGroup;
  rect: Rect;
  hidden: boolean;
  /** Changes with every model update, so the group re-reads its panels. */
  version: number;
}) {
  const ctx = useLayoutContext();
  const { api } = ctx;
  const elRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    group.setElement(elRef.current);
  }, [group]);

  // Put each panel's element in the content area: the selected one, and every
  // `always` one (hidden), so a webview or a terminal keeps its DOM.
  useLayoutEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    for (const panel of group.panels) {
      const el = panel.element;
      const selected = group.activePanel === panel;
      if (selected || panel.renderer === "always") {
        if (el.parentElement !== host) host.appendChild(el);
        el.style.display = selected ? "" : "none";
        el.toggleAttribute("data-selected", selected);
      } else if (el.parentElement === host) {
        el.remove();
      }
    }
  });

  // Focus or a pointer press inside the group makes it the active one.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const activate = () => api.setActiveGroup(group);
    el.addEventListener("focusin", activate);
    el.addEventListener("pointerdown", activate, true);
    return () => {
      el.removeEventListener("focusin", activate);
      el.removeEventListener("pointerdown", activate, true);
    };
  }, [api, group]);

  // A vertical mouse wheel scrolls the tab list sideways. Everything else
  // (a trackpad's horizontal swipe, touch) scrolls it natively.
  useEffect(() => {
    const list = tabsRef.current;
    if (!list) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the selected tab in view.
  const selectedId = group.activePanel?.id;
  useLayoutEffect(() => {
    const list = tabsRef.current;
    if (!list || !selectedId) return;
    const tab = [...list.querySelectorAll<HTMLElement>("[data-panel-id]")].find(
      (t) => t.dataset.panelId === selectedId,
    );
    if (!tab) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
    if (tabRect.left < listRect.left) list.scrollLeft -= (listRect.left - tabRect.left) / scale;
    else if (tabRect.right > listRect.right)
      list.scrollLeft += (tabRect.right - listRect.right) / scale;
  }, [selectedId]);

  const Prefix = ctx.prefixHeaderActionsComponent;
  const Left = ctx.leftHeaderActionsComponent;
  const Right = ctx.rightHeaderActionsComponent;
  const isGroupActive = api.activeGroup === group;
  const actionProps: LayoutHeaderActionsProps = {
    api: group.api,
    containerApi: api,
    group,
    panels: [...group.panels],
    activePanel: group.activePanel,
    isGroupActive,
  };

  return (
    <div
      ref={elRef}
      className="band-layout-group"
      data-testid="layout-group"
      data-group-id={group.id}
      data-active-group={isGroupActive ? "true" : "false"}
      data-hidden={hidden ? "" : undefined}
      tabIndex={-1}
      style={{
        left: `${rect.x}%`,
        top: `${rect.y}%`,
        width: `${rect.w}%`,
        height: `${rect.h}%`,
        visibility: hidden ? "hidden" : undefined,
      }}
    >
      <div className="band-layout-header" data-testid="layout-header">
        {Prefix && (
          <div className="band-layout-pre-actions">
            <Prefix {...actionProps} />
          </div>
        )}
        <div
          ref={tabsRef}
          className="band-layout-tabs"
          data-testid="layout-tab-list"
          role="tablist"
          aria-orientation="horizontal"
        >
          {group.panels.map((panel, i) => (
            <TabItem
              key={panel.id}
              panel={panel}
              params={panel.params}
              selected={group.activePanel === panel}
              first={i === 0}
            />
          ))}
        </div>
        {Left && (
          <div className="band-layout-left-actions">
            <Left {...actionProps} />
          </div>
        )}
        <div className="band-layout-void" data-testid="layout-header-void" />
        {Right && (
          <div className="band-layout-right-actions">
            <Right {...actionProps} />
          </div>
        )}
      </div>
      <div ref={contentRef} className="band-layout-content" />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

const TabItem = memo(function TabItem({
  panel,
  params,
  selected,
  first,
}: {
  panel: LayoutPanel;
  params: PanelParams;
  selected: boolean;
  first: boolean;
}) {
  const { api, tabComponents, defaultTabComponent, disableDnd } = useLayoutContext();
  const Tab = (panel.tabComponent && tabComponents?.[panel.tabComponent]) || defaultTabComponent;
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: panel.id,
    disabled: disableDnd,
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const tabs = panel.group.panels;
    const i = tabs.indexOf(panel);
    let next: LayoutPanel | undefined;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    else if (e.key === "Enter" || e.key === " ") next = panel;
    if (!next) return;
    e.preventDefault();
    next.api.setActive();
    const list = e.currentTarget.parentElement;
    const id = next.id;
    requestAnimationFrame(() => {
      [...(list?.querySelectorAll<HTMLElement>("[data-panel-id]") ?? [])]
        .find((t) => t.dataset.panelId === id)
        ?.focus({ preventScroll: true });
    });
  };

  return (
    <div
      ref={setNodeRef}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className="band-layout-tab"
      data-testid="layout-tab"
      data-panel-id={panel.id}
      data-selected={selected ? "true" : "false"}
      data-first={first ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
      {...listeners}
      onPointerDown={(e) => {
        // A mouse or pen press selects at once; a touch waits for the click,
        // so a swipe along the strip scrolls it without switching tabs.
        if (e.pointerType !== "touch" && e.button === 0) panel.api.setActive();
      }}
      onClick={() => {
        if (panel.group.activePanel !== panel) panel.api.setActive();
      }}
      onKeyDown={onKeyDown}
    >
      <Tab params={params} api={panel.api} containerApi={api} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Sash
// ---------------------------------------------------------------------------

function SashView({
  sash,
  rootRef,
}: {
  sash: SashSpec;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { api, minGroupSize } = useLayoutContext();
  const horizontal = sash.orientation === "HORIZONTAL";
  const [active, setActive] = useState(false);

  /**
   * Start a resize of the two groups beside this sash. Returns a function that
   * takes the distance moved (in the pointer's pixels) from the start and
   * applies it, or null when the layout is not measurable.
   */
  const beginResize = () => {
    const root = rootRef.current;
    if (!root) return null;
    const { branch, index } = sash;
    const rootRect = root.getBoundingClientRect();
    // The branch's pixel extent on its axis, as the pointer reports it.
    const extent =
      ((horizontal ? sash.rect.w : sash.rect.h) / 100) *
      (horizontal ? rootRect.width : rootRect.height);
    const startWeights = [...branch.weights];
    const total = startWeights.reduce((a, b) => a + b, 0) || 1;
    const pairWeight = startWeights[index] + startWeights[index + 1];
    const pairPx = (pairWeight / total) * extent;
    const startA = (startWeights[index] / total) * extent;
    if (pairPx <= 0) return null;
    // The minimum size is in CSS px; the pointer reports zoomed (visual) px.
    const zoom = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
    const min = Math.min(minGroupSize * zoom, pairPx / 2);
    return (delta: number) => {
      const a = Math.min(Math.max(startA + delta, min), pairPx - min);
      const next = [...startWeights];
      next[index] = pairWeight * (a / pairPx);
      next[index + 1] = pairWeight * ((pairPx - a) / pairPx);
      api.setWeights(branch, next);
    };
  };

  // A drag in flight when the sash unmounts must still release the resize lock.
  const finishRef = useRef<(() => void) | null>(null);
  useEffect(() => () => finishRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const resize = beginResize();
    if (!resize) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const start = horizontal ? e.clientX : e.clientY;
    setActive(true);
    beginLayoutResize();
    document.documentElement.setAttribute("data-band-layout-dragging", "");

    const onMove = (ev: PointerEvent) => resize((horizontal ? ev.clientX : ev.clientY) - start);
    const finish = () => {
      finishRef.current = null;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      target.removeEventListener("lostpointercapture", finish);
      setActive(false);
      document.documentElement.removeAttribute("data-band-layout-dragging");
      endLayoutResize();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
    target.addEventListener("lostpointercapture", finish);
    finishRef.current = finish;
  };

  // Arrow keys move the sash by 20px (100px with Shift).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = horizontal
      ? { ArrowLeft: -1, ArrowRight: 1 }
      : ({ ArrowUp: -1, ArrowDown: 1 } as Record<string, number>);
    const direction = (keys as Record<string, number>)[e.key];
    if (!direction) return;
    const resize = beginResize();
    if (!resize) return;
    e.preventDefault();
    beginLayoutResize();
    resize(direction * (e.shiftKey ? 100 : 20));
    endLayoutResize();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter cannot be an <hr>
    <div
      className="band-layout-sash"
      data-testid="layout-sash"
      data-orientation={sash.orientation}
      data-active={active ? "" : undefined}
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(sash.position)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={
        horizontal
          ? { left: `${sash.position}%`, top: `${sash.rect.y}%`, height: `${sash.rect.h}%` }
          : { top: `${sash.position}%`, left: `${sash.rect.x}%`, width: `${sash.rect.w}%` }
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Dragging a tab: reorder, move to another group, or split
// ---------------------------------------------------------------------------

interface TabDrag {
  dragging: boolean;
  target: DropTarget | null;
  ghost: { x: number; y: number; title: string } | null;
  onDragStart: (e: DragStartEvent) => void;
  onDragMove: (e: DragMoveEvent) => void;
  onDragEnd: (e: DragEndEvent) => void;
  onDragCancel: () => void;
}

function useTabDrag(
  api: LayoutApi,
  rootRef: React.RefObject<HTMLDivElement | null>,
  ctx: LayoutContextValue,
): TabDrag {
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<TabDrag["ghost"]>(null);
  const targetRef = useRef<DropTarget | null>(null);

  const clear = useCallback(() => {
    setDragging(false);
    setTarget(null);
    setGhost(null);
    targetRef.current = null;
    document.documentElement.removeAttribute("data-band-layout-dragging");
  }, []);

  // A layout torn down mid-drag must not leave the page marked as dragging.
  useEffect(() => () => document.documentElement.removeAttribute("data-band-layout-dragging"), []);

  const onDragStart = useCallback((_e: DragStartEvent) => {
    setDragging(true);
    document.documentElement.setAttribute("data-band-layout-dragging", "");
  }, []);

  const onDragMove = useCallback(
    (e: DragMoveEvent) => {
      const root = rootRef.current;
      const panel = api.getPanel(String(e.active.id));
      const start = e.activatorEvent as MouseEvent | undefined;
      if (!root || !panel || !start) return;
      const x = start.clientX + e.delta.x;
      const y = start.clientY + e.delta.y;
      const rootRect = root.getBoundingClientRect();
      const scale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
      setGhost({
        x: (x - rootRect.left) / scale + 8,
        y: (y - rootRect.top) / scale + 8,
        title: panel.title,
      });
      const next = hitTest(api, root, panel, x, y, ctx.paneMode === true);
      targetRef.current = next;
      setTarget(next);
    },
    [api, rootRef, ctx.paneMode],
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const drop = targetRef.current;
      const panel = api.getPanel(String(e.active.id));
      clear();
      if (!drop || !panel) return;
      const group = api.getGroup(drop.groupId);
      if (!group) return;
      if (drop.zone === "tabs") {
        const from = group.panels.indexOf(panel);
        const index = drop.index ?? group.panels.length;
        if (from >= 0 && (index === from || index === from + 1)) {
          panel.api.setActive();
          return;
        }
        api.movePanel(panel, { group, index });
      } else if (drop.zone === "center") {
        if (group === panel.group) return;
        api.movePanel(panel, { group });
      } else {
        api.movePanel(panel, { group, position: drop.zone });
      }
    },
    [api, clear],
  );

  return { dragging, target, ghost, onDragStart, onDragMove, onDragEnd, onDragCancel: clear };
}

/** What a drop at the pointer position would do, or null if nothing. */
function hitTest(
  api: LayoutApi,
  root: HTMLElement,
  dragged: LayoutPanel,
  x: number,
  y: number,
  paneMode: boolean,
): DropTarget | null {
  const rootRect = root.getBoundingClientRect();
  const scale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
  const box = (left: number, top: number, width: number, height: number) => ({
    left: (left - rootRect.left) / scale,
    top: (top - rootRect.top) / scale,
    width: width / scale,
    height: height / scale,
  });

  for (const group of api.groups) {
    if (!api.isGroupShown(group)) continue;
    const r = group.element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const alone = group === dragged.group && group.panels.length === 1;

    const header = group.element.querySelector<HTMLElement>('[data-testid="layout-header"]');
    const headerRect = header?.getBoundingClientRect();
    if (!paneMode && headerRect && y <= headerRect.bottom) {
      const tabs = [...group.element.querySelectorAll<HTMLElement>("[data-panel-id]")];
      let index = group.panels.length;
      let lineX =
        tabs.length > 0 ? tabs[tabs.length - 1].getBoundingClientRect().right : headerRect.left;
      for (const tab of tabs) {
        const tr = tab.getBoundingClientRect();
        if (x < tr.left + tr.width / 2) {
          index = group.panels.findIndex((p) => p.id === tab.dataset.panelId);
          lineX = tr.left;
          break;
        }
      }
      return {
        groupId: group.id,
        zone: "tabs",
        index,
        box: box(lineX - 1, headerRect.top, 2, headerRect.height),
      };
    }

    const top = paneMode || !headerRect ? r.top : headerRect.bottom;
    const height = r.bottom - top;
    const relX = (x - r.left) / r.width;
    const relY = (y - top) / height;
    // The nearest edge within the edge band wins; elsewhere it is the center.
    const distances: [DropZone, number][] = [
      ["left", relX],
      ["right", 1 - relX],
      ["top", relY],
      ["bottom", 1 - relY],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    let zone: DropZone = distances[0][1] < EDGE_RATIO ? distances[0][0] : "center";
    if (paneMode && zone === "center") zone = distances[0][0];
    if (alone) return null;
    switch (zone) {
      case "left":
        return { groupId: group.id, zone, box: box(r.left, top, r.width / 2, height) };
      case "right":
        return {
          groupId: group.id,
          zone,
          box: box(r.left + r.width / 2, top, r.width / 2, height),
        };
      case "top":
        return { groupId: group.id, zone, box: box(r.left, top, r.width, height / 2) };
      case "bottom":
        return { groupId: group.id, zone, box: box(r.left, top + height / 2, r.width, height / 2) };
      default:
        if (group === dragged.group) return null;
        return { groupId: group.id, zone: "center", box: box(r.left, top, r.width, height) };
    }
  }
  return null;
}
