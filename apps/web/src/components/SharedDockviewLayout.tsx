import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { useRouterState } from "@tanstack/react-router";
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
import {
  buildCommands,
  CommandPaletteDialog,
  DashboardShell,
  DiffView,
  parseFileLocation,
  QuickOpenDialog,
  recordWorkspaceAccess,
  SearchFilesDialog,
  useDiffTarget,
  useSettingsQuery,
  WorkspacePickerDialog,
} from "@/dashboard";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import {
  type ActiveTabState,
  applyActiveState,
  applyMaximizedGroupToApi,
  extractActiveState,
  walkGridNode,
} from "../lib/dockview-active-state";
import { isDesktop } from "../lib/is-desktop";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { trpc } from "../lib/trpc-client";
import { CodeBrowserView } from "./CodeBrowserView";
import { DockviewChatContainer } from "./DockviewChatContainer";
import { MultiWorkspacePanelHost } from "./MultiWorkspacePanelHost";
import {
  getPerWorkspaceState,
  setPerWorkspaceState,
  subscribePerWorkspaceState,
  usePerWorkspaceState,
} from "./per-workspace-state-store";
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
// Lazy-loaded dockview inner containers
// ---------------------------------------------------------------------------
// Terminal: avoid importing @xterm (CJS) during SSR.
// Browser: avoid running BrowserPaneComponent's `useLayoutEffect`s during
// TanStack Start's SSR pass (React emits "useLayoutEffect does nothing on
// the server" warnings for any layout effect that gets rendered into the
// streaming output). Lazy-wrapping defers the whole subtree until the
// client takes over, which matches the Terminal pattern and keeps the
// SSR transcript clean.

const DockviewTerminalContainer = lazy(() =>
  import("./DockviewTerminalContainer").then((m) => ({
    default: m.DockviewTerminalContainer,
  })),
);

const DockviewBrowserContainer = lazy(() =>
  import("./DockviewBrowserContainer").then((m) => ({
    default: m.DockviewBrowserContainer,
  })),
);

// ---------------------------------------------------------------------------
// Per-panel cross-workspace context
// ---------------------------------------------------------------------------
//
// Cross-panel state (currentFile, openFilePath, find-in-file registration) is
// per-workspace but read/written by panels that live inside the SHARED
// dockview. The dockview's own params system can't carry this state because
// the host renders one child per CACHED workspace, not per dockview panel.
// We use module-level handlers wired by SharedDockviewLayout's effects.
// ---------------------------------------------------------------------------

interface CrossPanelHandlers {
  /** Called when the Changes panel asks us to open a file in Files. */
  onOpenFile: (workspaceId: string, filename: string) => void;
  /** Called when the Files panel reports the active file changed. */
  onSelectFile: (workspaceId: string, filePath: string | null) => void;
  /** Called when the Files panel finishes opening the requested file. */
  onFileOpened: (workspaceId: string) => void;
  /** Called by a panel to register/unregister its find-in-file callback. */
  onFindInFile: (workspaceId: string, fn: (() => void) | null) => void;
  /**
   * Bring the Files panel to the foreground without touching its
   * current-file state. Used by the `band open <external-file>` flow:
   * the external path is queued via `lib/pending-external-open.ts`
   * and the `CodeBrowserView` mounted inside the Files panel drains
   * it, but the panel itself still needs to be `setActive()`'d so
   * the user actually *sees* the new tab. Guarded on
   * active-workspace so a CLI call targeting a non-visible workspace
   * doesn't hijack the panel switcher.
   */
  onActivateFilesPanel: (workspaceId: string) => void;
}

// Mutable module-level handlers — SharedDockviewLayout writes them on every
// render so per-workspace callbacks always reference the latest closure
// without re-rendering every cached panel child. Exported so non-dockview
// call sites (e.g. the SSE listener in `__root.tsx`) can drive the dockview
// without owning a dockview API reference.
export const crossPanelHandlers: CrossPanelHandlers = {
  onOpenFile: () => {},
  onSelectFile: () => {},
  onFileOpened: () => {},
  onFindInFile: () => {},
  onActivateFilesPanel: () => {},
};

// ---------------------------------------------------------------------------
// Panel wrapper components
// ---------------------------------------------------------------------------

/** Empty-state shown by every workspace-scoped panel when no workspace is
 *  selected (index route). */
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
  // With the shared layout, only ONE DashboardShell is mounted (one project
  // list), so its useStatusWatcher / useBranchStatusWatcher /
  // useSetupStatusWatcher subscriptions run exactly once.
  // hideMenu suppresses the in-shell hamburger overflow menu — the global
  // DesktopTitleBar in __root.tsx already exposes the same Tasks / Cronjobs
  // / Settings entries via its own dropdown.
  return <DashboardShell hideTitleBar={isDesktop} hideMenu />;
}

function ChatPanelComponent({ api }: IDockviewPanelProps) {
  // Track physical visibility (not focus/active state).
  // In a split layout, the Chat panel remains visible when another panel
  // (Changes, Files, Terminal) is focused. `isVisible` is only false when
  // the panel is behind another tab in a tabbed group, or when its edge
  // group is collapsed (dockview reports !isVisible in both cases).
  const [isVisible, setIsVisible] = useState(api.isVisible);

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  return (
    <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage Icon={MessageSquare} />}>
      {(workspaceId, wsActive) => (
        <DockviewChatContainer
          workspaceId={workspaceId}
          visible={isVisible && wsActive}
          wsActive={wsActive}
        />
      )}
    </MultiWorkspacePanelHost>
  );
}

