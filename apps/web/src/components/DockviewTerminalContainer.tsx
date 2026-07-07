import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { Columns2, Plus, Rows2, TerminalSquare, X } from "lucide-react";
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TerminalInsertDetail, useAdapter } from "@/dashboard";
import {
  attachEdgeGroupDragVisibility,
  centralPanelPosition,
  ensureEdgeGroups,
  registerInnerDockview,
} from "../lib/dockview-edge-groups";
import {
  cycleGridGroups,
  cycleTabsInActiveGroup,
  selectNeighbourBeforeRemove,
} from "../lib/dockview-section-actions";
import { disposeTerminal } from "../lib/terminal-cache";
import { trpc } from "../lib/trpc-client";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";

// Lazy-load TerminalPanel to avoid importing @xterm CJS during SSR
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** crypto.randomUUID() fallback for insecure contexts. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newTerminalId(): string {
  return uuid();
}

// ---------------------------------------------------------------------------
// React Query cache key
// ---------------------------------------------------------------------------

function terminalLayoutKey(workspaceId: string) {
  return ["terminalLayout", workspaceId] as const;
}

// ---------------------------------------------------------------------------
// Debounced server persistence (500ms) — also updates React Query cache
// so the next mount renders instantly from cached data.
// ---------------------------------------------------------------------------

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface PersistOptions {
  queryClient?: ReturnType<typeof useQueryClient>;
}

function panelIdsFromLayout(layout: unknown): Set<string> {
  if (typeof layout === "object" && layout !== null) {
    const panels = (layout as Record<string, unknown>).panels;
    if (typeof panels === "object" && panels !== null) {
      return new Set(Object.keys(panels as Record<string, unknown>));
    }
  }
  return new Set();
}

function persistToServer(workspaceId: string, layout: unknown, opts?: PersistOptions): void {
  // Update React Query cache immediately so next mount is instant.
  if (opts?.queryClient) {
    opts.queryClient.setQueryData(terminalLayoutKey(workspaceId), {
      layout,
      terminalIds: panelIdsFromLayout(layout),
    });
  }

  const existing = saveTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    workspaceId,
    setTimeout(() => {
      saveTimers.delete(workspaceId);
      trpc.terminalLayout.save.mutate({ workspaceId, tree: layout }).catch((err) => {
        console.error("[DockviewTerminalContainer] failed to persist layout:", err);
      });
    }, 500),
  );
}

// ---------------------------------------------------------------------------
// Cached data shape
// ---------------------------------------------------------------------------

interface TerminalLayoutData {
  layout: unknown | null;
  terminalIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

function isDockviewLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

// ---------------------------------------------------------------------------
// Dockview theme (reuse the band theme from the outer instance)
// ---------------------------------------------------------------------------

const terminalTabTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band dockview-terminal-tabs",
};

// ---------------------------------------------------------------------------
// Terminal tab panel component (renders inside each dockview tab)
// ---------------------------------------------------------------------------

interface TerminalTabParams {
  workspaceId: string;
  terminalId: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
}

