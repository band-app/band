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
  GitCompare,
  Globe,
  Maximize2,
  MessageSquare,
  Minimize2,
  Terminal as TerminalIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AddToTerminalDetail,
  buildCommands,
  type ChatInsertDetail,
  CommandPaletteDialog,
  DiffView,
  parseFileLocation,
  QuickOpenDialog,
  recordWorkspaceAccess,
  SearchFilesDialog,
  type SelectionToChatDetail,
  useDiffTarget,
  useSettingsQuery,
  WorkspacePickerDialog,
} from "@/dashboard";
import { isTerminalOriginatedEvent, useAppShortcut } from "../hooks/useAppShortcut";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import {
  type ActiveTabState,
  applyActiveState,
  applyGroupActiveViewsToApi,
  applyMaximizedGroupToApi,
  extractActiveState,
  walkGridNode,
} from "../lib/dockview-active-state";
import {
  anchorHiddenGridViews,
  applyMaximizeEdgeVisibility,
  attachSyncLayout,
  findFocusedInnerDockview,
  prepareMaximizeRestoreAnimation,
  toggleEdgeGroup,
} from "../lib/dockview-edge-groups";
import { isDesktop } from "../lib/is-desktop";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { GLOBAL_SHORTCUTS } from "../lib/shortcuts";
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
  /**
   * Bring the Terminal panel to the foreground. Used by the chat tab's
   * "Continue in terminal" action: the server has already spawned the
   * resume-command terminal pane (and emitted `terminal-created`), so the
   * inner terminal dockview will add it; this just surfaces the outer
   * Terminal panel so the user lands on the resumed session. Guarded on
   * active-workspace, same as `onActivateFilesPanel`.
   */
  onActivateTerminalPanel: (workspaceId: string) => void;
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
  onActivateTerminalPanel: () => {},
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
            onClick={(e) => {
              if (props.api.isMaximized()) {
                // Re-commit the hidden views' parked positions before the
                // restore writes land, so the tween starts from the right
                // edge (see prepareMaximizeRestoreAnimation).
                prepareMaximizeRestoreAnimation(e.currentTarget.closest<HTMLElement>(".dv-shell"));
                props.api.exitMaximized();
              } else {
                props.api.maximize();
              }
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

const REQUIRED_PANEL_IDS = ["chat", "changes", "files", "terminal", "browser"] as const;

/**
 * Panel ids that USED to be required and may live in saved layouts. We strip
 * them on layout restore so old localStorage entries don't break dockview.
 */
const REMOVED_PANEL_IDS = ["screencast"] as const;

// Bumped v6 → v7 when the project list moved out of the dockview into a
// standalone sidebar: old saved layouts still contain the `projects` edge
// panel, so we discard them and rebuild without it.
const GLOBAL_LAYOUT_KEY = "band:dockview-layout-v7";
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
 * Layout structure (panel positions, tab order, hidden panels) is shared
 * across all workspaces and persisted to `band:dockview-layout-v7`.
 * Per-workspace ACTIVE TAB state is persisted separately under
 * `band:dockview-active:${workspaceId}`.
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

  const handleActivateTerminalPanel = useCallback((workspaceId: string) => {
    // Same active-workspace guard as `handleActivateFilesPanel`, plus the
    // hidden-panel guard the Ctrl+` shortcut uses so we never try to
    // activate a panel the user has removed from the layout. Mirror the
    // shortcut's `band:focus-terminal` dispatch so the freshly-surfaced
    // terminal grabs keyboard focus.
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    if (hiddenPanelsRef.current.includes("terminal")) return;
    apiRef.current?.getPanel("terminal")?.api.setActive();
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("band:focus-terminal"));
    });
  }, []);

  // Mirror the handlers into the module-level registry so panel children
  // (which can't reach into a closure across the dockview boundary) can
  // call them.
  crossPanelHandlers.onOpenFile = handleOpenFile;
  crossPanelHandlers.onFileOpened = handleFileOpened;
  crossPanelHandlers.onSelectFile = handleSelectFile;
  crossPanelHandlers.onFindInFile = handleSetFindInFile;
  crossPanelHandlers.onActivateFilesPanel = handleActivateFilesPanel;
  crossPanelHandlers.onActivateTerminalPanel = handleActivateTerminalPanel;

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
        editorGoBack: () => {
          const ws = activeWorkspaceIdRef.current;
          // Bail without a target workspace — a `{ workspaceId: null }` detail
          // is falsy, so the listener guard would treat it as "fall through to
          // every mounted workspace" and re-introduce the cross-workspace
          // history-stepping this fix prevents. Mirrors `formatCurrentFile` /
          // `changeLanguageMode` above.
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-back", { detail: { workspaceId: ws } }),
          );
        },
        editorGoForward: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-forward", { detail: { workspaceId: ws } }),
          );
        },
      }),
    [],
  );

  // ---------------------------------------------------------------------
  // Global keyboard shortcuts
  // ---------------------------------------------------------------------

  // Every global shortcut below is bound through `useAppShortcut`, which
  // supplies the defaults the old hand-rolled handler implemented inline:
  // capture-phase listening (so a focused xterm can't swallow the chord),
  // firing inside form fields / contentEditable, `preventDefault`, and
  // character-vs-physical key matching per the combo's `useKey`. Combos come
  // from `GLOBAL_SHORTCUTS` so the command palette advertises exactly what is
  // bound here. See `apps/web/src/hooks/useAppShortcut.ts`.
  //
  // What the wrapper does NOT supply is `stopPropagation` — the library never
  // calls it. The three chords below stop propagation by hand because they can
  // fire while a terminal is focused, and without it the keystroke goes on to
  // reach xterm's own keydown listener and leaks into the shell.
  //
  // `TERMINAL_YIELDS` is the shell-key bail: a chord reached via Ctrl defers to
  // a focused terminal (Ctrl+K is kill-to-end-of-line, Ctrl+D is EOF), while the
  // same chord reached via ⌘ still fires. On Windows/Linux, where `mod` IS Ctrl,
  // that means these deliberately yield to the shell — preserved from the
  // `terminalFocused && !e.metaKey` gate this replaces.
  const TERMINAL_YIELDS = {
    ignoreEventWhen: (e: KeyboardEvent) => isTerminalOriginatedEvent(e) && !e.metaKey,
  };

  // ⌘K → workspace picker. Fires even while a terminal is focused (a
  // long-standing request); the Ctrl+K spelling on other platforms still yields
  // to xterm via `TERMINAL_YIELDS`.
  useAppShortcut(
    GLOBAL_SHORTCUTS.workspacePicker,
    (e) => {
      e.stopPropagation();
      setWorkspacePickerOpen(true);
    },
    { ...TERMINAL_YIELDS },
  );

  // Ctrl+` → Terminal panel.
  useAppShortcut(GLOBAL_SHORTCUTS.showTerminal, (e) => {
    e.stopPropagation();
    if (hiddenPanelsRef.current.includes("terminal")) return;
    apiRef.current?.getPanel("terminal")?.api.setActive();
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("band:focus-terminal"));
    });
  });

  // Ctrl+0 → reveal the project-list sidebar and focus it. The sidebar lives
  // outside the dockview, so we reveal it via the `band:show-sidebar` window
  // event and let the sidebar's `band:focus-projects` listener move keyboard
  // focus into the list.
  useAppShortcut(GLOBAL_SHORTCUTS.focusProjects, (e) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("band:show-sidebar"));
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("band:focus-projects"));
    });
  });

  // ⇧⌥F → Format Current File (VS Code parity). The only binding with no mod
  // key in the chord. `useKey: false` matches on the physical key so the macOS
  // Option-layer dead-key (⌥F → "ƒ") doesn't swallow it — the reason the old
  // branch tested `e.code` rather than `e.key`.
  useAppShortcut(
    GLOBAL_SHORTCUTS.formatCurrentFile,
    () => {
      const ws = activeWorkspaceIdRef.current;
      if (!ws) return;
      window.dispatchEvent(
        new CustomEvent("band:format-current-file", {
          detail: { workspaceId: ws, filePath: currentFileRef.current },
        }),
      );
    },
    { useKey: false, ignoreEventWhen: isTerminalOriginatedEvent },
  );

  useAppShortcut(
    GLOBAL_SHORTCUTS.newChatSession,
    () => window.dispatchEvent(new CustomEvent("band:new-chat-session")),
    { ...TERMINAL_YIELDS },
  );

  useAppShortcut(
    GLOBAL_SHORTCUTS.newUntitledTab,
    () => window.dispatchEvent(new CustomEvent("band:new-untitled-tab")),
    { ...TERMINAL_YIELDS },
  );

  useAppShortcut(GLOBAL_SHORTCUTS.commandPalette, () => setCommandPaletteOpen(true), {
    ...TERMINAL_YIELDS,
  });

  useAppShortcut(GLOBAL_SHORTCUTS.quickOpen, () => setQuickOpenOpen(true), { ...TERMINAL_YIELDS });

  useAppShortcut(GLOBAL_SHORTCUTS.searchFiles, () => setSearchFilesOpen(true), {
    ...TERMINAL_YIELDS,
  });

  // ⌘F → Find in File. Prefers the active editor's registered handler; falls
  // back to the broadcast event when no editor has registered one.
  useAppShortcut(
    GLOBAL_SHORTCUTS.findInFile,
    () => {
      const ws = activeWorkspaceIdRef.current;
      const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
      if (fn) fn();
      else window.dispatchEvent(new CustomEvent("band:find-in-file"));
    },
    { ...TERMINAL_YIELDS },
  );

  // ⌘O → Open File… The actual picker invocation lives in CodeBrowserView and
  // is gated by `capabilities.pickFile`, so the event is a no-op in the plain
  // web build — `preventDefault` still suppresses the browser's own ⌘O.
  //
  // Addressed to the active workspace: the per-panel content cache keeps
  // multiple CodeBrowserView instances alive at once, and an undelimited
  // broadcast would race every cached instance into opening its own picker (the
  // file landed in the wrong workspace). Same shape as
  // `band:format-current-file`.
  useAppShortcut(
    GLOBAL_SHORTCUTS.openFile,
    () => {
      const ws = activeWorkspaceIdRef.current;
      if (!ws) return;
      window.dispatchEvent(
        new CustomEvent("band:open-file-external", { detail: { workspaceId: ws } }),
      );
    },
    { ...TERMINAL_YIELDS },
  );

  // Panel activation. Each one no-ops when its panel is hidden, then hands
  // focus to the panel via a `band:focus-*` event on the next microtask (after
  // dockview has committed the activation).
  const activatePanel = (panelId: string, focusEvent: string) => () => {
    if (hiddenPanelsRef.current.includes(panelId)) return;
    apiRef.current?.getPanel(panelId)?.api.setActive();
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(focusEvent));
    });
  };

  useAppShortcut(GLOBAL_SHORTCUTS.showChat, activatePanel("chat", "band:focus-chat"), {
    ...TERMINAL_YIELDS,
  });
  useAppShortcut(GLOBAL_SHORTCUTS.showChanges, activatePanel("changes", "band:focus-changes"), {
    ...TERMINAL_YIELDS,
  });
  useAppShortcut(GLOBAL_SHORTCUTS.showFiles, activatePanel("files", "band:focus-files"), {
    ...TERMINAL_YIELDS,
  });
  useAppShortcut(GLOBAL_SHORTCUTS.showBrowser, activatePanel("browser", "band:focus-browser"), {
    ...TERMINAL_YIELDS,
  });

  // ⌘B → toggle the project-list sidebar. Unconditional: unlike its two
  // siblings below it does NOT resolve its target by focus. A shortcut that
  // means different things depending on invisible focus state is hard to trust,
  // and the sidebar is overwhelmingly the intended target. The cost is that an
  // inner dockview's LEFT edge has no keyboard toggle — if that turns out to
  // matter it gets its own combo rather than focus-dependence here.
  useAppShortcut(
    GLOBAL_SHORTCUTS.toggleSidebar,
    () => window.dispatchEvent(new CustomEvent("band:toggle-sidebar")),
    { ...TERMINAL_YIELDS },
  );

  // ⌥⌘B → toggle the RIGHT edge, focus-aware: when an inner dockview (terminal /
  // chat / browser) holds focus and has panels on that edge, toggle its edge;
  // otherwise fall through to the main layout's. The fallthrough is driven by
  // `toggleEdgeGroup`'s return value (`true` when it acted on a non-empty edge),
  // so empty inner edges delegate transparently. See `dockview-edge-groups.ts`
  // for the registry behind the focus lookup.
  //
  // `useKey: false` matches the physical key: macOS substitutes Alt-layer
  // characters into `e.key` (⌥B → "∫"), which is why the handler this replaces
  // tested `e.code`.
  useAppShortcut(
    GLOBAL_SHORTCUTS.toggleRightEdge,
    () => {
      const api = apiRef.current;
      if (!api) return;
      const inner = findFocusedInnerDockview();
      if (inner && toggleEdgeGroup(inner, "right")) return;
      toggleEdgeGroup(api, "right");
    },
    { ...TERMINAL_YIELDS, useKey: false },
  );

  // ⌘J → toggle the OUTERMOST layout's bottom edge, always. Like ⌘B (and unlike
  // its ⌥⌘B sibling above) it does not consult focus: the bottom panel is a
  // single shared surface in the user's mental model, so the chord that shows
  // and hides it should mean one thing everywhere rather than retargeting to
  // whichever inner dock happens to hold focus.
  //
  // `toggleEdgeGroup` already no-ops when that edge is absent or holds no
  // panels, so "toggle it if there is one" needs no extra guard here.
  useAppShortcut(
    GLOBAL_SHORTCUTS.toggleBottomEdge,
    () => {
      const api = apiRef.current;
      if (!api) return;
      toggleEdgeGroup(api, "bottom");
    },
    { ...TERMINAL_YIELDS },
  );

  // ⇧⌘M → maximize / restore the active grid group. A non-grid (edge) group
  // can't be maximized, so the shortcut only exits an existing maximize there.
  useAppShortcut(
    GLOBAL_SHORTCUTS.maximizePanel,
    () => {
      const api = apiRef.current;
      const active = api?.activeGroup;
      if (!api || !active) return;
      if (active.api.location.type !== "grid") {
        if (api.hasMaximizedGroup()) {
          prepareMaximizeRestoreAnimation(containerRef.current);
          api.exitMaximizedGroup();
        }
        return;
      }
      if (active.api.isMaximized()) {
        prepareMaximizeRestoreAnimation(containerRef.current);
        active.api.exitMaximized();
      } else {
        active.api.maximize();
      }
    },
    { ...TERMINAL_YIELDS },
  );

  // Listen for file link clicks from chat messages → open Quick Open with query.
  //
  // Filter by `detail.workspaceId` so a click in workspace A's chat doesn't
  // open the file against workspace B when B is the currently-active tab.
  // The dockview keeps up to `maxCachedWorkspaces` workspace subtrees alive
  // at once, but only this single layout owns the Quick Open dialog —
  // dropping cross-workspace events here is what keeps the dialog bound
  // to the correct workspace (see `dispatchOpenFile` in
  // `file-link-components.tsx` and issue #539). A missing detail
  // (legacy dispatcher / forward-compat) falls through to the active
  // workspace so any non-chat caller keeps working.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename?: string; workspaceId?: string }>).detail;
      if (!detail?.filename) return;
      if (detail.workspaceId && detail.workspaceId !== activeWorkspaceId) return;
      setQuickOpenQuery(detail.filename);
      setQuickOpenOpen(true);
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [activeWorkspaceId]);

  // File-tree toolbar window-event triggers, plus the workspace picker opener.
  // The picker state lives here, but the desktop title bar (rendered as a
  // sibling in __root.tsx, where it has no access to this state) opens it by
  // dispatching `band:open-workspace-picker` — same cross-component pattern as
  // the file-tree toolbar events above.
  useEffect(() => {
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    const openPicker = () => setWorkspacePickerOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    window.addEventListener("band:open-workspace-picker", openPicker);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
      window.removeEventListener("band:open-workspace-picker", openPicker);
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

  // "Add to Terminal" from the diff/file selection tooltip. The tooltip can't
  // know which workspace it lives in, so it dispatches the workspace-agnostic
  // `band:add-to-terminal` intent; here we resolve the active workspace,
  // surface its terminal panel (changes/files/terminal share one group by
  // default, so the terminal is usually a hidden tab), then re-dispatch the
  // scoped `band:terminal-insert` delivery so only that workspace's visible
  // terminal types the reference. Mirrors the Ctrl+` / "Continue in terminal"
  // surfacing pattern (`setActive` + microtask dispatch) so the terminal is
  // visible by the time the panel flushes the reference.
  useEffect(() => {
    const handler = (e: Event) => {
      const reference = (e as CustomEvent<AddToTerminalDetail>).detail?.reference;
      const workspaceId = activeWorkspaceIdRef.current;
      if (!reference || !workspaceId) return;
      if (hiddenPanelsRef.current.includes("terminal")) return;
      apiRef.current?.getPanel("terminal")?.api.setActive();
      // Resolve the workspace's last-focused terminal so the reference lands in
      // the one the user was actually using (not just whichever tab is visible).
      // The awaited query naturally defers the dispatch past the `setActive`
      // render, so the target terminal is surfaced by the time it flushes. Falls
      // back to an undefined terminalId (visible-terminal behavior) on error or
      // when no focus has been recorded yet.
      void (async () => {
        let terminalId: string | undefined;
        try {
          const focus = await trpc.panelFocus.get.query({ workspaceId });
          terminalId = focus.terminal;
        } catch {
          // best-effort — fall back to visible-terminal delivery
        }
        window.dispatchEvent(
          new CustomEvent("band:terminal-insert", {
            detail: { reference, workspaceId, terminalId },
          }),
        );
      })();
    };
    window.addEventListener("band:add-to-terminal", handler);
    return () => window.removeEventListener("band:add-to-terminal", handler);
  }, []);

  // "Add to Chat" from the diff/file selection tooltip. Symmetric to the
  // terminal handler above: the tooltip dispatches the workspace-agnostic
  // `band:add-to-chat` intent; here we resolve the active workspace and its
  // last-focused chat, surface the Chat panel, and re-dispatch the scoped
  // `band:chat-insert` delivery so only that specific chat pane appends the
  // reference. Previously every mounted PromptInput in the active workspace
  // listened to `band:add-to-chat` directly, so the reference was appended to
  // *all* open chat panes; scoping by chatId fixes that.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SelectionToChatDetail>).detail;
      const workspaceId = activeWorkspaceIdRef.current;
      if (!detail || !workspaceId) return;
      if (hiddenPanelsRef.current.includes("chat")) return;
      apiRef.current?.getPanel("chat")?.api.setActive();
      void (async () => {
        let chatId: string | undefined;
        try {
          const focus = await trpc.panelFocus.get.query({ workspaceId });
          chatId = focus.chat;
        } catch {
          // best-effort — fall back to visible-chat delivery
        }
        const insert: ChatInsertDetail = {
          filePath: detail.filePath,
          startLine: detail.startLine,
          endLine: detail.endLine,
          workspaceId,
          chatId,
        };
        window.dispatchEvent(new CustomEvent("band:chat-insert", { detail: insert }));
      })();
    };
    window.addEventListener("band:add-to-chat", handler);
    return () => window.removeEventListener("band:add-to-chat", handler);
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

      // Restore the initial workspace's saved state: per-group active
      // tabs first, then the maximize. ORDER MATTERS (same constraint
      // as the workspace-switch useEffect below): `setActive()` on a
      // panel inside a non-maximized group implicitly exits any
      // existing maximize, so doing it after `applyMaximizedGroupToApi`
      // would silently undo the maximize. Doing setActive first means
      // every group ends up on the correct tab; the final
      // `applyMaximizedGroupToApi` then re-applies the maximize over
      // the top.
      //
      // Without this initial-mount setActive pass the workspace-switch
      // useEffect doesn't restore per-group active tabs on the FIRST
      // page load — that effect early-returns while `initializedRef`
      // is still `false`, and never re-fires because `activeWorkspaceId`
      // didn't change. Invariant: on first mount, every group's active
      // tab must be applied here (not deferred to the switch effect),
      // otherwise a hidden group keeps whatever tab the default layout
      // left it on and the user sees the wrong tab after exiting
      // maximize. Has to happen AFTER `fromJSON` + the required-panel
      // reconciliation above so the target panels actually exist in the
      // dockview by the time we ask to activate them.
      const initialActiveState = loadActiveState(initialWorkspaceId);
      if (initialActiveState) {
        applyGroupActiveViewsToApi(event.api, initialActiveState);
      }
      if (initialActiveState?.maximizedGroup) {
        applyMaximizedGroupToApi(event.api, initialActiveState.maximizedGroup);
        // The `onDidMaximizedGroupChange` listener is guarded out here
        // (`initializedRef.current` is still false), so hide the edge
        // panels explicitly for a reload that lands on a maximized tab.
        // The edge-visibility reconciliation above already ran (edges
        // visible from panel count); this hides them over the top.
        applyMaximizeEdgeVisibility(event.api, true);
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
          // Collapse the edge panels while a group is maximized so the
          // maximized tab gets the full area; re-derive them on exit. This
          // is the hook for the Maximize/Restore button (which calls
          // `api.maximize()` / `api.exitMaximized()` directly) and for
          // workspace-switch-driven maximize changes. The initial-mount
          // path is handled separately below because `initializedRef` is
          // still false there and this listener is guarded out.
          applyMaximizeEdgeVisibility(event.api, !!e.isMaximized, containerRef.current);
          // Synchronously (same task, same style recalc as dockview's own
          // hide writes) re-anchor the views the maximize just hid, so the
          // in-flight tween collapses them in place instead of sweeping
          // them across the maximized group. See anchorHiddenGridViews.
          if (e.isMaximized && containerRef.current) {
            anchorHiddenGridViews(containerRef.current);
          }
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
  // Synchronous layout on container resize
  // ---------------------------------------------------------------------

  // dockview's built-in resize handling is deferred by one animation frame,
  // which makes the grid visibly trail the panel edge during the sidebar
  // toggle tween and sash drags — see attachSyncLayout. `apiRef` is set by
  // `onReady` during DockviewReact's mount, which runs before this parent
  // effect, so the api is available on first pass. The observer's initial
  // notification also reconciles any mount-time container/api size mismatch
  // (this replaced a one-shot rAF layout-sync effect that did only that).
  useEffect(() => {
    const el = containerRef.current;
    const api = apiRef.current;
    if (!el || !api) return;
    return attachSyncLayout(el, api);
  }, []);

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
  // new panel's content area WITHOUT `preventScroll`. Calling it on an
  // already-active panel in the center group re-focuses its content and can
  // jump its scroll position. Skipping these no-ops keeps the user's
  // keyboard focus + scroll intact when they navigate back to a
  // previously-visited workspace.
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
      // Intentionally do NOT activate `activeState.activeGroup` here.
      // The previous code activated the first panel of the saved active
      // group to focus that group, which re-focused that group's content
      // and could reset its scroll. The helper skips no-op activations +
      // single-panel groups for the same reason.
      applyGroupActiveViewsToApi(api, activeState);
    }
    // Apply (or clear) the maximize last. Even when the workspace has
    // no saved state we still need to clear any maximize carried over
    // from the workspace we just left — otherwise switching A
    // (maximized) → B (no state) would leave B rendered under A's
    // maximize overlay.
    //
    // When this is about to EXIT a maximize (switching out of a maximized
    // workspace), the exit animates via the onDidMaximizedGroupChange
    // listener — commit the hidden views' parked positions first so the
    // tween starts from the correct edge.
    if (api.hasMaximizedGroup()) {
      prepareMaximizeRestoreAnimation(containerRef.current);
    }
    applyMaximizedGroupToApi(api, activeState?.maximizedGroup);
    // Keep the edge panels in sync with the incoming workspace's maximize
    // state deterministically. When `applyMaximizedGroupToApi` actually
    // changes the maximize the listener above also fires, but it's a no-op
    // when the state is unchanged — and `applyMaximizeEdgeVisibility` is
    // idempotent, so calling it here is safe either way.
    applyMaximizeEdgeVisibility(api, !!activeState?.maximizedGroup);
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
