import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import type { Extension } from "@codemirror/state";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import {
  AlignJustify,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Code,
  Columns2,
  Eye,
  GitCompare,
  Globe,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreVertical,
  Plus,
  RotateCcw,
  Save,
  SquarePen,
  Terminal as TerminalIcon,
  TerminalSquare,
  X,
} from "lucide-react";
import type React from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AgentIcon,
  buildLspWsUrl,
  type ChangeEntry,
  type ChangeSection,
  type ChatInsertDetail,
  createDiffLspNavigation,
  createLspExtension,
  DiffFileContent,
  DiffOverviewRuler,
  FileViewer,
  formatShortcut,
  getFileIcon,
  getFilePreviewType,
  getLspLanguageId,
  getStoredViewMode,
  isMacPlatform,
  readAgentMode,
  releaseLspClient,
  SearchBar,
  serializeViewPosition,
  storeViewMode,
  type TerminalInsertDetail,
  toFileUri,
  toLspServerLang,
  useAdapter,
  useCapabilities,
  useSearch,
  useSettingsQuery,
  useWorkspacePath,
  type ViewMode,
} from "@/dashboard";
import { isUntitledPath, UNTITLED_PREFIX } from "../hooks/useFileTabs";
import type { TabFileState } from "../hooks/useTabState";
import {
  findChange,
  invalidateWorkspaceChanges,
  SECTION_LABELS,
  useWorkspaceChanges,
} from "../hooks/useWorkspaceChanges";
import { useWorkspaceColdParked } from "../hooks/useWorkspaceColdParked";
import {
  type CenterTab,
  type CenterTabs,
  centerTabsFromApi,
  centerTabsKey,
  diffCenterTabs,
  isSharedTab,
  keepHiddenTabs,
  parseCenterTabs,
  readCenterTabs,
  withLocalMembership,
  writeCenterTabs,
} from "../lib/center-tabs";
import { clientStorage, hydrateWorkspace, subscribeClientState } from "../lib/client-state";
import { writeClipboardText } from "../lib/clipboard";
import { listen as desktopListen } from "../lib/desktop-ipc";
import {
  cycleGridGroups,
  cycleTabsInActiveGroup,
  selectNeighbourBeforeRemove,
  splitDirectionForKey,
} from "../lib/dockview-section-actions";
import { attachTouchTabActivation } from "../lib/dockview-touch-tabs";
import { isDesktop } from "../lib/is-desktop";
import {
  markBrowserFresh,
  markChatFresh,
  newBrowserId,
  newChatId,
  newTerminalId,
} from "../lib/leaf-instance-ids";
import { pathInside } from "../lib/path-inside";
import { disposeTerminal, hasTerminal } from "../lib/terminal-cache";
import {
  clearLeafOwners,
  deleteNestedLayout,
  findFocusedTerminalSplitDockview,
  isOwnedPane,
  leafOwnsAnyLive,
  ownerOfTerminal,
  seedOwnersFromStorage,
  terminalSplitApiForLeaf,
  terminalsOwnedByLeaf,
  unregisterPaneOwner,
} from "../lib/terminal-split-registry";
import { trpc } from "../lib/trpc-client";
import { BrowserPaneComponent, type BrowserPaneParams, useFavicon } from "./BrowserPanel";
import { discardWarning } from "./ChangesSections";
import { ChatPane, type CodingAgentDef, useChatPaneState } from "./ChatPane";
import {
  CenterDragBar,
  RightPanelToggle,
  SidebarGutter,
  useWorkspaceChrome,
} from "./DesktopTitleBar";
import { renderMarkdownBlock } from "./markdown-block-renderer";
import { NewAgentButton, NewAgentSubmenu } from "./NewAgentMenu";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";
import { setPerWorkspaceState } from "./per-workspace-state-store";
// `crossPanelHandlers` is a module-level mutable registry exported from
// SharedDockviewLayout. Importing it closes an ESM cycle (SharedDockviewLayout
// → WorkspaceCenterDockview → SharedDockviewLayout), but we only read it inside
// callbacks (call time, never module eval), so the live binding is always
// populated by then — same pattern the legacy containers use.
import { crossPanelHandlers } from "./SharedDockviewLayout";
import { TerminalSplitLeaf } from "./TerminalSplitLeaf";

// ---------------------------------------------------------------------------
// Leaf kinds
// ---------------------------------------------------------------------------
//
// The unified center dockview holds LEAF panels. Each panel's dockview
// `component` field is the leaf KIND; its `id` is the instance id
// (chatId / terminalId / browserId) for the per-instance kinds, or the
// prefixed `file:<path>` / `diff:<path>` for the per-path file/diff leaves
// opened from the right sidepanel (Explorer + Changes). Keeping the instance
// id AS the panel id means all the focus / insert / status-event plumbing
// carries over unchanged from the legacy per-app inner dockviews.
// ---------------------------------------------------------------------------

export type LeafKind = "chat" | "term" | "browser" | "file" | "diff";

const PANEL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  chat: MessageSquare,
  term: TerminalIcon,
  browser: Globe,
};

const PANEL_SHORTCUTS: Record<string, string> = {};

// Every tab is a fixed 120px-wide row so the tab strip doesn't reflow as
// titles load/change. The title fills the remaining space and truncates; the
// full title is surfaced on hover (native `title` tooltip on the per-instance
// tabs; the singleton IconTab keeps its richer shortcut tooltip).
const TAB_TITLE_CLASS = "min-w-0 flex-1 truncate text-xs";
// Inner icon+title wrapper (grows to fill, leaving the close button pinned right).
const TAB_CONTENT_WRAP = "flex min-w-0 flex-1 items-center gap-1.5";

// Tab root fills the dockview `.dv-tab` wrapper (which is pinned to a fixed
// 120px in dockview-theme.css). `group` drives close-on-hover; the active-tab
// bottom accent is a CSS box-shadow on `.dv-active-tab` so it lands on the tab
// strip's bottom edge rather than floating inside the tab.
const TAB_ROOT_CLASS = "dv-default-tab group flex w-full items-center gap-1.5";

// Close button: always shown on the active tab; hidden on inactive tabs until
// the tab is hovered (the tab root carries the `group` class). Keeps the tab
// strip uncluttered while the active tab stays closable at a glance.
const CLOSE_BTN_BASE =
  "ml-0.5 inline-flex size-4 items-center justify-center rounded-sm transition-opacity hover:bg-accent";
function closeButtonClass(isActive: boolean): string {
  return `${CLOSE_BTN_BASE} ${isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"}`;
}

/** Track a tab's active state via its dockview panel api. */
function useTabActive(api: IDockviewPanelHeaderProps["api"]): boolean {
  const [isActive, setIsActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setIsActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  return isActive;
}

/** Track a leaf's `preview` param (italic tab) reactively — it flips to
 *  `false` when the preview tab is pinned via `updateParameters`. Seeds from
 *  `initialPreview` (the params dockview passes to the tab at first render)
 *  because `api.getParameters()` can be empty on the very first render of a
 *  freshly-added panel's tab. */
function useTabPreview(api: IDockviewPanelHeaderProps["api"], initialPreview?: boolean): boolean {
  const [preview, setPreview] = useState(
    () => api.getParameters<{ preview?: boolean }>().preview ?? initialPreview,
  );
  useEffect(() => {
    const d = api.onDidParametersChange(() => {
      setPreview(api.getParameters<{ preview?: boolean }>().preview);
    });
    return () => d.dispose();
  }, [api]);
  return preview === true;
}

const bandTheme: DockviewTheme = {
  name: "band",
  // `dockview-center-tabs` scopes the unified-center tab CSS (fixed 120px tab
  // width + active-tab bottom accent) so it never touches the legacy nested
  // chat/terminal tab strips still used by the mobile layout.
  className: "dockview-theme-band dockview-center-tabs",
};

// Desktop layout: the tab strip doubles as the window's top row (38px, drag
// region). See `.dockview-center-desktop` in dockview-theme.css.
const bandDesktopTheme: DockviewTheme = {
  ...bandTheme,
  className: `${bandTheme.className} dockview-center-desktop`,
};

// ---------------------------------------------------------------------------
// Per-workspace dockview api registry
// ---------------------------------------------------------------------------
//
// The shell (`SharedDockviewLayout`) owns global keyboard shortcuts + dialogs
// but no longer owns a dockview. It resolves the ACTIVE workspace's dockview
// api from this registry to route panel-activation / maximize shortcuts.
// Registered on `onReady`, cleared on unmount.
// ---------------------------------------------------------------------------

const workspaceDockviewApis = new Map<string, DockviewApi>();

export function getWorkspaceDockviewApi(workspaceId: string | null): DockviewApi | undefined {
  return workspaceId ? workspaceDockviewApis.get(workspaceId) : undefined;
}

/** First panel of a given leaf kind (or the singleton), or undefined. */
export function firstLeafOfKind(api: DockviewApi, kind: LeafKind) {
  return api.panels.find((p) => (p.api.component as LeafKind) === kind);
}

// Per-workspace leaf actions, so the shell (SharedDockviewLayout) can add a
// leaf to the active workspace's dockview (e.g. ⇧⌘N new chat) without owning
// a dockview api. Registered on `onReady`, cleared on unmount.
const workspaceLeafActions = new Map<string, { current: LeafActions }>();

export function getWorkspaceLeafActions(workspaceId: string | null): LeafActions | undefined {
  return workspaceId ? workspaceLeafActions.get(workspaceId)?.current : undefined;
}

// ---------------------------------------------------------------------------
// Per-panel header actions
// ---------------------------------------------------------------------------
//
// Each leaf can publish a node of action buttons (save, view toggle, revert…)
// that the group header (`RightHeaderActions`) renders next to the Maximize
// action for whichever tab is active — so the tab content holds no toolbar of
// its own. Leaves publish via `usePublishHeaderActions`; the header subscribes
// to a change event and re-reads the active panel's entry each render.
// ---------------------------------------------------------------------------

const leafHeaderActionsByPanelId = new Map<string, () => React.ReactNode>();
const HEADER_ACTIONS_EVENT = "band:leaf-header-actions-changed";

// The event carries the publishing panel's id so only the group header that
// holds that panel re-renders. Every visited workspace stays mounted, so an
// unscoped broadcast would re-render every hidden workspace's headers too.
function notifyHeaderActionsChanged(panelId: string): void {
  window.dispatchEvent(new CustomEvent<string>(HEADER_ACTIONS_EVENT, { detail: panelId }));
}

/** Publish this leaf's header-action buttons while mounted (and while `render`
 *  is non-null). `render` is re-published whenever `deps` change so the header
 *  reflects live state (e.g. a markdown toggle's current mode). */
function usePublishHeaderActions(
  panelId: string,
  render: (() => React.ReactNode) | null,
  // biome-ignore lint/suspicious/noExplicitAny: caller-controlled dep list
  deps: any[],
): void {
  const renderRef = useRef(render);
  renderRef.current = render;
  // `render` is re-read from a ref (so we always publish the latest closure)
  // and re-published when the caller's `deps` change.
  useEffect(() => {
    const render = renderRef.current;
    if (render) {
      leafHeaderActionsByPanelId.set(panelId, render);
    } else {
      leafHeaderActionsByPanelId.delete(panelId);
    }
    notifyHeaderActionsChanged(panelId);
    return () => {
      leafHeaderActionsByPanelId.delete(panelId);
      notifyHeaderActionsChanged(panelId);
    };
  }, [panelId, ...deps]);
}

// Per-workspace monotonic counter for untitled scratch buffers, mirroring
// `useFileTabs`'s `untitledCounterRef` — the file leaf isn't backed by
// `useFileTabs` (dockview owns the tab list), so the shell mints the
// `untitled:N` path itself. In-memory only: a reload restarts at 1, which is
// acceptable since untitled buffers aren't persisted across reloads here.
const untitledCounters = new Map<string, number>();

/** Mint the next `untitled:N` path for a workspace (1-based, monotonic). */
export function nextUntitledPath(workspaceId: string): string {
  const n = (untitledCounters.get(workspaceId) ?? 0) + 1;
  untitledCounters.set(workspaceId, n);
  return `${UNTITLED_PREFIX}${n}`;
}

// ---------------------------------------------------------------------------
// Per-workspace layout persistence (localStorage, kept on the server per
// device type through `lib/client-state.ts`)
// ---------------------------------------------------------------------------
//
// The layout holds splits and sizes, so a phone and a desktop each keep their
// own. Which tabs are open, their order and the active tab are shared by every
// device through `band:center-tabs:<ws>` (see "Shared tab list" below).
//
// Bumped v8 → v9 for Phase 2: v8 layouts (written during Phase 1) held `files`
// / `changes` singleton panels whose component types no longer exist, so
// restoring one would render an unregistered component and crash. Clean break —
// stale v8 blobs are simply ignored and a default layout is rebuilt.

const LAYOUT_KEY_PREFIX = "band:dockview-layout-v9:";

// Leaf component names this dockview can actually render. A saved layout that
// references anything else (a removed kind, a hand-edited blob) is sanitized on
// load so `fromJSON` never instantiates a panel we can't mount.
const KNOWN_LEAF_COMPONENTS = new Set<string>(["chat", "term", "browser", "file", "diff"]);

function layoutKey(workspaceId: string): string {
  return `${LAYOUT_KEY_PREFIX}${workspaceId}`;
}

function isDockviewLayout(obj: unknown): boolean {
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
 *  first grid group as tabs, then drop `edgeGroups` so `fromJSON` never
 *  recreates an edge group. dockview only builds panels a group references, so
 *  deleting `edgeGroups` alone would silently lose those panels. */
function moveEdgePanelsIntoGrid(layout: Record<string, unknown>): void {
  const edgeGroups = layout.edgeGroups as
    | Record<string, { group?: { views?: unknown } } | undefined>
    | undefined;
  delete layout.edgeGroups;
  if (!edgeGroups || typeof edgeGroups !== "object") return;
  // Only move views that have a panel entry. dockview's edge restore skipped a
  // view with no entry, but its grid restore throws on one, which would make
  // `fromJSON` fail and reset the whole layout to the default.
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
 *  `files`/`changes` singleton from an older layout) so `fromJSON` can't mount
 *  an unregistered component, and fold any legacy edge-group panels into the
 *  grid. Mutates + returns the layout clone. */
function sanitizeSavedLayout(layout: Record<string, unknown>): Record<string, unknown> {
  moveEdgePanelsIntoGrid(layout);
  const panels = layout.panels as Record<string, { contentComponent?: string }> | undefined;
  if (!panels) return layout;
  const removed = new Set<string>();
  for (const [id, panel] of Object.entries(panels)) {
    // dockview serializes each panel's kind as `contentComponent` (its
    // `toJSON()` shape), NOT `component`. Reading the wrong key here strips
    // EVERY panel as "unknown", which resets the layout on every reload.
    if (!panel?.contentComponent || !KNOWN_LEAF_COMPONENTS.has(panel.contentComponent)) {
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
function stripParams(json: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(json));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const panel of Object.values(panels)) panel.params = {};
  }
  return clone;
}

/** Re-inject `{ workspaceId, <kind>Id }` (and browser `initialUrl`) into the
 *  saved layout's panel params before `fromJSON`. */
function reinjectParams(
  layout: Record<string, unknown>,
  workspaceId: string,
  urls: Map<string, string>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(layout));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const [id, panel] of Object.entries(panels)) {
      // dockview's serialized panel records its kind under `contentComponent`.
      const comp = panel.contentComponent as LeafKind;
      if (comp === "chat") panel.params = { workspaceId, chatId: id };
      else if (comp === "term") panel.params = { workspaceId, terminalId: id };
      else if (comp === "browser") {
        panel.params = { workspaceId, browserId: id, initialUrl: urls.get(id) };
        // Same as `addBrowserLeaf`; layouts saved before browser tabs were
        // `<webview>`s carry no renderer.
        panel.renderer = "always";
      } else if (comp === "file" || comp === "diff") {
        panel.params = viewLeafParams(comp, id, workspaceId);
      } else panel.params = { workspaceId };
    }
  }
  return clone;
}

/** Params of a file / diff leaf, rebuilt from its id. `"file:".length === 5`
 *  and `"diff:".length === 5` — strip the prefix back into the filePath param.
 *  Line/column are transient (jump targets) and intentionally not persisted. */
function viewLeafParams(
  kind: "file" | "diff",
  id: string,
  workspaceId: string,
): FileLeafParams | DiffLeafParams {
  if (kind === "file") return { workspaceId, filePath: id.slice(5) };
  const commit = COMMIT_DIFF_ID.exec(id);
  const allOf = SECTION_DIFFS_ID.exec(id);
  return commit
    ? { workspaceId, filePath: commit[2], commit: commit[1] }
    : allOf
      ? { workspaceId, filePath: "", allOf: allOf[1] as ChangeSection }
      : { workspaceId, filePath: id.slice(5) };
}

/** Pin a new panel to a grid group rather than whatever `activeGroup` is (which
 *  can be a floating group). With no grid group left, `{ direction: "within" }`
 *  without a reference makes dockview create a fresh central group. */
function centralPanelPosition(
  api: DockviewApi,
): { referenceGroup: string } | { direction: "within" } {
  const central = api.groups.find((g) => g.api.location.type === "grid");
  if (central) return { referenceGroup: central.id };
  return { direction: "within" };
}

/** Where a newly-opened file/diff leaf should go: the group the user is
 *  currently working in (the active grid group), falling back to the central
 *  group. Prevents every open from landing in the first tab group. */
function activeOrCentralPosition(api: DockviewApi): AddPanelOptions["position"] {
  const active = api.activeGroup;
  if (active && active.api.location.type === "grid") return { referenceGroup: active.id };
  return centralPanelPosition(api);
}

