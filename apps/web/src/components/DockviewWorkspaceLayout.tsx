import {
  buildCommands,
  CommandPaletteDialog,
  DashboardShell,
  type DiffStats,
  DiffView,
  parseFileLocation,
  QuickOpenDialog,
  SearchFilesDialog,
  useDiffTarget,
  useSettingsQuery,
  WorkspacePickerDialog,
} from "@band-app/dashboard-core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import {
  FolderOpen,
  Folders,
  GitCompare,
  Globe,
  Maximize2,
  MessageSquare,
  Minimize2,
  Terminal as TerminalIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";
import { useWsActive } from "../lib/workspace-visibility-store";
import { CodeBrowserView } from "./CodeBrowserView";
import { DockviewBrowserContainer } from "./DockviewBrowserContainer";
import { DockviewChatContainer } from "./DockviewChatContainer";
import { ScreencastPanel } from "./ScreencastPanel";
import { useAnyToolbarDialogOpen } from "./ToolbarButtons";

// ---------------------------------------------------------------------------
// Custom dockview theme – prevents the default themeAbyss from being applied
// ---------------------------------------------------------------------------

const bandTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band",
};

// ---------------------------------------------------------------------------
// Panel icon map
// ---------------------------------------------------------------------------

const PANEL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  projects: Folders,
  chat: MessageSquare,
  changes: GitCompare,
  files: FolderOpen,
  terminal: TerminalIcon,
  browser: Globe,
};

const PANEL_SHORTCUTS: Record<string, string> = {
  chat: "⌃⌘I",
  changes: "⇧⌘G",
  files: "⇧⌘E",
  terminal: "⌃`",
  browser: "⇧⌘B",
};

// ---------------------------------------------------------------------------
// Lazy-loaded dockview terminal container (avoid importing @xterm CJS during SSR)
// ---------------------------------------------------------------------------

const DockviewTerminalContainer = lazy(() =>
  import("./DockviewTerminalContainer").then((m) => ({
    default: m.DockviewTerminalContainer,
  })),
);

// Browser panel params (browser container handles its own lazy loading internally)

// ---------------------------------------------------------------------------
// Panel params types
// ---------------------------------------------------------------------------

interface ChatParams {
  workspaceId: string;
}

interface ChangesParams {
  workspaceId: string;
  onStatsChange: (stats: DiffStats | null) => void;
  onOpenFile: (filename: string) => void;
  onFindInFile: (fn: (() => void) | null) => void;
}

interface FilesParams {
  workspaceId: string;
  file: string | undefined;
  openFilePath: string | null;
  onSelectFile: (filePath: string | null) => void;
  onFileOpened: () => void;
  onFindInFile: (fn: (() => void) | null) => void;
}

interface TerminalParams {
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Panel wrapper components
// ---------------------------------------------------------------------------

/** Empty-state shown by every workspace-scoped panel when no workspace is
 *  selected (i.e. the index route mounts DockviewWorkspaceLayout with
 *  workspaceId="" so the layout shape matches /workspace/$id). */
function NoWorkspaceMessage({ Icon }: { Icon: React.FC<{ className?: string }> }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center px-8">
        <Icon className="size-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Select a workspace to get started</p>
      </div>
    </div>
  );
}

function ProjectsPanelComponent() {
  // DashboardShell is workspace-agnostic — it shows the global project list.
  // We mount one instance per workspace's dockview (via DockviewInstanceManager),
  // which is wasteful: useStatusWatcher / useBranchStatusWatcher /
  // useSetupStatusWatcher each open a parallel subscription per copy. They
  // funnel into the same Zustand store so it's idempotent, but a follow-up
  // should hoist those watchers to <AppShell> and let DashboardShell read
  // from the store.
  // hideMenu suppresses DashboardShell's in-shell hamburger overflow menu —
  // the global DesktopTitleBar in __root.tsx already exposes the same
  // Tasks / Cronjobs / Settings entries via its own dropdown, so the
  // duplicate menu inside the panel is just noise. ToolbarOverflowMenuItems
  // is no longer needed here since the only consumer was that menu.
  return <DashboardShell hideTitleBar={isDesktop} hideMenu />;
}

function ChatPanelComponent({ params, api }: IDockviewPanelProps<ChatParams>) {
  // Track physical visibility (not focus/active state).
  // In a split layout, the Chat panel remains visible when another panel
  // (Changes, Files, Terminal) is focused.  `isVisible` is only false when
  // the panel is behind another tab in a tabbed group, or when its edge
  // group is collapsed (dockview reports !isVisible in both cases).
  const [isVisible, setIsVisible] = useState(api.isVisible);
  const wsActive = useWsActive(params.workspaceId ?? "");

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = wsActive && isVisible;

  // No workspace selected (index route mounts the layout with workspaceId="")
  // — show a hint that prompts the user to pick a project.
  if (!params.workspaceId) return <NoWorkspaceMessage Icon={MessageSquare} />;

  return (
    <DockviewChatContainer workspaceId={params.workspaceId} visible={visible} wsActive={wsActive} />
  );
}

function ChangesPanelComponent({ params }: IDockviewPanelProps<ChangesParams>) {
  if (!params.workspaceId) return <NoWorkspaceMessage Icon={GitCompare} />;
  return (
    <DiffView
      workspaceId={params.workspaceId}
      active
      onStatsChange={params.onStatsChange}
      onOpenFile={params.onOpenFile}
      onFindInFile={params.onFindInFile}
    />
  );
}

function FilesPanelComponent({ params }: IDockviewPanelProps<FilesParams>) {
  if (!params.workspaceId) return <NoWorkspaceMessage Icon={FolderOpen} />;
  return (
    <CodeBrowserView
      workspaceId={params.workspaceId}
      file={params.file}
      onSelectFile={params.onSelectFile}
      openFilePath={params.openFilePath}
      onFileOpened={params.onFileOpened}
      onFindInFile={params.onFindInFile}
    />
  );
}