function ChangesPanelComponent(_props: IDockviewPanelProps) {
  return (
    <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage Icon={GitCompare} />}>
      {(workspaceId, wsActive) => (
        <DiffView
          workspaceId={workspaceId}
          active={wsActive}
          onOpenFile={(filename) => crossPanelHandlers.onOpenFile(workspaceId, filename)}
          onFindInFile={(fn) => crossPanelHandlers.onFindInFile(workspaceId, fn)}
        />
      )}
    </MultiWorkspacePanelHost>
  );
}

function FilesPanelComponent(_props: IDockviewPanelProps) {
  return (
    <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage Icon={FolderOpen} />}>
      {(workspaceId, _wsActive) => <FilesPanelChild workspaceId={workspaceId} />}
    </MultiWorkspacePanelHost>
  );
}

/** Reads per-workspace cross-panel state for the Files panel child. */
function FilesPanelChild({ workspaceId }: { workspaceId: string }) {
  const state = usePerWorkspaceState(workspaceId);
  return (
    <CodeBrowserView
      workspaceId={workspaceId}
      file={state.currentFile}
      openFilePath={state.openFilePath}
      onSelectFile={(filePath) => crossPanelHandlers.onSelectFile(workspaceId, filePath)}
      onFileOpened={() => crossPanelHandlers.onFileOpened(workspaceId)}
      onFindInFile={(fn) => crossPanelHandlers.onFindInFile(workspaceId, fn)}
    />
  );
}

function TerminalPanelComponent({ api }: IDockviewPanelProps) {
  const [isVisible, setIsVisible] = useState(api.isVisible);

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  return (
    <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage Icon={TerminalIcon} />}>
      {(workspaceId, wsActive) => (
        <Suspense fallback={null}>
          <DockviewTerminalContainer
            workspaceId={workspaceId}
            visible={isVisible && wsActive}
            wsActive={wsActive}
          />
        </Suspense>
      )}
    </MultiWorkspacePanelHost>
  );
}