/** Collapse every grid group into the first one — mobile is tabs-only, so a
 *  default or restored (desktop-created) split must render as a single tab
 *  strip. No-op when there's already one grid group. */
function flattenToSingleGroup(api: DockviewApi): void {
  const grid = api.groups.filter((g) => g.api.location.type === "grid");
  if (grid.length <= 1) return;
  const target = grid[0];
  for (const group of grid.slice(1)) {
    for (const panel of [...group.panels]) {
      try {
        panel.api.moveTo({ group: target });
      } catch {}
    }
  }
}

function loadSavedLayout(workspaceId: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(layoutKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isDockviewLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared settings fetch
//
// `settings.get` is global. A workspace with several chat tabs would otherwise
// fire one `settings.get` per tab header mount (N small server-side file
// reads). A short-TTL shared promise collapses that burst into a single fetch
// while staying fresh enough that a Settings-UI agent change is picked up on
// the next tab mount. Ported from the legacy `DockviewChatContainer`.
// ---------------------------------------------------------------------------

let sharedSettingsPromise: Promise<unknown> | null = null;
let sharedSettingsAt = 0;
const SHARED_SETTINGS_TTL_MS = 5_000;

function getSharedSettings(): Promise<unknown> {
  const now = Date.now();
  if (!sharedSettingsPromise || now - sharedSettingsAt > SHARED_SETTINGS_TTL_MS) {
    sharedSettingsAt = now;
    sharedSettingsPromise = trpc.settings.get.query().catch(() => {
      // Don't cache a failed fetch for the whole TTL — reset so the next
      // mount retries instead of every tab in the window seeing null.
      sharedSettingsPromise = null;
      return null;
    });
  }
  return sharedSettingsPromise;
}

// ---------------------------------------------------------------------------
// Live-instance data (chats / terminals / browsers) fetched once per mount
// ---------------------------------------------------------------------------

interface CenterLayoutData {
  chatIds: Set<string>;
  terminalIds: Set<string>;
  browserIds: Set<string>;
  urls: Map<string, string>;
}

function centerLayoutKey(workspaceId: string) {
  return ["workspaceCenterLayout", workspaceId] as const;
}

// ---------------------------------------------------------------------------
// Leaf param shapes
// ---------------------------------------------------------------------------

interface ChatLeafParams {
  workspaceId: string;
  chatId: string;
}
interface TermLeafParams {
  workspaceId: string;
  terminalId: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
}
interface BrowserLeafParams {
  workspaceId: string;
  browserId: string;
  initialUrl?: string;
}
interface FileLeafParams {
  workspaceId: string;
  filePath: string;
  line?: number;
  column?: number;
  external?: boolean;
  /** Untitled scratch buffer (`untitled:N` path) — no backing file until saved. */
  untitled?: boolean;
  /** Preview (italic, reused) tab — set by a single-click, cleared on pin. */
  preview?: boolean;
}
interface DiffLeafParams {
  workspaceId: string;
  filePath: string;
  preview?: boolean;
  /** Set for a diff opened from the Commits panel: the file's change in
   *  this commit (vs its first parent) instead of the working-tree diff. */
  commit?: string;
  /** Which Changes section's diff to show (staged, unstaged, committed on
   *  the branch, …). Unset for a diff restored from a saved layout or opened
   *  with "View changes": the leaf uses the first section listing the file. */
  section?: ChangeSection;
  /** The path before a rename, so the diff pairs both sides. */
  oldPath?: string;
  /** Set for a section's "View all" tab: every file of that section, stacked
   *  (`filePath` is empty). */
  allOf?: ChangeSection;
}

// Diff leaves are keyed `diff:<path>` — one tab per path, whichever section it
// was opened from. A commit's file diff is keyed `diff@<sha>:<path>` and a
// section's "View all" tab `diffs:<section>`, so renames/deletes in the
// Explorer (which match on the `diff:` prefix) leave them alone.
const COMMIT_DIFF_ID = /^diff@([0-9a-f]{7,40}):(.+)$/i;
const SECTION_DIFFS_ID = /^diffs:(conflicts|unstaged|staged|untracked|branch)$/;

function commitDiffId(sha: string, filePath: string): string {
  return `diff@${sha}:${filePath}`;
}

function sectionDiffsId(section: ChangeSection): string {
  return `diffs:${section}`;
}

// ---------------------------------------------------------------------------
// Chat leaf
// ---------------------------------------------------------------------------

function ChatLeaf({ params, api }: IDockviewPanelProps<ChatLeafParams>) {
  const [tabActive, setTabActive] = useState(api.isActive);
  const { visible: parentVisible, wsActive } = usePanelVisibility();

  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => d.dispose();
  }, [api]);

  if (!params.workspaceId || !params.chatId) return null;

  return (
    <ChatLeafContent
      workspaceId={params.workspaceId}
      chatId={params.chatId}
      visible={parentVisible && tabActive}
      wsActive={wsActive}
      setTitle={(title) => api.setTitle(title)}
    />
  );
}

function ChatLeafContent({
  workspaceId,
  chatId,
  visible,
  wsActive,
  setTitle,
}: {
  workspaceId: string;
  chatId: string;
  visible: boolean;
  wsActive: boolean;
  setTitle: (title: string) => void;
}) {
  const state = useChatPaneState(workspaceId, chatId);

  const setTitleRef = useRef(setTitle);
  setTitleRef.current = setTitle;
  useEffect(() => {
    if (!state.sessionQueryDone) return;
    const title = state.activeSessionSummary || state.agentLabel || state.codingAgentId || "Chat";
    setTitleRef.current(title);
  }, [state.sessionQueryDone, state.activeSessionSummary, state.agentLabel, state.codingAgentId]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-chat-leaf__visible-${visible ? "true" : "false"}`}
    >
      <ChatPane
        workspaceId={workspaceId}
        chatId={chatId}
        visible={visible}
        wsActive={wsActive}
        state={state}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal leaf
// ---------------------------------------------------------------------------

function TerminalLeaf({ params, api, containerApi }: IDockviewPanelProps<TermLeafParams>) {
  // On screen = workspace visible AND this is the selected tab in its group.
  // Terminal leaves use `renderer: "always"`, so an unselected tab stays
  // mounted; without this fold every terminal tab in the workspace reported
  // visible, stayed attached (starving the parked-terminal LRU), and all of
  // them grabbed ⌃` focus and received "Add to Terminal" inserts.
  //
  // `isVisible` (selected in its group), NOT `isActive` (selected AND its group
  // focused): a terminal split beside a focused chat is still on screen and
  // must stay attached.
  const { visible: parentVisible } = usePanelVisibility();
  const [tabVisible, setTabVisible] = useState(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setTabVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  const visible = parentVisible && tabVisible;

  // The OUTER tab title tracks the last-focused pane inside the nested split.
  const onTitleChange = useCallback((title: string) => api.setTitle(title), [api]);

  const ws = params.workspaceId;
  const tid = params.terminalId;
  // A lone-pane close / ⌘W routes here → close the whole terminal tab (the
  // outer `doCloseLeaf` kills every pane's PTY it owns).
  const onCloseLeaf = useCallback(() => {
    if (ws && tid) getWorkspaceLeafActions(ws)?.onClose(tid, "term");
  }, [ws, tid]);

  // Mobile is single-pane / no-split — the workspace dockview tags itself in
  // `mobileByApiId` on `onReady`.
  const mobile = mobileByApiId.has(containerApi.id);

  if (!ws || !tid) return null;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-term-leaf__visible-${visible ? "true" : "false"}`}
    >
      <TerminalSplitLeaf
        workspaceId={ws}
        leafId={tid}
        primaryTerminalId={tid}
        command={params.command}
        cwd={params.cwd}
        env={params.env}
        autoFocus={params.autoFocus}
        visible={visible}
        mobile={mobile}
        onActivePaneTitleChange={onTitleChange}
        onCloseLeaf={onCloseLeaf}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browser leaf (desktop only)
// ---------------------------------------------------------------------------

function BrowserLeaf({ params, api }: IDockviewPanelProps<BrowserLeafParams>) {
  const { visible } = usePanelVisibility();

  if (!params.workspaceId || !params.browserId) return null;

  const paneParams: BrowserPaneParams = {
    workspaceId: params.workspaceId,
    browserId: params.browserId,
    wsActive: visible,
    initialUrl: params.initialUrl,
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-browser-leaf__visible-${visible ? "true" : "false"}`}
    >
      <BrowserPaneComponent
        params={paneParams}
        api={api}
        // biome-ignore lint/suspicious/noExplicitAny: dockview panel props require matching shape
        {...({} as any)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// File + Diff per-path leaves (opened from the right sidepanel)
// ---------------------------------------------------------------------------

/** Last path segment (POSIX or Windows separators), for a tab title. */
function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

// ---------------------------------------------------------------------------
// Per-file editor-state persistence (localStorage) — FRESH reads/writes
// ---------------------------------------------------------------------------
//
// Format-compatible with mobile's `useTabState` (same `band-tab-state:<ws>`
// key + `TabFileState` shape). But `useTabState` caches its state in a
// per-instance `useRef` loaded once from localStorage, and dockview renders
// the tab header (`FileTab`) and the leaf content (`FileLeaf`) as SEPARATE
// React trees — so a `useTabState` instance in one is invisible to the other.
// These module-level helpers read/write localStorage FRESH on every call,
// sidestepping that cross-instance staleness while staying interoperable with
// mobile's store.
// ---------------------------------------------------------------------------

const TAB_STATE_KEY = (ws: string): string => `band-tab-state:${ws}`;

function readTabStates(ws: string): Record<string, TabFileState> {
  try {
    const raw = localStorage.getItem(TAB_STATE_KEY(ws));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return dropLegacyEditorState(ws, parsed as Record<string, LegacyTabFileState>);
  } catch {
    return {};
  }
}

// Earlier builds persisted the full CodeMirror `EditorState` (entire document +
// undo history) under `editorState`. Strip it on first read and write the
// slimmer blob back once, so existing users stop re-parsing megabytes per
// render and a stale document snapshot can never be restored.
// `migrateLegacyTabStates` does the same eagerly for EVERY workspace's blob
// once per page load, so file text viewed in a workspace the user never
// reopens doesn't sit in browser storage indefinitely.
type LegacyTabFileState = TabFileState & { editorState?: unknown };
function dropLegacyEditorState(
  ws: string,
  states: Record<string, LegacyTabFileState>,
): Record<string, TabFileState> {
  let changed = false;
  for (const state of Object.values(states)) {
    if (state && typeof state === "object" && "editorState" in state) {
      delete state.editorState;
      changed = true;
    }
  }
  if (changed) writeTabStates(ws, states);
  return states;
}

let legacyTabStatesMigrated = false;
function migrateLegacyTabStates(): void {
  if (legacyTabStatesMigrated) return;
  legacyTabStatesMigrated = true;
  try {
    const prefix = TAB_STATE_KEY("");
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      // Cheap pre-check: only parse (and rewrite) blobs that carry the field.
      if (!localStorage.getItem(key)?.includes('"editorState"')) continue;
      readTabStates(key.slice(prefix.length));
    }
  } catch {
    // storage unavailable — best-effort
  }
}

function writeTabStates(ws: string, states: Record<string, TabFileState>): void {
  try {
    clientStorage.setItem(TAB_STATE_KEY(ws), JSON.stringify(states));
  } catch {
    // storage unavailable — best-effort
  }
}

function getFileTabState(ws: string, path: string): TabFileState | undefined {
  return readTabStates(ws)[path];
}

function updateFileTabState(ws: string, path: string, patch: Partial<TabFileState>): void {
  const states = readTabStates(ws);
  states[path] = { ...(states[path] ?? {}), ...patch };
  writeTabStates(ws, states);
}

function isFileDirty(ws: string, path: string): boolean {
  return getFileTabState(ws, path)?.editedContent != null;
}

// File leaves closed by the user. `doCloseLeaf` drops the leaf's tab state
// synchronously, but React unmounts the leaf afterwards and its cleanup would
// persist the cursor position right back, so a closed file would not start
// clean on its next open. The cleanup consumes this marker and skips the write.
const closedFileLeaves = new Set<string>();
const closedFileLeafKey = (ws: string, path: string): string => `${ws}\u0000${path}`;

function removeFileTabState(ws: string, path: string): void {
  const states = readTabStates(ws);
  if (path in states) {
    delete states[path];
    writeTabStates(ws, states);
  }
}

// ---------------------------------------------------------------------------
// Self-contained find-in-file for the file / diff leaves
// ---------------------------------------------------------------------------
//
// `FileViewer` has no built-in find, so we replicate the small slice of
// CodeBrowserView's wiring here: a `useSearch` over the leaf's
// CodeMirror editor view(s) plus a `SearchBar`. `useSearch` already ships a
// window-level Cmd/Ctrl+F handler and reports its "open find" fn through
// `onFindInFile`, so all we add on top is:
//   - scoping open-on-⌘F to focus inside THIS leaf (capture-phase keydown on
//     the leaf container, mirroring the terminal/chat leaf handlers), and
//   - registering the leaf's open fn with the shell's per-workspace
//     `crossPanelHandlers.onFindInFile` registry while the leaf is visible so
//     the global ⌘F (SharedDockviewLayout) resolves to it.
function useLeafFind(
  workspaceId: string,
  visible: boolean,
  // True while a markdown file is shown as its rendered preview. The preview
  // is a CodeMirror view too, so find works the same; only the placeholder
  // changes.
  previewActive = false,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The set of CodeMirror EditorViews to search. `file` leaves have one;
  // `diff` leaves have one (unified) or two (split) — kept untyped to avoid a
  // direct @codemirror/view dependency in this component (same pattern as
  // CodeBrowserView).
  // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped to avoid cross-package dependency
  const viewsRef = useRef<any[]>([]);
  const getViews = useCallback(() => viewsRef.current, []);

  // Only the visible leaf registers with the shell's per-workspace registry,
  // so the global ⌘F resolves to the leaf the user is looking at (the registry
  // holds a single fn per workspace). Hidden leaves pass `null` and unregister.
  const onFindInFile = useMemo(
    () =>
      visible
        ? (fn: (() => void) | null) => crossPanelHandlers.onFindInFile(workspaceId, fn)
        : null,
    [visible, workspaceId],
  );

  // `registerGlobalFindKey: false` — this hook owns a focus-scoped Cmd+F
  // handler below. `useSearch`'s built-in window handler is unscoped and would
  // open EVERY mounted leaf's find bar on a single Cmd+F (with split groups
  // several leaves are visible at once, and even a Cmd+F from a focused
  // terminal reached every leaf's opener). The scoped handler is the single
  // opener; it only fires when focus is inside this leaf's container.
  const search = useSearch({ getViews, onFindInFile, registerGlobalFindKey: false });

  // Re-dispatch the active query to newly-registered views (e.g. a split-diff
  // second pane, or the editor after content loads).
  const setViews = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped
    (views: any[]) => {
      viewsRef.current = views;
      if (views.length > 0) search.dispatchToViews(views);
    },
    [search.dispatchToViews],
  );

  // Open on Cmd/Ctrl+F only when focus is inside this leaf. `useSearch`'s own
  // window handler is unscoped (it would open every mounted leaf's bar), so we
  // stop it here and drive just this leaf's open. Esc closes via the SearchBar.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.key.toLowerCase() !== "f") return;
      if (!containerRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      search.handleOpenSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, search.handleOpenSearch]);

  const searchBar = search.searchOpen ? (
    <SearchBar
      ref={search.searchBarRef}
      variant="floating"
      query={search.searchQuery}
      onQueryChange={search.setSearchQuery}
      options={search.searchOptions}
      onOptionsChange={search.setSearchOptions}
      placeholder={previewActive ? "Find in preview..." : "Find in file..."}
      matchInfo={search.matchInfo}
      onNext={search.handleNext}
      onPrevious={search.handlePrevious}
      onClose={search.handleCloseSearch}
    />
  ) : undefined;

  return { containerRef, setViews, searchBar };
}

// ---------------------------------------------------------------------------
// Per-file LSP extensions for the file and diff leaves
// ---------------------------------------------------------------------------
//
// External + untitled paths get no LSP (external files are outside the project
// root; untitled buffers have no file URI). The LSP clients are refcounted per
// WS url, so several leaves on one workspace share a language server; each
// effect run releases exactly the reference it acquired.

// Maps a file extension to the CodeMirror language name used by the LSP layer.
const LSP_EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
};

function fileCmLang(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? LSP_EXT_LANG_MAP[ext] : undefined;
}

type LspExtensionFactory = (
  wsUrl: string,
  rootUri: string,
  documentUri: string,
  languageId: string,
  workspaceId: string,
) => Promise<Extension>;

function useLeafLsp(
  workspaceId: string,
  filePath: string,
  disabled: boolean,
  create: LspExtensionFactory,
): Extension | null {
  const { settings } = useSettingsQuery();
  const workspacePath = useWorkspacePath(workspaceId);
  const [lspExtension, setLspExtension] = useState<Extension | null>(null);
  // A cold-parked hidden workspace releases its language server (a tsserver
  // can hold hundreds of MB) and re-acquires it when shown again.
  const coldParked = useWorkspaceColdParked(workspaceId);

  // Only TS/JS-family files have a mapped server language.
  const lspServerLang = useMemo(() => {
    if (!settings.enableLSP || coldParked || disabled) return null;
    const cmLang = fileCmLang(filePath);
    return cmLang ? toLspServerLang(cmLang) : null;
  }, [filePath, disabled, settings.enableLSP, coldParked]);

  const lspWsUrl = useMemo(
    () => (lspServerLang ? buildLspWsUrl(workspaceId, lspServerLang) : null),
    [workspaceId, lspServerLang],
  );

  useEffect(() => {
    setLspExtension(null);
    if (!lspWsUrl || !workspacePath) return;
    let cancelled = false;
    const cmLang = fileCmLang(filePath);
    const created = create(
      lspWsUrl,
      toFileUri(workspacePath),
      toFileUri(workspacePath, filePath),
      (cmLang && getLspLanguageId(cmLang)) || "",
      workspaceId,
    );
    created
      .then((ext) => {
        if (!cancelled) setLspExtension(ext);
      })
      .catch((err) => console.warn("[leaf] LSP extension creation failed:", err));
    return () => {
      cancelled = true;
      // Release only once the client was acquired (a failed connect holds none).
      created.then(
        () => releaseLspClient(lspWsUrl),
        () => {},
      );
    };
  }, [lspWsUrl, workspacePath, filePath, workspaceId, create]);

  return lspExtension;
}

