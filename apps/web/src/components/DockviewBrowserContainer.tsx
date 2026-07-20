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
import { Columns2, Globe, Plus, Rows2, X } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAdapter } from "@/dashboard";
import { useAppShortcut } from "../hooks/useAppShortcut";
import { injectInitialUrls } from "../lib/browser-layout";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
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
import { isDesktop } from "../lib/is-desktop";
import { DOCK_SHORTCUTS } from "../lib/shortcuts";
import { trpc } from "../lib/trpc-client";
import { BrowserPaneComponent, type BrowserPaneParams, useFavicon } from "./BrowserPanel";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";

// ---------------------------------------------------------------------------
// Track browser IDs that were just created by an "add tab" action.
// BrowserPane checks this to skip server fetch and start fresh.
// ---------------------------------------------------------------------------

const freshBrowserIds = new Set<string>();

/** Mark a browserId as freshly created (by add-tab). */
export function markBrowserFresh(browserId: string): void {
  freshBrowserIds.add(browserId);
}

/** Check (and consume) whether a browserId is fresh. */
export function consumeBrowserFresh(browserId: string): boolean {
  return freshBrowserIds.delete(browserId);
}

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

export function newBrowserId(): string {
  return `browser_${uuid()}`;
}

// ---------------------------------------------------------------------------
// React Query cache key
// ---------------------------------------------------------------------------

function browserLayoutKey(workspaceId: string) {
  return ["browserLayout", workspaceId] as const;
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
  // Derive browserIds from the layout's panels map so the cache stays
  // in sync — prevents orphan-pruning on remount after CLI additions.
  // The `urls` map is owned by the queryFn (it comes from
  // `trpc.browsers.list`) — preserve whatever the cache already holds,
  // since URL changes are persisted via `trpc.browsers.navigate` and
  // don't flow through this code path.
  if (opts?.queryClient) {
    const prev = opts.queryClient.getQueryData<BrowserLayoutData>(browserLayoutKey(workspaceId));
    opts.queryClient.setQueryData(browserLayoutKey(workspaceId), {
      layout,
      browserIds: panelIdsFromLayout(layout),
      urls: prev?.urls ?? new Map<string, string>(),
    });
  }

  const existing = saveTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    workspaceId,
    setTimeout(() => {
      saveTimers.delete(workspaceId);
      trpc.browserLayout.save.mutate({ workspaceId, tree: layout }).catch((err) => {
        console.error("[DockviewBrowserContainer] failed to persist layout:", err);
      });
    }, 500),
  );
}

// ---------------------------------------------------------------------------
// Cached data shape
// ---------------------------------------------------------------------------

interface BrowserLayoutData {
  layout: unknown | null;
  browserIds: Set<string>;
  /**
   * Latest URL the server has on file for each browser, indexed by
   * browserId. Injected into the layout's panel params on restore so
   * BrowserPaneComponent mounts with `initialUrl` already set, instead
   * of having to round-trip through `trpc.browsers.get` and racing the
   * create-webview effect.
   */
  urls: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Legacy layout detection
// ---------------------------------------------------------------------------

function isDockviewLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

// ---------------------------------------------------------------------------
// Dockview theme (reuse the band theme from the outer instance)
// ---------------------------------------------------------------------------

const browserTabTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band dockview-browser-tabs",
};

// ---------------------------------------------------------------------------
// Browser tab panel component (renders inside each dockview tab)
// ---------------------------------------------------------------------------

// Visibility is propagated from DockviewBrowserContainer via the shared
// PanelVisibilityContext instead of dockview's updateParameters (which
// clobbers params).

interface BrowserTabParams {
  workspaceId: string;
  browserId: string;
  initialUrl?: string;
}