function TerminalTabPanel({ params, api }: IDockviewPanelProps<TerminalTabParams>) {
  const { visible } = usePanelVisibility();

  // Stable callback to update the dockview tab title when the shell emits a title change
  const onTitleChange = useCallback(
    (title: string) => {
      api.setTitle(title);
    },
    [api],
  );

  if (!params.workspaceId || !params.terminalId) return null;

  // Build paneMetadata from params if command/cwd/env were provided
  const paneMetadata =
    params.command || params.cwd || params.env
      ? {
          command: params.command,
          cwd: params.cwd,
          env: params.env,
        }
      : undefined;

  return (
    // `data-testid` encodes the visibility signal the SHARED
    // `PanelVisibilityContext` propagated into this tab panel
    // (see `panel-visibility-context.tsx`), so an integration test can
    // assert the context plumbing reaches the leaf.
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`dockview-terminal-tab__visible-${visible ? "true" : "false"}`}
    >
      <Suspense fallback={null}>
        <TerminalPanel
          workspaceId={params.workspaceId}
          terminalId={params.terminalId}
          visible={visible}
          paneMetadata={paneMetadata}
          autoFocus={params.autoFocus}
          onTitleChange={onTitleChange}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom tab header: terminal icon + title + close button
// ---------------------------------------------------------------------------

function TerminalTab(props: IDockviewPanelHeaderProps<TerminalTabParams>) {
  const [title, setTitle] = useState(props.api.title ?? "Terminal");
  const [panelCount, setPanelCount] = useState(props.containerApi.panels.length);

  // Track title changes from the terminal (shell sets title via escape sequences)
  useEffect(() => {
    const d = props.api.onDidTitleChange(() => {
      setTitle(props.api.title ?? "Terminal");
    });
    return () => d.dispose();
  }, [props.api]);

  // Track panel count reactively for close button visibility
  useEffect(() => {
    const cApi = props.containerApi;
    const update = () => setPanelCount(cApi.panels.length);
    const d1 = cApi.onDidAddPanel(update);
    const d2 = cApi.onDidRemovePanel(update);
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [props.containerApi]);

  const containerApi = props.containerApi;
  const terminalId = props.params.terminalId;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Route to the handlers owned by THIS tab's dockview (keyed by
      // `containerApi.id`) so closing a tab never hits a cached workspace.
      panelActionsByApiId.get(containerApi.id)?.current?.onClose(terminalId);
    },
    [containerApi, terminalId],
  );

  const showClose = panelCount > 1;

  return (
    <div className="dv-default-tab">
      <div className="flex items-center gap-1.5 min-w-0">
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
      </div>
      {showClose && (
        <button
          type="button"
          className="ml-1 inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 hover:bg-accent transition-colors"
          onClick={handleClose}
          title="Close terminal"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-instance action registry for stable Dockview components
//
// dockview's `rightHeaderActionsComponent` and tab header components must be
// STABLE references, but the handlers they invoke are per-container-instance
// (each mounted DockviewTerminalContainer has its own `workspaceId` + inner
// dockview api). MultiWorkspacePanelHost keeps up to 3 workspaces mounted at
// once (inactive ones only `visibility: hidden`), so a module-level handler
// ref suffered last-writer-wins: a hidden instance's handlers would handle a
// click made in the visible workspace, creating the terminal in the wrong
// (cached) workspace.
//
// Fix: key the handlers by the owning dockview's `api.id`. dockview passes the
// owning `containerApi` into header-action + tab-header props; every wrapper
// shares the same underlying component `id` even though the DockviewApi object
// differs per group. The value is the instance's `useRef` holder so clicks
// always read the latest closures via `.current`.
// ---------------------------------------------------------------------------

interface TerminalPanelActions {
  onAdd: (groupId?: string) => void;
  onSplit: (groupId: string, direction: "right" | "below") => void;
  onClose: (terminalId: string) => void;
}

const panelActionsByApiId = new Map<string, { current: TerminalPanelActions }>();

const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  // Edge groups (left/right/bottom) don't support splits — dockview's
  // `addPanel` with `position: { referenceGroup: <edge>, direction }`
  // silently ignores the direction and just adds a tab. We still show
  // the "+" button there so users can add another terminal to the
  // edge group; only the split buttons are hidden. Defaults to "grid"
  // when `location` is missing (older dockview versions / tests).
  const isGridGroup = (props.location?.type ?? "grid") === "grid";
  // Resolve the owning dockview at click time so the action always targets the
  // workspace that owns THIS group, never a last-writer-wins global.
  const apiId = props.containerApi.id;
  const groupId = props.group.id;
  // `w-full justify-center` keeps the "+" centered horizontally inside
  // the vertical (left/right) edge action strip, which dockview sizes
  // to `--dv-tabs-and-actions-container-height` (~35px wide) via
  // `.dv-groupview-header-vertical`. In horizontal tab strips the
  // right-actions container shrink-wraps to its content, so `w-full`
  // resolves to the same content width and the button row looks
  // identical to before.
  return (
    // `data-testid` on grid-group toolbars only (edge groups get no testid)
    // gives integration tests a stable hook for the central action row.
    <div
      className="flex h-full w-full items-center justify-center"
      data-testid={isGridGroup ? "dockview-terminal__toolbar" : undefined}
    >
      {isGridGroup && (
        <>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            onClick={() => panelActionsByApiId.get(apiId)?.current?.onSplit(groupId, "right")}
            title="Split right"
          >
            <Columns2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            onClick={() => panelActionsByApiId.get(apiId)?.current?.onSplit(groupId, "below")}
            title="Split down"
          >
            <Rows2 className="size-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => panelActionsByApiId.get(apiId)?.current?.onAdd(groupId)}
        title="New terminal"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Dockview panel/tab component registries
// ---------------------------------------------------------------------------

const terminalPanelComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelProps<TerminalTabParams>>
> = {
  terminalTab: TerminalTabPanel,
};

const terminalTabComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelHeaderProps<TerminalTabParams>>
> = {
  terminalTab: TerminalTab,
};

// ---------------------------------------------------------------------------
// Main container
// ---------------------------------------------------------------------------

interface DockviewTerminalContainerProps {
  workspaceId: string;
  visible: boolean;
  wsActive?: boolean;
}

export function DockviewTerminalContainer({
  workspaceId,
  visible,
  wsActive,
}: DockviewTerminalContainerProps) {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const apiRef = useRef<DockviewApi | null>(null);
  const isRestoringRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror `wsActive` for use inside stable closures (onReady, effects) so
  // focus reporting only fires for the workspace the user is looking at — never
  // for the cached, hidden workspaces MultiWorkspacePanelHost keeps alive.
  const wsActiveRef = useRef(wsActive);
  wsActiveRef.current = wsActive;
  // Tracks the cleanup function returned by `attachEdgeGroupDragVisibility`
  // so the drag-visibility listeners can be detached on unmount (or on a
  // hypothetical re-`onReady`).
  const edgeDragDisposerRef = useRef<(() => void) | null>(null);
  // Tracks the unregister fn from `registerInnerDockview` so the global
  // sidebar-toggle shortcuts (⌘B / ⌥⌘B / ⌘J in SharedDockviewLayout) stop
  // routing into this dockview after unmount.
  const innerRegisterDisposerRef = useRef<(() => void) | null>(null);

  // Fetch layout AND terminal records via React Query — cached across mounts
  const { data: initialData } = useQuery<TerminalLayoutData>({
    queryKey: terminalLayoutKey(workspaceId),
    queryFn: async () => {
      const [{ tree }, { terminals }] = await Promise.all([
        trpc.terminalLayout.get.query({ workspaceId }).catch(() => ({ tree: null })),
        trpc.terminal.list
          .query({ workspaceId })
          .catch(() => ({ terminals: [] as { terminalId: string }[] })),
      ]);
      return {
        layout: tree,
        terminalIds: new Set(terminals.map((t: { terminalId: string }) => t.terminalId)),
      };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Debounced persist: serialize the full dockview layout + update cache
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const schedulePersist = useCallback(() => {
    if (isRestoringRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    persistToServer(workspaceId, api.toJSON(), { queryClient: queryClientRef.current });
  }, [workspaceId]);

  // Report the active terminal tab to the server as the workspace's last-focused
  // terminal — the target "Add to Terminal" routes references to. Gated on
  // `wsActive` and skipped during layout restore. Fire-and-forget.
  const reportTerminalFocus = useCallback(() => {
    if (isRestoringRef.current) return;
    if (wsActiveRef.current === false) return;
    const panelId = apiRef.current?.activePanel?.id;
    if (!panelId) return;
    trpc.panelFocus.set.mutate({ workspaceId, panelType: "terminal", panelId }).catch(() => {});
  }, [workspaceId]);

  const handleAddTab = useCallback(
    async (groupId?: string) => {
      const api = apiRef.current;
      if (!api) return;

      // Generate ID client-side so we can add the panel to the correct group
      // immediately, before the server emits a terminal-created event.
      const terminalId = newTerminalId();

      const options: Parameters<typeof api.addPanel>[0] = {
        id: terminalId,
        component: "terminalTab",
        tabComponent: "terminalTab",
        title: "Terminal",
        params: {
          workspaceId,
          terminalId,
          autoFocus: true,
        },
      };

      if (groupId) {
        (options as Record<string, unknown>).position = {
          referenceGroup: groupId,
        };
      }

      api.addPanel(options);

      // Create the server-side terminal (spawns PTY + updates layout + emits event).
      // The event handler will skip it since the panel already exists.
      try {
        await trpc.terminal.create.mutate({ workspaceId, id: terminalId });
      } catch (err) {
        console.error("[DockviewTerminalContainer] error creating terminal:", err);
      }
    },
    [workspaceId],
  );

  const handleSplit = useCallback(
    async (groupId: string, direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api) return;

      const terminalId = newTerminalId();

      api.addPanel({
        id: terminalId,
        component: "terminalTab",
        tabComponent: "terminalTab",
        title: "Terminal",
        params: {
          workspaceId,
          terminalId,
          autoFocus: true,
        },
        position: {
          referenceGroup: groupId,
          direction,
        },
      } as Parameters<typeof api.addPanel>[0]);

      try {
        await trpc.terminal.create.mutate({ workspaceId, id: terminalId });
      } catch (err) {
        console.error("[DockviewTerminalContainer] error creating split terminal:", err);
      }
    },
    [workspaceId],
  );

  const closeTab = useCallback((terminalId: string) => {
    const api = apiRef.current;
    if (!api || api.panels.length <= 1) return; // don't close last tab

    selectNeighbourBeforeRemove(api, terminalId);
    const panel = api.getPanel(terminalId);
    if (panel) {
      api.removePanel(panel);
    }

    // After closing, focus the xterm textarea in the newly active panel
    // so the terminal receives keyboard input immediately.
    requestAnimationFrame(() => {
      const activePanel = api.activePanel;
      if (!activePanel) return;
      activePanel.view.content.element
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
    });

    // Dispose the cached xterm instance (intentional close — tears down the
    // socket + surface, no reconnect). The server-side PTY is killed below.
    disposeTerminal(terminalId);

    // Kill the terminal on the server (kills PTY + removes from layout + emits event)
    trpc.terminal.kill.mutate({ terminalId }).catch((err) => {
      console.error("[DockviewTerminalContainer] failed to kill terminal:", err);
    });
  }, []);

  // Keyboard shortcuts (capture phase, scoped to this section's focus).
  // The outer modifier guard uses `mod = e.metaKey || e.ctrlKey`, so every
  // shortcut that names `Cmd+X` below also fires for `Ctrl+X` — that's
  // intentional for cross-platform support; readers should not assume
  // platform-specific dispatch.
  // - Cmd/Ctrl+T              → open a new terminal tab
  // - Cmd/Ctrl+W              → close the active terminal tab
  // - Ctrl+D                  → close the active terminal tab (Cmd owns split)
  // - Cmd/Ctrl+D              → split right (vertical split)
  // - Cmd/Ctrl+Shift+D        → split down (horizontal split)
  // - Ctrl+(Shift)+Tab        → cycle tabs in the active group
  // - Cmd/Ctrl+[ / Cmd/Ctrl+] → cycle between split terminal groups (panels)
  // - Cmd/Ctrl+Shift+[/]      → cycle tabs in the active group
  useEffect(() => {
    if (!visible) return;

    const refocusActivePanel = () => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      panel.view.content.element
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
    };

    const cycleTabs = (direction: 1 | -1) => {
      cycleTabsInActiveGroup(apiRef.current, direction, () => {
        requestAnimationFrame(refocusActivePanel);
      });
    };

    const cycleGroups = (direction: 1 | -1) => {
      cycleGridGroups(apiRef.current, direction, () => {
        requestAnimationFrame(refocusActivePanel);
      });
    };

    const handler = (e: KeyboardEvent) => {
      // Only handle shortcut if this container (or a descendant) has focus
      if (!containerRef.current?.contains(document.activeElement)) return;

      const key = e.key.toLowerCase();

      // Ctrl+(Shift)+Tab → cycle tabs within the active group
      if (e.ctrlKey && !e.metaKey && key === "tab") {
        e.preventDefault();
        e.stopPropagation();
        cycleTabs(e.shiftKey ? -1 : 1);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd/Ctrl+Shift+[ / Cmd/Ctrl+Shift+] → cycle tabs in active group
      if (e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleTabs(key === "]" ? 1 : -1);
        return;
      }

      // Cmd/Ctrl+[ / Cmd/Ctrl+] → cycle between split groups (panels)
      if (!e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        cycleGroups(key === "]" ? 1 : -1);
        return;
      }

      // Try to close the active tab; returns whether the close path actually
      // ran. Callers use the return value to decide whether to swallow the
      // keystroke. When `false` (no tab to close), the caller should let the
      // event bubble — Cmd+W on the last tab needs to reach Electron's menu
      // so the window can close, and Ctrl+D on the last tab needs to reach
      // xterm so the user's shell can receive EOF.
      const tryCloseActiveTab = (): boolean => {
        const api = apiRef.current;
        if (!api || api.panels.length <= 1) return false;
        const active = api.activePanel;
        if (!active) return false;
        closeTab(active.id);
        return true;
      };

      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleAddTab();
      } else if (key === "w" && !e.shiftKey) {
        // Don't preventDefault when there's nothing to close — let the OS /
        // Electron menu handle Cmd+W (close window) and let plain Ctrl+W
        // bubble up.
        if (tryCloseActiveTab()) {
          e.preventDefault();
          e.stopPropagation();
        }
      } else if (key === "d") {
        // Cmd+D / Cmd+Shift+D → split. Ctrl+D → close active tab (Cmd already
        // owns split, so reuse Ctrl+D for close).
        //
        // For the SPLIT branch we always `preventDefault` so unhandled
        // modifier-d combos that fall through (e.g. Ctrl+Shift+D, Cmd+Ctrl+D)
        // don't leak a stray `^D` to xterm.
        //
        // For the CLOSE branch we conditionally preventDefault — on the last
        // terminal tab `tryCloseActiveTab` returns false and we let Ctrl+D
        // through to xterm so the user can exit their shell with EOF.
        if (e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          const activeGroup = apiRef.current?.activeGroup;
          if (!activeGroup) return;
          handleSplit(activeGroup.id, e.shiftKey ? "below" : "right");
        } else if (e.ctrlKey && !e.metaKey && !e.shiftKey) {
          if (tryCloseActiveTab()) {
            e.preventDefault();
            e.stopPropagation();
          }
        } else {
          // Any other modifier-d combo (e.g. Ctrl+Shift+D, Cmd+Ctrl+D):
          // swallow so xterm doesn't see a stray `^D`. No close, no split.
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, closeTab, handleSplit, handleAddTab]);

  // Force a synchronous re-layout of the inner dockview when the outer
  // Terminal panel becomes visible. Background: dockview-core's
  // `watchElementResize` (node_modules/dockview-core/.../dom.js) wraps
  // its ResizeObserver callback in `requestAnimationFrame`, so the
  // first time the inner dockview's shell element gains real size
  // (because the outer panel just re-attached its DOM), the dockview
  // engine waits one frame before it re-applies inline `style.width` /
  // `style.height` on its splitview view containers. That frame paints
  // with the previous (often very narrow) width still inlined on those
  // containers — visible as the inner tab strip shrunk against the
  // left edge with the right-header action buttons clustered next to
  // it. Calling `api.layout(...)` synchronously inside
  // `useLayoutEffect` runs BEFORE paint, so the first painted frame
  // already has the correct widths.
  //
  // Zero-rect fallback: in the common case
  // `container.getBoundingClientRect()` returns the real size right
  // away because `useLayoutEffect` runs after React has committed
  // the DOM change. If the browser hasn't reflowed yet (rare timing
  // edge), the rect comes back 0×0 and we'd silently skip the fix.
  // The ResizeObserver's guaranteed initial delivery catches that
  // case by deferring `api.layout()` until the container actually
  // has non-zero size, avoiding the silent no-op.
  //
  // The observer stays attached for the whole visible period (it is
  // NOT a one-shot). The synchronous measure above can run one effect
  // ahead of a container resize: on a workspace switch back into a
  // workspace with a saved maximize, this (child) layout effect
  // measures while the outer dockview is still in the previous
  // workspace's split, and `SharedDockviewLayout`'s switch effect
  // re-applies the maximize — growing this container — only
  // afterwards. That transient pre-maximize size never reaches a
  // rendered frame, so dockview-core's own `watchElementResize` (which
  // compares against the size it last delivered) can miss the change,
  // leaving the inner splitview inlined at the stale split width — the
  // "ghost panel" regression in #490's maximize-restore flow. A
  // persistent observer gets the post-maximize size delivered
  // regardless (initial delivery on `observe()` + one per subsequent
  // change) and re-layouts.
  //
  // Both paths funnel through a last-applied-dims dedupe: the
  // observer's guaranteed initial delivery repeats the synchronous
  // measure's size, and re-forcing `api.layout` for identical dims
  // would cascade a redundant full re-layout (an xterm refit + PTY
  // resize message per terminal) on every reveal. The ghost-panel fix
  // is unaffected — the post-maximize delivery arrives with different
  // dims and still lays out.
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
      if (w <= 0 || h <= 0) return;
      if (w === lastWidth && h === lastHeight) return;
      lastWidth = w;
      lastHeight = h;
      api.layout(w, h, true);
    };
    const rect = container.getBoundingClientRect();
    applyLayout(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyLayout(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [visible]);

  // Auto-focus the active terminal's xterm textarea whenever the section
  // becomes visible (e.g. user clicked the outer "Terminal" panel tab).
  // Without this, the section-scoped keydown handler above bails out because
  // document.activeElement is outside containerRef — meaning shortcuts only
  // worked after the user manually clicked into a tab.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      panel.view.content.element
        .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        ?.focus();
      // Record a baseline last-focused terminal as soon as the section is shown,
      // so "Add to Terminal" has a target even if the user never switches tabs.
      reportTerminalFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, reportTerminalFocus]);

  // Bring the last-focused terminal tab forward when "Add to Terminal" targets
  // it. SharedDockviewLayout resolves the workspace's last-focused terminal and
  // dispatches the scoped `band:terminal-insert` with that id; activating the
  // matching inner tab makes it visible so `TerminalPanel` flushes the pending
  // reference into it. Mirrors the chat container's `band:chat-insert` handler.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TerminalInsertDetail>).detail;
      if (!detail?.terminalId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.terminalId)?.api.setActive();
    };
    window.addEventListener("band:terminal-insert", handler);
    return () => window.removeEventListener("band:terminal-insert", handler);
  }, [workspaceId]);

  // Sync dockview panels when terminals are created/killed externally (e.g. CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "terminal-created" && typeof event.terminalId === "string") {
        // Skip if this panel already exists (we created it ourselves)
        if (api.getPanel(event.terminalId)) return;
        // Pin the new panel to the inner dockview's central area.
        // Without this explicit position, dockview's fallback uses
        // `activeGroup`, which can be one of the collapsed edge
        // groups added by `ensureEdgeGroups` — making the panel
        // render as a thin docked strip. See `centralPanelPosition`
        // for the full rationale.
        api.addPanel({
          id: event.terminalId,
          component: "terminalTab",
          tabComponent: "terminalTab",
          title: "Terminal",
          params: { workspaceId, terminalId: event.terminalId },
          position: centralPanelPosition(api),
        });
      } else if (event.kind === "terminal-killed" && typeof event.terminalId === "string") {
        // Dispose the cached xterm too so an externally-killed terminal (e.g.
        // via the CLI) doesn't leave an orphaned instance + socket behind.
        disposeTerminal(event.terminalId);
        const panel = api.getPanel(event.terminalId);
        if (panel) {
          api.removePanel(panel);
          // If that was the last panel, create a fresh default terminal
          if (api.panels.length === 0) {
            createDefaultTerminal(api, workspaceId);
          }
        }
      }
    });
  }, [adapter, workspaceId]);

  // Per-instance action handlers for the stable Dockview header/tab
  // components. Registered in `panelActionsByApiId` (keyed by this inner
  // dockview's `api.id`) from `onReady`; mutated every render so the registry
  // always holds this instance's latest closures.
  const actionsRef = useRef<TerminalPanelActions>({
    onAdd: () => {},
    onSplit: () => {},
    onClose: () => {},
  });
  actionsRef.current = { onAdd: handleAddTab, onSplit: handleSplit, onClose: closeTab };

  // Detach edge-group drag-visibility listeners + inner-dockview
  // registration, and drop this instance's action handlers, on unmount.
  useEffect(() => {
    return () => {
      const api = apiRef.current;
      if (api) panelActionsByApiId.delete(api.id);
      edgeDragDisposerRef.current?.();
      edgeDragDisposerRef.current = null;
      innerRegisterDisposerRef.current?.();
      innerRegisterDisposerRef.current = null;
    };
  }, []);

  // Use refs for the initial data so onReady's closure captures the latest
  const initialLayoutRef = useRef<unknown | null>(null);
  initialLayoutRef.current = initialData?.layout ?? null;
  const initialTerminalIdsRef = useRef<Set<string> | null>(null);
  initialTerminalIdsRef.current = initialData?.terminalIds ?? null;
  // Mirror `visible` into a ref so onReady can decide whether to
  // force-layout the freshly-attached api. Covers the cold-mount
  // path where the `useLayoutEffect([visible])` below ran with
  // `apiRef.current === null` (because dockview hadn't initialised
  // yet) and so silently bailed.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      // Defensive double-onReady guard (mirrors the disposer guards below):
      // if onReady fires again with a fresh api, drop the previous registry
      // entry so it doesn't orphan — unmount only deletes the last-seen id.
      const prevApi = apiRef.current;
      if (prevApi && prevApi.id !== event.api.id) panelActionsByApiId.delete(prevApi.id);
      apiRef.current = event.api;
      // Register this instance's handlers under the inner dockview's id so the
      // header/tab components resolve to the correct workspace (see registry).
      panelActionsByApiId.set(event.api.id, actionsRef);
      const savedLayout = initialLayoutRef.current;
      const knownTerminalIds = initialTerminalIdsRef.current;

      if (savedLayout && isDockviewLayout(savedLayout)) {
        // Restore full dockview layout (preserves groups, splits, sizes)
        isRestoringRef.current = true;
        try {
          // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON API requires any
          event.api.fromJSON(savedLayout as any);
        } catch (err) {
          console.error("[DockviewTerminalContainer] fromJSON failed, creating default:", err);
          createDefaultTerminal(event.api, workspaceId);
        }

        // Prune panels whose terminal sessions no longer exist on the server
        // (e.g. PTYs died during server restart).
        let dropped = 0;
        if (knownTerminalIds) {
          const orphans = event.api.panels.filter((p) => !knownTerminalIds.has(p.id));
          for (const orphan of orphans) {
            event.api.removePanel(orphan);
            dropped++;
          }
          // If all panels were orphaned, create a fresh default terminal.
          if (event.api.panels.length === 0) {
            createDefaultTerminal(event.api, workspaceId);
            dropped++;
          }
        }

        // Allow persistence after restoration settles
        setTimeout(() => {
          isRestoringRef.current = false;
        }, 0);

        // Persist the cleaned-up layout if orphans were removed. The
        // dockview events that fired during `removePanel` landed inside
        // the restoration window and were swallowed by
        // `schedulePersist`'s `isRestoringRef` guard, so without this
        // explicit save the saved `terminal_layout` row would never
        // converge with `terminal.list`.
        if (dropped > 0) {
          persistToServer(workspaceId, event.api.toJSON(), {
            queryClient: queryClientRef.current,
          });
        }
      } else {
        // No saved layout — check for workspace terminal config, then create default
        seedFromConfigOrDefault(event.api, workspaceId, queryClientRef.current);
      }

      // Ensure the three cardinal edge groups (left/right/bottom) exist so
      // future panels can be docked to the edges of this inner container.
      // MUST be called BEFORE the `onDidLayoutChange` registration below —
      // `ensureEdgeGroups` may synchronously add edge groups and call
      // `setEdgeGroupVisible`, and routing those events through
      // `schedulePersist` would write a spurious initial save. Idempotent
      // on restored layouts.
      ensureEdgeGroups(event.api);

      // Drag-visibility: while the user drags a panel/group, force every
      // edge group visible so it can accept a drop; once the drag ends,
      // hide any edge groups that are still empty. Dispose the previous
      // registration if onReady somehow fires twice.
      edgeDragDisposerRef.current?.();
      edgeDragDisposerRef.current = attachEdgeGroupDragVisibility(event.api);

      // Register with the global edge-shortcut registry so ⌘B / ⌥⌘B / ⌘J
      // in SharedDockviewLayout's keydown can route to this inner dockview
      // when focus is inside it. Same defensive double-onReady guard.
      innerRegisterDisposerRef.current?.();
      if (containerRef.current) {
        innerRegisterDisposerRef.current = registerInnerDockview(containerRef.current, event.api);
      }

      // Listen for any layout changes and auto-persist
      const persist = () => schedulePersist();
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);
      event.api.onDidActivePanelChange(() => {
        persist();
        reportTerminalFocus();
      });
      event.api.onDidAddGroup(persist);
      event.api.onDidRemoveGroup(persist);

      // Cold-mount catch-up: if the outer Terminal panel was already
      // visible when this container first rendered, the
      // `useLayoutEffect([visible])` below already fired with
      // `apiRef.current === null` (dockview wasn't initialised yet)
      // and silently bailed. DockviewReact's own mount effect calls
      // `api.layout(clientWidth, clientHeight)` immediately before
      // `onReady`, so the dockview IS correctly laid out at this
      // point — but make that guarantee explicit by re-running the
      // forced layout here if we're currently visible. Idempotent.
      if (visibleRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          event.api.layout(Math.round(rect.width), Math.round(rect.height), true);
        }
      }
    },
    [workspaceId, schedulePersist, reportTerminalFocus],
  );

  const visibilityValue = useMemo(
    () => ({ visible: visible && wsActive !== false, wsActive: wsActive !== false }),
    [visible, wsActive],
  );

  // Don't render dockview until the initial layout is fetched from the server.
  if (!initialData) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={terminalTabTheme}
          className="h-full"
          components={terminalPanelComponents}
          tabComponents={terminalTabComponents}
          defaultTabComponent={TerminalTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </PanelVisibilityContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default terminal creation
// ---------------------------------------------------------------------------

function createDefaultTerminal(api: DockviewApi, workspaceId: string): void {
  // Generate ID client-side so we can add the panel immediately.
  const terminalId = newTerminalId();

  // Pin the default panel to the inner dockview's central area so it
  // lands there instead of leaking into an edge group that
  // `ensureEdgeGroups` may have already added. See
  // `centralPanelPosition` for the full rationale.
  api.addPanel({
    id: terminalId,
    component: "terminalTab",
    tabComponent: "terminalTab",
    title: "Terminal",
    params: {
      workspaceId,
      terminalId,
    },
    position: centralPanelPosition(api),
  });

  // Create the server-side terminal (spawns PTY + updates layout + emits event).
  // The event handler will skip it since the panel already exists.
  trpc.terminal.create.mutate({ workspaceId, id: terminalId }).catch((err) => {
    console.error("[DockviewTerminalContainer] error creating default terminal:", err);
  });
}

// ---------------------------------------------------------------------------
// Seed layout from workspace terminal config or create default
// ---------------------------------------------------------------------------

async function seedFromConfigOrDefault(
  api: DockviewApi,
  workspaceId: string,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  try {
    const { config } = await trpc.workspace.getTerminalConfig.query({ workspaceId });
    if (config?.layout) {
      // Flatten the config tree into pane nodes and create terminals for each
      const panes = flattenConfigPanes(config.layout);
      if (panes.length > 0) {
        for (const pane of panes) {
          try {
            const terminalId = newTerminalId();
            // `seedFromConfigOrDefault` is async and runs AFTER the
            // synchronous `ensureEdgeGroups` call in `onReady` — by
            // the time we get here, the inner dockview's collapsed
            // edge groups already exist. Pin each seeded panel to
            // the central area so it lands there instead of being
            // appended into one of those edge groups. See
            // `centralPanelPosition` for the full rationale.
            api.addPanel({
              id: terminalId,
              component: "terminalTab",
              tabComponent: "terminalTab",
              title: pane.name ?? "Terminal",
              params: {
                workspaceId,
                terminalId,
                command: pane.command,
                cwd: pane.cwd,
                env: pane.env,
              },
              position: centralPanelPosition(api),
            });
            await trpc.terminal.create.mutate({
              workspaceId,
              id: terminalId,
              command: pane.command,
              cwd: pane.cwd,
              env: pane.env,
            });
          } catch (err) {
            console.error("[DockviewTerminalContainer] error creating terminal from config:", err);
          }
        }
        // Persist the seeded layout
        persistToServer(workspaceId, api.toJSON(), { queryClient });
        return;
      }
    }
  } catch {
    // Failed to fetch config — fall through to default
  }

  // No config — create a single default terminal
  createDefaultTerminal(api, workspaceId);
}

// ---------------------------------------------------------------------------
// Flatten terminal config layout into pane list
// ---------------------------------------------------------------------------

interface ConfigPane {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

function flattenConfigPanes(node: unknown, depth = 0): ConfigPane[] {
  if (depth > 10 || typeof node !== "object" || node === null) return [];

  const n = node as Record<string, unknown>;

  // Pane node
  if ("pane" in n && typeof n.pane === "object" && n.pane !== null) {
    const pane = n.pane as Record<string, unknown>;
    return [
      {
        name: typeof pane.name === "string" ? pane.name : undefined,
        command: typeof pane.command === "string" ? pane.command : undefined,
        cwd: typeof pane.cwd === "string" ? pane.cwd : undefined,
        env:
          typeof pane.env === "object" && pane.env !== null
            ? (pane.env as Record<string, string>)
            : undefined,
      },
    ];
  }

  // Split node
  if ("children" in n && Array.isArray(n.children)) {
    const result: ConfigPane[] = [];
    for (const child of n.children) {
      result.push(...flattenConfigPanes(child, depth + 1));
    }
    return result;
  }

  return [];
}