// ---------------------------------------------------------------------------
// Active-file tracking (feeds the per-workspace `currentFile` store)
// ---------------------------------------------------------------------------
//
// Re-enables Quick Open's current-file highlight + the Explorer/Changes tree
// highlight, both of which subscribe to `currentFile`. A `file` / `diff` leaf
// publishes its path to the store only when it is BOTH the active tab in its
// group AND visible (`usePanelVisibility().visible` already folds in
// "outer panel visible AND workspace active"), so a hidden or cached
// workspace's leaves never clobber the active workspace's current file.
function useActiveFileTracking(
  api: IDockviewPanelProps["api"],
  workspaceId: string,
  filePath: string,
  visible: boolean,
): void {
  const [tabActive, setTabActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => d.dispose();
  }, [api]);

  useEffect(() => {
    if (!visible || !tabActive || !workspaceId || !filePath) return;
    setPerWorkspaceState(workspaceId, { currentFile: filePath });
  }, [visible, tabActive, workspaceId, filePath]);
}

function FileLeaf({ params, api }: IDockviewPanelProps<FileLeafParams>) {
  const { visible } = usePanelVisibility();
  const workspaceIdRaw = params.workspaceId ?? "";
  const filePathRaw = params.filePath ?? "";

  // FileViewer's markdown code/preview toggle and language override are
  // CONTROLLED props — they must reflect React state, not a bare localStorage
  // read (which never re-renders, so the toggle would appear to do nothing).
  // Seed from the persisted tab state, then update state + persist on change.
  const [viewMode, setViewMode] = useState<"preview" | "source" | undefined>(
    () => getFileTabState(workspaceIdRaw, filePathRaw)?.viewMode,
  );

  // Markdown defaults to the rendered preview, so anything but explicit "source".
  const previewFindActive = getFilePreviewType(filePathRaw) === "markdown" && viewMode !== "source";

  const { containerRef, setViews, searchBar } = useLeafFind(
    workspaceIdRaw,
    visible,
    previewFindActive,
  );
  useActiveFileTracking(api, workspaceIdRaw, filePathRaw, visible);
  const capabilities = useCapabilities();
  const untitled = params.untitled === true || isUntitledPath(filePathRaw);
  const external = untitled ? false : (params.external ?? filePathRaw.startsWith("/"));
  const lspExtension = useLeafLsp(
    workspaceIdRaw,
    filePathRaw,
    external || untitled,
    createLspExtension,
  );
  const coldParked = useWorkspaceColdParked(workspaceIdRaw);

  const workspacePath = useWorkspacePath(workspaceIdRaw);

  const [languageOverride, setLanguageOverride] = useState<string | undefined>(
    () => getFileTabState(workspaceIdRaw, filePathRaw)?.language,
  );

  // FileViewer reports its Save + markdown-toggle availability here; the file
  // leaf lifts those (plus "View changes") into the dockview group header so
  // the tab content carries no toolbar (#643).
  const [fileActions, setFileActions] = useState<{
    isDirty: boolean;
    canSave: boolean;
    saving: boolean;
    save: () => void;
    showMarkdownToggle: boolean;
  } | null>(null);

  // Hold the live EditorView so we can serialize its cursor selection + scroll
  // offset on unmount/pagehide and restore it next open (see `persistEditorState`).
  // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped
  const editorViewRef = useRef<any>(null);
  const handleEditorView = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped
    (view: any) => {
      editorViewRef.current = view;
      setViews(view ? [view] : []);
    },
    [setViews],
  );

  // Capture the editor's cursor selection + scroll offset into the per-tab
  // store so reopening the file (or reloading) lands the user back where they
  // were. `FileViewer` restores it via `savedSelection`/`savedScrollTop` below.
  // Only positions are stored, never the document or undo history: the text
  // always comes from disk (or the saved unsaved-edits), so a reload can't
  // replay a stale copy of the file over newer content.
  const persistEditorState = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    try {
      const { selection, scrollTop } = serializeViewPosition(view);
      updateFileTabState(workspaceIdRaw, filePathRaw, { selection, scrollTop });
    } catch {
      // editor not ready — nothing to capture
    }
  }, [workspaceIdRaw, filePathRaw]);

  // Persist on unmount (the `[]`-dep cleanup below — a `file` leaf uses
  // dockview's default `onlyWhenVisible` renderer, so closing or navigating away
  // from the tab tears the leaf down) and on page hide (covers a reload/close
  // while this leaf is the active, visible tab — its cleanup wouldn't otherwise
  // fire in time). Note this does NOT fire on a bare `visible` flip.
  const persistEditorStateRef = useRef(persistEditorState);
  persistEditorStateRef.current = persistEditorState;
  useEffect(() => {
    const onPageHide = () => persistEditorStateRef.current();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // A leaf the user closed must not write its position back (see
      // `closedFileLeaves`); consume the marker so a later open persists again.
      if (closedFileLeaves.delete(closedFileLeafKey(workspaceIdRaw, filePathRaw))) return;
      persistEditorStateRef.current();
    };
    // A file leaf's workspace + path never change, so this still runs only on
    // mount/unmount.
  }, [workspaceIdRaw, filePathRaw]);

  // Save-as flow for untitled buffers. `capabilities.pickSaveFile` bundles the
  // OS "Save As" dialog + the disk write and resolves with the absolute path
  // (null on cancel). On success we open the now-real file as its own leaf
  // (workspace-relative when it landed inside the workspace, external
  // otherwise) and close this untitled leaf — mirrors CodeBrowserView's
  // untitled→file transition, just at the leaf granularity.
  const pickSaveFile = capabilities.pickSaveFile;
  const handleSaveAs = useCallback(
    async (content: string): Promise<string | null> => {
      if (!pickSaveFile) return null;
      const chosen = await pickSaveFile({ content, defaultPath: workspacePath ?? undefined });
      if (!chosen) return null;
      const chosenPosix = chosen.replace(/\\/g, "/");
      const relative = workspacePath != null ? pathInside(workspacePath, chosenPosix) : null;
      const isExternal = relative === null;
      const newPath = relative ?? chosenPosix;
      const actions = getWorkspaceLeafActions(workspaceIdRaw);
      // Drop the untitled buffer's persisted edited-content so the close
      // confirm doesn't treat the (now-saved) tab as dirty, then swap leaves.
      removeFileTabState(workspaceIdRaw, filePathRaw);
      actions?.openFile(newPath, { external: isExternal, preview: false });
      actions?.onClose(`file:${filePathRaw}`, "file");
      window.dispatchEvent(new CustomEvent("band:dirty-change"));
      return chosenPosix;
    },
    [pickSaveFile, workspacePath, workspaceIdRaw, filePathRaw],
  );

  // "View changes" only shows while this file is in one of the Changes
  // sections, read from the same cached result the Changes panel uses (a
  // renamed file is listed under its new path). Untitled and external files are
  // never in it. The poll runs only while the leaf is visible; a save
  // refetches at once so the button appears without waiting for the next poll.
  const changesEnabled = !untitled && !external;
  const changesQuery = useWorkspaceChanges(workspaceIdRaw, {
    enabled: changesEnabled && visible,
    refetchInterval: visible ? 15_000 : false,
  });
  const canViewDiff = changesEnabled && !!findChange(changesQuery.data, filePathRaw);
  const refetchChanges = changesQuery.refetch;
  const wasDirtyRef = useRef(false);
  const isDirty = fileActions?.isDirty ?? false;
  useEffect(() => {
    if (wasDirtyRef.current && !isDirty && changesEnabled) void refetchChanges();
    wasDirtyRef.current = isDirty;
  }, [isDirty, changesEnabled, refetchChanges]);

  // Publish this file leaf's actions (markdown toggle, Save, View changes) to
  // the group header — the FileViewer's own title bar is hidden (#643).
  usePublishHeaderActions(
    api.id,
    workspaceIdRaw && filePathRaw
      ? () => (
          <div className="flex items-center gap-0.5">
            {fileActions?.showMarkdownToggle && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("preview");
                    updateFileTabState(workspaceIdRaw, filePathRaw, { viewMode: "preview" });
                  }}
                  title="Preview"
                  data-testid="center-file-leaf__view--preview"
                  className={`inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-accent ${
                    viewMode !== "source" ? "bg-accent text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <Eye className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("source");
                    updateFileTabState(workspaceIdRaw, filePathRaw, { viewMode: "source" });
                  }}
                  title="Source"
                  data-testid="center-file-leaf__view--source"
                  className={`inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-accent ${
                    viewMode === "source" ? "bg-accent text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <Code className="size-3.5" />
                </button>
              </>
            )}
            {fileActions?.canSave && fileActions.isDirty && (
              <button
                type="button"
                onClick={() => fileActions.save()}
                disabled={fileActions.saving}
                title="Save (Cmd+S)"
                data-testid="center-file-leaf__save"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {fileActions.saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
              </button>
            )}
            {canViewDiff && (
              <button
                type="button"
                onClick={() =>
                  getWorkspaceLeafActions(workspaceIdRaw)?.openDiff(filePathRaw, { preview: false })
                }
                title="View changes"
                data-testid="center-file-leaf__view-diff"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <GitCompare className="size-3.5" />
              </button>
            )}
          </div>
        )
      : null,
    [fileActions, viewMode, canViewDiff, workspaceIdRaw, filePathRaw],
  );

  if (!params.workspaceId || !params.filePath) return null;
  const workspaceId = params.workspaceId;
  const filePath = params.filePath;
  const persisted = getFileTabState(workspaceId, filePath);
  return (
    <div
      ref={containerRef}
      // Focusable (but not in the tab order) so clicking anywhere in the leaf,
      // including a rendered markdown preview that has no focusable content,
      // moves focus inside it. `useLeafFind` only opens on Cmd/Ctrl+F when
      // focus is within this container; without this a preview could never
      // open its find bar.
      tabIndex={-1}
      className="flex h-full w-full flex-col overflow-hidden outline-none"
      data-testid={`center-file-leaf__visible-${visible ? "true" : "false"}`}
    >
      <FileViewer
        workspaceId={workspaceId}
        filePath={filePath}
        line={params.line}
        column={params.column}
        editable
        external={external}
        untitled={untitled}
        // LSP is workspace-scoped: external files have no project root and
        // untitled buffers have no file URI, so `useLeafLsp` returns null
        // for both — pass it straight through.
        lspExtension={lspExtension}
        // A cold-parked hidden workspace releases its server-side file watcher.
        watchFileChanges={!coldParked}
        // Untitled buffers save through the OS "Save As" dialog; file-backed
        // tabs save in place (FileViewer handles that itself), so only wire
        // `onSaveAs` when this is an untitled buffer and the shell can save.
        onSaveAs={untitled && pickSaveFile ? handleSaveAs : undefined}
        // The tab content carries no toolbar: hide FileViewer's title bar and
        // lift its Save + markdown toggle into the group header via
        // `onActionsChange` (see `usePublishHeaderActions` above).
        hideTitleBar
        onActionsChange={setFileActions}
        // Self-heal: a persisted file leaf whose path no longer exists (ENOENT)
        // drops itself on mount, so a stale/relocated path doesn't stay pinned
        // behind an error banner (the #539 defensive guard, in the leaf model).
        onLoadError={(err) => {
          if (!/ENOENT|no such file|not found/i.test(err.message)) return;
          removeFileTabState(workspaceId, filePath);
          getWorkspaceLeafActions(workspaceId)?.onClose(`file:${filePath}`, "file");
        }}
        // Markdown files open in an editable rendered preview with a
        // preview/source toggle; tables, frontmatter and mermaid blocks render
        // through Streamdown.
        renderMarkdownBlock={renderMarkdownBlock}
        onEditorView={handleEditorView}
        overlay={searchBar}
        // Cursor selection + scroll restore: seeded from the per-tab store;
        // `CodeMirrorEditor` applies them on view creation, on top of the
        // document from disk. Captured back by `persistEditorState` on
        // unmount/reload. Read fresh each render, which is cheap now the blob
        // holds positions rather than documents; `CodeMirrorEditor` only
        // consumes it via a ref at view-creation time.
        savedSelection={persisted?.selection}
        savedScrollTop={persisted?.scrollTop}
        // Editor-state persistence (localStorage, `band-tab-state:<ws>`). Seed
        // from the fresh module-level store and write back on every change so a
        // reload restores unsaved edits, the markdown code/preview choice, and
        // the manual language override. FileViewer dispatches the
        // `band:dirty-change` event after every call, which lets the tab header
        // (a separate React tree) re-check its dirty dot; dispatching it here
        // too would double the per-keystroke re-checks.
        initialEditedContent={persisted?.editedContent ?? null}
        onEditedContentChange={(content) => {
          updateFileTabState(workspaceId, filePath, {
            editedContent: content ?? undefined,
          });
        }}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          updateFileTabState(workspaceId, filePath, { viewMode: mode });
        }}
        languageOverride={languageOverride}
        onLanguageOverrideChange={(languageId) => {
          setLanguageOverride(languageId ?? undefined);
          updateFileTabState(workspaceId, filePath, { language: languageId });
        }}
      />
    </div>
  );
}

// Full-file context: `getFileDiff`'s max contextLines renders the whole file
// with the changes in place (not just the changed hunks).
const FULL_FILE_CONTEXT = 99999;

// The diff's CodeMirror views, typed through the ruler's props so this file
// keeps no direct @codemirror/view dependency.
type DiffEditorViews = React.ComponentProps<typeof DiffOverviewRuler>["views"];

function DiffLeaf(props: IDockviewPanelProps<DiffLeafParams>) {
  // A panel's id never changes, so neither does which of the two it renders.
  return props.params.allOf ? (
    <SectionDiffsLeaf {...props} section={props.params.allOf} />
  ) : (
    <FileDiffLeaf {...props} />
  );
}

/** Sections whose changes live in the working tree or index, so the diff
 *  leaf's revert button can discard them. */
function discardableSection(
  section: ChangeSection | undefined,
): "unstaged" | "staged" | "untracked" | null {
  return section === "unstaged" || section === "staged" || section === "untracked" ? section : null;
}