function BrowserPanelComponent({ api }: IDockviewPanelProps) {
  const [isVisible, setIsVisible] = useState(api.isVisible);
  const { settings } = useSettingsQuery();
  const cdpEnabled = (settings as { webBrowserCdpEnabled?: boolean }).webBrowserCdpEnabled ?? false;

  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setIsVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  return (
    <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage Icon={Globe} />}>
      {(workspaceId, wsActive) => {
        const visible = isVisible && wsActive;
        // On the web build the native webview path doesn't exist (no Electron
        // IPC). Two render modes depending on the CDP screencast experiment
        // flag (Settings → Browser → "Stream desktop tabs to web"):
        //   - enabled: surface the desktop app's browser tabs as a CDP
        //     screencast picker.
        //   - disabled (default): show the "desktop only" fallback.
        if (!isDesktop) {
          if (cdpEnabled) {
            return <ScreencastPanel workspaceId={workspaceId} visible={visible} />;
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
          <Suspense fallback={null}>
            <DockviewBrowserContainer
              workspaceId={workspaceId}
              visible={visible}
              wsActive={wsActive}
            />
          </Suspense>
        );
      }}
    </MultiWorkspacePanelHost>
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

  // `data-testid` is keyed by the dockview panel `component` (e.g.
  // "terminal", "browser", "files"). Owned by us (not by dockview's
  // CSS class names) so it survives dockview upgrades, and it
  // disambiguates the OUTER shared-layout tabs from any nested
  // dockview tabs (which use their own tab renderers, e.g.
  // `TerminalTab` in `DockviewTerminalContainer`). Used by e2e
  // specs that need to click a specific outer panel tab.
  const tab = (
    <div className="dv-default-tab" data-testid={`workspace__tab--${props.api.component}`}>
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

  // See `DefaultTab` above for the `data-testid` rationale.
  const tab = (
    <div className="dv-default-tab" data-testid={`workspace__tab--${props.api.component}`}>
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
// Right-side header actions — maximize/restore toggle on every center group.
// ---------------------------------------------------------------------------

const MainGroupRightActions = memo(function MainGroupRightActions(
  props: IDockviewHeaderActionsProps,
) {
  const isGridGroup = (props.location?.type ?? "grid") === "grid";

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
// Diff file count hook (polls every 15s for the active workspace).
// ---------------------------------------------------------------------------

function useDiffFileCount(workspaceId: string | null): number {
  const { diffMode, compareBranch } = useDiffTarget(workspaceId ?? "");
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!workspaceId) {
      setCount(0);
      return;
    }
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
  }, [workspaceId, diffMode, compareBranch]);
  return count;
}

// ---------------------------------------------------------------------------
// Required panel definitions & layout persistence
// ---------------------------------------------------------------------------

const REQUIRED_PANEL_IDS = ["projects", "chat", "changes", "files", "terminal", "browser"] as const;

/**
 * Panel ids that USED to be required and may live in saved layouts. We strip
 * them on layout restore so old localStorage entries don't break dockview.
 */
const REMOVED_PANEL_IDS = ["screencast"] as const;

const GLOBAL_LAYOUT_KEY = "band:dockview-layout-v6";
const ACTIVE_STATE_KEY_PREFIX = "band:dockview-active:";

const EDGE_GROUP_IDS = {
  left: "edge-left",
  right: "edge-right",
  bottom: "edge-bottom",
} as const;
type EdgeDirection = keyof typeof EDGE_GROUP_IDS;

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
 * state and container dimensions. Kept around to guard the SAVE path during
 * initial layout setup against spurious writes — no longer drives eviction
 * since there are no per-workspace dockview instances to evict.
 */
function getStructuralFingerprint(json: Record<string, unknown>): string {
  const clone = JSON.parse(JSON.stringify(json));
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
 * serialized layout so that the saved JSON only contains structural data.
 */
function stripPanelParams(json: Record<string, unknown>): Record<string, unknown> {
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
 * Module-level flag: `true` only for the brief synchronous window in
 * which `saveLayout` calls `api.toJSON()`. dockview's `toJSON()`
 * internally exits then re-enters the currently-maximized group as
 * part of its serialization dance, firing
 * `onDidMaximizedGroupChange(false)` followed by
 * `onDidMaximizedGroupChange(true, <group>)`. Those events are not
 * user-initiated and must NOT be persisted — the re-enter event in
 * particular would otherwise contaminate the incoming workspace's
 * localStorage with the outgoing workspace's maximize. The
 * `onDidMaximizedGroupChange` listener (down in `onReady`) checks this
 * flag and skips while it's true.
 *
 * Module scope is safe here because there's exactly one
 * `SharedDockviewLayout` mounted at a time.
 */
let inSaveLayoutToJSON = false;

/**
 * Persist the current layout.
 * - Full layout (structure + active tabs) → global key
 * - Active tab state → per-workspace key (maximizedGroup is preserved
 *   from whatever's already saved; it's owned by the dedicated
 *   `onDidMaximizedGroupChange` listener — see notes below).
 */
function saveLayout(
  api: DockviewApi,
  workspaceId: string | null,
  lastStructureRef: React.MutableRefObject<string>,
): void {
  try {
    let json: Record<string, unknown>;
    inSaveLayoutToJSON = true;
    try {
      json = stripPanelParams(api.toJSON() as unknown as Record<string, unknown>);
    } finally {
      inSaveLayoutToJSON = false;
    }

    // Save per-workspace active tab state only when we have a real workspace.
    //
    // NOTE: we intentionally DON'T capture `maximizedGroup` here.
    // `api.toJSON()` above internally exits and re-enters the maximized
    // group as part of its serialization, which means by the time we
    // reach this point `findMaximizedGroupId(api)` could observe a
    // transient "no group maximized" state and clobber the real
    // value. Maximize state is owned by the dedicated
    // `onDidMaximizedGroupChange` listener, which patches the
    // `maximizedGroup` field in isolation. We just need to PRESERVE
    // whatever maximizedGroup is already on disk so this save doesn't
    // drop it.
    if (workspaceId) {
      const activeState = extractActiveState(json);
      const existing = loadActiveState(workspaceId);
      if (existing?.maximizedGroup) {
        // Only preserve the saved maximize when the named group is
        // still present in the current layout. If a group has been
        // deleted (e.g. the user removed all its tabs), dockview may
        // not fire `onDidMaximizedGroupChange(false)` along the
        // destruction path, so the stale id would otherwise hang
        // around in localStorage indefinitely.
        const groupStillExists = api.groups.some((g) => g.id === existing.maximizedGroup);
        if (groupStillExists) {
          activeState.maximizedGroup = existing.maximizedGroup;
        }
      }
      localStorage.setItem(`${ACTIVE_STATE_KEY_PREFIX}${workspaceId}`, JSON.stringify(activeState));
    }

    // Always save full layout to the global key
    localStorage.setItem(GLOBAL_LAYOUT_KEY, JSON.stringify(json));

    // Track the structural fingerprint so the caller can compare init vs.
    // user-initiated changes if it ever needs to.
    lastStructureRef.current = getStructuralFingerprint(json);
  } catch {
    // Best-effort persistence
  }
}

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

/** Read the saved active-tab state for a workspace, or null when absent
 *  or unparseable. Defends against malformed payloads (older versions,
 *  hand-edited localStorage, extensions) by requiring `groups` to be a
 *  plain object — every caller indexes into it, and a missing `groups`
 *  key would throw `TypeError: Cannot read properties of undefined`
 *  inside the surrounding try/catch and silently nuke the workspace's
 *  saved layout. */
function loadActiveState(workspaceId: string | null): ActiveTabState | null {
  if (!workspaceId) return null;
  try {
    const raw = localStorage.getItem(`${ACTIVE_STATE_KEY_PREFIX}${workspaceId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { groups?: unknown }).groups !== "object" ||
      (parsed as { groups?: unknown }).groups === null
    ) {
      return null;
    }
    return parsed as ActiveTabState;
  } catch {
    return null;
  }
}

/** Load layout: global structure + per-workspace active tabs merged.
 *  Note that `maximizedGroup` is NOT folded into the returned JSON — it
 *  has to be re-applied to the live api via `applyMaximizedGroupToApi`
 *  after `fromJSON` because dockview doesn't model maximize in its
 *  serialized form. */
function loadLayout(workspaceId: string | null): unknown | null {
  try {
    const raw = localStorage.getItem(GLOBAL_LAYOUT_KEY);
    if (!raw) return null;
    const layout = JSON.parse(raw);

    stripRemovedPanels(layout);

    // Overlay this workspace's saved active tab state (if any).
    const activeState = loadActiveState(workspaceId);
    if (activeState) {
      applyActiveState(layout, activeState);
    }

    return layout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main SharedDockviewLayout — one instance for the whole app
// ---------------------------------------------------------------------------

/**
 * The single shared dockview that lives at the app shell. Mounts ONE
 * dockview instance for the whole app; per-workspace content is cached
 * inside each panel via `MultiWorkspacePanelHost`.
 *
 * Layout structure (panel positions, tab order, hidden panels, the project
 * list) is shared across all workspaces and persisted to
 * `band:dockview-layout-v6`. Per-workspace ACTIVE TAB state is persisted
 * separately under `band:dockview-active:${workspaceId}`.
 */
export function SharedDockviewLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  const apiRef = useRef<DockviewApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hidden panels from settings — used to gate panel operations.
  const { settings } = useSettingsQuery();
  const hiddenPanels = useMemo(
    () =>
      ((settings as unknown as Record<string, unknown>).hiddenPanels as string[] | undefined) ?? [],
    [settings],
  );
  const hiddenPanelsRef = useRef(hiddenPanels);
  hiddenPanelsRef.current = hiddenPanels;

  // Suppress saves during initial layout setup (fromJSON / buildDefaultLayout
  // fire onDidLayoutChange events that are not user-initiated).
  const initializedRef = useRef(false);

  // Structural fingerprint of the last persisted layout — purely defensive,
  // no longer drives any eviction.
  const lastStructureRef = useRef("");

  // Active workspace id available to async callbacks without re-binding.
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  // Notify the "recent workspaces" picker on every workspace switch. Lives
  // here (rather than inside each `MultiWorkspacePanelHost`) so the call
  // fires exactly once per navigation instead of five times.
  useEffect(() => {
    if (activeWorkspaceId) recordWorkspaceAccess(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // Per-workspace cross-panel state lives in the module-level pub-sub above.
  // The recent files hook is workspace-keyed and survives remounts via its
  // own module-level Map, so reading it here for the ACTIVE workspace is
  // safe — the dialogs we render below only show the active workspace's
  // recents.
  const { recentFiles, trackFile } = useRecentFiles(activeWorkspaceId ?? "");

  // The Changes panel tab badge — only the ACTIVE workspace's diff count is
  // surfaced because the badge lives on the single shared tab header.
  const diffFileCount = useDiffFileCount(activeWorkspaceId);

  // The currentFile-ref shadows the active workspace's currentFile for the
  // Format Current File keyboard handler (intentionally not re-subscribed on
  // every selection change).
  const currentFileRef = useRef<string | undefined>(undefined);
  // Find-in-file: registry of per-workspace callbacks. The keyboard handler
  // invokes the ACTIVE workspace's callback.
  const findInFileRegistry = useRef(new Map<string, () => void>());

  // Dialog state — there's only one dialog open at a time across the whole
  // app, regardless of which workspace is active.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [lastQuickOpenQuery, setLastQuickOpenQuery] = useState("");

  // Track the currently-displayed currentFile for the ACTIVE workspace so
  // dialogs can highlight it without subscribing to the per-workspace store.
  // Updated via cross-panel handlers below.
  const [activeCurrentFile, setActiveCurrentFile] = useState<string | undefined>(undefined);

  // Refresh the active workspace's currentFile shadow when navigating between
  // workspaces — the store may already hold a value for the new workspace.
  useEffect(() => {
    if (!activeWorkspaceId) {
      setActiveCurrentFile(undefined);
      currentFileRef.current = undefined;
      return;
    }
    const state = getPerWorkspaceState(activeWorkspaceId);
    setActiveCurrentFile(state.currentFile);
    currentFileRef.current = state.currentFile;
    const unsub = subscribePerWorkspaceState(activeWorkspaceId, () => {
      const next = getPerWorkspaceState(activeWorkspaceId).currentFile;
      setActiveCurrentFile(next);
      currentFileRef.current = next;
    });
    return unsub;
  }, [activeWorkspaceId]);

  // ---------------------------------------------------------------------
  // Cross-panel handler wiring
  // ---------------------------------------------------------------------

  const handleOpenFile = useCallback(
    (workspaceId: string, filename: string) => {
      const cleanPath = parseFileLocation(filename).filePath;
      setPerWorkspaceState(workspaceId, {
        currentFile: cleanPath,
        openFilePath: filename,
      });
      trackFile(cleanPath);
      // Activate the Files panel only for the currently visible workspace —
      // otherwise we'd hijack the active tab in the shared layout because of
      // an action that fired in a cached but invisible workspace.
      if (workspaceId === activeWorkspaceIdRef.current) {
        apiRef.current?.getPanel("files")?.api.setActive();
      }
    },
    [trackFile],
  );

  const handleFileOpened = useCallback((workspaceId: string) => {
    setPerWorkspaceState(workspaceId, { openFilePath: null });
  }, []);

  const handleSelectFile = useCallback(
    (workspaceId: string, filePath: string | null) => {
      setPerWorkspaceState(workspaceId, { currentFile: filePath ?? undefined });
      if (filePath) trackFile(filePath);
    },
    [trackFile],
  );

  const handleSetFindInFile = useCallback((workspaceId: string, fn: (() => void) | null) => {
    if (fn) findInFileRegistry.current.set(workspaceId, fn);
    else findInFileRegistry.current.delete(workspaceId);
  }, []);

  const handleActivateFilesPanel = useCallback((workspaceId: string) => {
    // Only activate when the request targets the currently visible
    // workspace — same invariant as `handleOpenFile`. A cached but
    // invisible workspace must not be allowed to flip the panel
    // switcher.
    if (workspaceId === activeWorkspaceIdRef.current) {
      apiRef.current?.getPanel("files")?.api.setActive();
    }
  }, []);

  // Mirror the handlers into the module-level registry so panel children
  // (which can't reach into a closure across the dockview boundary) can
  // call them.
  crossPanelHandlers.onOpenFile = handleOpenFile;
  crossPanelHandlers.onFileOpened = handleFileOpened;
  crossPanelHandlers.onSelectFile = handleSelectFile;
  crossPanelHandlers.onFindInFile = handleSetFindInFile;
  crossPanelHandlers.onActivateFilesPanel = handleActivateFilesPanel;

  // ---------------------------------------------------------------------
  // Command palette
  // ---------------------------------------------------------------------

  const paletteCommands = useMemo(
    () =>
      buildCommands({
        getApi: () => apiRef.current,
        getHiddenPanels: () => hiddenPanelsRef.current,
        openQuickOpen: () => setQuickOpenOpen(true),
        openSearchFiles: () => setSearchFilesOpen(true),
        findInFile: () => {
          const ws = activeWorkspaceIdRef.current;
          const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
          if (fn) {
            fn();
          } else {
            window.dispatchEvent(new CustomEvent("band:find-in-file"));
          }
        },
        formatCurrentFile: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          const filePath = currentFileRef.current;
          window.dispatchEvent(
            new CustomEvent("band:format-current-file", {
              detail: { workspaceId: ws, filePath },
            }),
          );
        },
        newUntitledTab: () => {
          window.dispatchEvent(new CustomEvent("band:new-untitled-tab"));
        },
        changeLanguageMode: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          const filePath = currentFileRef.current;
          window.dispatchEvent(
            new CustomEvent("band:open-language-picker", {
              detail: { workspaceId: ws, filePath },
            }),
          );
        },
      }),
    [],
  );

  // ---------------------------------------------------------------------
  // Global keyboard shortcuts
  // ---------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ws = activeWorkspaceIdRef.current;
      const terminalFocused = document.activeElement?.closest(".xterm") != null;

      // Ctrl+R → workspace picker — skip when terminal focused
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "r" && !e.shiftKey) {
        if (terminalFocused) return;
        e.preventDefault();
        e.stopPropagation();
        setWorkspacePickerOpen(true);
        return;
      }

      // Ctrl+` → Terminal panel
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

      // Ctrl+0 → focus Projects in the left edge group.
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

      // ⇧⌥F → Format Current File (matches VS Code; uses e.code so the
      // macOS Option-layer dead-key doesn't swallow the keystroke).
      if (e.code === "KeyF" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (terminalFocused) return;
        e.preventDefault();
        if (!ws) return;
        const filePath = currentFileRef.current;
        window.dispatchEvent(
          new CustomEvent("band:format-current-file", {
            detail: { workspaceId: ws, filePath },
          }),
        );
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (terminalFocused && !e.metaKey) return;

      const api = apiRef.current;
      const key = e.key.toLowerCase();

      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:new-chat-session"));
      } else if (key === "n" && !e.shiftKey && !e.altKey) {
        // ⌘N → New Untitled File
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:new-untitled-tab"));
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
        if (fn) {
          fn();
        } else {
          window.dispatchEvent(new CustomEvent("band:find-in-file"));
        }
      } else if (key === "o" && !e.shiftKey && !e.altKey) {
        // ⌘O → Open File… The actual picker invocation lives in
        // CodeBrowserView and is gated by `capabilities.pickFile`, so
        // the event is a no-op in the plain web build — preventDefault
        // here still suppresses the browser's own Cmd+O.
        //
        // Address the event to the active workspace: the per-panel
        // content cache keeps multiple CodeBrowserView instances alive
        // at once, and an undelimited broadcast would race every
        // cached instance to open its own picker (the file landed in
        // the wrong workspace). Same shape as `band:format-current-file`.
        e.preventDefault();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:open-file-external", {
            detail: { workspaceId: ws },
          }),
        );
      } else if (key === "i" && e.ctrlKey && e.metaKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("chat")) {
          api.getPanel("chat")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-chat"));
          });
        }
      } else if (key === "g" && e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("changes")) {
          api.getPanel("changes")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-changes"));
          });
        }
      } else if (key === "e" && e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("files")) {
          api.getPanel("files")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-files"));
          });
        }
      } else if (key === "b" && e.shiftKey && api) {
        e.preventDefault();
        if (!hiddenPanelsRef.current.includes("browser")) {
          api.getPanel("browser")?.api.setActive();
          queueMicrotask(() => {
            window.dispatchEvent(new CustomEvent("band:focus-browser"));
          });
        }
      } else if (key === "b" && !e.shiftKey && api) {
        e.preventDefault();
        const left = api.groups.find((g) => g.id === EDGE_GROUP_IDS.left);
        if (left) {
          if (left.api.isCollapsed()) left.api.expand();
          else left.api.collapse();
        }
      } else if (key === "m" && e.shiftKey && api) {
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
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Listen for file link clicks from chat messages → open Quick Open with query
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail?.filename) {
        setQuickOpenQuery(detail.filename);
        setQuickOpenOpen(true);
      }
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, []);

  // File-tree toolbar window-event triggers
  useEffect(() => {
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
    };
  }, []);

  // Panel activation events from the title bar panel switcher
  useEffect(() => {
    const handler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId: string }>).detail?.panelId;
      if (panelId && apiRef.current && !hiddenPanelsRef.current.includes(panelId)) {
        apiRef.current.getPanel(panelId)?.api.setActive();
      }
    };
    window.addEventListener("band:activate-panel", handler);
    return () => window.removeEventListener("band:activate-panel", handler);
  }, []);

  // ---------------------------------------------------------------------
  // Layout management
  // ---------------------------------------------------------------------

  // Add a single missing panel back into the layout at a sensible position.
  const addMissingPanel = useCallback((api: DockviewApi, panelId: string) => {
    if (!(panelId in components)) return;

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
      params: {},
      inactive: true,
    };

    if (panelId === "changes") {
      opts.tabComponent = "badge";
    }

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

    if (panelId === "chat" && anyExisting) {
      opts.position = { referencePanel: anyExisting.id, direction: "left" };
    } else if (anyExisting) {
      opts.position = { referencePanel: anyExisting.id, direction: "within" };
    }

    // biome-ignore lint/suspicious/noExplicitAny: dynamic panel options
    api.addPanel(opts as any);
  }, []);

  // Build the default layout from scratch.
  const buildDefaultLayout = useCallback((api: DockviewApi) => {
    const hidden = hiddenPanelsRef.current;

    api.addPanel({
      id: "chat",
      component: "chat",
      title: "Chat",
      params: {},
    });

    let rightGroupRef: string | null = null;

    if (!hidden.includes("changes")) {
      api.addPanel({
        id: "changes",
        component: "changes",
        tabComponent: "badge",
        title: "Changes",
        params: {},
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
          params: {},
          position: { referencePanel: rightGroupRef, direction: "within" },
          inactive: true,
        });
      } else {
        api.addPanel({
          id: "files",
          component: "files",
          title: "Files",
          params: {},
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
          params: {},
          position: { referencePanel: rightGroupRef, direction: "within" },
          inactive: true,
        });
      } else {
        api.addPanel({
          id: "terminal",
          component: "terminal",
          title: "Terminal",
          params: {},
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
          params: {},
          position: { referencePanel: rightGroupRef, direction: "within" },
          inactive: true,
        });
      } else {
        api.addPanel({
          id: "browser",
          component: "browser",
          title: "Browser",
          params: {},
          position: { referencePanel: "chat", direction: "right" },
        });
      }
    }

    try {
      api.getPanel("chat")?.api.setSize({ width: api.width * 0.5 });
    } catch {}

    try {
      if (!api.groups.some((g) => g.id === "edge-left")) {
        api.addEdgeGroup("left", { id: "edge-left", initialSize: 240 });
      }
    } catch {}
    api.addPanel({
      id: "projects",
      component: "projects",
      title: "Projects",
      params: {},
      position: { referenceGroup: "edge-left", direction: "within" },
    });
  }, []);

  // onReady: restore or create the layout, heal missing panels, wire up
  // edge groups, set up persistence. The dockview is initialised exactly
  // once per app lifetime — the active workspace flows through refs and
  // ISN'T captured here, so we can keep the dependency list minimal.
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Drop orphaned keys from the old custom-collapse system.
      try {
        localStorage.removeItem("band:collapsed-groups");
        localStorage.removeItem("band:group-expanded-widths");
      } catch {}

      const initialWorkspaceId = activeWorkspaceIdRef.current;
      let restored = false;
      const saved = loadLayout(initialWorkspaceId);
      if (saved) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: localStorage JSON shape
          event.api.fromJSON(saved as any);
          restored = true;
        } catch {}
      }

      if (!restored) {
        buildDefaultLayout(event.api);
      }

      for (const id of REQUIRED_PANEL_IDS) {
        if (!event.api.getPanel(id) && !hiddenPanelsRef.current.includes(id)) {
          addMissingPanel(event.api, id);
        }
      }

      for (const id of hiddenPanelsRef.current) {
        const panel = event.api.getPanel(id);
        if (panel) {
          event.api.removePanel(panel);
        }
      }

      try {
        if (event.api.getEdgeGroup("top")) event.api.removeEdgeGroup("top");
      } catch {}

      for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
        const id = EDGE_GROUP_IDS[direction];
        if (!event.api.groups.some((g) => g.id === id)) {
          try {
            event.api.addEdgeGroup(direction, { id, collapsed: true });
          } catch {}
        }
      }

      for (const direction of Object.keys(EDGE_GROUP_IDS) as EdgeDirection[]) {
        const id = EDGE_GROUP_IDS[direction];
        try {
          const group = event.api.groups.find((g) => g.id === id);
          event.api.setEdgeGroupVisible(direction, !!group && group.panels.length > 0);
        } catch {}
      }

      // Guard: if a required panel is removed (edge-case drag, API call, etc.)
      // re-add it immediately so it can't be lost.
      event.api.onDidRemovePanel((panel) => {
        const id = panel.id;
        if (
          (REQUIRED_PANEL_IDS as readonly string[]).includes(id) &&
          !hiddenPanelsRef.current.includes(id)
        ) {
          setTimeout(() => {
            if (!event.api.getPanel(id) && !hiddenPanelsRef.current.includes(id)) {
              addMissingPanel(event.api, id);
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

      // Restore the initial workspace's maximize state, if any. Has to
      // happen AFTER `fromJSON` + the required-panel reconciliation
      // above so that the target group actually exists in the dockview
      // by the time we ask to maximize it.
      const initialActiveState = loadActiveState(initialWorkspaceId);
      if (initialActiveState?.maximizedGroup) {
        applyMaximizedGroupToApi(event.api, initialActiveState.maximizedGroup);
      }

      // Persist layout on changes. With a single dockview instance shared by
      // all workspaces, there's no eviction dance — fromJSON is only called
      // once at init, and onDidLayoutChange events after that are always
      // user-driven structural edits or tab activations.
      event.api.onDidLayoutChange(() => {
        if (!initializedRef.current) return;
        saveLayout(event.api, activeWorkspaceIdRef.current, lastStructureRef);
      });

      // `onDidLayoutChange` is NOT fired when the user enters or exits
      // maximize on a group (dockview wires that event off a different
      // emitter chain), so we listen explicitly. Without this, the
      // maximize-state save lags behind by one structural event and
      // toggling maximize alone wouldn't persist.
      //
      // CRITICAL: do NOT call `saveLayout` from here. `saveLayout`
      // calls `api.toJSON()`, and `toJSON()` on a dockview with a
      // maximized group internally toggles the maximize state (exits
      // then re-enters) as part of its serialization dance. That
      // re-entry fires another `onDidMaximizedGroupChange` event,
      // which would re-trigger this listener and `saveLayout` again,
      // producing an infinite event cascade. Instead, just patch the
      // `maximizedGroup` field of the persisted active state — the
      // rest of the layout JSON is unchanged by a max toggle and is
      // already kept in sync by the `onDidLayoutChange` listener
      // above.
      event.api.onDidMaximizedGroupChange(
        (e: { group?: { id?: string }; isMaximized?: boolean }) => {
          if (!initializedRef.current) return;
          // Suppress the spurious exit-then-reenter pair dockview fires
          // from inside `toJSON()`. Without this guard the "re-enter"
          // event would write the outgoing workspace's maximized group
          // into the INCOMING workspace's localStorage entry — a real
          // contamination bug the reviewer flagged in #491. Module-level
          // flag is set by `saveLayout` for the synchronous duration of
          // its `toJSON()` call.
          if (inSaveLayoutToJSON) return;
          const workspaceId = activeWorkspaceIdRef.current;
          if (!workspaceId) return;
          // Defensive: dockview's event payload types both `group` and
          // `group.id` as optional. If a future version (or an edge case
          // during init) ever fires `isMaximized: true` without a group
          // id, we'd silently overwrite the saved state with `undefined`
          // and lose the user's maximize. Skip rather than corrupt.
          if (e.isMaximized && !e.group?.id) return;
          try {
            const current = loadActiveState(workspaceId) ?? { groups: {} };
            const nextMax = e.isMaximized ? e.group?.id : undefined;
            if (current.maximizedGroup === nextMax) return;
            current.maximizedGroup = nextMax;
            localStorage.setItem(
              `${ACTIVE_STATE_KEY_PREFIX}${workspaceId}`,
              JSON.stringify(current),
            );
          } catch {
            // Best-effort persistence
          }
        },
      );

      initializedRef.current = true;
    },
    [buildDefaultLayout, addMissingPanel],
  );

  // ---------------------------------------------------------------------
  // Reactive: badge update on diff count change
  // ---------------------------------------------------------------------

  useEffect(() => {
    const panel = apiRef.current?.getPanel("changes");
    if (!panel) return;
    panel.api.updateParameters({ badge: diffFileCount });
  }, [diffFileCount]);

  // ---------------------------------------------------------------------
  // Reactive: persist active-tab state on workspace switch
  // ---------------------------------------------------------------------

  // When the URL changes to a different workspace, dockview's tab state
  // doesn't automatically swap — we apply the previously-saved active tab
  // state for the new workspace.
  //
  // CRITICAL: only call `setActive()` for panels that are NOT already active
  // AND that belong to a tab group with siblings. Every `setActive()` call
  // triggers a dockview focus dance: dockview tears down the previously
  // active panel content, mounts the new one, and calls .focus() on the
  // new panel's content area WITHOUT `preventScroll`. Calling it on the
  // projects edge group (which only has one tab — Projects) re-focuses the
  // DashboardShell container and scrolls the project-list ScrollArea back
  // to scrollTop=0; calling it on the already-active panel in the center
  // group has the same effect for its content. Skipping both no-ops keeps
  // the project list scroll + the user's keyboard focus intact when they
  // navigate back to a previously-visited workspace.
  useEffect(() => {
    if (!initializedRef.current) return;
    const api = apiRef.current;
    if (!api || !activeWorkspaceId) return;
    const activeState = loadActiveState(activeWorkspaceId);
    // ORDER MATTERS: restore per-group active tabs FIRST, then apply
    // the saved maximize state. Doing it the other way around causes
    // two correctness problems:
    //
    //   - `setActive()` on a panel inside a group that's NOT the
    //     currently-maximized one implicitly exits the maximize so the
    //     group can come to the foreground. If we'd just applied max,
    //     that exit immediately undoes it.
    //   - Skipping `setActive` for non-maximized groups (the obvious
    //     workaround) is also wrong: those groups would silently
    //     inherit whatever active tab the PREVIOUS workspace left in
    //     the shared dockview, so when the user later exits maximize
    //     they'd see stale tabs.
    //
    // Running setActive first means every group ends up on the correct
    // tab for the incoming workspace. Any intermediate maximize-exit
    // side effects then get overwritten by the final
    // `applyMaximizedGroupToApi` call below, which fires its own
    // `onDidMaximizedGroupChange` event so the persisted state ends up
    // accurate.
    if (activeState) {
      try {
        for (const [_groupId, viewId] of Object.entries(activeState.groups)) {
          const panel = api.getPanel(viewId);
          if (!panel) continue;
          // Skip if already active in its group — setActive is a focus-fire
          // even for no-op tab switches.
          if (panel.api.isActive) continue;
          // Skip single-panel groups (e.g. the projects edge group) — there's
          // nothing to "switch to", and the focus side-effect resets the
          // project list scroll position.
          if (panel.group.panels.length <= 1) continue;
          panel.api.setActive();
        }
        // Intentionally do NOT activate `activeState.activeGroup` here for
        // the same reason: the previous code activated the first panel of
        // the saved active group to focus that group, which on the edge-left
        // group meant re-focusing the DashboardShell container and resetting
        // the project list scroll.
      } catch {}
    }
    // Apply (or clear) the maximize last. Even when the workspace has
    // no saved state we still need to clear any maximize carried over
    // from the workspace we just left — otherwise switching A
    // (maximized) → B (no state) would leave B rendered under A's
    // maximize overlay.
    applyMaximizedGroupToApi(api, activeState?.maximizedGroup);
  }, [activeWorkspaceId]);

  // ---------------------------------------------------------------------
  // React to hiddenPanels changes
  // ---------------------------------------------------------------------

  const prevHiddenRef = useRef<string[]>(hiddenPanels);
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const prev = prevHiddenRef.current;
    prevHiddenRef.current = hiddenPanels;

    const nowHidden = hiddenPanels.filter((id) => !prev.includes(id));
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
      }
    }
  }, [hiddenPanels, addMissingPanel]);

  // ---------------------------------------------------------------------
  // Recalculate dockview layout on container resize
  // ---------------------------------------------------------------------

  useEffect(() => {
    if (!apiRef.current || !containerRef.current) return;
    const api = apiRef.current;
    const el = containerRef.current;
    requestAnimationFrame(() => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth !== api.width || clientHeight !== api.height) {
        api.layout(clientWidth, clientHeight);
      }
    });
  }, []);

  // ---------------------------------------------------------------------
  // Edge group drag visibility
  // ---------------------------------------------------------------------

  useEffect(() => {
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

    refresh();

    const d1 = api.onWillDragPanel(startDrag);
    const d2 = api.onWillDragGroup(startDrag);
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
  }, []);

  // ---------------------------------------------------------------------
  // Hide all browser webviews when a dialog is open (active workspace only)
  // ---------------------------------------------------------------------

  const toolbarDialogOpen = useAnyToolbarDialogOpen();
  useEffect(() => {
    if (!isDesktop) return;
    if (!activeWorkspaceId) return;
    const isDialogOpen =
      quickOpenOpen ||
      searchFilesOpen ||
      workspacePickerOpen ||
      commandPaletteOpen ||
      toolbarDialogOpen;

    if (isDialogOpen) {
      desktopInvoke("browser_hide_all_for_workspace", {
        workspaceId: activeWorkspaceId,
      }).catch(() => {});
    } else {
      const browserPanel = apiRef.current?.getPanel("browser");
      if (browserPanel?.api.isActive) {
        desktopInvoke("browser_show_all_for_workspace", {
          workspaceId: activeWorkspaceId,
        }).catch(() => {});
      }
    }
  }, [
    quickOpenOpen,
    searchFilesOpen,
    workspacePickerOpen,
    commandPaletteOpen,
    toolbarDialogOpen,
    activeWorkspaceId,
  ]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <>
      {/* `absolute inset-0` so we OVERLAY the AppShell's relative div instead
        of stacking in normal flow next to the <Outlet /> sibling (which
        itself renders an empty `<div className="h-full">` on desktop for
        the workspace route). The old DockviewInstanceManager used the same
        trick — without it, the dockview ends up partly behind the title
        bar because two `h-full` siblings stack vertically and the second
        one gets clipped by the parent's overflow-hidden. */}
      <div ref={containerRef} className="absolute inset-0">
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
        workspaceId={activeWorkspaceId ?? ""}
        open={quickOpenOpen}
        onOpenChange={(open) => {
          setQuickOpenOpen(open);
          if (!open) setQuickOpenQuery(undefined);
        }}
        onOpenFile={(filename) => {
          if (activeWorkspaceId) handleOpenFile(activeWorkspaceId, filename);
        }}
        currentFile={activeCurrentFile}
        initialQuery={quickOpenQuery}
        autoOpen={quickOpenQuery != null}
        recentFiles={recentFiles}
        lastQuery={lastQuickOpenQuery}
        onQueryChange={setLastQuickOpenQuery}
      />
      <SearchFilesDialog
        workspaceId={activeWorkspaceId ?? ""}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={(filename) => {
          if (activeWorkspaceId) handleOpenFile(activeWorkspaceId, filename);
        }}
      />
      <WorkspacePickerDialog open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen} />
      <CommandPaletteDialog
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={paletteCommands}
      />
    </>
  );
}
