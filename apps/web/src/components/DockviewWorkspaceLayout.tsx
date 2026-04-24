import {
  type DiffStats,
  DiffView,
  parseFileLocation,
  QuickOpenDialog,
  SearchFilesDialog,
  useSettingsQuery,
} from "@band-app/dashboard-core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import {
  FolderOpen,
  GitCompare,
  Globe,
  MessageSquare,
  Terminal as TerminalIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import { trpc } from "../lib/trpc-client";
import { CodeBrowserView } from "./CodeBrowserView";
import { DockviewChatContainer } from "./DockviewChatContainer";

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
  chat: MessageSquare,
  changes: GitCompare,
  files: FolderOpen,
  terminal: TerminalIcon,
  ...(isTauri ? { browser: Globe } : {}),
};

const PANEL_SHORTCUTS: Record<string, string> = {
  changes: "⌘E",
  files: "⌘G",
  terminal: "⌘J",
  ...(isTauri ? { browser: "⌘B" } : {}),
};

// ---------------------------------------------------------------------------
// Lazy-loaded split terminal container (avoid importing @xterm CJS during SSR)
// ---------------------------------------------------------------------------

const SplitTerminalContainer = lazy(() =>
  import("./SplitTerminalContainer").then((m) => ({ default: m.SplitTerminalContainer })),
);

// Lazy-load browser panel so the Tauri webview code is never bundled for web
const LazyBrowserPanel = isTauri
  ? lazy(() => import("./BrowserPanel").then((m) => ({ default: m.BrowserPanelComponent })))
  : null;

// ---------------------------------------------------------------------------
// Panel params types
// ---------------------------------------------------------------------------

interface ChatParams {
  workspaceId: string;
  wsActive?: boolean;
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
  onQuickOpen: () => void;
  onSearchFiles: () => void;
}

interface TerminalParams {
  workspaceId: string;
  wsActive?: boolean;
}

// ---------------------------------------------------------------------------
// Panel wrapper components
// ---------------------------------------------------------------------------

function ChatPanelComponent({ params, api }: IDockviewPanelProps<ChatParams>) {
  // Track physical visibility (not focus/active state).
  // In a split layout, the Chat panel remains visible when another panel
  // (Changes, Files, Terminal) is focused.  `isVisible` is only false when
  // the panel is behind another tab in a tabbed group.
  const [isVisible, setIsVisible] = useState(api.isVisible);

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = params.wsActive !== false && isVisible;
  // Workspace is active (but the chat tab may not be the focused tab).
  // Used by PromptInput to accept "Add to Chat" events from sibling panels
  // (e.g. Changes, Files) even when the Chat tab isn't in front.
  const wsActive = params.wsActive !== false;

  // Don't render until workspaceId is injected — during layout sync fromJSON
  // recreates panels with empty params before injectParams runs a tick later.
  // Rendering with undefined workspaceId would cause draft/session state issues.
  if (!params.workspaceId) return null;

  return (
    <DockviewChatContainer workspaceId={params.workspaceId} visible={visible} wsActive={wsActive} />
  );
}

function ChangesPanelComponent({ params }: IDockviewPanelProps<ChangesParams>) {
  if (!params.workspaceId) return null;
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
  if (!params.workspaceId) return null;
  return (
    <CodeBrowserView
      workspaceId={params.workspaceId}
      file={params.file}
      onSelectFile={params.onSelectFile}
      openFilePath={params.openFilePath}
      onFileOpened={params.onFileOpened}
      onFindInFile={params.onFindInFile}
      onQuickOpen={params.onQuickOpen}
      onSearchFiles={params.onSearchFiles}
    />
  );
}