function FileDiffLeaf({ params, api, containerApi }: IDockviewPanelProps<DiffLeafParams>) {
  // On desktop the diff selection tooltip offers only "Copy reference"; the
  // "Add to Chat" / "Add to Terminal" routing actions are reserved for the
  // mobile diff tooltip (#643). Mobile leaves are tagged in `mobileByApiId`.
  const isMobile = mobileByApiId.has(containerApi.id);
  const { visible } = usePanelVisibility();
  const { workspaceId, filePath, commit } = params;
  const queryClient = useQueryClient();
  const { containerRef, setViews, searchBar } = useLeafFind(workspaceId ?? "", visible);

  // A commit's diff doesn't compare against the working tree, so it never
  // reads the workspace's Changes sections.
  const changesQuery = useWorkspaceChanges(workspaceId ?? "", {
    enabled: !!filePath && !commit,
    // Keep an open diff reasonably fresh while it's the visible leaf, mirroring
    // the sidepanel's visibility-gated poll — a hidden/cached leaf never polls.
    // Same 15 s as the sidepanel so their shared-key ticks de-duplicate.
    refetchInterval: visible ? 15_000 : false,
  });
  // The section the tab was opened from, unless the file has since left it
  // (staged, committed, …) for another one.
  const found = findChange(changesQuery.data, filePath);
  const inParamSection =
    !!params.section && !!changesQuery.data?.[params.section].some((e) => e.path === filePath);
  const section = inParamSection || !found ? params.section : found.section;
  const oldPath =
    (section === params.section ? params.oldPath : undefined) ??
    (section ? changesQuery.data?.[section].find((e) => e.path === filePath)?.oldPath : undefined);
  // Only the `branch` section diffs against the merge base.
  const mergeBase = section === "branch" ? (changesQuery.data?.mergeBase ?? undefined) : undefined;
  // A commit's diff is history, not the worktree file: it doesn't mark a row
  // in the Explorer / Changes trees as the open file.
  useActiveFileTracking(api, workspaceId ?? "", commit ? "" : (filePath ?? ""), visible);
  // Go-to-definition on the working-tree side (see `createDiffLspNavigation`).
  // Off where the new side isn't the file on disk: a commit's diff, a staged
  // diff (the index) and a branch diff (HEAD).
  const lspNavigation = useLeafLsp(
    workspaceId ?? "",
    filePath ?? "",
    !!commit || section === "staged" || section === "branch",
    createDiffLspNavigation,
  );
  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredViewMode());
  const [revertOpen, setRevertOpen] = useState(false);
  // The diff's editors also feed the overview ruler, which measures where each
  // change sits inside `diffScrollerRef`.
  const diffScrollerRef = useRef<HTMLDivElement>(null);
  const [diffViews, setDiffViews] = useState<DiffEditorViews>([]);
  const handleEditorViews = useCallback(
    (views: DiffEditorViews) => {
      setViews(views);
      setDiffViews(views);
    },
    [setViews],
  );

  const setMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    storeViewMode(mode);
  }, []);

  const fileDiffQuery = useQuery({
    queryKey: ["diffLeafFile", workspaceId, filePath, section, mergeBase, oldPath],
    queryFn: () =>
      trpc.workspace.getFileDiff.query({
        workspaceId,
        filePath,
        section: section ?? "unstaged",
        mergeBase,
        oldPath,
        // Show the full file, with the diff in place — clicking a changed file
        // opens its whole contents, not just the changed hunks.
        contextLines: FULL_FILE_CONTEXT,
      }),
    enabled:
      !!workspaceId && !!filePath && !!section && (section !== "branch" || !!mergeBase) && !commit,
    refetchInterval: visible ? 10_000 : false,
  });

  // A commit's diff never changes, so it is fetched once and never polled.
  const commitDiffQuery = useQuery({
    queryKey: ["diffLeafCommitFile", workspaceId, commit, filePath],
    queryFn: () =>
      trpc.workspace.getCommitFileDiff.query({
        workspaceId,
        sha: commit ?? "",
        filePath,
        contextLines: FULL_FILE_CONTEXT,
      }),
    enabled: !!workspaceId && !!filePath && !!commit,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Publish this diff leaf's actions (view toggle, open-for-edit, revert) to the
  // group header — the tab content itself carries no toolbar (#643).
  // A commit's diff is history, and so is a branch diff: there is nothing to
  // revert in the worktree. A conflict is resolved, not reverted.
  const revertSection = commit ? null : discardableSection(section);
  const canRevert = revertSection !== null;
  usePublishHeaderActions(
    api.id,
    workspaceId && filePath
      ? () => (
          <div className="flex items-center gap-0.5">
            {/* Split view is desktop-only — mobile renders a single unified
                column (no side-by-side). */}
            {!isMobile && (
              <>
                <button
                  type="button"
                  onClick={() => setMode("unified")}
                  aria-pressed={viewMode === "unified"}
                  title="Unified view"
                  data-testid="center-diff-leaf__view--unified"
                  className={`inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-accent ${
                    viewMode === "unified" ? "bg-accent text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <AlignJustify className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setMode("split")}
                  aria-pressed={viewMode === "split"}
                  title="Side-by-side view"
                  data-testid="center-diff-leaf__view--split"
                  className={`inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-accent ${
                    viewMode === "split" ? "bg-accent text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <Columns2 className="size-3.5" />
                </button>
              </>
            )}
            {/* The file may no longer exist in the worktree for a commit's diff. */}
            {!commit && (
              <button
                type="button"
                onClick={() =>
                  getWorkspaceLeafActions(workspaceId)?.openFile(filePath, { preview: false })
                }
                title="Open file for editing"
                data-testid="center-diff-leaf__open-file"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SquarePen className="size-3.5" />
              </button>
            )}
            {canRevert && (
              <button
                type="button"
                onClick={() => setRevertOpen(true)}
                title="Revert file"
                data-testid="center-diff-leaf__revert"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <RotateCcw className="size-3.5" />
              </button>
            )}
          </div>
        )
      : null,
    [viewMode, workspaceId, filePath, canRevert, commit],
  );

  if (!workspaceId || !filePath) return null;

  const diff = commit ? commitDiffQuery.data?.diff : fileDiffQuery.data?.diff;
  const loading = commit
    ? commitDiffQuery.isLoading
    : changesQuery.isLoading || fileDiffQuery.isLoading;

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`center-diff-leaf__visible-${visible ? "true" : "false"}`}
    >
      <div className="relative min-h-0 flex-1">
        {searchBar}
        {/* The overview ruler stands in for this scroller's vertical scrollbar,
            so the native one is hidden and the content leaves room for it. */}
        <div
          ref={diffScrollerRef}
          data-testid="center-diff-leaf__scroller"
          className={`h-full overflow-auto ${diff ? "pr-3 [scrollbar-width:none]" : ""}`}
        >
          {diff ? (
            <DiffFileContent
              hunks={diff}
              filename={filePath}
              // Mobile is always unified — no room for a side-by-side split.
              viewMode={isMobile ? "unified" : viewMode}
              onEditorViews={handleEditorViews}
              copyReferenceOnly={!isMobile}
              lspNavigation={lspNavigation}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              {loading
                ? "Loading diff…"
                : commit && commitDiffQuery.isError
                  ? commitDiffQuery.error instanceof Error
                    ? commitDiffQuery.error.message
                    : "Failed to load the diff"
                  : "No changes"}
            </div>
          )}
        </div>
        {diff && <DiffOverviewRuler views={diffViews} scrollerRef={diffScrollerRef} />}
      </div>

      <Dialog open={revertOpen} onOpenChange={setRevertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revert file</DialogTitle>
            <DialogDescription>
              Discard the changes to <span className="font-mono">{basename(filePath)}</span>?{" "}
              {revertSection && discardWarning(revertSection)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevertOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="center-diff-leaf__revert-confirm"
              onClick={() => {
                if (!revertSection) return;
                trpc.workspace.discardChanges
                  .mutate({
                    workspaceId,
                    section: revertSection,
                    paths: revertSection === "staged" && oldPath ? [filePath, oldPath] : [filePath],
                  })
                  .then(() => {
                    setRevertOpen(false);
                    fileDiffQuery.refetch();
                    void invalidateWorkspaceChanges(queryClient, workspaceId);
                  })
                  .catch((err) => console.error("[DiffLeaf] revert failed:", err));
              }}
            >
              Revert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A Changes section's "View all" tab: every file of the section as a diff,
 * one under the other, like orca's combined diff. Each file fetches its diff
 * only once it scrolls near the viewport, so a section of hundreds of
 * untracked files doesn't start hundreds of requests at once.
 */
function SectionDiffsLeaf({
  params,
  section,
}: IDockviewPanelProps<DiffLeafParams> & { section: ChangeSection }) {
  const { workspaceId } = params;
  const { visible } = usePanelVisibility();
  const changesQuery = useWorkspaceChanges(workspaceId, {
    refetchInterval: visible ? 15_000 : false,
  });
  const entries = changesQuery.data?.[section] ?? [];
  const mergeBase = changesQuery.data?.mergeBase ?? undefined;

  return (
    <div className="h-full w-full overflow-auto" data-testid={`center-section-diffs--${section}`}>
      {entries.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
          {changesQuery.isLoading ? "Loading diff…" : "No changes"}
        </div>
      ) : (
        entries.map((entry) => (
          <SectionDiffFile
            key={entry.path}
            workspaceId={workspaceId}
            section={section}
            entry={entry}
            mergeBase={mergeBase}
          />
        ))
      )}
    </div>
  );
}

function SectionDiffFile({
  workspaceId,
  section,
  entry,
  mergeBase,
}: {
  workspaceId: string;
  section: ChangeSection;
  entry: ChangeEntry;
  mergeBase: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || nearViewport) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) setNearViewport(true);
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nearViewport]);

  const diffQuery = useQuery({
    // The line counts change whenever the file does, so they refresh the diff
    // on the section's poll without a poll of their own.
    queryKey: [
      "sectionDiffFile",
      workspaceId,
      section,
      entry.path,
      entry.oldPath,
      mergeBase,
      entry.additions,
      entry.deletions,
    ],
    queryFn: () =>
      trpc.workspace.getFileDiff.query({
        workspaceId,
        filePath: entry.path,
        section,
        mergeBase: section === "branch" ? mergeBase : undefined,
        oldPath: entry.oldPath,
      }),
    enabled: nearViewport && (section !== "branch" || !!mergeBase),
  });
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      ref={ref}
      className="border-b border-border"
      data-testid={`center-section-diffs__file--${entry.path}`}
    >
      <div className="sticky top-0 z-10 flex h-8 items-center gap-1.5 border-b border-border bg-background px-2 text-xs">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium" title={entry.path}>
            {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
          </span>
          {!!entry.additions && (
            <span className="shrink-0 text-green-600 dark:text-green-400">+{entry.additions}</span>
          )}
          {!!entry.deletions && (
            <span className="shrink-0 text-red-600 dark:text-red-400">-{entry.deletions}</span>
          )}
        </button>
        <button
          type="button"
          title="Open diff"
          data-testid="center-section-diffs__open"
          onClick={() =>
            getWorkspaceLeafActions(workspaceId)?.openDiff(entry.path, {
              preview: false,
              section,
              oldPath: entry.oldPath,
            })
          }
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <GitCompare className="size-3.5" />
        </button>
      </div>
      {!collapsed &&
        (diffQuery.data?.diff ? (
          <DiffFileContent
            hunks={diffQuery.data.diff}
            filename={entry.path}
            viewMode="unified"
            copyReferenceOnly
          />
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {diffQuery.data ? "No textual changes" : "Loading diff…"}
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-instance action registry (stable dockview header/tab components)
// ---------------------------------------------------------------------------
//
// dockview's header + tab components must be STABLE references, but the
// handlers they invoke are per-workspace (each mounted WorkspaceCenterDockview
// has its own api). MultiWorkspacePanelHost keeps several workspaces mounted
// at once, so a module-level singleton would suffer last-writer-wins. Key the
// handlers by the owning dockview's `api.id` (dockview passes `containerApi`
// into the props), reading the latest closures via the ref holder.
// ---------------------------------------------------------------------------

interface OpenDiffOptions {
  preview?: boolean;
  /** The Changes section the diff comes from; see `DiffLeafParams.section`. */
  section?: ChangeSection;
  oldPath?: string;
}

interface LeafActions {
  /** `kind: "chat"` starts a coding agent in this device's mode, a chat or a
   *  terminal (issue #682). `agentId` picks the agent; the default agent
   *  without it. */
  onAdd: (kind: LeafKind, groupId?: string, agentId?: string) => void;
  onSplit: (kind: LeafKind, groupId: string, direction: "right" | "below") => void;
  onClose: (id: string, kind: LeafKind) => void;
  openFile: (
    filePath: string,
    opts?: {
      line?: number;
      column?: number;
      external?: boolean;
      preview?: boolean;
      untitled?: boolean;
      fromHistory?: boolean;
    },
  ) => void;
  openDiff: (filePath: string, opts?: OpenDiffOptions) => void;
  /** Open every file of a Changes section in one tab ("View all"). */
  openSectionDiffs: (section: ChangeSection) => void;
  /** Open `filePath`'s change in commit `sha` (Commits panel). */
  openCommitDiff: (sha: string, filePath: string, opts?: { preview?: boolean }) => void;
  /** Retarget file / diff leaves at or under `oldPath` after the Explorer
   *  renamed or moved it (workspace-relative paths). */
  onPathMoved: (oldPath: string, newPath: string) => void;
  /** Close file / diff leaves at or under `path` after the Explorer deleted
   *  it. Dirty file leaves stay open so unsaved edits aren't lost. */
  onPathRemoved: (path: string) => void;
}

const leafActionsByApiId = new Map<string, { current: LeafActions }>();

// Mobile flag keyed by the owning dockview's `api.id`. Header action components
// must be STABLE references (dockview caches them), so they can't read a
// per-instance `mobile` prop directly — they look it up here by
// `containerApi.id`. Set on `onReady`, cleared on unmount. Desktop dockviews
// never add themselves, so `has(id)` is false → maximize toggle stays.
const mobileByApiId = new Set<string>();

// ---------------------------------------------------------------------------
// Tab headers
// ---------------------------------------------------------------------------

function IconTab(props: IDockviewPanelHeaderProps) {
  const component = props.api.component;
  const Icon = PANEL_ICONS[component];
  const shortcut = PANEL_SHORTCUTS[component];
  const [title, setTitle] = useState(props.api.title ?? "");
  const [badge, setBadge] = useState<number | undefined>(props.params?.badge as number | undefined);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  useEffect(() => {
    const d = props.api.onDidParametersChange(() => {
      setBadge(props.api.getParameters<{ badge?: number }>().badge);
    });
    return () => d.dispose();
  }, [props.api]);

  const hasBadge = badge != null && badge > 0;

  const tab = (
    <div className={TAB_ROOT_CLASS} data-testid={`center-tab--${component}`}>
      {Icon ? (
        <Icon className="size-4 shrink-0" />
      ) : (
        <span className="inline-block size-4 shrink-0" aria-hidden />
      )}
      <span className={TAB_TITLE_CLASS}>{title}</span>
      {hasBadge && (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 px-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          {badge}
        </span>
      )}
    </div>
  );

  if (!shortcut) return tab;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{tab}</TooltipTrigger>
      <TooltipContent>
        {title} ({shortcut})
      </TooltipContent>
    </Tooltip>
  );
}

/** Coding-agent types whose CLI can resume a session in a terminal. */
const RESUME_CAPABLE_AGENT_TYPES = new Set(["claude-code", "codex", "opencode"]);

function readCachedTabMeta(chatId: string): { title?: string; agentType?: string } {
  if (!chatId) return {};
  try {
    const raw = sessionStorage.getItem(`band:chat-tab-meta:${chatId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCachedTabMeta(chatId: string, patch: { title?: string; agentType?: string }) {
  if (!chatId) return;
  try {
    const prev = readCachedTabMeta(chatId);
    sessionStorage.setItem(`band:chat-tab-meta:${chatId}`, JSON.stringify({ ...prev, ...patch }));
  } catch {}
}

function ChatTab(props: IDockviewPanelHeaderProps<ChatLeafParams>) {
  const chatId = props.params.chatId;
  const workspaceId = props.params.workspaceId;
  const initialCache = readCachedTabMeta(chatId);
  const [title, setTitle] = useState(initialCache.title ?? props.api.title ?? "Chat");
  const [agentType, setAgentType] = useState<string | undefined>(initialCache.agentType);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const isActive = useTabActive(props.api);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => {
      const next = props.api.title ?? "Chat";
      setTitle(next);
      writeCachedTabMeta(chatId, { title: next });
    });
    return () => d.dispose();
  }, [props.api, chatId]);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const codingAgentsRef = useRef<CodingAgentDef[]>([]);
  const defaultAgentIdRef = useRef<string | undefined>(undefined);

  const applyChatMeta = useCallback(
    (chat: { agent?: string; activeSessionId?: string } | null | undefined) => {
      if (!mountedRef.current) return;
      setSessionId(chat?.activeSessionId ?? undefined);
      const agentId = chat?.agent ?? defaultAgentIdRef.current ?? "";
      const found = codingAgentsRef.current.find((a) => a.id === agentId);
      if (found) {
        setAgentType(found.type);
        writeCachedTabMeta(chatId, { agentType: found.type });
      }
    },
    [chatId],
  );

  const refreshTabMeta = useCallback(() => {
    if (!chatId || !workspaceId) return;
    Promise.all([
      getSharedSettings(),
      trpc.chats.get.query({ chatId }).catch(() => ({ chat: null })),
    ])
      .then(([settings, chatResult]) => {
        if (!mountedRef.current) return;
        const raw = (settings as Record<string, unknown> | null)?.codingAgents;
        codingAgentsRef.current = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
        defaultAgentIdRef.current = (settings as Record<string, unknown> | null)
          ?.defaultCodingAgent as string | undefined;
        applyChatMeta(chatResult.chat);
      })
      .catch(() => {});
  }, [chatId, workspaceId, applyChatMeta]);

  const refreshChatMeta = useCallback(() => {
    if (!chatId) return;
    trpc.chats.get
      .query({ chatId })
      .then((res) => applyChatMeta(res.chat))
      .catch(() => {});
  }, [chatId, applyChatMeta]);

  useEffect(() => {
    refreshTabMeta();
  }, [refreshTabMeta]);

  const canResume = !!sessionId && !!agentType && RESUME_CAPABLE_AGENT_TYPES.has(agentType);

  const handleContinueInTerminal = useCallback(() => {
    trpc.chats.continueInTerminal
      .mutate({ chatId })
      .then(() => crossPanelHandlers.onActivateTerminalPanel(workspaceId))
      .catch((err) => console.error("[ChatTab] continue in terminal failed:", err));
  }, [chatId, workspaceId]);

  const handleCopySessionId = useCallback(() => {
    if (!sessionId) return;
    void writeClipboardText(sessionId);
  }, [sessionId]);

  const containerApi = props.containerApi;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(chatId, "chat");
    },
    [containerApi, chatId],
  );

  return (
    <ContextMenu onOpenChange={(open) => open && refreshChatMeta()}>
      <ContextMenuTrigger asChild>
        <div className={TAB_ROOT_CLASS} data-testid={`center-chat-tab--${chatId}`}>
          <div className={TAB_CONTENT_WRAP}>
            <span
              className="inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150"
              style={{ opacity: agentType ? 1 : 0 }}
            >
              {agentType && <AgentIcon type={agentType} className="size-3.5" />}
            </span>
            <span className={TAB_TITLE_CLASS} title={title}>
              {title}
            </span>
          </div>
          <button
            type="button"
            className={closeButtonClass(isActive)}
            onClick={handleClose}
            title="Close tab"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="center-chat-tab__context-menu">
        <ContextMenuItem
          disabled={!canResume}
          onClick={handleContinueInTerminal}
          data-testid="center-chat-tab__context-menu-item--continue-in-terminal"
        >
          <TerminalSquare className="size-4" />
          Continue in terminal
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!sessionId}
          onClick={handleCopySessionId}
          data-testid="center-chat-tab__context-menu-item--copy-session-id"
        >
          <ClipboardCopy className="size-4" />
          Copy session ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TerminalTab(props: IDockviewPanelHeaderProps<TermLeafParams>) {
  const [title, setTitle] = useState(props.api.title ?? "Terminal");
  const terminalId = props.params.terminalId;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "Terminal"));
    return () => d.dispose();
  }, [props.api]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(terminalId, "term");
    },
    [containerApi, terminalId],
  );

  const handleCopyTerminalId = useCallback(() => {
    void writeClipboardText(terminalId);
  }, [terminalId]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={TAB_ROOT_CLASS} data-testid={`center-term-tab--${terminalId}`}>
          <div className={TAB_CONTENT_WRAP}>
            <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={TAB_TITLE_CLASS} title={title}>
              {title}
            </span>
          </div>
          <button
            type="button"
            className={closeButtonClass(isActive)}
            onClick={handleClose}
            title="Close terminal"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="center-term-tab__context-menu">
        <ContextMenuItem
          onClick={handleCopyTerminalId}
          data-testid="center-term-tab__context-menu-item--copy-terminal-id"
        >
          <ClipboardCopy className="size-4" />
          Copy terminal ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function BrowserTab(props: IDockviewPanelHeaderProps<BrowserLeafParams>) {
  const [title, setTitle] = useState(props.api.title ?? "New Tab");
  const [faviconError, setFaviconError] = useState(false);
  const browserId = props.params.browserId;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);
  const faviconUrl = useFavicon(browserId);
  const prevFaviconRef = useRef(faviconUrl);

  if (faviconUrl !== prevFaviconRef.current) {
    prevFaviconRef.current = faviconUrl;
    if (faviconError) setFaviconError(false);
  }

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "New Tab"));
    return () => d.dispose();
  }, [props.api]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(browserId, "browser");
    },
    [containerApi, browserId],
  );

  const showFavicon = faviconUrl && !faviconError;

  return (
    <div className={TAB_ROOT_CLASS} data-testid={`center-browser-tab--${browserId}`}>
      <div className={TAB_CONTENT_WRAP}>
        {showFavicon ? (
          <img
            src={faviconUrl}
            alt=""
            className="size-3.5 shrink-0"
            onError={() => setFaviconError(true)}
          />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={TAB_TITLE_CLASS} title={title}>
          {title}
        </span>
      </div>
      <button
        type="button"
        className={closeButtonClass(isActive)}
        onClick={handleClose}
        title="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** Right-click menu on a file/diff tab: copy the workspace-relative or absolute
 *  path. `absolute` needs the workspace root (from `useWorkspacePath`); it's
 *  disabled until that resolves, or when the path is already absolute (external
 *  file), in which case relative == absolute == the path itself. */
function TabPathContextMenu({
  workspaceId,
  filePath,
  testidPrefix,
  children,
}: {
  workspaceId: string;
  filePath: string;
  testidPrefix: string;
  children: React.ReactNode;
}) {
  const workspacePath = useWorkspacePath(workspaceId);
  const isAbsolute = filePath.startsWith("/");
  const absolute = isAbsolute
    ? filePath
    : workspacePath
      ? `${workspacePath.replace(/\/+$/, "")}/${filePath}`
      : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid={`${testidPrefix}__context-menu`}>
        <ContextMenuItem
          onClick={() => void writeClipboardText(filePath)}
          data-testid={`${testidPrefix}__context-menu-item--copy-relative-path`}
        >
          <ClipboardCopy className="size-4" />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!absolute}
          onClick={() => absolute && void writeClipboardText(absolute)}
          data-testid={`${testidPrefix}__context-menu-item--copy-absolute-path`}
        >
          <ClipboardCopy className="size-4" />
          Copy absolute path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileTab(props: IDockviewPanelHeaderProps<FileLeafParams>) {
  const { workspaceId, filePath } = props.params;
  const containerApi = props.containerApi;
  const isActive = useTabActive(props.api);
  const isPreview = useTabPreview(props.api, props.params.preview);
  const title = basename(filePath);
  // Same file-type icon the Explorer/Changes trees use, so a file reads
  // identically in the tree and its tab (#643).
  const FileTypeIcon = getFileIcon(title);

  // Dirty indicator. `FileLeaf` (a separate dockview React tree) dispatches
  // `band:dirty-change` on every edited-content change; re-read the fresh
  // per-file store when that fires. Seeded synchronously so a restored dirty
  // file shows the dot immediately on mount.
  const [dirty, setDirty] = useState(() => isFileDirty(workspaceId, filePath));
  useEffect(() => {
    const recheck = () => setDirty(isFileDirty(workspaceId, filePath));
    window.addEventListener("band:dirty-change", recheck);
    return () => window.removeEventListener("band:dirty-change", recheck);
  }, [workspaceId, filePath]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(`file:${filePath}`, "file");
    },
    [containerApi, filePath],
  );

  return (
    <TabPathContextMenu
      workspaceId={workspaceId}
      filePath={filePath}
      testidPrefix={`center-file-tab--${filePath}`}
    >
      <div className={TAB_ROOT_CLASS} data-testid={`center-file-tab--${filePath}`}>
        <div className={TAB_CONTENT_WRAP}>
          <FileTypeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`${TAB_TITLE_CLASS}${isPreview ? " italic" : ""}`} title={filePath}>
            {title}
          </span>
        </div>
        {/* VS Code-style close slot. When the file is dirty and the tab is NOT
            active, render a filled dot in the same slot as the close X: the dot
            is visible at rest and fades out on hover (`group-hover:opacity-0`),
            while the X (via `closeButtonClass` on an inactive tab:
            `opacity-0 group-hover:opacity-100`) fades in on hover — so they
            swap cleanly. On the active tab the X is always shown (opacity-70),
            so the dot is suppressed entirely to avoid overlapping the X. */}
        {dirty && !isActive ? (
          <span
            aria-hidden
            data-testid={`center-file-tab__dirty--${filePath}`}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center opacity-100 transition-opacity group-hover:opacity-0"
          >
            <span className="size-2 rounded-full bg-foreground/70" />
          </span>
        ) : null}
        <button
          type="button"
          className={closeButtonClass(isActive)}
          onClick={handleClose}
          title="Close file"
          data-testid={`center-file-tab__close--${filePath}`}
        >
          <X className="size-3" />
        </button>
      </div>
    </TabPathContextMenu>
  );
}

function DiffTab(props: IDockviewPanelHeaderProps<DiffLeafParams>) {
  const { workspaceId, filePath, commit, section, allOf } = props.params;
  const containerApi = props.containerApi;
  const panelId = props.api.id;
  const isActive = useTabActive(props.api);
  const isPreview = useTabPreview(props.api, props.params.preview);
  const title = commit
    ? `${basename(filePath)} @ ${commit.slice(0, 7)}`
    : section === "staged"
      ? `${basename(filePath)} (Staged)`
      : section === "branch"
        ? `${basename(filePath)} (Committed)`
        : basename(filePath);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      leafActionsByApiId.get(containerApi.id)?.current?.onClose(panelId, "diff");
    },
    [containerApi, panelId],
  );

  if (allOf) {
    return (
      <div className={TAB_ROOT_CLASS} data-testid={`center-section-diffs-tab--${allOf}`}>
        <div className={TAB_CONTENT_WRAP}>
          <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={TAB_TITLE_CLASS}>{SECTION_LABELS[allOf]}</span>
        </div>
        <button
          type="button"
          className={closeButtonClass(isActive)}
          onClick={handleClose}
          title="Close diff"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <TabPathContextMenu
      workspaceId={workspaceId}
      filePath={filePath}
      testidPrefix={`center-diff-tab--${filePath}`}
    >
      <div
        className={TAB_ROOT_CLASS}
        data-testid={`center-diff-tab--${filePath}`}
        data-commit={commit}
      >
        <div className={TAB_CONTENT_WRAP}>
          <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`${TAB_TITLE_CLASS}${isPreview ? " italic" : ""}`} title={filePath}>
            {title}
          </span>
        </div>
        <button
          type="button"
          className={closeButtonClass(isActive)}
          onClick={handleClose}
          title="Close diff"
        >
          <X className="size-3" />
        </button>
      </div>
    </TabPathContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Header actions: the "+" new-tab menu renders in the LEFT slot (right after
// the last tab, browser-style); the maximize toggle stays in the RIGHT slot.
// In the desktop layout the tab strip is also the window's top row (there is
// no title bar over it), so the groups along the top edge carry window chrome:
// the top-left group's PREFIX slot reserves space under `AppShell`'s nav
// cluster while the sidebar is collapsed, and the top-right group's RIGHT slot
// holds the right sidepanel's expand button while that panel is collapsed.
// ---------------------------------------------------------------------------

interface GroupEdges {
  top: boolean;
  left: boolean;
  right: boolean;
}

const NO_EDGES: GroupEdges = { top: false, left: false, right: false };

interface GroupEdgesStore {
  edges: GroupEdges;
  subscribe: (onChange: () => void) => () => void;
}

// One store per group, shared by the group's prefix and right header-action
// slots so each group is measured once.
const groupEdgesStores = new WeakMap<IDockviewHeaderActionsProps["group"], GroupEdgesStore>();

function getGroupEdgesStore(props: IDockviewHeaderActionsProps): GroupEdgesStore {
  const existing = groupEdgesStores.get(props.group);
  if (existing) return existing;
  const el = props.group.element;
  const containerApi = props.containerApi;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const measure = () => {
    const root = el.closest(".dv-dockview");
    if (!root) return;
    const g = el.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const next = {
      top: g.top - r.top < 2,
      left: g.left - r.left < 2,
      right: r.right - g.right < 2,
    };
    el.toggleAttribute("data-band-top-row", next.top);
    const prev = store.edges;
    if (prev.top === next.top && prev.left === next.left && prev.right === next.right) return;
    store.edges = next;
    for (const l of listeners) l();
  };
  const store: GroupEdgesStore = {
    edges: NO_EDGES,
    subscribe(onChange) {
      listeners.add(onChange);
      if (!stop) {
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        const d = containerApi.onDidLayoutChange(measure);
        stop = () => {
          ro.disconnect();
          d.dispose();
          el.removeAttribute("data-band-top-row");
          store.edges = NO_EDGES;
        };
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
  groupEdgesStores.set(props.group, store);
  return store;
}

const noopSubscribe = () => () => {};

/** Which edges of the dockview this group's rect touches. Re-measured when the
 *  group resizes (which covers a hidden workspace being shown again) and on
 *  every dockview layout change (a split, move, close or maximize). Also marks
 *  top-row groups with `data-band-top-row`, which makes their empty tab-strip
 *  space a window drag region (see `.dockview-center-desktop` in
 *  dockview-theme.css). Measures nothing when `enabled` is false. */
function useGroupEdges(props: IDockviewHeaderActionsProps, enabled: boolean): GroupEdges {
  const store = enabled ? getGroupEdgesStore(props) : null;
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.edges ?? NO_EDGES,
  );
}

const PrefixHeaderActions = memo(function PrefixHeaderActions(props: IDockviewHeaderActionsProps) {
  const chrome = useWorkspaceChrome();
  const isGridGroup = (props.location?.type ?? "grid") === "grid";
  const edges = useGroupEdges(props, !!chrome && isGridGroup);
  if (!edges.top || !edges.left) return null;
  return <SidebarGutter />;
});

const LeftHeaderActions = memo(function LeftHeaderActions(props: IDockviewHeaderActionsProps) {
  // Only grid groups get the "+" new-tab menu, not floating groups — mirror
  // RightHeaderActions' guard.
  if ((props.location?.type ?? "grid") !== "grid") return null;
  return (
    <div className="flex h-full items-center px-0.5">
      <NewTabMenu apiId={props.containerApi.id} groupId={props.group.id} />
    </div>
  );
});

const RightHeaderActions = memo(function RightHeaderActions(props: IDockviewHeaderActionsProps) {
  const isGridGroup = (props.location?.type ?? "grid") === "grid";
  const chrome = useWorkspaceChrome();
  const edges = useGroupEdges(props, !!chrome && isGridGroup);

  const [isMaximized, setIsMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const refresh = () => setIsMaximized(props.api.isMaximized());
    refresh();
    const d = props.containerApi.onDidMaximizedGroupChange(refresh);
    return () => d.dispose();
  }, [props.api, props.containerApi]);

  // Re-render when the active tab changes (in any group) or a leaf republishes
  // its header actions, so this group's active-tab actions stay current.
  const [, bumpActions] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const d = props.containerApi.onDidActivePanelChange(() => bumpActions());
    const onActionsChanged = (e: Event) => {
      const panelId = (e as CustomEvent<string>).detail;
      if (props.group.panels.some((p) => p.id === panelId)) bumpActions();
    };
    window.addEventListener(HEADER_ACTIONS_EVENT, onActionsChanged);
    return () => {
      d.dispose();
      window.removeEventListener(HEADER_ACTIONS_EVENT, onActionsChanged);
    };
  }, [props.containerApi, props.group]);

  // Floating groups don't maximize.
  if (!isGridGroup) return null;

  // The active tab's own action buttons (view toggle, save, revert…).
  const activeId = props.group.activePanel?.id;
  const renderLeafActions = activeId ? leafHeaderActionsByPanelId.get(activeId) : undefined;

  // Mobile / tabs-only: no Maximize (single full-screen group). The active
  // tab's actions fold behind a ⋮ menu so the narrow tab strip stays uncluttered.
  if (mobileByApiId.has(props.containerApi.id)) {
    if (!renderLeafActions) return null;
    return (
      <div className="flex h-full items-center px-1" data-testid="workspace-center__toolbar">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Tab actions"
              data-testid="workspace-center__tab-actions-button"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-0 p-1">
            <div className="flex items-center gap-0.5">{renderLeafActions()}</div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const MaxIcon = isMaximized ? Minimize2 : Maximize2;
  const maxLabel = isMaximized ? "Restore" : "Maximize";

  return (
    <div className="flex h-full items-center gap-0.5 px-1" data-testid="workspace-center__toolbar">
      {renderLeafActions?.()}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={maxLabel}
            onClick={() => {
              if (props.api.isMaximized()) {
                props.api.exitMaximized();
              } else {
                props.api.maximize();
              }
            }}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MaxIcon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {maxLabel}
          <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
            ⇧⌘M
          </kbd>
        </TooltipContent>
      </Tooltip>
      {edges.top && edges.right && chrome?.onToggleRightPanel && !chrome.rightPanelVisible && (
        <RightPanelToggle onToggle={chrome.onToggleRightPanel} visible={false} />
      )}
    </div>
  );
});

function NewTabMenu({ apiId, groupId }: { apiId: string; groupId: string }) {
  const add = (kind: LeafKind, agentId?: string) =>
    leafActionsByApiId.get(apiId)?.current?.onAdd(kind, groupId, agentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="New tab"
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          data-testid="workspace-center__new-tab-button"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" data-testid="workspace-center__new-tab-menu">
        <NewAgentSubmenu onPick={(agentId) => add("chat", agentId)} />
        <DropdownMenuItem onClick={() => add("term")} data-testid="workspace-center__new-tab--term">
          <TerminalIcon className="size-4" />
          New terminal
          <DropdownMenuShortcut>{formatShortcut("Cmd+T")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {isDesktop && (
          <DropdownMenuItem
            onClick={() => add("browser")}
            data-testid="workspace-center__new-tab--browser"
          >
            <Globe className="size-4" />
            New browser
            <DropdownMenuShortcut>{formatShortcut("Cmd+Shift+B")}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Component registries
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  chat: ChatLeaf,
  term: TerminalLeaf,
  browser: BrowserLeaf,
  file: FileLeaf,
  diff: DiffLeaf,
};

const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  chat: ChatTab,
  term: TerminalTab,
  browser: BrowserTab,
  file: FileTab,
  diff: DiffTab,
  icon: IconTab,
};

const EMPTY_STATE_BUTTON_CLASS =
  "flex w-56 items-center gap-3 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

// ---------------------------------------------------------------------------
// addPanel helpers
// ---------------------------------------------------------------------------

type AddPanelOptions = Parameters<DockviewApi["addPanel"]>[0];

function addChatLeaf(
  api: DockviewApi,
  workspaceId: string,
  chatId: string,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: chatId,
    component: "chat",
    tabComponent: "chat",
    title: "Chat",
    params: { workspaceId, chatId },
    position: position ?? centralPanelPosition(api),
  } as AddPanelOptions);
}

function addTermLeaf(
  api: DockviewApi,
  workspaceId: string,
  terminalId: string,
  extra?: Partial<TermLeafParams>,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: terminalId,
    component: "term",
    tabComponent: "term",
    title: "Terminal",
    params: { workspaceId, terminalId, ...extra },
    position: position ?? centralPanelPosition(api),
    // Keep the leaf MOUNTED when its tab is inactive (dockview hides it via CSS)
    // instead of the default `onlyWhenVisible` detach, so switching center tabs
    // never unmounts and rebuilds the nested split dockview. The xterm itself is
    // still parked and re-attached through the terminal cache, driven by
    // `TerminalLeaf`'s folded `visible` (selected tab AND visible workspace).
    renderer: "always",
  } as AddPanelOptions);
}

function addBrowserLeaf(
  api: DockviewApi,
  workspaceId: string,
  browserId: string,
  initialUrl?: string,
  position?: AddPanelOptions["position"],
): void {
  api.addPanel({
    id: browserId,
    component: "browser",
    tabComponent: "browser",
    title: "New Tab",
    params: { workspaceId, browserId, ...(initialUrl ? { initialUrl } : {}) },
    position: position ?? centralPanelPosition(api),
    // The page is a `<webview>`, and detaching it from the DOM (dockview's
    // default `onlyWhenVisible` renderer does that for an unselected tab)
    // destroys its guest and reloads the page. Keep the leaf mounted and let
    // dockview hide it with `display: none` instead.
    renderer: "always",
  } as AddPanelOptions);
}

// ---------------------------------------------------------------------------
// Shared tab list (`band:center-tabs:<ws>`, see lib/center-tabs.ts)
// ---------------------------------------------------------------------------

/** Browser tabs exist only in the desktop app. */
function isShownHere(tab: CenterTab): boolean {
  return tab.kind !== "browser" || isDesktop;
}

/**
 * Write the dockview's tabs to the shared list. With `keepOrder` (another
 * device's order or active tab is waiting to be applied) only this device's
 * opened and closed tabs are written, on top of the shared order.
 */
function persistCenterTabs(api: DockviewApi, workspaceId: string, keepOrder: boolean): void {
  const shared = readCenterTabs(workspaceId);
  const local = centerTabsFromApi(api);
  writeCenterTabs(
    workspaceId,
    keepOrder && shared
      ? withLocalMembership(shared, local, isShownHere)
      : keepHiddenTabs(local, shared, isShownHere),
  );
}

/** Open a file or diff tab another device opened, next to the tab it follows. */
function addSharedViewLeaf(
  api: DockviewApi,
  workspaceId: string,
  tab: CenterTab & { kind: "file" | "diff" },
  afterId: string | null,
): void {
  const params = viewLeafParams(tab.kind, tab.id, workspaceId);
  const allOf = (params as DiffLeafParams).allOf;
  api.addPanel({
    id: tab.id,
    component: tab.kind,
    tabComponent: tab.kind,
    title: allOf ? SECTION_LABELS[allOf] : basename(params.filePath),
    params,
    position:
      afterId && api.getPanel(afterId)
        ? { referencePanel: afterId, direction: "within" }
        : centralPanelPosition(api),
    inactive: true,
  } as AddPanelOptions);
}

function isViewTab(tab: CenterTab): tab is CenterTab & { kind: "file" | "diff" } {
  return tab.kind === "file" || tab.kind === "diff";
}

/**
 * Open and close file and diff tabs to match another device's changes.
 * Chats, terminals and browser tabs aren't touched: they open and close with
 * their server records (`chat-created`, `terminal-killed`, …). A file with
 * unsaved edits on this device stays open. Returns whether anything changed.
 */
function applyCenterTabMembership(
  api: DockviewApi,
  workspaceId: string,
  target: CenterTabs,
  added: CenterTab[],
  removed: CenterTab[],
): boolean {
  let changed = false;
  for (const tab of removed) {
    if (!isViewTab(tab)) continue;
    const panel = api.getPanel(tab.id);
    if (!panel || (tab.kind === "file" && isFileDirty(workspaceId, tab.id.slice(5)))) continue;
    api.removePanel(panel);
    changed = true;
  }
  for (const tab of added) {
    if (!isViewTab(tab) || !isSharedTab(tab) || api.getPanel(tab.id)) continue;
    const i = target.tabs.findIndex((t) => t.id === tab.id);
    let afterId: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (api.getPanel(target.tabs[j].id)) {
        afterId = target.tabs[j].id;
        break;
      }
    }
    addSharedViewLeaf(api, workspaceId, tab, afterId);
    changed = true;
  }
  return changed;
}

/**
 * Make the dockview show the shared tab list: its file and diff tabs, in its
 * order, with its active tab. Tabs this device has and the list doesn't
 * (untitled buffers, a terminal whose record the list hasn't caught up with)
 * keep their place after the listed ones. Returns whether anything changed.
 */
function applyCenterTabsFull(api: DockviewApi, workspaceId: string, target: CenterTabs): boolean {
  const listed = new Set(target.tabs.map((t) => t.id));
  const extra = api.panels
    .map((p) => ({ id: p.id, kind: p.api.component as CenterTab["kind"] }))
    .filter((t) => isViewTab(t) && isSharedTab(t) && !listed.has(t.id));
  const onPanel = new Set(api.panels.map((p) => p.id));
  let changed = applyCenterTabMembership(
    api,
    workspaceId,
    target,
    target.tabs.filter((t) => !onPanel.has(t.id)),
    extra,
  );

  const rank = new Map(target.tabs.map((t, i) => [t.id, i]));
  for (const group of api.groups) {
    if (group.api.location.type !== "grid") continue;
    const desired = [...group.panels].sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const shown = group.activePanel;
    let moved = false;
    desired.forEach((panel, index) => {
      if (group.panels.indexOf(panel) === index) return;
      try {
        panel.api.moveTo({ group, index, skipSetActive: true });
        moved = true;
      } catch {}
    });
    // dockview moves a panel within its group by removing and re-adding it
    // without activating it, which leaves the group showing no content.
    if (moved) {
      changed = true;
      shown?.api.setActive();
    }
  }

  const active = target.active ? api.getPanel(target.active) : undefined;
  if (active) {
    if (api.activePanel?.id !== active.id) changed = true;
    active.api.setActive();
  }
  return changed;
}

/** Whether two tab lists differ in the order of shared tabs or the active tab. */
function orderOrActiveDiffers(a: CenterTabs, b: CenterTabs): boolean {
  if (a.active !== b.active) return true;
  const inB = new Set(b.tabs.map((t) => t.id));
  const inA = new Set(a.tabs.map((t) => t.id));
  const orderA = a.tabs.filter((t) => inB.has(t.id)).map((t) => t.id);
  const orderB = b.tabs.filter((t) => inA.has(t.id)).map((t) => t.id);
  return orderA.join("\n") !== orderB.join("\n");
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface WorkspaceCenterDockviewProps {
  workspaceId: string;
  visible: boolean;
  wsActive: boolean;
  /** Mobile / tabs-only mode: disables drag→split (`disableDnd`) and hides the
   *  maximize toggle in the right header actions. Everything else (leaves,
   *  tabs, close, dirty dot, find, preview, `+` New-tab menu) is unchanged.
   *  Defaults to false (desktop behaviour). */
  mobile?: boolean;
}

// Memoized: every visited workspace stays mounted, so without it each render of
// `SharedDockviewLayout` (route changes, dialog toggles, current-file changes)
// would re-render every hidden workspace's dockview. The props are primitives.
export const WorkspaceCenterDockview = memo(function WorkspaceCenterDockview({
  workspaceId,
  visible,
  wsActive,
  mobile = false,
}: WorkspaceCenterDockviewProps) {
  const adapter = useAdapter();
  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isRestoringRef = useRef(false);
  // True while writeLayout runs. dockview's serialize() exits + re-adds the
  // maximized view, firing onDidMaximizedGroupChange mid-write — this flag stops
  // that from re-triggering a persist (which would loop forever).
  const isPersistingRef = useRef(false);
  // True while another device's tab changes are being applied, so the
  // dockview events they fire don't write the half-applied tabs back.
  const applyingSharedRef = useRef(false);
  // Another device changed the tab order or active tab while this workspace
  // was on screen. Applied the next time the workspace is shown, unless the
  // user rearranges tabs here first (their arrangement then wins).
  const pendingSharedOrderRef = useRef(false);
  const wsActiveRef = useRef(wsActive);
  wsActiveRef.current = wsActive;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const touchTabsDisposerRef = useRef<(() => void) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VS Code-style preview tabs: at most one previewing file leaf and one
  // previewing diff leaf per dockview. A single-click in the sidepanel opens
  // a leaf in "preview" mode (italic tab) that the NEXT single-click reuses
  // (closes + replaces); a double-click — or editing — pins it. These refs
  // hold the id of the current preview leaf of each kind, or null.
  const previewFileIdRef = useRef<string | null>(null);
  const previewDiffIdRef = useRef<string | null>(null);
  // Per-workspace editor navigation history (file paths). `index` points at the
  // current entry; Go Back/Forward step it. Driven by openFile (incl. LSP
  // go-to-definition) and consumed by the band:editor-go-back/forward listeners.
  const editorHistoryRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });

  // Close-confirm for a dirty file leaf: holds the pending {id, path} while the
  // "Unsaved changes" dialog is open, or null when no confirm is in flight.
  const [pendingClose, setPendingClose] = useState<{ id: string; path: string } | null>(null);

  // True when the dockview has zero leaves (the user closed everything). Drives
  // the centered "New Terminal / Chat / Browser" empty state instead of forcing
  // a leaf back — a closed-out workspace should stay closed until the user picks
  // what to open next.
  const [isEmpty, setIsEmpty] = useState(false);

  const { data: initialData } = useQuery<CenterLayoutData>({
    queryKey: centerLayoutKey(workspaceId),
    queryFn: async () => {
      // The saved layout, shared tab list and split blobs are read from
      // localStorage in onReady: bring them up to date from the server first.
      const [chatsRes, terminalsRes, browsersRes] = await Promise.all([
        trpc.chats.list.query({ workspaceId }).catch(() => ({ chats: [] as { id: string }[] })),
        trpc.terminal.list
          .query({ workspaceId })
          .catch(() => ({ terminals: [] as { terminalId: string }[] })),
        isDesktop
          ? trpc.browsers.list
              .query({ workspaceId })
              .catch(() => ({ browsers: [] as { id: string; url?: string }[] }))
          : Promise.resolve({ browsers: [] as { id: string; url?: string }[] }),
        hydrateWorkspace(workspaceId),
      ]);
      const urls = new Map<string, string>();
      for (const b of browsersRes.browsers) {
        if (b.url && b.url !== "about:blank") urls.set(b.id, b.url);
      }
      return {
        chatIds: new Set(chatsRes.chats.map((c) => c.id)),
        terminalIds: new Set(terminalsRes.terminals.map((t) => t.terminalId)),
        browserIds: new Set(browsersRes.browsers.map((b) => b.id)),
        urls,
      };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const initialDataRef = useRef<CenterLayoutData | null>(null);
  initialDataRef.current = initialData ?? null;

  // ---- persistence ----
  // Write the current layout to localStorage now.
  const writeLayout = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      // Capture the maximized group BEFORE toJSON: dockview's serialize()
      // temporarily exits the maximized view (to record un-maximized grid
      // dimensions) and re-adds it, so reading isMaximized after toJSON misses
      // it. dockview's toJSON also doesn't persist maximize, so we stamp it on
      // the blob ourselves — a maximized editor should survive a reload (#490).
      const maximizedId = api.groups.find((g) => g.api.isMaximized())?.id;
      // Guard so the exit/re-enter serialize() fires (onDidMaximizedGroupChange)
      // during toJSON don't re-enter writeLayout → infinite loop.
      isPersistingRef.current = true;
      const json = stripParams(api.toJSON() as unknown as Record<string, unknown>);
      if (maximizedId) json.maximizedGroup = maximizedId;
      clientStorage.setItem(layoutKey(workspaceId), JSON.stringify(json));
      persistCenterTabs(api, workspaceId, pendingSharedOrderRef.current);
    } catch {
      // best-effort
    } finally {
      isPersistingRef.current = false;
    }
  }, [workspaceId]);

  // Debounced save — used for the high-frequency `onDidLayoutChange` (drag /
  // resize / move) so we don't write on every pixel.
  const schedulePersist = useCallback(() => {
    if (isRestoringRef.current || applyingSharedRef.current || !apiRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      writeLayout();
    }, 400);
  }, [writeLayout]);

  // Immediate save — used for discrete STRUCTURAL changes (add / close a leaf,
  // add / remove a group). Closing a tab must persist right away: a debounced
  // write can be lost to a fast reload, an unmount, or a continuous stream of
  // layout events resetting the timer. Cancels any pending debounce first.
  const flushPersist = useCallback(() => {
    if (isRestoringRef.current || applyingSharedRef.current || !apiRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    writeLayout();
  }, [writeLayout]);

  // Strip legacy full-document editor state from every workspace's tab-state
  // blob, once per page load (see `migrateLegacyTabStates`).
  useEffect(() => {
    migrateLegacyTabStates();
  }, []);

  // A reload doesn't unmount React, so the unmount flush below never runs for
  // it. Without this, a debounced save still pending at reload time (tab
  // switches and resizes are debounced, and terminal title updates keep
  // resetting the timer) is dropped, and the page restores a stale layout,
  // e.g. with the wrong tab active.
  const flushPersistRef = useRef(flushPersist);
  flushPersistRef.current = flushPersist;
  useEffect(() => {
    const onPageHide = () => {
      if (saveTimerRef.current) flushPersistRef.current();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const reportFocus = useCallback(() => {
    if (isRestoringRef.current || wsActiveRef.current === false) return;
    const panel = apiRef.current?.activePanel;
    if (!panel) return;
    const kind = panel.api.component as LeafKind;
    const panelType =
      kind === "chat"
        ? "chat"
        : kind === "term"
          ? "terminal"
          : kind === "browser"
            ? "browser"
            : null;
    if (!panelType) return;
    trpc.panelFocus.set.mutate({ workspaceId, panelType, panelId: panel.id }).catch(() => {});
  }, [workspaceId]);

  // ---- add / split / close ----

  // Where a leaf the server is still creating should go. The server's
  // `chat-created` / `terminal-created` echo can arrive before the launch
  // mutation returns, and the live-sync handler reads this so the tab still
  // lands in the group the user picked.
  const pendingLeafPositionsRef = useRef(new Map<string, AddPanelOptions["position"]>());

  // Start a coding agent in this device's mode (issue #682). The server
  // creates the chat or spawns the agent's CLI first, so the pane never
  // mounts before its chat row (with the picked agent) or its PTY exists.
  const launchAgent = useCallback(
    (position: AddPanelOptions["position"], agentId?: string) => {
      const mode = readAgentMode();
      const pending = pendingLeafPositionsRef.current;
      const chatId = newChatId();
      const terminalId = newTerminalId();
      if (mode !== "tui") markChatFresh(chatId);
      pending.set(chatId, position);
      pending.set(terminalId, position);
      trpc.agentSessions.launch
        .mutate({ workspaceId, agentId, mode, chatId, terminalId })
        .then((result) => {
          const api = apiRef.current;
          if (!api) return;
          if (result.mode === "tui" && result.terminalId) {
            if (!api.getPanel(result.terminalId)) {
              addTermLeaf(api, workspaceId, result.terminalId, { autoFocus: true }, position);
            }
          } else if (result.chatId && !api.getPanel(result.chatId)) {
            addChatLeaf(api, workspaceId, result.chatId, position);
          }
          if (result.notice) console.warn("[WorkspaceCenterDockview]", result.notice);
        })
        .catch((err) => {
          console.error("[WorkspaceCenterDockview] agent launch failed:", err);
          // A default-agent chat pane still works without its launch: it
          // creates its chat row on the first message, the way panes did
          // before #682. With a picked agent no pane opens, since it would
          // fall back to the default agent.
          const api = apiRef.current;
          if (mode !== "tui" && !agentId && api && !api.getPanel(chatId)) {
            addChatLeaf(api, workspaceId, chatId, position);
          }
        })
        .finally(() => {
          pending.delete(chatId);
          pending.delete(terminalId);
        });
    },
    [workspaceId],
  );

  const handleAdd = useCallback(
    (kind: LeafKind, groupId?: string, agentId?: string) => {
      const api = apiRef.current;
      if (!api) return;
      const position = groupId ? { referenceGroup: groupId } : undefined;
      if (kind === "term") {
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, { autoFocus: true }, position);
        trpc.terminal.create.mutate({ workspaceId, id }).catch((err) => {
          console.error("[WorkspaceCenterDockview] terminal create failed:", err);
        });
      } else if (kind === "chat") {
        launchAgent(position, agentId);
      } else if (kind === "browser") {
        if (!isDesktop) return;
        const id = newBrowserId();
        markBrowserFresh(id);
        addBrowserLeaf(api, workspaceId, id, undefined, position);
        trpc.browsers.create.mutate({ workspaceId, id }).catch((err) => {
          console.error("[WorkspaceCenterDockview] browser create failed:", err);
        });
      }
    },
    [workspaceId, launchAgent],
  );

  const handleSplit = useCallback(
    (kind: LeafKind, groupId: string, direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api) return;
      const position = { referenceGroup: groupId, direction };
      if (kind === "term") {
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, { autoFocus: true }, position);
        trpc.terminal.create.mutate({ workspaceId, id }).catch(() => {});
      } else if (kind === "chat") {
        launchAgent(position);
      } else if (kind === "browser" && isDesktop) {
        const id = newBrowserId();
        markBrowserFresh(id);
        addBrowserLeaf(api, workspaceId, id, undefined, position);
        trpc.browsers.create.mutate({ workspaceId, id }).catch(() => {});
      }
    },
    [workspaceId, launchAgent],
  );

  // Actually remove a leaf (panel + any server-side instance). Shared by the
  // normal close path and the "Close without saving" confirm button. For a
  // `file` leaf, also drop its persisted editor state so the next open starts
  // clean (mirrors mobile's `removeFile` on tab close).
  const doCloseLeaf = useCallback(
    (id: string, kind: LeafKind) => {
      const api = apiRef.current;
      if (!api) return;
      selectNeighbourBeforeRemove(api, id);
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
      if (kind === "term") {
        // A terminal leaf hosts N nested panes — kill EVERY owned pane's PTY,
        // not just the outer panel id (which may be a pane the user already
        // closed). Then drop the leaf's nested-layout blob + ownership.
        const owned = terminalsOwnedByLeaf(id);
        for (const terminalId of owned.length ? owned : [id]) {
          disposeTerminal(terminalId);
          trpc.terminal.kill.mutate({ terminalId }).catch(() => {});
        }
        clearLeafOwners(id);
        deleteNestedLayout(workspaceId, id);
      } else if (kind === "chat") {
        trpc.chats.remove.mutate({ chatId: id }).catch(() => {});
      } else if (kind === "browser") {
        trpc.browsers.remove.mutate({ browserId: id }).catch(() => {});
      } else if (kind === "file") {
        closedFileLeaves.add(closedFileLeafKey(workspaceId, id.slice(5)));
        removeFileTabState(workspaceId, id.slice(5));
      }
      // file / diff leaves are otherwise pure client views — no server mutation.
    },
    [workspaceId],
  );

  const handleClose = useCallback(
    (id: string, kind: LeafKind) => {
      const api = apiRef.current;
      if (!api) return;
      // Closing the LAST leaf is allowed: the dockview drops to its centered
      // empty state (New Terminal / Chat / Browser), so there's always a way back.
      // Closing a dirty file prompts first; the confirm button does the removal.
      if (kind === "file") {
        const path = id.slice(5); // strip the `file:` prefix
        if (isFileDirty(workspaceId, path)) {
          setPendingClose({ id, path });
          return;
        }
      }
      doCloseLeaf(id, kind);
    },
    [workspaceId, doCloseLeaf],
  );

  // ---- open a per-path file / diff leaf (driven by the right sidepanel) ----
  const handleOpenFile = useCallback(
    (
      filePath: string,
      opts?: {
        line?: number;
        column?: number;
        external?: boolean;
        preview?: boolean;
        untitled?: boolean;
        // Set when the open is a Go Back/Forward history step, so it doesn't
        // itself push onto the history stack.
        fromHistory?: boolean;
      },
    ) => {
      const api = apiRef.current;
      if (!api) return;
      // Record forward navigations on the editor history stack (skip history
      // steps + no-op re-opens of the current file).
      if (!opts?.fromHistory) {
        const h = editorHistoryRef.current;
        if (h.stack[h.index] !== filePath) {
          h.stack = h.stack.slice(0, h.index + 1);
          h.stack.push(filePath);
          h.index = h.stack.length - 1;
        }
      }
      const preview = opts?.preview ?? false;
      const id = `file:${filePath}`;
      const existing = api.getPanel(id);
      if (existing) {
        // Pinning (double-click / intentional open) an already-open preview
        // clears its preview flag so the next single-click won't replace it.
        if (!preview && previewFileIdRef.current === id) previewFileIdRef.current = null;
        // Spread current params so we never drop workspaceId/filePath/external
        // regardless of dockview's updateParameters merge semantics.
        const cur = existing.api.getParameters<FileLeafParams>();
        existing.api.updateParameters({
          ...cur,
          line: opts?.line,
          column: opts?.column,
          preview: preview ? cur.preview : false,
        });
        existing.api.setActive();
        return;
      }
      // Placement: default to the group the user is working in (active grid
      // group), not always the first central group. When replacing a preview,
      // reuse the OLD preview's group so a moved preview stays where the user
      // put it (add the new leaf into that group first, then close the old one).
      let position: AddPanelOptions["position"] = activeOrCentralPosition(api);
      let previewToRemove: IDockviewPanel | null = null;
      if (preview && previewFileIdRef.current && previewFileIdRef.current !== id) {
        const prev = api.getPanel(previewFileIdRef.current);
        if (prev) {
          position = { referenceGroup: prev.group.id };
          previewToRemove = prev;
        }
      }
      api.addPanel({
        id,
        component: "file",
        tabComponent: "file",
        title: basename(filePath),
        params: {
          workspaceId,
          filePath,
          line: opts?.line,
          column: opts?.column,
          external: opts?.external,
          untitled: opts?.untitled,
          preview,
        },
        position,
      } as AddPanelOptions);
      if (previewToRemove) api.removePanel(previewToRemove);
      previewFileIdRef.current = preview ? id : previewFileIdRef.current;
    },
    [workspaceId],
  );

  // Working-tree diffs (`diff:<path>`) and commit diffs (`diff@<sha>:<path>`)
  // share one preview slot, so browsing either reuses the same italic tab.
  const openDiffLeaf = useCallback(
    (filePath: string, commit: string | undefined, opts?: OpenDiffOptions) => {
      const api = apiRef.current;
      if (!api) return;
      const preview = opts?.preview ?? false;
      const id = commit ? commitDiffId(commit, filePath) : `diff:${filePath}`;
      const existing = api.getPanel(id);
      if (existing) {
        if (!preview && previewDiffIdRef.current === id) previewDiffIdRef.current = null;
        // One tab per path: opening the file from another section switches
        // the tab to that section's diff. An open without a section ("View
        // changes") clears it, so the leaf picks the file's section afresh.
        const cur = existing.api.getParameters<DiffLeafParams>();
        const sectionChanged = opts?.section !== cur.section || opts?.oldPath !== cur.oldPath;
        if (!commit && (!preview || sectionChanged)) {
          existing.api.updateParameters({
            ...cur,
            ...(preview ? {} : { preview: false }),
            section: opts?.section,
            oldPath: opts?.oldPath,
          });
        } else if (!preview) {
          existing.api.updateParameters({ ...cur, preview: false });
        }
        existing.api.setActive();
        return;
      }
      let position: AddPanelOptions["position"] = activeOrCentralPosition(api);
      let previewToRemove: IDockviewPanel | null = null;
      if (preview && previewDiffIdRef.current && previewDiffIdRef.current !== id) {
        const prev = api.getPanel(previewDiffIdRef.current);
        if (prev) {
          position = { referenceGroup: prev.group.id };
          previewToRemove = prev;
        }
      }
      api.addPanel({
        id,
        component: "diff",
        tabComponent: "diff",
        title: basename(filePath),
        params: {
          workspaceId,
          filePath,
          preview,
          commit,
          section: opts?.section,
          oldPath: opts?.oldPath,
        },
        position,
      } as AddPanelOptions);
      if (previewToRemove) api.removePanel(previewToRemove);
      previewDiffIdRef.current = preview ? id : previewDiffIdRef.current;
    },
    [workspaceId],
  );

  const handleOpenDiff = useCallback(
    (filePath: string, opts?: OpenDiffOptions) => openDiffLeaf(filePath, undefined, opts),
    [openDiffLeaf],
  );

  const handleOpenSectionDiffs = useCallback(
    (section: ChangeSection) => {
      const api = apiRef.current;
      if (!api) return;
      const id = sectionDiffsId(section);
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      api.addPanel({
        id,
        component: "diff",
        tabComponent: "diff",
        title: SECTION_LABELS[section],
        params: { workspaceId, filePath: "", allOf: section },
        position: activeOrCentralPosition(api),
      } as AddPanelOptions);
    },
    [workspaceId],
  );

  const handleOpenCommitDiff = useCallback(
    (sha: string, filePath: string, opts?: { preview?: boolean }) =>
      openDiffLeaf(filePath, sha, opts),
    [openDiffLeaf],
  );

  // ---- keep file / diff leaves in step with Explorer renames and deletes ----
  const handlePathMoved = useCallback(
    (oldPath: string, newPath: string) => {
      const api = apiRef.current;
      if (!api) return;
      const remap = (p: string): string | null =>
        p === oldPath
          ? newPath
          : p.startsWith(`${oldPath}/`)
            ? newPath + p.slice(oldPath.length)
            : null;
      const moves: { panel: IDockviewPanel; prefix: "file" | "diff"; nextPath: string }[] = [];
      for (const panel of api.panels) {
        const prefix = panel.id.startsWith("file:")
          ? "file"
          : panel.id.startsWith("diff:")
            ? "diff"
            : null;
        if (!prefix) continue;
        // Read `panel.params` (what the leaf was added with): `panel.api
        // .getParameters()` came back empty for these leaves in the e2e run.
        const params = (panel.params ?? {}) as Partial<FileLeafParams>;
        if (prefix === "file" && (params.external || params.untitled)) continue;
        const nextPath = remap(panel.id.slice(5));
        if (nextPath != null) moves.push({ panel, prefix, nextPath });
      }
      if (moves.length === 0) return;

      // Carry each file tab's persisted state (cursor, unsaved edits) to its
      // new path before the new leaves mount and read it, and mark the old
      // leaves closed so their unmount cleanup doesn't write the old keys back.
      const states = readTabStates(workspaceId);
      let statesChanged = false;
      for (const { panel, prefix, nextPath } of moves) {
        if (prefix !== "file") continue;
        const filePath = panel.id.slice(5);
        if (filePath in states) {
          states[nextPath] = states[filePath];
          delete states[filePath];
          statesChanged = true;
        }
        closedFileLeaves.add(closedFileLeafKey(workspaceId, filePath));
      }
      if (statesChanged) writeTabStates(workspaceId, states);

      for (const { panel, prefix, nextPath } of moves) {
        const nextId = `${prefix}:${nextPath}`;
        const wasVisible = panel.api.isVisible;
        const existing = api.getPanel(nextId);
        if (existing) {
          // A tab for the destination path is already open (e.g. a dirty tab
          // kept after its file was deleted): reuse it rather than adding a
          // duplicate id, which dockview rejects.
          if (wasVisible) existing.api.setActive();
        } else {
          // Same group and tab position, so the rename doesn't reorder tabs.
          api.addPanel({
            id: nextId,
            component: prefix,
            tabComponent: prefix,
            title: basename(nextPath),
            params: { ...panel.params, workspaceId, filePath: nextPath },
            position: { referenceGroup: panel.group.id, index: panel.group.panels.indexOf(panel) },
            inactive: !wasVisible,
          } as AddPanelOptions);
        }
        api.removePanel(panel);
        if (previewFileIdRef.current === panel.id) previewFileIdRef.current = nextId;
        if (previewDiffIdRef.current === panel.id) previewDiffIdRef.current = nextId;
      }
    },
    [workspaceId],
  );

  const handlePathRemoved = useCallback(
    (path: string) => {
      const api = apiRef.current;
      if (!api) return;
      for (const panel of [...api.panels]) {
        const kind: LeafKind | null = panel.id.startsWith("file:")
          ? "file"
          : panel.id.startsWith("diff:")
            ? "diff"
            : null;
        if (!kind) continue;
        const params = (panel.params ?? {}) as Partial<FileLeafParams>;
        if (kind === "file" && params.external) continue;
        const p = panel.id.slice(5);
        if (p !== path && !p.startsWith(`${path}/`)) continue;
        if (kind === "file" && isFileDirty(workspaceId, p)) continue;
        doCloseLeaf(panel.id, kind);
      }
    },
    [workspaceId, doCloseLeaf],
  );

  const actionsRef = useRef<LeafActions>({
    onAdd: () => {},
    onSplit: () => {},
    onClose: () => {},
    openFile: () => {},
    openDiff: () => {},
    openSectionDiffs: () => {},
    openCommitDiff: () => {},
    onPathMoved: () => {},
    onPathRemoved: () => {},
  });
  actionsRef.current = {
    onAdd: handleAdd,
    onSplit: handleSplit,
    onClose: handleClose,
    openFile: handleOpenFile,
    openDiff: handleOpenDiff,
    openSectionDiffs: handleOpenSectionDiffs,
    openCommitDiff: handleOpenCommitDiff,
    onPathMoved: handlePathMoved,
    onPathRemoved: handlePathRemoved,
  };

  // ---- default layout ----
  const buildDefaultLayout = useCallback(
    (api: DockviewApi, data: CenterLayoutData) => {
      // Default layout for an EMPTY workspace: a single terminal tab, full
      // width. But if the workspace already has live instances (CLI-created
      // chats/browsers/extra terminals, or a seeded session), surface THOSE and
      // do NOT fabricate a terminal — a fresh empty shell must never bury the
      // user's existing chat/browser behind it on every load. They stack as tabs
      // into the one group (a user can split them out later).
      let anchorId: string | null = null;
      let activeId: string | null = null;
      const stack = (): AddPanelOptions["position"] | undefined =>
        anchorId ? { referencePanel: anchorId, direction: "within" } : undefined;

      const termIds = [...data.terminalIds];
      const hasPreExisting =
        termIds.length > 0 || data.chatIds.size > 0 || (isDesktop && data.browserIds.size > 0);

      if (!hasPreExisting) {
        // Truly empty → the single-terminal default (freshly created + booted).
        const id = newTerminalId();
        addTermLeaf(api, workspaceId, id, { autoFocus: true }, stack());
        anchorId = id;
        activeId = id;
        trpc.terminal.create.mutate({ workspaceId, id }).catch(() => {});
      } else {
        // Surface pre-existing live instances. A terminal is preferred active
        // (matches the empty default's feel); otherwise the first surfaced leaf.
        for (const id of termIds) {
          addTermLeaf(api, workspaceId, id, undefined, stack());
          anchorId ??= id;
          activeId ??= id;
        }
        for (const chatId of data.chatIds) {
          addChatLeaf(api, workspaceId, chatId, stack());
          anchorId ??= chatId;
          activeId ??= chatId;
        }
        if (isDesktop) {
          for (const id of [...data.browserIds]) {
            addBrowserLeaf(api, workspaceId, id, data.urls.get(id), stack());
            anchorId ??= id;
            activeId ??= id;
          }
        }
      }

      if (activeId) {
        try {
          api.getPanel(activeId)?.api.setActive();
        } catch {}
      }
    },
    [workspaceId],
  );

  // ---- reconcile a restored layout against live instances ----
  const reconcile = useCallback(
    (api: DockviewApi, data: CenterLayoutData) => {
      // Remove per-instance leaves whose server record is gone.
      for (const panel of [...api.panels]) {
        const kind = panel.api.component as LeafKind;
        if (kind === "chat" && !data.chatIds.has(panel.id)) api.removePanel(panel);
        else if (kind === "term") {
          // A term leaf owns N nested panes — it survives as long as ANY of its
          // panes' terminals is still live (ownership-based), not just the outer
          // panel id (which may be a pane the user closed). Owner map is
          // pre-seeded from persisted split blobs in onReady, so this is
          // populated before the nested leaves mount.
          // A leaf also survives if its terminal is still alive in the CLIENT
          // cache (PARKED across a workspace switch). When the workspace's
          // dockview remounts in-app, the server's `terminal.list` can
          // momentarily omit the parked terminal; without this cache check
          // reconcile would prune the restored leaf and the empty-fallback
          // below would fabricate a phantom duplicate terminal (regression of
          // the band-app/band#617 fix).
          const selfLive = data.terminalIds.has(panel.id) || hasTerminal(panel.id);
          const ownsLive =
            leafOwnsAnyLive(panel.id, data.terminalIds) ||
            terminalsOwnedByLeaf(panel.id).some(hasTerminal);
          if (!selfLive && !ownsLive) api.removePanel(panel);
        } else if (kind === "browser" && !data.browserIds.has(panel.id)) api.removePanel(panel);
      }
      // Add live instances missing from the restored layout (CLI-created while closed).
      for (const chatId of data.chatIds) {
        if (!api.getPanel(chatId)) addChatLeaf(api, workspaceId, chatId);
      }
      for (const terminalId of data.terminalIds) {
        // Skip terminals that are panes of an existing terminal leaf — they live
        // inside a nested dockview, not as top-level tabs. Only genuine
        // top-level terminals (no owner) seed a new leaf.
        if (!isOwnedPane(terminalId) && !api.getPanel(terminalId)) {
          addTermLeaf(api, workspaceId, terminalId);
        }
      }
      if (isDesktop) {
        for (const browserId of data.browserIds) {
          if (!api.getPanel(browserId))
            addBrowserLeaf(api, workspaceId, browserId, data.urls.get(browserId));
        }
      }
      // Restored `file` / `diff` leaves are pure client views with no server
      // record — leave them exactly as they were persisted (do NOT prune).
      // A dockview that ends up EMPTY here (the user closed every leaf) is left
      // empty on purpose: the centered empty state offers New Terminal / Chat /
      // Browser rather than forcing a leaf back on the next reload (#643).
    },
    [workspaceId],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      workspaceDockviewApis.set(workspaceId, api);
      workspaceLeafActions.set(workspaceId, actionsRef);
      leafActionsByApiId.set(api.id, actionsRef);
      if (mobile) mobileByApiId.add(api.id);

      const data = initialDataRef.current ?? {
        chatIds: new Set<string>(),
        terminalIds: new Set<string>(),
        browserIds: new Set<string>(),
        urls: new Map<string, string>(),
      };

      // Pre-seed terminal-pane ownership from persisted split blobs BEFORE
      // reconcile: the nested `TerminalSplitLeaf`s haven't mounted yet, so
      // without this reconcile would see a pane's terminalId in `terminal.list`,
      // find no owner, and wrongly add it as a top-level tab.
      seedOwnersFromStorage(workspaceId);

      isRestoringRef.current = true;
      const saved = loadSavedLayout(workspaceId);
      // The tab list shared with other devices (the phone and the desktop
      // show the same tabs; this device's own layout keeps splits and sizes).
      const shared = readCenterTabs(workspaceId);
      // Track whether we BUILT a fresh default (vs restored a persisted layout).
      // Only a freshly-built default needs the one-shot persist below — a
      // restored layout is already durable, and re-flushing it on mount would
      // race the deferred maximize re-apply and clobber the saved maximizedGroup.
      let builtDefault = false;
      if (saved) {
        try {
          api.fromJSON(
            // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON requires any
            reinjectParams(sanitizeSavedLayout(saved), workspaceId, data.urls) as any,
          );
          reconcile(api, data);
        } catch (err) {
          console.error("[WorkspaceCenterDockview] fromJSON failed, rebuilding:", err);
          for (const p of [...api.panels]) api.removePanel(p);
          buildDefaultLayout(api, data);
          builtDefault = true;
        }
      } else if (shared) {
        // First open on this device type: start from the shared tabs (added
        // below) plus the live instances, not a fabricated terminal.
        reconcile(api, data);
        builtDefault = true;
      } else {
        buildDefaultLayout(api, data);
        builtDefault = true;
      }

      // Mobile is tabs-only: collapse any split (default or a restored desktop
      // layout) into a single group.
      if (mobile) flattenToSingleGroup(api);

      // Take another device's tab changes made since this layout was saved.
      if (shared && applyCenterTabsFull(api, workspaceId, shared)) builtDefault = true;

      // Restore a persisted maximized group (issue #490): dockview's fromJSON
      // preserves group ids, so re-maximize the one writeLayout recorded. Skip
      // on mobile (single group — nothing to maximize against). Deferred to the
      // next frame so the grid is laid out (maximizing a 0×0 group is a no-op).
      if (!mobile && saved && typeof saved.maximizedGroup === "string") {
        const maxId = saved.maximizedGroup;
        requestAnimationFrame(() => {
          try {
            api.groups.find((grp) => grp.id === maxId)?.api.maximize();
          } catch {}
        });
      }

      // Touch: a drag along the tab strip scrolls it; only a tap switches tabs.
      touchTabsDisposerRef.current?.();
      if (containerRef.current) {
        touchTabsDisposerRef.current = attachTouchTabActivation(containerRef.current, api);
      }

      // Persistence + focus reporting. Structural changes (add/remove leaf or
      // group) flush immediately so a close survives an instant reload; the
      // high-frequency layout stream (resize/move) is debounced.
      const syncEmpty = () => setIsEmpty(api.panels.length === 0);
      api.onDidLayoutChange(() => schedulePersist());
      api.onDidAddPanel(() => {
        syncEmpty();
        flushPersist();
      });
      api.onDidRemovePanel((panel) => {
        // Drop the preview pointer if the previewing leaf was closed, so a
        // later single-click opens fresh instead of trying to reuse a dead id.
        if (previewFileIdRef.current === panel.id) previewFileIdRef.current = null;
        if (previewDiffIdRef.current === panel.id) previewDiffIdRef.current = null;
        syncEmpty();
        flushPersist();
      });
      api.onDidAddGroup(() => flushPersist());
      api.onDidRemoveGroup(() => flushPersist());
      // Maximize/restore isn't an onDidLayoutChange, so persist it explicitly
      // (immediately) — a maximized editor must survive a reload (#490).
      api.onDidMaximizedGroupChange(() => {
        // Ignore the transient exit/re-enter that writeLayout's own toJSON
        // triggers — only a real user maximize/restore should persist.
        if (isPersistingRef.current) return;
        flushPersist();
      });
      api.onDidActivePanelChange(() => {
        if (!applyingSharedRef.current && !isRestoringRef.current) {
          pendingSharedOrderRef.current = false;
        }
        schedulePersist();
        reportFocus();
      });
      api.onDidMovePanel(() => {
        if (!applyingSharedRef.current && !isRestoringRef.current) {
          pendingSharedOrderRef.current = false;
        }
      });

      setTimeout(() => {
        isRestoringRef.current = false;
        // Persist a freshly-built DEFAULT layout once, immediately. It is
        // otherwise only written on the NEXT outer-layout change — but splitting
        // a terminal is a NESTED change that never touches the outer layout, so
        // without this a fresh workspace that only split terminals would lose its
        // outer layout (and thus the primary terminal id the nested split blob is
        // keyed by) on reload. A RESTORED layout is skipped: it's already durable
        // and re-flushing would race the deferred maximize re-apply.
        if (builtDefault) flushPersist();
      }, 0);

      // Seed the initial empty state: the add/remove-panel subscriptions above
      // are attached AFTER the build/restore, so a restored layout that ended up
      // empty never fires onDidAddPanel — set it directly from the panel count.
      setIsEmpty(api.panels.length === 0);

      // Cold-mount layout catch-up.
      if (visibleRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          api.layout(Math.round(rect.width), Math.round(rect.height), true);
        }
      }
    },
    [
      workspaceId,
      mobile,
      buildDefaultLayout,
      reconcile,
      schedulePersist,
      flushPersist,
      reportFocus,
    ],
  );

  // Live sync: add/remove leaves when instances are created/killed externally (CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      const pendingPositions = pendingLeafPositionsRef.current;
      if (event.kind === "chat-created" && typeof event.chatId === "string") {
        if (!api.getPanel(event.chatId)) {
          addChatLeaf(api, workspaceId, event.chatId, pendingPositions.get(event.chatId));
        }
      } else if (event.kind === "chat-removed" && typeof event.chatId === "string") {
        const panel = api.getPanel(event.chatId);
        if (panel) api.removePanel(panel);
      } else if (event.kind === "terminal-created" && typeof event.terminalId === "string") {
        // A pane created by an in-tab split registers ownership before its
        // `terminal.create`, so its echo lands here already-owned — don't add a
        // stray top-level tab. Only genuine CLI-created terminals (no owner)
        // seed a new leaf.
        if (!isOwnedPane(event.terminalId) && !api.getPanel(event.terminalId)) {
          // A terminal this tab launched an agent into gets focus, like New terminal.
          const launched = pendingPositions.has(event.terminalId);
          addTermLeaf(
            api,
            workspaceId,
            event.terminalId,
            launched ? { autoFocus: true } : undefined,
            pendingPositions.get(event.terminalId),
          );
        }
      } else if (event.kind === "terminal-killed" && typeof event.terminalId === "string") {
        disposeTerminal(event.terminalId);
        // Every terminal is a PANE of some terminal leaf (the primary pane's id
        // === the outer leaf id). Resolve the owning leaf, then remove the killed
        // pane from its nested dockview — and remove the OUTER leaf only once no
        // panes remain. Keying only on `api.getPanel(id)` would wrongly nuke the
        // whole leaf when the (primary) pane is closed while others survive.
        const killedId = event.terminalId;
        const leafId = ownerOfTerminal(killedId) ?? (api.getPanel(killedId) ? killedId : undefined);
        if (leafId) {
          const nested = terminalSplitApiForLeaf(leafId);
          const pane = nested?.getPanel(killedId);
          if (nested && pane) nested.removePanel(pane);
          if (!nested || nested.panels.length === 0) {
            const outer = api.getPanel(leafId);
            if (outer) api.removePanel(outer);
          }
        }
        unregisterPaneOwner(killedId);
      } else if (
        isDesktop &&
        event.kind === "browser-created" &&
        typeof event.browserId === "string"
      ) {
        if (!api.getPanel(event.browserId)) addBrowserLeaf(api, workspaceId, event.browserId);
      } else if (event.kind === "browser-removed" && typeof event.browserId === "string") {
        const panel = api.getPanel(event.browserId);
        if (panel) api.removePanel(panel);
      }
    });
  }, [adapter, workspaceId]);

  // Another device changed the shared tab list. Off screen, take it whole;
  // on screen, only open and close tabs, and leave the order and active tab
  // for the next time the workspace is shown.
  useEffect(() => {
    const key = centerTabsKey(workspaceId);
    return subscribeClientState((change) => {
      if (change.key !== key) return;
      const api = apiRef.current;
      const next = parseCenterTabs(change.value);
      if (!api || !next || isRestoringRef.current) return;
      applyingSharedRef.current = true;
      let changed: boolean;
      try {
        if (!visibleRef.current) {
          pendingSharedOrderRef.current = false;
          changed = applyCenterTabsFull(api, workspaceId, next);
        } else {
          if (orderOrActiveDiffers(centerTabsFromApi(api), next)) {
            pendingSharedOrderRef.current = true;
          }
          const { added, removed } = diffCenterTabs(parseCenterTabs(change.previous), next);
          changed = applyCenterTabMembership(api, workspaceId, next, added, removed);
        }
      } finally {
        applyingSharedRef.current = false;
      }
      // A refused write means this device's tabs aren't saved yet: write them
      // again on top of the other device's list.
      if (changed || change.source === "conflict") flushPersist();
    });
  }, [workspaceId, flushPersist]);

  // Shown again: apply the order and active tab another device set meanwhile.
  useEffect(() => {
    if (!visible || !pendingSharedOrderRef.current) return;
    pendingSharedOrderRef.current = false;
    const api = apiRef.current;
    const shared = readCenterTabs(workspaceId);
    if (!api || !shared) return;
    applyingSharedRef.current = true;
    let changed: boolean;
    try {
      changed = applyCenterTabsFull(api, workspaceId, shared);
    } finally {
      applyingSharedRef.current = false;
    }
    if (changed) flushPersist();
  }, [visible, workspaceId, flushPersist]);

  // Page popups (window.open, target="_blank", middle-click) reach us as a
  // request for a new Band tab; the main process has already denied the OS
  // window (issue #488). Only the workspace holding the source tab acts.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void desktopListen<{ browser_id: string; url: string }>("browser-open-window", (event) => {
      const api = apiRef.current;
      const source = api?.getPanel(event.payload.browser_id);
      if (!api || !source) return;
      const id = newBrowserId();
      markBrowserFresh(id);
      addBrowserLeaf(api, workspaceId, id, event.payload.url, {
        referenceGroup: source.group.id,
      });
      trpc.browsers.create.mutate({ workspaceId, id, url: event.payload.url }).catch((err) => {
        console.error("[WorkspaceCenterDockview] popup browser create failed:", err);
      });
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [workspaceId]);

  // Bring a specific chat/terminal leaf forward when "Add to Chat/Terminal" targets it.
  useEffect(() => {
    const onChatInsert = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail?.chatId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.chatId)?.api.setActive();
    };
    const onTerminalInsert = (e: Event) => {
      const detail = (e as CustomEvent<TerminalInsertDetail>).detail;
      if (!detail?.terminalId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.terminalId)?.api.setActive();
    };
    window.addEventListener("band:chat-insert", onChatInsert);
    window.addEventListener("band:terminal-insert", onTerminalInsert);
    return () => {
      window.removeEventListener("band:chat-insert", onChatInsert);
      window.removeEventListener("band:terminal-insert", onTerminalInsert);
    };
  }, [workspaceId]);

  // Editor navigation history: Go Back / Go Forward (command palette) step this
  // workspace's file history. Scoped by workspaceId so a Go Back addressed to
  // workspace A can't step a cached, hidden workspace B's stack (a missing id
  // falls through to the active workspace, for backwards-compat).
  useEffect(() => {
    const step = (delta: 1 | -1) => (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId ? detail.workspaceId !== workspaceId : !wsActiveRef.current) return;
      const h = editorHistoryRef.current;
      const next = h.index + delta;
      if (next < 0 || next >= h.stack.length) return;
      h.index = next;
      actionsRef.current.openFile(h.stack[next], { fromHistory: true });
    };
    const onBack = step(-1);
    const onForward = step(1);
    window.addEventListener("band:editor-go-back", onBack);
    window.addEventListener("band:editor-go-forward", onForward);
    return () => {
      window.removeEventListener("band:editor-go-back", onBack);
      window.removeEventListener("band:editor-go-forward", onForward);
    };
  }, [workspaceId]);

  // Section-scoped keyboard shortcuts (active workspace + focus inside only).
  useEffect(() => {
    if (!visible) return;

    const refocusActive = () => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      const el = panel.view.content.element;
      (
        el.querySelector<HTMLElement>(".xterm-helper-textarea") ??
        el.querySelector<HTMLElement>("[data-band-address-input]")
      )?.focus();
    };

    const handler = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;
      const api = apiRef.current;
      if (!api) return;
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.metaKey && key === "tab") {
        e.preventDefault();
        e.stopPropagation();
        cycleTabsInActiveGroup(api, e.shiftKey ? -1 : 1, () =>
          requestAnimationFrame(refocusActive),
        );
        return;
      }

      // ⌘D / ⌘⇧D (Ctrl+Shift+D / Alt+Shift+D off macOS) split chat / browser
      // leaves into sibling groups. Terminals split INTO nested panes instead,
      // so with a terminal focused the chord is left to its leaf's handler.
      const split = splitDirectionForKey(e, isMacPlatform());
      if (split) {
        if (findFocusedTerminalSplitDockview()) return;
        const groupId = api.activeGroup?.id;
        const kind = api.activePanel?.api.component as LeafKind | undefined;
        e.preventDefault();
        e.stopPropagation();
        if (groupId && (kind === "chat" || kind === "browser")) handleSplit(kind, groupId, split);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Defer the pane-level keys to a focused terminal leaf's nested dockview:
      // it owns plain ⌘[ / ⌘] (cycle panes), ⌘W / Ctrl+D (close pane). Bail
      // WITHOUT preventDefault so the nested capture handler (registered later
      // on the same window) still fires and acts.
      if (
        findFocusedTerminalSplitDockview() &&
        (key === "d" || key === "w" || ((key === "[" || key === "]") && !e.shiftKey))
      ) {
        return;
      }

      if (e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleTabsInActiveGroup(api, key === "]" ? 1 : -1, () =>
          requestAnimationFrame(refocusActive),
        );
        return;
      }
      if (!e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleGridGroups(api, key === "]" ? 1 : -1, () => requestAnimationFrame(refocusActive));
        return;
      }

      // ⌘T (new terminal) lives in the shell's global handler with the other
      // new-tab chords (SharedDockviewLayout).
      if (key === "w" && !e.shiftKey) {
        const active = api.activePanel;
        const kind = active?.api.component as LeafKind | undefined;
        if (!active || !kind) return;
        e.preventDefault();
        e.stopPropagation();
        handleClose(active.id, kind);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, handleClose, handleSplit]);

  // Focus the active leaf when the workspace becomes visible.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      const el = panel.view.content.element;
      (
        el.querySelector<HTMLElement>(".xterm-helper-textarea") ??
        el.querySelector<HTMLElement>("[data-band-address-input]")
      )?.focus();
      reportFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, reportFocus]);

  // Force a synchronous re-layout when this workspace's dockview becomes visible
  // (mirrors the legacy inner containers' reveal fix).
  useLayoutEffect(() => {
    if (!visible) return;
    const api = apiRef.current;
    const container = containerRef.current;
    if (!api || !container) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const applyLayout = (width: number, height: number) => {
      const w = Math.round(width);
      const h = Math.round(height);
      if (w <= 0 || h <= 0 || (w === lastWidth && h === lastHeight)) return;
      lastWidth = w;
      lastHeight = h;
      api.layout(w, h, true);
    };
    const rect = container.getBoundingClientRect();
    applyLayout(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) applyLayout(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [visible]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      const api = apiRef.current;
      if (api) {
        leafActionsByApiId.delete(api.id);
        mobileByApiId.delete(api.id);
        if (workspaceDockviewApis.get(workspaceId) === api) {
          workspaceDockviewApis.delete(workspaceId);
          workspaceLeafActions.delete(workspaceId);
        }
      }
      touchTabsDisposerRef.current?.();
      touchTabsDisposerRef.current = null;
      // Flush a pending debounced save rather than dropping it, so a layout
      // tweak right before a workspace switch / unmount still persists.
      if (saveTimerRef.current && api) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        try {
          clientStorage.setItem(
            layoutKey(workspaceId),
            JSON.stringify(stripParams(api.toJSON() as unknown as Record<string, unknown>)),
          );
          persistCenterTabs(api, workspaceId, pendingSharedOrderRef.current);
        } catch {
          // best-effort
        }
      }
    };
  }, [workspaceId]);

  const visibilityValue = useMemo(
    () => ({ visible: visible && wsActive !== false, wsActive: wsActive !== false }),
    [visible, wsActive],
  );

  if (!initialData) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div ref={containerRef} className="relative flex h-full w-full flex-col overflow-hidden">
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={mobile ? bandTheme : bandDesktopTheme}
          className="h-full"
          components={components}
          tabComponents={tabComponents}
          defaultTabComponent={IconTab}
          prefixHeaderActionsComponent={PrefixHeaderActions}
          leftHeaderActionsComponent={LeftHeaderActions}
          rightHeaderActionsComponent={RightHeaderActions}
          // Mobile: no drag→split. Every leaf stays a tab in a single group.
          disableDnd={mobile}
          // No "N hidden tabs" dropdown: the strip scrolls sideways instead
          // (wheel, trackpad, touch — see `.dockview-center-tabs` in
          // dockview-theme.css).
          disableTabsOverflowList
          onReady={onReady}
        />
      </PanelVisibilityContext.Provider>

      {/* Empty state: shown when every leaf is closed. Offers the same
          "New …" actions as the header "+" menu, centered in the vacant area,
          so a closed-out workspace is a deliberate blank slate rather than a
          dead end. */}
      {isEmpty && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          data-testid="workspace-center__empty-state"
        >
          {/* Closing the last tab removes the tab strip, which is the
              window's top row on desktop; the drag bar keeps the window
              draggable and the sidepanel expand button reachable. */}
          {!mobile && <CenterDragBar className="absolute inset-x-0 top-0" />}
          <div className="flex flex-col gap-2">
            <NewAgentButton
              className={EMPTY_STATE_BUTTON_CLASS}
              onPick={(agentId) => handleAdd("chat", undefined, agentId)}
            />
            <button
              type="button"
              onClick={() => handleAdd("term")}
              className={EMPTY_STATE_BUTTON_CLASS}
              data-testid="workspace-center__empty-new-term"
            >
              <TerminalIcon className="size-4" />
              New terminal
            </button>
            {isDesktop && (
              <button
                type="button"
                onClick={() => handleAdd("browser")}
                className={EMPTY_STATE_BUTTON_CLASS}
                data-testid="workspace-center__empty-new-browser"
              >
                <Globe className="size-4" />
                New browser
              </button>
            )}
          </div>
        </div>
      )}

      {/* Unsaved-changes confirm for a dirty file leaf. Mirrors the mobile
          FileTabBar confirm: Cancel keeps the tab, "Close without saving"
          removes the panel and drops the persisted edited content (via
          `doCloseLeaf` → `removeFileTabState`). */}
      <Dialog open={pendingClose !== null} onOpenChange={(open) => !open && setPendingClose(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              {pendingClose ? basename(pendingClose.path) : ""} has unsaved changes. Close without
              saving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingClose(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingClose) doCloseLeaf(pendingClose.id, "file");
                setPendingClose(null);
              }}
            >
              Close without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