function BrowserTabPanel({ params, api }: IDockviewPanelProps<BrowserTabParams>) {
  const { visible } = usePanelVisibility();

  if (!params.workspaceId || !params.browserId) return null;

  // Build params for BrowserPaneComponent (it uses IDockviewPanelProps shape)
  // Pass `visible` (which combines outer panel visibility AND workspace activity)
  // as `wsActive` — BrowserPaneComponent uses this to hide/show the native webview
  // for reasons external to the inner browser dockview (e.g. switching to Changes tab).
  const paneParams: BrowserPaneParams = {
    workspaceId: params.workspaceId,
    browserId: params.browserId,
    wsActive: visible,
    initialUrl: params.initialUrl,
  };

  return (
    // `data-testid` encodes the visibility signal the SHARED
    // `PanelVisibilityContext` propagated into this tab panel
    // (see `panel-visibility-context.tsx`), so an integration test can
    // assert the context plumbing reaches the leaf. Note: the browser
    // path is only mounted in the Electron desktop build (see
    // `SharedDockviewLayout`'s `BrowserPanelComponent` web-fallback
    // branch), so the marker is only observable from desktop e2e
    // coverage — but the assignment is part of the same shared-context
    // contract, so we mark it here for parity.
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`dockview-browser-tab__visible-${visible ? "true" : "false"}`}
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
// Custom tab header: globe icon + title + close button
// ---------------------------------------------------------------------------

function BrowserTab(props: IDockviewPanelHeaderProps<BrowserTabParams>) {
  const [title, setTitle] = useState(props.api.title ?? "New Tab");
  const [faviconError, setFaviconError] = useState(false);

  const browserId = props.params.browserId;
  const faviconUrl = useFavicon(browserId);
  const prevFaviconRef = useRef(faviconUrl);

  // Reset error state when the favicon URL changes
  if (faviconUrl !== prevFaviconRef.current) {
    prevFaviconRef.current = faviconUrl;
    if (faviconError) setFaviconError(false);
  }

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "New Tab"));
    return () => d.dispose();
  }, [props.api]);

  const containerApi = props.containerApi;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Route to the handlers owned by THIS tab's dockview (keyed by
      // `containerApi.id`) so closing a tab never hits a cached workspace.
      panelActionsByApiId.get(containerApi.id)?.current?.onClose(browserId);
    },
    [containerApi, browserId],
  );

  const showFavicon = faviconUrl && !faviconError;

  return (
    <div className="dv-default-tab">
      <div className="flex items-center gap-1.5 min-w-0">
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
        <span className="truncate">{title}</span>
      </div>
      <button
        type="button"
        className="ml-1 inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 hover:bg-accent transition-colors"
        onClick={handleClose}
        title="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-instance action registry for stable Dockview components
//
// dockview's `rightHeaderActionsComponent` and tab header components must be
// STABLE references, but the handlers they invoke are per-container-instance
// (each mounted DockviewBrowserContainer has its own `workspaceId` + inner
// dockview api). MultiWorkspacePanelHost keeps up to 3 workspaces mounted at
// once (inactive ones only `visibility: hidden`), so a module-level handler
// ref suffered last-writer-wins: a hidden instance's handlers would handle a
// click made in the visible workspace, creating the browser tab in the wrong
// (cached) workspace.
//
// Fix: key the handlers by the owning dockview's `api.id`. dockview passes the
// owning `containerApi` into header-action + tab-header props; every wrapper
// shares the same underlying component `id` even though the DockviewApi object
// differs per group. The value is the instance's `useRef` holder so clicks
// always read the latest closures via `.current`.
// ---------------------------------------------------------------------------

/**
 * Options for `handleAddTab` and `BrowserPanelActions.onAdd`.
 *
 * `initialUrl` lets callers materialize a tab that loads a specific
 * URL on mount — used by the `browser-open-window` listener (issue
 * #488) to forward `window.open(url)` / `target="_blank"` clicks
 * into a new Band tab. When omitted the tab opens blank, matching
 * the Cmd+T / "+" button UX.
 */
interface AddTabOptions {
  initialUrl?: string;
}

interface BrowserPanelActions {
  onAdd: (groupId?: string, options?: AddTabOptions) => void;
  onSplit: (groupId: string, direction: "right" | "below") => void;
  onClose: (browserId: string) => void;
}

const panelActionsByApiId = new Map<string, { current: BrowserPanelActions }>();

/**
 * Stable component for DockviewReact's rightHeaderActionsComponent.
 * Resolves the per-instance handlers from `panelActionsByApiId` keyed by the
 * owning `containerApi.id` (see the registry comment above) to avoid the
 * "only React.memo/forwardRef/function components accepted" error while still
 * routing each click to the workspace that owns the clicked group.
 */
const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  // Edge groups (left/right/bottom) don't support splits — dockview's
  // `addPanel` with `position: { referenceGroup: <edge>, direction }`
  // silently ignores the direction and just adds a tab. We still show
  // the "+" button there so users can add another browser tab to the
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
      data-testid={isGridGroup ? "dockview-browser__toolbar" : undefined}
    >
      {isGridGroup && (
        <>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            onClick={() => panelActionsByApiId.get(apiId)?.current?.onSplit(groupId, "right")}
            title="Split right"
          >
            <Columns2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            onClick={() => panelActionsByApiId.get(apiId)?.current?.onSplit(groupId, "below")}
            title="Split down"
          >
            <Rows2 className="size-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => panelActionsByApiId.get(apiId)?.current?.onAdd(groupId)}
        title="New browser tab"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Dockview panel/tab component registries
// ---------------------------------------------------------------------------

const browserPanelComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelProps<BrowserTabParams>>
> = {
  browserTab: BrowserTabPanel,
};

const browserTabComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelHeaderProps<BrowserTabParams>>
> = {
  browserTab: BrowserTab,
};

// ---------------------------------------------------------------------------
// Main container
// ---------------------------------------------------------------------------

interface DockviewBrowserContainerProps {
  workspaceId: string;
  visible: boolean;
  wsActive?: boolean;
}

export function DockviewBrowserContainer({
  workspaceId,
  visible,
  wsActive,
}: DockviewBrowserContainerProps) {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const apiRef = useRef<DockviewApi | null>(null);
  const isRestoringRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror `wsActive` for use inside stable closures so focus reporting only
  // fires for the workspace the user is looking at — never for the cached,
  // hidden workspaces MultiWorkspacePanelHost keeps alive.
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

  // Fetch layout AND browser records via React Query — cached across mounts
  // so re-visiting a workspace renders instantly from the cache.
  const { data: initialData } = useQuery<BrowserLayoutData>({
    queryKey: browserLayoutKey(workspaceId),
    queryFn: async () => {
      const [{ tree }, { browsers }] = await Promise.all([
        trpc.browserLayout.get.query({ workspaceId }).catch(() => ({ tree: null })),
        trpc.browsers.list
          .query({ workspaceId })
          .catch(() => ({ browsers: [] as { id: string; url?: string }[] })),
      ]);
      const urls = new Map<string, string>();
      for (const b of browsers as { id: string; url?: string }[]) {
        // Skip empty / about:blank — those won't usefully seed
        // `initialUrl` and would just suppress the fallback fetch.
        if (b.url && b.url !== "about:blank") urls.set(b.id, b.url);
      }
      return {
        layout: tree,
        browserIds: new Set(browsers.map((b: { id: string }) => b.id)),
        urls,
      };
    },
    staleTime: Number.POSITIVE_INFINITY, // never auto-refetch — we manage persistence ourselves
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

  // Report the active browser tab to the server as the workspace's last-focused
  // browser. Gated on `wsActive` and skipped during layout restore.
  // Fire-and-forget — tracked for symmetry with chat/terminal focus.
  const reportBrowserFocus = useCallback(() => {
    if (isRestoringRef.current) return;
    if (wsActiveRef.current === false) return;
    const panelId = apiRef.current?.activePanel?.id;
    if (!panelId) return;
    trpc.panelFocus.set.mutate({ workspaceId, panelType: "browser", panelId }).catch(() => {});
  }, [workspaceId]);

  const handleAddTab = useCallback(
    async (groupId?: string, addOptions?: AddTabOptions) => {
      const api = apiRef.current;
      if (!api) return;

      const browserId = newBrowserId();
      markBrowserFresh(browserId);

      const initialUrl = addOptions?.initialUrl;

      // Build panel options, targeting the specific group if provided.
      // `initialUrl` (when present) gets injected into the panel's
      // params so `BrowserPaneComponent` mounts with the URL already
      // in hand — avoids the create-webview / server-fetch race on
      // tabs spawned from `window.open` (issue #488).
      const options: Parameters<typeof api.addPanel>[0] = {
        id: browserId,
        component: "browserTab",
        tabComponent: "browserTab",
        title: "New Tab",
        params: {
          workspaceId,
          browserId,
          ...(initialUrl ? { initialUrl } : {}),
        },
      };

      if (groupId) {
        (options as Record<string, unknown>).position = {
          referenceGroup: groupId,
        };
      }

      // Important: add the dockview panel BEFORE the trpc mutation. The
      // server fires a `browser-created` status event on success, which
      // `subscribeStatusEvents` (below) reacts to by also calling
      // `api.addPanel` — without a `position`, so it always adds as a
      // tab in the active group. Calling addPanel first means the
      // status-event listener finds the panel already exists and skips.
      // For handleAddTab the outcome is the same either way, but
      // handleSplit relies on the same ordering to preserve its
      // `position.direction` — see comment there.
      api.addPanel(options);

      try {
        // Persist `initialUrl` to the server-side browser record so
        // workspace restarts and CLI-side `browsers.get` queries see
        // the right starting URL.
        await trpc.browsers.create.mutate({
          workspaceId,
          id: browserId,
          ...(initialUrl ? { url: initialUrl } : {}),
        });
      } catch (err) {
        console.error("[DockviewBrowserContainer] error pre-creating browser:", err);
      }
      // Layout change listeners will auto-persist
    },
    [workspaceId],
  );

  const handleSplit = useCallback(
    async (groupId: string, direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api) return;

      const browserId = newBrowserId();
      markBrowserFresh(browserId);

      // Add the dockview panel BEFORE the trpc mutation — the server
      // fires `browser-created` on success, which `subscribeStatusEvents`
      // reacts to with its own positionless `api.addPanel` call (always
      // a tab in the active group). If we awaited the trpc call first,
      // that listener races handleSplit and wins, dropping the panel
      // into the active group as a tab and then `handleSplit`'s
      // positioned addPanel throws "panel already exists" — which is
      // exactly what was making Cmd+D / the Split right button feel
      // broken for the browser section. The terminal container uses the
      // same ordering for the same reason.
      try {
        api.addPanel({
          id: browserId,
          component: "browserTab",
          tabComponent: "browserTab",
          title: "New Tab",
          params: {
            workspaceId,
            browserId,
          },
          position: {
            referenceGroup: groupId,
            direction,
          },
        } as Parameters<typeof api.addPanel>[0]);
      } catch (err) {
        console.error("[DockviewBrowserContainer] split addPanel threw:", err);
        return;
      }

      try {
        await trpc.browsers.create.mutate({ workspaceId, id: browserId });
      } catch (err) {
        console.error("[DockviewBrowserContainer] error creating split browser:", err);
      }
    },
    [workspaceId],
  );

  const closeTab = useCallback(
    (browserId: string) => {
      const api = apiRef.current;
      if (!api) return;

      selectNeighbourBeforeRemove(api, browserId);
      const panel = api.getPanel(browserId);
      if (panel) {
        api.removePanel(panel);
      }

      // Closing the last tab would leave an empty pane — spawn a fresh
      // blank tab so the browser section is never a dead end (matches the
      // self-heal in the `browser-removed` status-event handler).
      if (api.panels.length === 0) {
        createDefaultPanel(api, workspaceId);
      }

      // After closing, focus the address bar in the newly active panel so the
      // section-scoped shortcuts still see Cmd+W on the next press.
      requestAnimationFrame(() => {
        const activePanel = api.activePanel;
        if (!activePanel) return;
        activePanel.view.content.element
          .querySelector<HTMLInputElement>("[data-band-address-input]")
          ?.focus();
      });

      // Delete the server-side browser record so closed tabs don't linger.
      trpc.browsers.remove.mutate({ browserId }).catch((err) => {
        console.error("[DockviewBrowserContainer] failed to remove browser:", err);
      });
      // Layout change listeners will auto-persist
    },
    [workspaceId],
  );

  // Keyboard shortcuts, scoped to this section's focus:
  // - Cmd+T              → open a new browser tab
  // - Cmd+W              → close the active browser tab
  // - Cmd+D              → split right (vertical split)
  // - Cmd+Shift+D        → split down (horizontal split)
  // - Cmd+R              → reload the active browser tab (desktop only)
  // - Ctrl+(Shift)+Tab   → cycle tabs in the active group
  // - Cmd+[ / Cmd+]      → cycle between split browser groups (panels)
  // - Cmd+Shift+[/]      → cycle tabs in the active group
  //
  // Combos come from `DOCK_SHORTCUTS`, shared with the chat, terminal and
  // file-tab docks. Scoping is `react-hotkeys-hook`'s returned ref rather than
  // the hand-written `containerRef.contains(document.activeElement)` check that
  // used to guard a window-level capture listener: each binding listens on this
  // container's root, so it only fires while that element or a descendant holds
  // focus. `useAppShortcut` supplies capture-phase listening, form-tag
  // enablement (the address bar is the usual focus target here) and
  // `preventDefault`. `stopPropagation` is called by hand wherever the old
  // handler called it, so the chord never also reaches the focused input.
  //
  // `data-band-address-input` is set on the address-bar input in
  // BrowserPanel.tsx — using the data attribute (rather than
  // `input[type='text']`) avoids matching the find-bar input.
  const refocusAddressBar = useCallback(() => {
    const panel = apiRef.current?.activePanel;
    if (!panel) return;
    panel.view.content.element
      .querySelector<HTMLInputElement>("[data-band-address-input]")
      ?.focus();
  }, []);

  const cycleTabs = useCallback(
    (direction: 1 | -1) => {
      cycleTabsInActiveGroup(apiRef.current, direction, () => {
        requestAnimationFrame(refocusAddressBar);
      });
    },
    [refocusAddressBar],
  );

  const cycleGroups = useCallback(
    (direction: 1 | -1) => {
      cycleGridGroups(apiRef.current, direction, () => {
        requestAnimationFrame(refocusAddressBar);
      });
    },
    [refocusAddressBar],
  );

  // Bindings are only live while the section is visible — same gate the
  // effect-based handler applied before registering its listener.
  const shortcutOptions = { enabled: visible };

  const cycleForwardRef = useAppShortcut(
    DOCK_SHORTCUTS.cycleTabForward,
    (e) => {
      e.stopPropagation();
      cycleTabs(1);
    },
    shortcutOptions,
    [cycleTabs, visible],
  );
  const cycleBackwardRef = useAppShortcut(
    DOCK_SHORTCUTS.cycleTabBackward,
    (e) => {
      e.stopPropagation();
      cycleTabs(-1);
    },
    shortcutOptions,
    [cycleTabs, visible],
  );
  const nextTabRef = useAppShortcut(
    DOCK_SHORTCUTS.nextTab,
    (e) => {
      e.stopPropagation();
      cycleTabs(1);
    },
    shortcutOptions,
    [cycleTabs, visible],
  );
  const previousTabRef = useAppShortcut(
    DOCK_SHORTCUTS.previousTab,
    (e) => {
      e.stopPropagation();
      cycleTabs(-1);
    },
    shortcutOptions,
    [cycleTabs, visible],
  );
  const nextGroupRef = useAppShortcut(
    DOCK_SHORTCUTS.nextGroup,
    (e) => {
      e.stopPropagation();
      cycleGroups(1);
    },
    shortcutOptions,
    [cycleGroups, visible],
  );
  const previousGroupRef = useAppShortcut(
    DOCK_SHORTCUTS.previousGroup,
    (e) => {
      e.stopPropagation();
      cycleGroups(-1);
    },
    shortcutOptions,
    [cycleGroups, visible],
  );

  const newTabRef = useAppShortcut(
    DOCK_SHORTCUTS.newTab,
    (e) => {
      e.stopPropagation();
      handleAddTab().then(() => {
        // Focus the address bar in the newly created panel.
        requestAnimationFrame(refocusAddressBar);
      });
    },
    shortcutOptions,
    [handleAddTab, refocusAddressBar, visible],
  );

  const closeTabRef = useAppShortcut(
    DOCK_SHORTCUTS.closeTab,
    (e) => {
      const api = apiRef.current;
      if (!api) return;
      e.preventDefault();
      e.stopPropagation();
      const active = api.activePanel;
      if (active) {
        closeTab(active.id);
      }
    },
    { ...shortcutOptions, preventDefault: false },
    [closeTab, visible],
  );

  const splitRightRef = useAppShortcut(
    DOCK_SHORTCUTS.splitRight,
    (e) => {
      e.stopPropagation();
      const activeGroup = apiRef.current?.activeGroup;
      if (!activeGroup) return;
      handleSplit(activeGroup.id, "right");
    },
    shortcutOptions,
    [handleSplit, visible],
  );
  const splitDownRef = useAppShortcut(
    DOCK_SHORTCUTS.splitDown,
    (e) => {
      e.stopPropagation();
      const activeGroup = apiRef.current?.activeGroup;
      if (!activeGroup) return;
      handleSplit(activeGroup.id, "below");
    },
    shortcutOptions,
    [handleSplit, visible],
  );

  // ⌘R reloads the embedded WebContentsView — desktop only, since the plain web
  // build has no such view to reload, and unbound there so the browser's own
  // page reload keeps working. No `DOCK_SHORTCUTS` entry: it is this dock's
  // alone. `preventDefault` stays conditional on there being a browser id to
  // reload, matching the old handler's ordering.
  //
  // Both modifier spellings are bound rather than `mod+r`: the old handler gated
  // on `e.metaKey || e.ctrlKey`, so Ctrl+R reloaded on macOS too, and `mod`
  // would collapse that to ⌘ alone there.
  const reloadRef = useAppShortcut(
    { binding: "meta+r, ctrl+r", display: "Cmd+R" },
    (e) => {
      const active = apiRef.current?.activePanel;
      const browserId = (active?.params as BrowserTabParams | undefined)?.browserId;
      if (!browserId) return;
      e.preventDefault();
      e.stopPropagation();
      desktopInvoke("browser_reload", { browserId }).catch((err) => {
        console.error("[DockviewBrowserContainer] browser_reload failed:", err);
      });
    },
    { enabled: visible && isDesktop, preventDefault: false },
    [visible],
  );

  // All bindings scope to the same root element, so their ref callbacks are
  // fanned out through one composed callback. The library's setters are stable,
  // so listing them as deps keeps this callback stable too — an unstable ref
  // callback would detach and re-attach (and re-register every listener) on
  // every render.
  const setContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      for (const attach of [
        cycleForwardRef,
        cycleBackwardRef,
        nextTabRef,
        previousTabRef,
        nextGroupRef,
        previousGroupRef,
        newTabRef,
        closeTabRef,
        splitRightRef,
        splitDownRef,
        reloadRef,
      ]) {
        attach(element);
      }
    },
    [
      cycleForwardRef,
      cycleBackwardRef,
      nextTabRef,
      previousTabRef,
      nextGroupRef,
      previousGroupRef,
      newTabRef,
      closeTabRef,
      splitRightRef,
      splitDownRef,
      reloadRef,
    ],
  );

  // Force a synchronous re-layout of the inner dockview when the outer
  // Browser panel becomes visible. See the matching effect (and its
  // long comment) in DockviewTerminalContainer for the full rationale:
  // dockview-core's `watchElementResize` defers its resize callback by
  // a `requestAnimationFrame`, so the first frame after the outer
  // panel re-attaches its DOM paints with the inner splitview's view
  // containers still carrying their stale inline width/height — which
  // shows up as the inner tab strip clustered against the left edge.
  // `api.layout(...)` runs synchronously and re-applies the correct
  // sizes before paint.
  //
  // Zero-rect fallback + persistent observation: same pattern as
  // `DockviewTerminalContainer`. The observer stays attached for the
  // whole visible period — the synchronous measure can run before
  // `SharedDockviewLayout`'s switch effect re-applies a saved maximize
  // (which grows this container), and dockview-core's own
  // `watchElementResize` can miss that change when the transient
  // pre-maximize size never reached a rendered frame (the "ghost
  // panel" regression in #490's maximize-restore flow). Both paths
  // funnel through a last-applied-dims dedupe so the observer's
  // guaranteed initial delivery doesn't re-force a full re-layout
  // (a WebContentsView bounds update per pane on desktop) for the
  // size the synchronous measure just applied. See the terminal
  // container's comment for the full mechanism.
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

  // Auto-focus the active browser pane's address bar whenever the section
  // becomes visible (e.g. user clicked the outer "Browser" panel tab) so
  // the section-scoped keydown handler above starts seeing events without
  // the user having to click into a tab first.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return;
      panel.view.content.element
        .querySelector<HTMLInputElement>("[data-band-address-input]")
        ?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Cmd+T / Ctrl+T when the WebContentsView itself has focus.
  // The keydown listener above only fires when DOM focus is inside this
  // container; once the user clicks into the rendered web page, focus
  // moves to a separate webContents and Chromium swallows the key. The
  // main process intercepts the shortcut there (see
  // `view-manager.ts::before-input-event`) and forwards
  // `browser-new-tab-shortcut` carrying the source pane's browserId.
  // We only react if the pane belongs to *this* container.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await desktopListen<{ browser_id: string; workspace_id: string }>(
        "browser-new-tab-shortcut",
        (event) => {
          const api = apiRef.current;
          if (!api) return;
          const sourceId = event.payload.browser_id;
          // Ignore the event if the source tab isn't one of ours —
          // multiple workspaces can have a DockviewBrowserContainer
          // mounted at once.
          if (!sourceId || !api.getPanel(sourceId)) return;
          void handleAddTab().then(() => {
            requestAnimationFrame(() => {
              const panel = apiRef.current?.activePanel;
              panel?.view.content.element
                .querySelector<HTMLInputElement>("[data-band-address-input]")
                ?.focus();
            });
          });
        },
      );
    })();
    return () => unlisten?.();
  }, [handleAddTab]);

  // Issue #488: page-initiated new-window requests (window.open,
  // target="_blank", middle-click, Cmd+click) get routed by the main
  // process through `setWindowOpenHandler` — the OS-level window is
  // always denied, and a `browser-open-window` event is forwarded
  // here with the requested URL. We materialize each one as a new
  // Band browser tab in the same dockview group as the source pane
  // so the navigation stays inside the workspace.
  //
  // Scoping: same as `browser-new-tab-shortcut` — multiple workspaces
  // can have a DockviewBrowserContainer mounted simultaneously, so
  // ignore events whose source browserId isn't one of ours.
  //
  // NOTE: `browser-open-window` must be in the preload's
  // `ALLOWED_EVENT_NAMES` allowlist (`apps/desktop/src/preload/index.cts`)
  // — otherwise `desktopListen` rejects synchronously and the listener
  // never attaches.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    // Guard against the unmount-before-resolution race: if the
    // component unmounts while we're awaiting `desktopListen`, the
    // cleanup closure runs synchronously with `unlisten` still
    // `undefined`. Without the `cancelled` flag the eventual listener
    // registration would survive the unmount and keep firing
    // `handleAddTab` against an already-gone component. Mirrors the
    // pattern used by the `browser-split-shortcut` / `*-close-shortcut`
    // / `*-cycle-shortcut` effects below.
    let cancelled = false;
    void (async () => {
      const fn = await desktopListen<{
        browser_id: string;
        workspace_id: string;
        url: string;
        disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
      }>("browser-open-window", (event) => {
        const api = apiRef.current;
        if (!api) return;
        const sourceId = event.payload.browser_id;
        const sourcePanel = sourceId ? api.getPanel(sourceId) : undefined;
        // Ignore events from panes in other DockviewBrowserContainers —
        // multiple workspaces' containers all receive every event.
        if (!sourcePanel) return;
        const groupId = sourcePanel.group?.id;
        const url = event.payload.url;
        if (!url) return;
        // Drop the new tab into the *source* pane's group so the
        // tab strip stays compact — same group placement Chrome
        // and Edge use for window.open requests today. Focus
        // follows the new tab (matches `markBrowserFresh` +
        // `addPanel` defaults).
        void handleAddTab(groupId, { initialUrl: url })
          .then(() => {
            requestAnimationFrame(() => {
              const panel = apiRef.current?.activePanel;
              panel?.view.content.element
                .querySelector<HTMLInputElement>("[data-band-address-input]")
                ?.focus();
            });
          })
          .catch((err) => {
            // Belt-and-suspenders: `handleAddTab` already try/catches
            // the tRPC mutation, but an unexpected throw (e.g. in the
            // RAF callback or future refactor of handleAddTab) would
            // otherwise vanish silently.
            console.error("[DockviewBrowserContainer] browser-open-window add-tab failed:", err);
          });
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleAddTab]);

  // Cmd+D / Cmd+Shift+D, Cmd+W, Cmd+[/], Cmd+Shift+[/], Ctrl+(Shift)+Tab
  // when the WebContentsView itself has focus.
  // Same story as `browser-new-tab-shortcut` above: focus inside the
  // child WebContentsView means the React keydown listener never fires.
  // The main process intercepts these in `view-manager.ts::before-input-event`
  // and forwards them as IPC events; we react to them here by delegating
  // to the same handlers the in-React keydown path uses (handleSplit /
  // closeTab / cycleTabsInActiveGroup / cycleGridGroups). Each listener
  // ignores events whose source pane isn't in this container so multiple
  // workspaces' containers don't all act on the same press.
  useEffect(() => {
    if (!isDesktop) return;
    const unlisteners: Array<() => void> = [];
    // Guards the async IIFE below: if the component unmounts before the
    // `desktopListen` awaits resolve, we must NOT push their unlisten
    // functions onto a list whose cleanup has already run. Without this,
    // those listeners survive the unmount and leak across remounts.
    let cancelled = false;

    const refocusAddressBar = () => {
      const panel = apiRef.current?.activePanel;
      panel?.view.content.element
        .querySelector<HTMLInputElement>("[data-band-address-input]")
        ?.focus();
    };

    void (async () => {
      const fns = await Promise.all([
        desktopListen<{
          browser_id: string;
          workspace_id: string;
          direction: "right" | "below";
        }>("browser-split-shortcut", (event) => {
          const api = apiRef.current;
          if (!api) return;
          const sourcePanel = api.getPanel(event.payload.browser_id);
          if (!sourcePanel?.group) return;
          void handleSplit(sourcePanel.group.id, event.payload.direction);
        }),
        desktopListen<{
          browser_id: string;
          workspace_id: string;
        }>("browser-close-shortcut", (event) => {
          const api = apiRef.current;
          if (!api) return;
          const sourceId = event.payload.browser_id;
          if (!api.getPanel(sourceId)) return;
          closeTab(sourceId);
        }),
        desktopListen<{
          browser_id: string;
          workspace_id: string;
          target: "tabs" | "groups";
          direction: 1 | -1;
        }>("browser-cycle-shortcut", (event) => {
          const api = apiRef.current;
          if (!api) return;
          const sourcePanel = api.getPanel(event.payload.browser_id);
          if (!sourcePanel) return;
          // Activate the source pane so the cycle helpers operate from
          // the user's current spot — dockview's activeGroup may lag if
          // the user only typed inside the embedded webContents without
          // clicking the tab header first.
          sourcePanel.api.setActive();
          const refocus = () => requestAnimationFrame(refocusAddressBar);
          if (event.payload.target === "tabs") {
            cycleTabsInActiveGroup(apiRef.current, event.payload.direction, refocus);
          } else {
            cycleGridGroups(apiRef.current, event.payload.direction, refocus);
          }
        }),
      ]);
      // If the effect already cleaned up while we were awaiting, dispose
      // the just-registered listeners immediately instead of letting them
      // outlive the component.
      if (cancelled) {
        for (const fn of fns) fn();
      } else {
        unlisteners.push(...fns);
      }
    })();

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [handleSplit, closeTab]);

  // Listen for the workspace-level ⇧⌘B "focus Browser" event. Scoped
  // to this container's subtree via containerRef. The native webview
  // can't be focused from React, so we focus the URL input instead —
  // which matches what users typically want (start typing → type a
  // new URL or search query). The visibility gate (offsetParent on
  // the container ref) means inactive workspaces' calls are no-ops.
  useEffect(() => {
    const handler = () => {
      const root = containerRef.current;
      if (!root || root.offsetParent === null) return;
      // Prefer the visible address bar (multiple are mounted while
      // the user has multiple browser tabs open inside the panel).
      const inputs = root.querySelectorAll<HTMLInputElement>("[data-band-address-input]");
      for (const input of inputs) {
        if (input.offsetParent !== null) {
          input.focus({ preventScroll: true });
          return;
        }
      }
    };
    window.addEventListener("band:focus-browser", handler);
    return () => window.removeEventListener("band:focus-browser", handler);
  }, []);

  // Sync dockview panels when browsers are created/removed externally (e.g. CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "browser-created" && typeof event.browserId === "string") {
        // Skip if this panel already exists (we created it ourselves)
        if (api.getPanel(event.browserId)) return;
        // Pin the new panel to the inner dockview's central area.
        // Without this explicit position, dockview's fallback uses
        // `activeGroup`, which can be one of the collapsed edge
        // groups added by `ensureEdgeGroups` — making the panel
        // render as a thin docked strip. See `centralPanelPosition`
        // for the full rationale.
        api.addPanel({
          id: event.browserId,
          component: "browserTab",
          tabComponent: "browserTab",
          title: "New Tab",
          params: { workspaceId, browserId: event.browserId },
          position: centralPanelPosition(api),
        });
      } else if (event.kind === "browser-removed" && typeof event.browserId === "string") {
        const panel = api.getPanel(event.browserId);
        if (panel) {
          api.removePanel(panel);
          // If that was the last panel, create a fresh default tab
          if (api.panels.length === 0) {
            createDefaultPanel(api, workspaceId);
          }
        }
      }
    });
  }, [adapter, workspaceId]);

  // Visibility is now propagated via PanelVisibilityContext (React context)
  // instead of updateParameters — see the Provider wrapping DockviewReact.

  // Per-instance action handlers for the stable Dockview header/tab
  // components. Registered in `panelActionsByApiId` (keyed by this inner
  // dockview's `api.id`) from `onReady`; mutated every render so the registry
  // always holds this instance's latest closures.
  const actionsRef = useRef<BrowserPanelActions>({
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
  const initialBrowserIdsRef = useRef<Set<string> | null>(null);
  initialBrowserIdsRef.current = initialData?.browserIds ?? null;
  const initialUrlsRef = useRef<Map<string, string> | null>(null);
  initialUrlsRef.current = initialData?.urls ?? null;
  // Mirror `visible` into a ref so onReady can decide whether to
  // force-layout the freshly-attached api. See the matching ref in
  // `DockviewTerminalContainer` for the cold-mount rationale.
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
      const knownBrowserIds = initialBrowserIdsRef.current;
      const knownUrls = initialUrlsRef.current;

      if (savedLayout && isDockviewLayout(savedLayout)) {
        // Restore full dockview layout (preserves groups, splits, sizes)
        isRestoringRef.current = true;
        // Inject the latest URLs into each panel's `params.initialUrl`
        // before `fromJSON` so BrowserPaneComponent mounts with the URL
        // already in hand — avoids the create-webview / server-fetch
        // race that was leaving address bars empty after eviction.
        const layoutToRestore = injectInitialUrls(savedLayout, knownUrls);
        try {
          // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON API requires any
          event.api.fromJSON(layoutToRestore as any);
        } catch (err) {
          console.error("[DockviewBrowserContainer] fromJSON failed, creating default:", err);
          createDefaultPanel(event.api, workspaceId);
        }

        // Prune panels whose browser records no longer exist on the server.
        let dropped = 0;
        if (knownBrowserIds) {
          const orphans = event.api.panels.filter((p) => !knownBrowserIds.has(p.id));
          for (const orphan of orphans) {
            event.api.removePanel(orphan);
            dropped++;
          }
          // If all panels were orphaned, create a fresh default tab.
          if (event.api.panels.length === 0) {
            createDefaultPanel(event.api, workspaceId);
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
        // explicit save the saved `browser_layout` row would never
        // converge with `browsers.list`.
        if (dropped > 0) {
          persistToServer(workspaceId, event.api.toJSON(), {
            queryClient: queryClientRef.current,
          });
        }
      } else {
        // No saved layout — create a default tab
        createDefaultPanel(event.api, workspaceId);
        persistToServer(workspaceId, event.api.toJSON(), { queryClient: queryClientRef.current });
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
        reportBrowserFocus();
      });
      event.api.onDidAddGroup(persist);
      event.api.onDidRemoveGroup(persist);

      // Cold-mount catch-up: if the outer Browser panel was already
      // visible when this container first rendered, the
      // `useLayoutEffect([visible])` below already fired with
      // `apiRef.current === null` and silently bailed. Same
      // rationale as `DockviewTerminalContainer.onReady`.
      if (visibleRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          event.api.layout(Math.round(rect.width), Math.round(rect.height), true);
        }
      }
    },
    [workspaceId, schedulePersist, reportBrowserFocus],
  );

  const visibilityValue = useMemo(
    () => ({ visible: visible && wsActive !== false, wsActive: wsActive !== false }),
    [visible, wsActive],
  );

  // Don't render dockview until the initial layout is fetched from the server.
  // On subsequent visits, React Query returns cached data instantly — no loading.
  if (!initialData) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div ref={setContainerRef} className="flex h-full w-full flex-col overflow-hidden">
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={browserTabTheme}
          className="h-full"
          components={browserPanelComponents}
          tabComponents={browserTabComponents}
          defaultTabComponent={BrowserTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </PanelVisibilityContext.Provider>
    </div>
  );
}

function createDefaultPanel(api: DockviewApi, workspaceId: string): void {
  const browserId = newBrowserId();
  // Create server-side record for the default tab
  trpc.browsers.create.mutate({ workspaceId, id: browserId }).catch((err) => {
    console.error("[DockviewBrowserContainer] error creating default browser:", err);
  });
  // Pin the default panel to the inner dockview's central area so it
  // lands there instead of leaking into an edge group that
  // `ensureEdgeGroups` may have already added. See
  // `centralPanelPosition` for the full rationale.
  api.addPanel({
    id: browserId,
    component: "browserTab",
    tabComponent: "browserTab",
    title: "Browser",
    params: {
      workspaceId,
      browserId,
    },
    position: centralPanelPosition(api),
  });
}