function TerminalPanelComponent({ params, api }: IDockviewPanelProps<TerminalParams>) {
  // Track physical visibility — same approach as ChatPanelComponent.
  const [isVisible, setIsVisible] = useState(api.isVisible);

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = params.wsActive !== false && isVisible;

  if (!params.workspaceId) return null;

  return (
    <Suspense fallback={null}>
      <SplitTerminalContainer workspaceId={params.workspaceId} visible={visible} />
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
        {Icon && <Icon className="size-4 shrink-0" />}
        <span>{title}</span>
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

  const tab = (
    <div className="dv-default-tab">
      <div
        className="dv-default-tab-content"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {Icon && <Icon className="size-4 shrink-0" />}
        <span>{title}</span>
        {badge != null && badge > 0 && (
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
// Component and tab registries
// ---------------------------------------------------------------------------

// Wrap the lazy-loaded browser panel in Suspense so it can be registered
// as a regular dockview component.
// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
function BrowserPanelWrapper(props: IDockviewPanelProps<any>) {
  if (!LazyBrowserPanel) return null;
  return (
    <Suspense fallback={null}>
      <LazyBrowserPanel {...props} />
    </Suspense>
  );
}

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  chat: ChatPanelComponent,
  changes: ChangesPanelComponent,
  files: FilesPanelComponent,
  terminal: TerminalPanelComponent,
  ...(isTauri ? { browser: BrowserPanelWrapper } : {}),
};

const tabComponents: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>> = {
  badge: BadgeTab,
};

// ---------------------------------------------------------------------------
// Diff file count hook (polls every 15s)
// ---------------------------------------------------------------------------

function useDiffFileCount(workspaceId: string, isActive: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiffSummary
        .query({ workspaceId })
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
  }, [workspaceId, isActive]);
  return count;
}

// ---------------------------------------------------------------------------
// Required panel definitions & layout persistence
// ---------------------------------------------------------------------------

/** All panels that must always be present in the layout.
 *  The browser panel is only available in the Tauri desktop app. */
const REQUIRED_PANEL_IDS = isTauri
  ? (["chat", "changes", "files", "terminal", "browser"] as const)
  : (["chat", "changes", "files", "terminal"] as const);

// ---------------------------------------------------------------------------
// Layout persistence: shared structure + per-workspace active tabs
// ---------------------------------------------------------------------------
//
// Structural layout (panel positions, sizes, tab order) is shared across
// ALL workspaces via a global key.  Active tab state (which tab is shown in
// each group) is stored per-workspace so that switching workspaces doesn't
// clobber the user's tab focus.

const GLOBAL_LAYOUT_KEY = "band:dockview-layout";
const ACTIVE_STATE_KEY_PREFIX = "band:dockview-active:";

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

/** Load layout: global structure + per-workspace active tabs merged. */
function loadLayout(workspaceId: string): unknown | null {
  try {
    const raw = localStorage.getItem(GLOBAL_LAYOUT_KEY);
    if (!raw) return null;
    const layout = JSON.parse(raw);

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
  isActive: boolean;
  /** Called when the user makes a STRUCTURAL layout change (panel move,
   *  resize, tab reorder — NOT simple tab activation).  The instance
   *  manager uses this to evict hidden workspaces so they pick up the
   *  new layout when re-opened. */
  onLayoutChange?: () => void;
}

export const DockviewWorkspaceLayout = memo(function DockviewWorkspaceLayout({
  workspaceId,
  isActive,
  onLayoutChange,
}: DockviewWorkspaceLayoutProps) {
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

  // Dialog state
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);

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
  const handleOpenFile = useCallback((filename: string) => {
    // Store clean path (without line refs) as currentFile so that
    // go-to-line (:N) in quick open works correctly.
    const cleanPath = parseFileLocation(filename).filePath;
    setCurrentFile(cleanPath);
    setOpenFilePath(filename);
    const api = apiRef.current;
    if (api) {
      api.getPanel("files")?.api.setActive();
    }
  }, []);

  const handleFileOpened = useCallback(() => {
    setOpenFilePath(null);
  }, []);

  const handleSelectFile = useCallback((filePath: string | null) => {
    setCurrentFile(filePath ?? undefined);
  }, []);

  // Global keyboard shortcuts (capture phase) — only active for the visible workspace
  useEffect(() => {
    if (!isActive) return;

    const handler = (e: KeyboardEvent) => {
      // Shift+Tab → toggle mode (Edit/Plan)
      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:toggle-mode"));
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const api = apiRef.current;
      const key = e.key.toLowerCase();

      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        if (findInFileRef.current) {
          findInFileRef.current();
        } else {
          window.dispatchEvent(new CustomEvent("band:find-in-file"));
        }
      } else if (key === "e" && !e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("changes")) api.getPanel("changes")?.api.setActive();
      } else if (key === "j" && !e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("terminal"))
          api.getPanel("terminal")?.api.setActive();
      } else if (key === "g" && !e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("files")) api.getPanel("files")?.api.setActive();
      } else if (key === "b" && !e.shiftKey && api && isTauri) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("browser")) api.getPanel("browser")?.api.setActive();
      } else if (key === "-") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:editor-go-back"));
      } else if (key === "_") {
        // Ctrl+Shift+- produces key="_" (underscore) in the browser
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:editor-go-forward"));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isActive]);

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
        onQuickOpen: () => setQuickOpenOpen(true),
        onSearchFiles: () => setSearchFilesOpen(true),
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

      if (isTauri && !hidden.includes("browser")) {
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
    },
    [workspaceId],
  );

  // onReady: restore or create default layout, then heal missing panels
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is constant for the lifetime of this component instance — one DockviewWorkspaceLayout per workspace. Including it would cause dockview to re-init on workspace ID change, which never happens.
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

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

  // Propagate workspace active state only to panels that use it (chat,
  // terminal, browser).  Kept separate from injectParams so that a workspace
  // switch doesn't trigger updateParameters on all panels — changes and files
  // don't care about wsActive and would re-render for nothing.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.getPanel("chat")?.api.updateParameters({ wsActive: isActive });
    api.getPanel("terminal")?.api.updateParameters({ wsActive: isActive });
    api.getPanel("browser")?.api.updateParameters({ wsActive: isActive });
  }, [isActive]);

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

  // Hide the browser webview when a dialog is open (z-ordering: native webview
  // renders on top of the React DOM, so it would cover the dialog otherwise).
  useEffect(() => {
    if (!isTauri) return;
    const isDialogOpen = quickOpenOpen || searchFilesOpen;

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      if (isDialogOpen) {
        invoke("browser_hide", { workspaceId }).catch(() => {});
      } else {
        // Only re-show if the browser panel is currently active
        const browserPanel = apiRef.current?.getPanel("browser");
        if (browserPanel?.api.isActive) {
          invoke("browser_show", { workspaceId }).catch(() => {});
        }
      }
    })();
  }, [quickOpenOpen, searchFilesOpen, workspaceId]);

  return (
    <>
      <div ref={containerRef} className="h-full">
        <DockviewReact
          theme={bandTheme}
          className="h-full"
          components={components}
          tabComponents={tabComponents}
          defaultTabComponent={DefaultTab}
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
      />
      <SearchFilesDialog
        workspaceId={workspaceId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
    </>
  );
});