function TerminalPanelComponent({ params, api }: IDockviewPanelProps<TerminalParams>) {
  // Track physical visibility — same approach as ChatPanelComponent.
  const [isVisible, setIsVisible] = useState(api.isVisible);
  const wsActive = useWsActive(params.workspaceId ?? "");

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = wsActive && isVisible;

  if (!params.workspaceId) return <NoWorkspaceMessage Icon={TerminalIcon} />;

  return (
    <Suspense fallback={null}>
      <DockviewTerminalContainer
        workspaceId={params.workspaceId}
        visible={visible}
        wsActive={wsActive}
      />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Tab components (icon + title, no close button)
// ---------------------------------------------------------------------------

function DefaultTab(props: IDockviewPanelHeaderProps) {
  const Icon = PANEL_ICONS[props.api.component];
  const shortcut = PANEL_SHORTCUTS[props.api.component];
  const [title, setTitle] = useState(props.api.title ?? "");

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  const tab = (
    <div className="dv-default-tab">
      <div
        className="dv-default-tab-content"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {Icon ? (
          <Icon className="size-4 shrink-0" />
        ) : (
          <span className="inline-block size-4 shrink-0" aria-hidden />
        )}
        <span className="truncate">{title}</span>
      </div>
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

function BadgeTab(props: IDockviewPanelHeaderProps) {
  const Icon = PANEL_ICONS[props.api.component];
  const shortcut = PANEL_SHORTCUTS[props.api.component];
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
    <div className="dv-default-tab">
      <div
        className="dv-default-tab-content"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {Icon ? (
          <Icon className="size-4 shrink-0" />
        ) : (
          <span className="inline-block size-4 shrink-0" aria-hidden />
        )}
        <span className="truncate">{title}</span>
        {hasBadge && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 px-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
            {badge}
          </span>
        )}
      </div>
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

// ---------------------------------------------------------------------------
// Browser panel wrapper — renders DockviewBrowserContainer (multi-tab)
// Same pattern as ChatPanelComponent → DockviewChatContainer.
// ---------------------------------------------------------------------------

interface BrowserParams {
  workspaceId: string;
}

function BrowserPanelComponent({ params, api }: IDockviewPanelProps<BrowserParams>) {
  // Track physical visibility — same approach as ChatPanelComponent.
  const [isVisible, setIsVisible] = useState(api.isVisible);
  const wsActive = useWsActive(params.workspaceId ?? "");
  const { settings } = useSettingsQuery();
  const cdpEnabled = (settings as { webBrowserCdpEnabled?: boolean }).webBrowserCdpEnabled ?? false;

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = wsActive && isVisible;

  if (!params.workspaceId) return <NoWorkspaceMessage Icon={Globe} />;

  // On the web build the native webview path doesn't exist (no Electron
  // IPC). Two render modes depending on the CDP screencast experiment
  // flag (Settings → Browser → "Stream desktop tabs to web"):
  //   - enabled (opt-in): surface the desktop app's browser tabs as a
  //     CDP screencast picker the user can drive remotely.
  //   - disabled (default): show the original "desktop only" fallback so the
  //     user understands why the pane is empty.
  if (!isDesktop) {
    if (cdpEnabled) {
      return <ScreencastPanel workspaceId={params.workspaceId} visible={visible} />;
    }
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <div className="max-w-md text-center">
          The Browser pane is only available in the desktop app. Enable{" "}
          <span className="font-medium text-foreground">
            Settings → Browser → Stream desktop tabs to web
          </span>{" "}
          to use it from a browser tab.
        </div>
      </div>
    );
  }

  return (
    <DockviewBrowserContainer
      workspaceId={params.workspaceId}
      visible={visible}
      wsActive={wsActive}
    />
  );
}

// ---------------------------------------------------------------------------
// Component and tab registries
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  projects: ProjectsPanelComponent,
  chat: ChatPanelComponent,
  changes: ChangesPanelComponent,
  files: FilesPanelComponent,
  terminal: TerminalPanelComponent,
  browser: BrowserPanelComponent,
};

const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  badge: BadgeTab,
};

// ---------------------------------------------------------------------------
// Right-side header actions — adds a maximize/restore toggle to the tab strip
// of every center (grid) group. Hidden on edge groups (projects / future
// right + bottom edges) where maximize doesn't make sense.
// ---------------------------------------------------------------------------

const MainGroupRightActions = memo(function MainGroupRightActions(
  props: IDockviewHeaderActionsProps,
) {
  // location.type === "grid" means a real center group; "edge" / "floating" /
  // "popout" are all skipped. Default to "grid" if dockview omits the field
  // (older builds) so the button still shows on the main layout.
  const isGridGroup = (props.location?.type ?? "grid") === "grid";

  // Track maximize state via the container event so the icon flips when the
  // user toggles via another path (e.g. drag-restore, future keyboard shortcut).
  // group.api.isMaximized() returns true only when *this* group is the
  // maximized one — global enough that we don't need a separate
  // hasMaximizedGroup() check.
  const [isMaximized, setIsMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const refresh = () => setIsMaximized(props.api.isMaximized());
    refresh();
    const d = props.containerApi.onDidMaximizedGroupChange(refresh);
    return () => d.dispose();
  }, [props.api, props.containerApi]);

  if (!isGridGroup) return null;

  const Icon = isMaximized ? Minimize2 : Maximize2;
  const label = isMaximized ? "Restore" : "Maximize";

  return (
    <div className="flex h-full items-center px-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={() => {
              if (props.api.isMaximized()) props.api.exitMaximized();
              else props.api.maximize();
            }}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {label}{" "}
          <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
            ⇧⌘M
          </kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Diff file count hook (polls every 15s)
// ---------------------------------------------------------------------------

function useDiffFileCount(workspaceId: string, isActive: boolean): number {
  // Track the same diff target (mode + compare branch) the user picked in the
  // Changes panel — without this, the badge always queried the default branch
  // and ignored Uncommitted / non-default branch selections (issue #396).
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiffSummary
        .query({
          workspaceId,
          diffMode,
          compareBranch: compareBranch ?? undefined,
        })
        .then((result) => {
          if (!cancelled) setCount(result.stats?.filesChanged ?? 0);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId, isActive, diffMode, compareBranch]);
  return count;
}

// ---------------------------------------------------------------------------
// Required panel definitions & layout persistence
// ---------------------------------------------------------------------------

/** All panels that must always be present in the layout. */
const REQUIRED_PANEL_IDS = ["projects", "chat", "changes", "files", "terminal", "browser"] as const;

/**
 * Panel ids that USED to be required and may live in saved layouts. We strip
 * them on layout restore so old localStorage entries don't break dockview
 * (which would throw when trying to instantiate a component that no longer
 * exists). Currently: the standalone "screencast" pane, which folded into
 * the Browser pane on web.
 */
const REMOVED_PANEL_IDS = ["screencast"] as const;

// ---------------------------------------------------------------------------
// Layout persistence: shared structure + per-workspace active tabs
// ---------------------------------------------------------------------------
//
// Structural layout (panel positions, sizes, tab order) is shared across
// ALL workspaces via a global key.  Active tab state (which tab is shown in
// each group) is stored per-workspace so that switching workspaces doesn't
// clobber the user's tab focus.

const GLOBAL_LAYOUT_KEY = "band:dockview-layout-v6";
const ACTIVE_STATE_KEY_PREFIX = "band:dockview-active:";

// Edge group ids — pinned to the four sides of the layout. Empty edge groups
// auto-collapse out of view; users drag panels onto a side to dock there.
const EDGE_GROUP_IDS = {
  left: "edge-left",
  right: "edge-right",
  bottom: "edge-bottom",
} as const;
type EdgeDirection = keyof typeof EDGE_GROUP_IDS;

/** Per-workspace active-tab state: which group is focused and which tab is
 *  shown in each tabbed group. */
interface ActiveTabState {
  activeGroup?: string;
  groups: Record<string, string>; // groupId → activeView panelId
}

// biome-ignore lint/suspicious/noExplicitAny: recursive grid JSON
function walkGridNode(node: any, callback: (leaf: any) => void): void {
  if (!node) return;
  if (node.type === "leaf") {
    callback(node);
  } else if (node.type === "branch" && Array.isArray(node.data)) {
    for (const child of node.data) {
      walkGridNode(child, callback);
    }
  }
}

/** Extract per-workspace active tab state from serialized layout. */
function extractActiveState(json: Record<string, unknown>): ActiveTabState {
  const state: ActiveTabState = { groups: {} };
  if (typeof json.activeGroup === "string") {
    state.activeGroup = json.activeGroup;
  }
  // dockview v5 uses "activePanel" at the top level (the active GROUP id)
  if (typeof json.activePanel === "string") {
    state.activeGroup = json.activePanel;
  }
  const grid = json.grid as Record<string, unknown> | undefined;
  if (grid?.root) {
    walkGridNode(grid.root, (leaf) => {
      const data = leaf.data;
      if (data?.id && data?.activeView) {
        state.groups[data.id] = data.activeView;
      }
    });
  }
  return state;
}

/** Apply per-workspace active tab state onto a layout JSON (mutates). */
function applyActiveState(json: Record<string, unknown>, state: ActiveTabState): void {
  if (state.activeGroup) {
    // dockview v5 uses "activePanel" for the focused group
    json.activePanel = state.activeGroup;
  }
  const grid = json.grid as Record<string, unknown> | undefined;
  if (grid?.root) {
    walkGridNode(grid.root, (leaf) => {
      const data = leaf.data;
      if (data?.id && state.groups[data.id]) {
        data.activeView = state.groups[data.id];
      }
    });
  }
}

/**
 * Recursively sort all object keys so that JSON.stringify produces a
 * deterministic output regardless of property insertion order.
 */
// biome-ignore lint/suspicious/noExplicitAny: recursive JSON normalizer
function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute a structural fingerprint of the layout that ignores active tab
 * state and container dimensions.  Two layouts with the same panels in the
 * same arrangement but different active tabs produce the same fingerprint.
 *
 * Keys are sorted before stringification so that property insertion order
 * differences (e.g. fromJSON() vs toJSON()) don't produce false positives.
 */
function getStructuralFingerprint(json: Record<string, unknown>): string {
  const clone = JSON.parse(JSON.stringify(json));
  // Strip active-tab state
  delete clone.activePanel;
  delete clone.activeGroup;
  const grid = clone.grid;
  if (grid) {
    delete grid.width;
    delete grid.height;
    walkGridNode(grid.root, (leaf) => {
      if (leaf.data) delete leaf.data.activeView;
    });
  }
  return JSON.stringify(sortKeys(clone));
}

/**
 * Strip runtime panel params (file paths, callbacks, workspaceId) from the
 * serialized layout so that the saved JSON only contains structural data
 * (panel positions, sizes, groups). Each workspace re-injects its own params
 * via injectParams() after restoring.
 */
function stripPanelParams(json: Record<string, unknown>): Record<string, unknown> {
  // JSON round-trip instead of structuredClone because api.toJSON() includes
  // panel params that may contain functions (callbacks injected via
  // injectParams). structuredClone throws DataCloneError on functions.
  const clone = JSON.parse(JSON.stringify(json));
  const panels = clone.panels as Record<string, Record<string, unknown>> | undefined;
  if (panels) {
    for (const panel of Object.values(panels)) {
      panel.params = {};
    }
  }
  return clone;
}

/**
 * Persist the current layout.
 * - Full layout (structure + active tabs) → global key (shared by all ws)
 * - Active tab state only → per-workspace key
 *
 * Returns true when the structural layout changed (panels moved, resized,
 * reordered) so the caller can decide whether to evict cached workspaces.
 */
function saveLayout(
  api: DockviewApi,
  workspaceId: string,
  lastStructureRef: React.MutableRefObject<string>,
): boolean {
  try {
    const json = stripPanelParams(api.toJSON() as unknown as Record<string, unknown>);

    // Always save active tab state per-workspace
    const activeState = extractActiveState(json);
    localStorage.setItem(`${ACTIVE_STATE_KEY_PREFIX}${workspaceId}`, JSON.stringify(activeState));

    // Always save full layout to the global key
    localStorage.setItem(GLOBAL_LAYOUT_KEY, JSON.stringify(json));

    // Detect structural changes (ignoring active tabs & container size)
    const fingerprint = getStructuralFingerprint(json);
    if (fingerprint !== lastStructureRef.current) {
      lastStructureRef.current = fingerprint;
      return true; // structural change
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Strip panel ids that no longer have a registered component (REMOVED_PANEL_IDS)
 * out of a saved layout JSON. dockview's `fromJSON` would otherwise throw
 * when it tries to instantiate the missing component for a stale id.
 *
 * Mutates `layout` in place. Specifically:
 *   - drops the entry from `layout.panels`
 *   - removes the id from each grid leaf's `data.views`
 *   - resets `data.activeView` to the first remaining view if it pointed at
 *     a removed id, or deletes it if the leaf is now empty
 */
function stripRemovedPanels(layout: Record<string, unknown>): void {
  const panels = layout.panels as Record<string, unknown> | undefined;
  if (panels) {
    for (const id of REMOVED_PANEL_IDS) {
      delete panels[id];
    }
  }
  const grid = layout.grid as Record<string, unknown> | undefined;
  if (grid?.root) {
    walkGridNode(grid.root, (leaf) => {
      const data = leaf.data as { views?: string[]; activeView?: string } | undefined;
      if (!data || !Array.isArray(data.views)) return;
      data.views = data.views.filter((v) => !(REMOVED_PANEL_IDS as readonly string[]).includes(v));
      if (data.activeView && (REMOVED_PANEL_IDS as readonly string[]).includes(data.activeView)) {
        data.activeView = data.views[0];
      }
    });
  }
}

/** Load layout: global structure + per-workspace active tabs merged. */
function loadLayout(workspaceId: string): unknown | null {
  try {
    const raw = localStorage.getItem(GLOBAL_LAYOUT_KEY);
    if (!raw) return null;
    const layout = JSON.parse(raw);

    // Strip panels whose components no longer exist (e.g. the standalone
    // screencast pane that folded into the Browser pane).
    stripRemovedPanels(layout);

    // Overlay this workspace's saved active tab state
    const activeRaw = localStorage.getItem(`${ACTIVE_STATE_KEY_PREFIX}${workspaceId}`);
    if (activeRaw) {
      const activeState: ActiveTabState = JSON.parse(activeRaw);
      applyActiveState(layout, activeState);
    }

    return layout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main DockviewWorkspaceLayout
// ---------------------------------------------------------------------------

interface DockviewWorkspaceLayoutProps {
  workspaceId: string;
  /** Called when the user makes a STRUCTURAL layout change (panel move,
   *  resize, tab reorder — NOT simple tab activation).  The instance
   *  manager uses this to evict hidden workspaces so they pick up the
   *  new layout when re-opened. */
  onLayoutChange?: () => void;
}

export const DockviewWorkspaceLayout = memo(function DockviewWorkspaceLayout({
  workspaceId,
  onLayoutChange,
}: DockviewWorkspaceLayoutProps) {
  // Subscribe to workspace visibility from the external store.
  // Only re-renders when this workspace's visibility actually changes —
  // no Context cascade to panel components.
  const isActive = useWsActive(workspaceId);

  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hidden panels from settings — used to gate panel operations
  const { settings } = useSettingsQuery();
  const hiddenPanels = useMemo(
    () =>
      ((settings as unknown as Record<string, unknown>).hiddenPanels as string[] | undefined) ?? [],
    [settings],
  );
  const hiddenPanelsRef = useRef(hiddenPanels);
  hiddenPanelsRef.current = hiddenPanels;

  // Ref so the onDidLayoutChange handler always sees the latest callback
  // without needing to re-subscribe.
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;

  // Suppress saves during initial layout setup (fromJSON / buildDefaultLayout
  // fire onDidLayoutChange events that are not user-initiated).
  const initializedRef = useRef(false);

  // Ref for injectParams so onReady doesn't need it as a dependency.
  // Without this, onReady would be recreated on every isActive / currentFile /
  // etc. change, causing dockview to dispose the onDidLayoutChange listener.
  const injectParamsRef = useRef<(api: DockviewApi) => void>(() => {});

  // Track active state via ref so the onDidLayoutChange handler can guard
  // against saves from non-active workspaces. When a workspace is evicted,
  // api.dispose() may fire layout events — without this guard the dying
  // instance would overwrite the good layout the active workspace just saved.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Structural fingerprint for detecting real layout changes (panel move,
  // resize, tab reorder) vs. simple tab activation changes.  Only
  // structural changes trigger eviction of hidden workspaces.
  const lastStructureRef = useRef("");

  // Cross-panel state
  const [currentFile, setCurrentFile] = useState<string | undefined>(undefined);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const diffFileCount = useDiffFileCount(workspaceId, isActive);

  // Mirror currentFile into a ref so the global keyboard handler — wired
  // once per workspace via useEffect and intentionally not re-subscribed on
  // every selection change — can read the latest value without a stale
  // closure. Used by the ⇧⌘F "Format Current File" branch.
  const currentFileRef = useRef<string | undefined>(undefined);
  currentFileRef.current = currentFile;

  // Dialog state
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [lastQuickOpenQuery, setLastQuickOpenQuery] = useState("");

  // Recent files tracking
  const { recentFiles, trackFile } = useRecentFiles(workspaceId);

  // Find-in-file: active panel registers its search callback here
  const findInFileRef = useRef<(() => void) | null>(null);
  const setFindInFile = useCallback((fn: (() => void) | null) => {
    findInFileRef.current = fn;
  }, []);

  // Diff stats (not displayed directly, but tracked for badge)
  const setDiffStats = useCallback((_stats: DiffStats | null) => {
    // Stats are used via the polling-based diffFileCount instead
  }, []);

  // Open file from Changes panel or dialogs → activate Files panel
  const handleOpenFile = useCallback(
    (filename: string) => {
      // Store clean path (without line refs) as currentFile so that
      // go-to-line (:N) in quick open works correctly.
      const cleanPath = parseFileLocation(filename).filePath;
      setCurrentFile(cleanPath);
      setOpenFilePath(filename);
      trackFile(cleanPath);
      const api = apiRef.current;
      if (api) {
        api.getPanel("files")?.api.setActive();
      }
    },
    [trackFile],
  );

  const handleFileOpened = useCallback(() => {
    setOpenFilePath(null);
  }, []);

  const handleSelectFile = useCallback(
    (filePath: string | null) => {
      setCurrentFile(filePath ?? undefined);
      if (filePath) trackFile(filePath);
    },
    [trackFile],
  );

  // Command palette: central command registry for Cmd+Shift+P
  const paletteCommands = useMemo(
    () =>
      buildCommands({
        getApi: () => apiRef.current,
        getHiddenPanels: () => hiddenPanelsRef.current,
        openQuickOpen: () => setQuickOpenOpen(true),
        openSearchFiles: () => setSearchFilesOpen(true),
        findInFile: () => {
          if (findInFileRef.current) {
            findInFileRef.current();
          } else {
            window.dispatchEvent(new CustomEvent("band:find-in-file"));
          }
        },
        formatCurrentFile: () => {
          // Always pass workspaceId so the matching FileViewer can filter
          // across multi-workspace layouts. `filePath` is optional — the
          // parent doesn't always know it (CodeBrowserView's initial-tab
          // restoration intentionally skips firing `onSelectFile`, so
          // `currentFileRef.current` can legitimately be `undefined` when
          // the user first triggers format). The FileViewer falls back
          // to its own `filePath` prop when detail.filePath is missing.
          const filePath = currentFileRef.current;
          window.dispatchEvent(
            new CustomEvent("band:format-current-file", {
              detail: { workspaceId, filePath },
            }),
          );
        },
      }),
    [workspaceId],
  );

  // Global keyboard shortcuts (capture phase) — only active for the visible workspace
  useEffect(() => {
    if (!isActive) return;

    const handler = (e: KeyboardEvent) => {
      // When the terminal (xterm) is focused, let most keyboard shortcuts
      // pass through so the shell receives them — e.g. Ctrl+R (reverse
      // search), Ctrl+C (SIGINT), Ctrl+D (EOF), Ctrl+L (clear),
      // Ctrl+A/E (line navigation), Ctrl+K (kill line), etc.
      // Only Meta/Cmd-based shortcuts (Cmd+P, Cmd+Shift+P, …) are still
      // handled at the app level when the terminal has focus.
      const terminalFocused = document.activeElement?.closest(".xterm") != null;

      // Note: Shift+Tab toggles Edit/Plan mode only when the chat input
      // (PromptInputTextarea) has focus — wired inside that component, not
      // globally. A global handler would hijack the standard "focus
      // previous element" Tab behaviour everywhere else (form fields,
      // dialogs, the command palette), which broke accessibility flows.

      // Ctrl+R (not Cmd+R) → workspace picker — skip when terminal focused
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "r" && !e.shiftKey) {
        if (terminalFocused) return;
        e.preventDefault();
        e.stopPropagation();
        setWorkspacePickerOpen(true);
        return;
      }

      // Ctrl+` (not Cmd+`) → Terminal panel. Handled here, ahead of the
      // mod gate, because we want to hijack even when xterm has focus
      // (otherwise the backtick would be typed into the shell). Matches
      // VS Code's "Toggle Terminal" binding.
      if (e.ctrlKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        e.stopPropagation();
        if (!hiddenPanelsRef.current.includes("terminal")) {
          apiRef.current?.getPanel("terminal")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-terminal"));
          });
        }
        return;
      }

      // Ctrl+0 (not Cmd+0) → focus Projects in the left edge group.
      // Matches VS Code's "Focus Side Bar" binding. Like ⌃`, handled in
      // an early branch so it hijacks even when xterm has focus.
      // Three-step flow: expand left edge if collapsed, activate the
      // projects panel, dispatch band:focus-projects on the next
      // microtask so DashboardShell's listener focuses [tabindex=-1]
      // after React commits the setActive change.
      if (e.ctrlKey && !e.metaKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        const dvApi = apiRef.current;
        if (!dvApi) return;
        const left = dvApi.groups.find((g) => g.id === EDGE_GROUP_IDS.left);
        if (left?.api.isCollapsed()) left.api.expand();
        dvApi.getPanel("projects")?.api.setActive();
        queueMicrotask(() => {
          window.dispatchEvent(new CustomEvent("band:focus-projects"));
        });
        return;
      }

      // Ctrl+Tab → next file tab
      if (e.key === "Tab" && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:next-file-tab"));
        return;
      }

      // Ctrl+Shift+Tab → previous file tab
      if (e.key === "Tab" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:prev-file-tab"));
        return;
      }

      // When terminal is focused, only handle Meta/Cmd-modified shortcuts.
      // All plain Ctrl+key combos pass through to the terminal.
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (terminalFocused && !e.metaKey) return;

      const api = apiRef.current;
      const key = e.key.toLowerCase();

      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:new-chat-session"));
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey) {
        // ⇧⌘F → Format Current File. Always include `workspaceId` so the
        // matching FileViewer can filter cross-workspace; `filePath` is
        // a best-effort hint — `currentFileRef.current` is `undefined`
        // for restored-but-never-switched-to tabs (see the palette
        // command for the longer explanation).
        e.preventDefault();
        const filePath = currentFileRef.current;
        window.dispatchEvent(
          new CustomEvent("band:format-current-file", {
            detail: { workspaceId, filePath },
          }),
        );
      } else if (key === "h" && e.shiftKey) {
        // ⇧⌘H → Search in Files (moved off ⇧⌘F to host the format binding
        // above). Mirrors VS Code's "Replace in Files".
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        if (findInFileRef.current) {
          findInFileRef.current();
        } else {
          window.dispatchEvent(new CustomEvent("band:find-in-file"));
        }
      } else if (key === "i" && e.ctrlKey && e.metaKey && api) {
        // ⌃⌘I → Chat (matches VS Code "Toggle Chat")
        // Both Ctrl AND Cmd held — distinguished from any plain ⌘I /
        // ⌃I combo (neither of which we currently bind).
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("chat")) {
          api.getPanel("chat")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-chat"));
          });
        }
      } else if (key === "g" && e.shiftKey && api) {
        // ⇧⌘G → Changes (matches VS Code "Show Source Control")
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("changes")) {
          api.getPanel("changes")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-changes"));
          });
        }
      } else if (key === "e" && e.shiftKey && api) {
        // ⇧⌘E → Files (matches VS Code "Show Explorer")
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("files")) {
          api.getPanel("files")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-files"));
          });
        }
      } else if (key === "b" && e.shiftKey && api) {
        // ⇧⌘B → Browser
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("browser")) {
          api.getPanel("browser")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-browser"));
          });
        }
      } else if (key === "b" && !e.shiftKey && api) {
        // ⌘B → toggle Projects sidebar (matches VS Code "Toggle Primary Side Bar")
        e.preventDefault();
        const left = api.groups.find((g) => g.id === EDGE_GROUP_IDS.left);
        if (left) {
          if (left.api.isCollapsed()) left.api.expand();
          else left.api.collapse();
        }
      } else if (key === "m" && e.shiftKey && api) {
        // Toggle maximize for the active group. Edge groups (Projects /
        // future right+bottom edges) are skipped — maximize only makes
        // sense for center grid groups. If a *different* group is already
        // maximized, exit that first so the user can never get stuck.
        e.preventDefault();
        const active = api.activeGroup;
        if (!active) return;
        if (active.api.location.type !== "grid") {
          if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
          return;
        }
        if (active.api.isMaximized()) active.api.exitMaximized();
        else active.api.maximize();
      }
      // Note: editor history navigation (band:editor-go-back / -forward) is
      // not bound to a keyboard shortcut. The previous binding was Cmd+- /
      // Cmd+Shift+-, but that key is permanently claimed by the desktop
      // View menu's Zoom Out accelerator (apps/desktop/src/main/menu.ts),
      // so the binding never fired. Workspace-level back/forward (Cmd+[ /
      // Cmd+]) is wired separately in useNavigationHistory; in-Files-tab
      // history can still be triggered from the back/forward arrow buttons
      // in the FileViewer toolbar or via the Command Palette.
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isActive, workspaceId]);

  // Listen for file link clicks from chat messages → open Quick Open with query
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail?.filename) {
        setQuickOpenQuery(detail.filename);
        setQuickOpenOpen(true);
      }
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [isActive]);

  // Window-event triggers for the file-tree toolbar's Quick Open / Search
  // in Files buttons. See workspace.$workspaceId.tsx for the rationale —
  // a window event is more reliable than threading the setters through
  // multiple layers of route-component context.
  useEffect(() => {
    if (!isActive) return;
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
    };
  }, [isActive]);

  // Listen for panel activation events from the title bar panel switcher
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId: string }>).detail?.panelId;
      if (panelId && apiRef.current && !hiddenPanelsRef.current.includes(panelId)) {
        apiRef.current.getPanel(panelId)?.api.setActive();
      }
    };
    window.addEventListener("band:activate-panel", handler);
    return () => window.removeEventListener("band:activate-panel", handler);
  }, [isActive]);

  // Wire callbacks into panels after layout restore (functions cannot be serialized).
  // Note: wsActive is handled by a separate effect below so that workspace
  // switches only re-render the 2 panels that care (chat, terminal), not all 4.
  const injectParams = useCallback(
    (api: DockviewApi) => {
      api.getPanel("chat")?.api.updateParameters({
        workspaceId,
      });
      api.getPanel("changes")?.api.updateParameters({
        workspaceId,
        onStatsChange: setDiffStats,
        onOpenFile: handleOpenFile,
        onFindInFile: setFindInFile,
        badge: diffFileCount,
      });
      api.getPanel("files")?.api.updateParameters({
        workspaceId,
        file: currentFile,
        openFilePath,
        onSelectFile: handleSelectFile,
        onFileOpened: handleFileOpened,
        onFindInFile: setFindInFile,
      });
      api.getPanel("terminal")?.api.updateParameters({
        workspaceId,
      });
      api.getPanel("browser")?.api.updateParameters({
        workspaceId,
      });
    },
    [
      workspaceId,
      currentFile,
      openFilePath,
      diffFileCount,
      setDiffStats,
      handleOpenFile,
      handleFileOpened,
      handleSelectFile,
      setFindInFile,
    ],
  );
  injectParamsRef.current = injectParams;

  // Add a single missing panel back into the layout at a sensible position
  const addMissingPanel = useCallback(
    (api: DockviewApi, panelId: string) => {
      // Guard: only add panels that have a registered component.
      // Without this check, dockview throws:
      //   "Only React.memo(...), React.ForwardRef(...) and functional
      //    components are accepted as components"
      if (!(panelId in components)) return;

      // Find any existing panel to anchor the new one relative to
      const anyExisting =
        api.getPanel("changes") ??
        api.getPanel("files") ??
        api.getPanel("terminal") ??
        api.getPanel("chat");

      const titleMap: Record<string, string> = {
        projects: "Projects",
        chat: "Chat",
        changes: "Changes",
        files: "Files",
        terminal: "Terminal",
        browser: "Browser",
      };

      const opts: Record<string, unknown> = {
        id: panelId,
        component: panelId,
        title: titleMap[panelId] ?? panelId,
        params: { workspaceId },
        inactive: true,
      };

      if (panelId === "changes") {
        opts.tabComponent = "badge";
      }

      // Projects has its own home in the left edge group — make sure that
      // edge exists, then dock the panel there.
      if (panelId === "projects") {
        try {
          if (!api.groups.some((g) => g.id === "edge-left")) {
            api.addEdgeGroup("left", { id: "edge-left" });
          }
        } catch {}
        opts.position = { referenceGroup: "edge-left", direction: "within" };
        // biome-ignore lint/suspicious/noExplicitAny: dynamic panel options
        api.addPanel(opts as any);
        return;
      }

      // Place chat to the left; everything else as a tab alongside an existing panel
      if (panelId === "chat" && anyExisting) {
        opts.position = { referencePanel: anyExisting.id, direction: "left" };
      } else if (anyExisting) {
        opts.position = { referencePanel: anyExisting.id, direction: "within" };
      }

      // biome-ignore lint/suspicious/noExplicitAny: dynamic panel options
      api.addPanel(opts as any);
    },
    [workspaceId],
  );

  // Build the default layout from scratch
  const buildDefaultLayout = useCallback(
    (api: DockviewApi) => {
      const hidden = hiddenPanelsRef.current;

      // Center panels first. Chat is the very first panel — without it,
      // every later addPanel that references chat would have no anchor,
      // and dockview's `addPanel` without an explicit position falls back
      // to `referenceGroup = activeGroup, target = 'within'`, so creating
      // the left edge group + projects up front would make `edge-left`
      // the active group and pull every subsequent center panel into it.
      // Edge group + projects panel are added at the end (see below) once
      // the center is built.
      api.addPanel({
        id: "chat",
        component: "chat",
        title: "Chat",
        params: { workspaceId },
      });

      // Track which panel to use as a reference for "within" positioning
      let rightGroupRef: string | null = null;

      if (!hidden.includes("changes")) {
        api.addPanel({
          id: "changes",
          component: "changes",
          tabComponent: "badge",
          title: "Changes",
          params: { workspaceId },
          position: { referencePanel: "chat", direction: "right" },
        });
        rightGroupRef = "changes";
      }

      if (!hidden.includes("files")) {
        if (rightGroupRef) {
          api.addPanel({
            id: "files",
            component: "files",
            title: "Files",
            params: { workspaceId },
            position: { referencePanel: rightGroupRef, direction: "within" },
            inactive: true,
          });
        } else {
          api.addPanel({
            id: "files",
            component: "files",
            title: "Files",
            params: { workspaceId },
            position: { referencePanel: "chat", direction: "right" },
          });
          rightGroupRef = "files";
        }
      }

      if (!hidden.includes("terminal")) {
        if (rightGroupRef) {
          api.addPanel({
            id: "terminal",
            component: "terminal",
            title: "Terminal",
            params: { workspaceId },
            position: { referencePanel: rightGroupRef, direction: "within" },
            inactive: true,
          });
        } else {
          api.addPanel({
            id: "terminal",
            component: "terminal",
            title: "Terminal",
            params: { workspaceId },
            position: { referencePanel: "chat", direction: "right" },
          });
          rightGroupRef = "terminal";
        }
      }

      if (!hidden.includes("browser")) {
        if (rightGroupRef) {
          api.addPanel({
            id: "browser",
            component: "browser",
            title: "Browser",
            params: { workspaceId },
            position: { referencePanel: rightGroupRef, direction: "within" },
            inactive: true,
          });
        } else {
          api.addPanel({
            id: "browser",
            component: "browser",
            title: "Browser",
            params: { workspaceId },
            position: { referencePanel: "chat", direction: "right" },
          });
        }
      }

      // Set chat panel to ~50% width
      try {
        api.getPanel("chat")?.api.setSize({ width: api.width * 0.5 });
      } catch {}

      // Now that the center grid is built, drop projects into the left
      // edge group as its default home. The edge starts expanded
      // (no `collapsed` option) so projects is visible at first paint;
      // empty right/bottom edges added later in onReady stay collapsed.
      // initialSize matches SIDEBAR_MIN_SIZE ("15rem" = 240px) from
      // apps/web/src/lib/sidebar-width.ts — the historical min width of
      // the project list panel — so the project list opens with a
      // legible width on first load instead of dockview's default 200px.
      // addEdgeGroup is idempotent here via the existence guard —
      // onReady's edge-group sweep below also ensures left/right/bottom
      // exist (so this just gets us the slot for projects to dock into).
      try {
        if (!api.groups.some((g) => g.id === "edge-left")) {
          api.addEdgeGroup("left", { id: "edge-left", initialSize: 240 });
        }
      } catch {}
      api.addPanel({
        id: "projects",
        component: "projects",
        title: "Projects",
        params: { workspaceId },
        position: { referenceGroup: "edge-left", direction: "within" },
      });
    },
    [workspaceId],
  );

  // onReady: restore or create default layout, then heal missing panels
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is constant for the lifetime of this component instance — one DockviewWorkspaceLayout per workspace. Including it would cause dockview to re-init on workspace ID change, which never happens.
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Drop orphaned keys from the old custom-collapse system (replaced by
      // dockview's built-in edge groups). Harmless if they're already absent.
      try {
        localStorage.removeItem("band:collapsed-groups");
        localStorage.removeItem("band:group-expanded-widths");
      } catch {}

      // Try to restore a saved layout
      let restored = false;
      const saved = loadLayout(workspaceId);
      if (saved) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: localStorage JSON shape
          event.api.fromJSON(saved as any);
          restored = true;
        } catch {
          // Corrupted layout — fall through to default
        }
      }

      if (!restored) {
        buildDefaultLayout(event.api);
      }

      // Self-heal: re-add any panels that are missing from the restored layout
      // (skip panels that are intentionally hidden by the user)
      for (const id of REQUIRED_PANEL_IDS) {
        if (!event.api.getPanel(id) && !hiddenPanelsRef.current.includes(id)) {
          addMissingPanel(event.api, id);
        }
      }

      // Remove panels that should be hidden (e.g. layout was saved before they were hidden)
      for (const id of hiddenPanelsRef.current) {
        const panel = event.api.getPanel(id);
        if (panel) {
          event.api.removePanel(panel);
        }
      }

      // Drop the legacy top edge group if it was persisted by an earlier
      // build of this branch — there's no panel that wants to dock there
      // and an always-present empty top strip eats vertical space.
      try {
        if (event.api.getEdgeGroup("top")) event.api.removeEdgeGroup("top");
      } catch {}

      // Ensure left / right / bottom edge groups exist as drop targets.
      // Done AFTER buildDefaultLayout intentionally — addPanel without an
      // explicit position falls back to `referenceGroup = activeGroup` plus
      // `target = 'within'`. If we pre-created edge groups and then projects
      // landed in edge-left (making it the active group), the next
      // chat/changes/etc would all stack into edge-left. By adding edges
      // last, the default layout builds in a clean grid and panels keep
      // their intended positions.
      // addEdgeGroup is not idempotent — id check guards re-runs after
      // fromJSON which auto-creates edge groups it sees in saved JSON.
      for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
        const id = EDGE_GROUP_IDS[direction];
        if (!event.api.groups.some((g) => g.id === id)) {
          try {
            event.api.addEdgeGroup(direction, { id, collapsed: true });
          } catch {}
        }
      }

      // Hide empty edge groups so the resting layout shows no edge strips
      // at all. The drag-visibility effect below toggles them back on while
      // a panel/group is being dragged so the user has somewhere to drop.
      for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
        const id = EDGE_GROUP_IDS[direction];
        try {
          const group = event.api.groups.find((g) => g.id === id);
          event.api.setEdgeGroupVisible(direction, !!group && group.panels.length > 0);
        } catch {}
      }

      // After restore, inject live callback references
      // (setTimeout ensures fromJSON completes rendering)
      setTimeout(() => injectParamsRef.current(event.api), 0);

      // Guard: if a required panel is removed (edge-case drag, API call, etc.)
      // re-add it immediately so it can't be lost.
      // Note: DockviewReact ignores onReady's return value, so cleanup is
      // handled by api.dispose() when the component unmounts — no need to
      // store the disposable.
      event.api.onDidRemovePanel((panel) => {
        const id = panel.id;
        if (
          (REQUIRED_PANEL_IDS as readonly string[]).includes(id) &&
          !hiddenPanelsRef.current.includes(id)
        ) {
          // Re-add on next tick so dockview finishes its removal first
          setTimeout(() => {
            if (!event.api.getPanel(id) && !hiddenPanelsRef.current.includes(id)) {
              addMissingPanel(event.api, id);
              injectParamsRef.current(event.api);
            }
          }, 0);
        }
      });

      // Initialize the structural fingerprint from the just-loaded layout
      // so the first real structural change can be detected.
      {
        const initJson = stripPanelParams(event.api.toJSON() as unknown as Record<string, unknown>);
        lastStructureRef.current = getStructuralFingerprint(initJson);
      }

      // Persist layout on changes and notify the instance manager.
      // The subscription is created AFTER fromJSON / buildDefaultLayout, so
      // their synchronous onDidLayoutChange events are never captured.
      // The initializedRef guard is a safety net for any edge-case async
      // layout events during setup.
      event.api.onDidLayoutChange(() => {
        if (!initializedRef.current) return;
        if (!isActiveRef.current) return;

        // saveLayout writes:
        //  - full layout → global key (shared structure)
        //  - active tab state → per-workspace key
        // It returns true when the STRUCTURAL layout changed (panels
        // moved, resized, or reordered) — NOT for simple tab clicks.
        const structureChanged = saveLayout(event.api, workspaceId, lastStructureRef);

        if (structureChanged) {
          onLayoutChangeRef.current?.();
        }
      });

      initializedRef.current = true;
    },
    [buildDefaultLayout, addMissingPanel],
  );

  // Re-inject params when callbacks/state change (badge count, file
  // state, and all callback references in one pass).
  useEffect(() => {
    const api = apiRef.current;
    if (api) injectParams(api);
  }, [injectParams]);

  // wsActive is propagated via an external store (useWsActive) — panel
  // components subscribe directly, avoiding React Context cascade re-renders.

  // React to hiddenPanels changes: remove newly-hidden panels, add newly-shown ones
  const prevHiddenRef = useRef<string[]>(hiddenPanels);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const prev = prevHiddenRef.current;
    prevHiddenRef.current = hiddenPanels;

    // Panels that were just hidden (not in prev, now in hiddenPanels)
    const nowHidden = hiddenPanels.filter((id) => !prev.includes(id));
    // Panels that were just shown (in prev, not in hiddenPanels)
    const nowShown = prev.filter((id) => !hiddenPanels.includes(id));

    for (const id of nowHidden) {
      const panel = api.getPanel(id);
      if (panel) {
        api.removePanel(panel);
      }
    }

    for (const id of nowShown) {
      if (!api.getPanel(id)) {
        addMissingPanel(api, id);
        injectParamsRef.current(api);
      }
    }
  }, [hiddenPanels, addMissingPanel]);

  // Recalculate dockview layout after becoming visible, but only if the
  // container actually resized (e.g. a window resize while this workspace
  // was hidden).  With visibility:hidden the container keeps its dimensions,
  // so most workspace switches skip this entirely — no reflow, no flash.
  useEffect(() => {
    if (!isActive || !apiRef.current || !containerRef.current) return;
    const api = apiRef.current;
    const el = containerRef.current;
    requestAnimationFrame(() => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth !== api.width || clientHeight !== api.height) {
        api.layout(clientWidth, clientHeight);
      }
    });
  }, [isActive]);

  // Show empty edge groups only while a panel/group drag is in progress.
  // Resting state: empty edges are hidden so they don't take up space.
  // During drag: empty edges become visible drop targets. Edges with
  // panels are always visible regardless of drag state.
  // Gate on isActive so only the foreground workspace responds to drags.
  useEffect(() => {
    if (!isActive) return;
    const api = apiRef.current;
    if (!api) return;

    let isDragging = false;

    const refresh = () => {
      for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
        const id = EDGE_GROUP_IDS[direction];
        const group = api.groups.find((g) => g.id === id);
        if (!group) continue;
        const isEmpty = group.panels.length === 0;
        try {
          api.setEdgeGroupVisible(direction, isDragging || !isEmpty);
        } catch {}
      }
    };

    const startDrag = () => {
      isDragging = true;
      refresh();
    };
    const endDrag = () => {
      isDragging = false;
      refresh();
    };

    // Establish the resting state on activation.
    refresh();

    // Drag start — show all empty edges as drop targets.
    const d1 = api.onWillDragPanel(startDrag);
    const d2 = api.onWillDragGroup(startDrag);

    // Drag end — needs multiple signals because HTML5 `dragend` does not
    // dispatch when the drag source element is removed from the DOM during
    // drop handling, which is exactly what dockview does for inter-group
    // moves. Coverage:
    //  - onDidMovePanel:   panel moved between groups (success drop into edge / center)
    //  - onDidRemovePanel: source group lost a panel (panel pulled out of an edge)
    //  - document `drop` in capture phase: any drop, fires before source removal
    //  - document `dragend`: cancel cases (no panel moved, source still in DOM)
    const d3 = api.onDidMovePanel(endDrag);
    const d4 = api.onDidRemovePanel(endDrag);

    const onDragEndNative = () => endDrag();
    document.addEventListener("drop", onDragEndNative, true);
    document.addEventListener("dragend", onDragEndNative, true);

    return () => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
      d4.dispose();
      document.removeEventListener("drop", onDragEndNative, true);
      document.removeEventListener("dragend", onDragEndNative, true);
    };
  }, [isActive]);

  // Hide all browser webviews when a dialog is open (z-ordering: native
  // webviews render on top of the React DOM, so they would cover dialogs).
  // With multi-tab browsers, we hide/show ALL webviews for this workspace.
  // Also reacts to global toolbar dialogs (Tasks, Cronjobs, Tunnel, Prereq).
  const toolbarDialogOpen = useAnyToolbarDialogOpen();
  useEffect(() => {
    if (!isDesktop) return;
    const isDialogOpen =
      quickOpenOpen ||
      searchFilesOpen ||
      workspacePickerOpen ||
      commandPaletteOpen ||
      toolbarDialogOpen;

    if (isDialogOpen) {
      desktopInvoke("browser_hide_all_for_workspace", { workspaceId }).catch(() => {});
    } else {
      // Only re-show if the browser panel is currently active
      const browserPanel = apiRef.current?.getPanel("browser");
      if (browserPanel?.api.isActive) {
        desktopInvoke("browser_show_all_for_workspace", { workspaceId }).catch(() => {});
      }
    }
  }, [
    quickOpenOpen,
    searchFilesOpen,
    workspacePickerOpen,
    commandPaletteOpen,
    toolbarDialogOpen,
    workspaceId,
  ]);

  return (
    <>
      <div ref={containerRef} className="h-full">
        <DockviewReact
          theme={bandTheme}
          className="h-full"
          components={components}
          tabComponents={tabComponents}
          defaultTabComponent={DefaultTab}
          rightHeaderActionsComponent={MainGroupRightActions}
          onReady={onReady}
        />
      </div>

      <QuickOpenDialog
        workspaceId={workspaceId}
        open={quickOpenOpen}
        onOpenChange={(open) => {
          setQuickOpenOpen(open);
          if (!open) setQuickOpenQuery(undefined);
        }}
        onOpenFile={handleOpenFile}
        currentFile={currentFile}
        initialQuery={quickOpenQuery}
        autoOpen={quickOpenQuery != null}
        recentFiles={recentFiles}
        lastQuery={lastQuickOpenQuery}
        onQueryChange={setLastQuickOpenQuery}
      />
      <SearchFilesDialog
        workspaceId={workspaceId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
      <WorkspacePickerDialog open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen} />
      <CommandPaletteDialog
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={paletteCommands}
      />
    </>
  );
});
