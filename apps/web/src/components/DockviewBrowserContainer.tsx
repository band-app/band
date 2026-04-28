import { useAdapter } from "@band-app/dashboard-core";
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
import { Globe, Plus, X } from "lucide-react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isTauri } from "../lib/is-tauri";
import { trpc } from "../lib/trpc-client";
import { BrowserPaneComponent, type BrowserPaneParams, useFavicon } from "./BrowserPanel";

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
  if (opts?.queryClient) {
    opts.queryClient.setQueryData(browserLayoutKey(workspaceId), {
      layout,
      browserIds: panelIdsFromLayout(layout),
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

// Visibility context — propagated from DockviewBrowserContainer via React
// context instead of dockview's updateParameters (which clobbers params).
const BrowserVisibilityContext = createContext({ visible: true, wsActive: true });

interface BrowserTabParams {
  workspaceId: string;
  browserId: string;
  initialUrl?: string;
}

function BrowserTabPanel({ params, api }: IDockviewPanelProps<BrowserTabParams>) {
  const { visible } = useContext(BrowserVisibilityContext);

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
    <div className="flex h-full w-full flex-col overflow-hidden">
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
  const [panelCount, setPanelCount] = useState(props.containerApi.panels.length);
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

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeTabRef.current?.(browserId);
    },
    [browserId],
  );

  const showClose = panelCount > 1;

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
      {showClose && (
        <button
          type="button"
          className="ml-1 inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 hover:bg-accent transition-colors"
          onClick={handleClose}
          title="Close tab"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared refs for stable Dockview components
// ---------------------------------------------------------------------------

const addTabRef: {
  current: { onAdd: (groupId?: string) => void };
} = {
  current: { onAdd: () => {} },
};

/** Shared ref for the close-tab action — used by BrowserTab's close button. */
const closeTabRef: { current: ((browserId: string) => void) | null } = {
  current: null,
};

/**
 * Stable component for DockviewReact's rightHeaderActionsComponent.
 * Reads callback from the module-level ref to avoid the
 * "only React.memo/forwardRef/function components accepted" error.
 */
const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  const groupId = props.group.id;
  return (
    <div className="flex items-center">
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => addTabRef.current.onAdd(groupId)}
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

  // Fetch layout AND browser records via React Query — cached across mounts
  // so re-visiting a workspace renders instantly from the cache.
  const { data: initialData } = useQuery<BrowserLayoutData>({
    queryKey: browserLayoutKey(workspaceId),
    queryFn: async () => {
      const [{ tree }, { browsers }] = await Promise.all([
        trpc.browserLayout.get.query({ workspaceId }).catch(() => ({ tree: null })),
        trpc.browsers.list
          .query({ workspaceId })
          .catch(() => ({ browsers: [] as { id: string }[] })),
      ]);
      return {
        layout: tree,
        browserIds: new Set(browsers.map((b: { id: string }) => b.id)),
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

  const handleAddTab = useCallback(
    async (groupId?: string) => {
      const api = apiRef.current;
      if (!api) return;

      const browserId = newBrowserId();
      markBrowserFresh(browserId);

      // Create the server-side browser record BEFORE adding the panel
      try {
        await trpc.browsers.create.mutate({ workspaceId, id: browserId });
      } catch (err) {
        console.error("[DockviewBrowserContainer] error pre-creating browser:", err);
      }

      // Build panel options, targeting the specific group if provided
      const options: Parameters<typeof api.addPanel>[0] = {
        id: browserId,
        component: "browserTab",
        tabComponent: "browserTab",
        title: "New Tab",
        params: {
          workspaceId,
          browserId,
        },
      };

      if (groupId) {
        (options as Record<string, unknown>).position = {
          referenceGroup: groupId,
        };
      }

      api.addPanel(options);
      // Layout change listeners will auto-persist
    },
    [workspaceId],
  );

  const closeTab = useCallback((browserId: string) => {
    const api = apiRef.current;
    if (!api || api.panels.length <= 1) return; // don't close last tab

    const panel = api.getPanel(browserId);
    if (panel) {
      api.removePanel(panel);
    }

    // Delete the server-side browser record so closed tabs don't linger.
    trpc.browsers.remove.mutate({ browserId }).catch((err) => {
      console.error("[DockviewBrowserContainer] failed to remove browser:", err);
    });
    // Layout change listeners will auto-persist
  }, []);

  // Cmd/Ctrl+W → close the active browser tab
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "w" && !e.shiftKey) {
        const api = apiRef.current;
        if (!api || api.panels.length <= 1) return;
        e.preventDefault();
        e.stopPropagation();
        const active = api.activePanel;
        if (active) {
          closeTab(active.id);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, closeTab]);

  // Cmd/Ctrl+R → reload the active browser tab
  useEffect(() => {
    if (!visible || !isTauri) return;
    const handler = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "r" && !e.shiftKey) {
        const api = apiRef.current;
        if (!api) return;
        const active = api.activePanel;
        const browserId = (active?.params as BrowserTabParams | undefined)?.browserId;
        if (!browserId) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("browser_reload", { browserId });
        } catch (err) {
          console.error("[DockviewBrowserContainer] browser_reload failed:", err);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible]);

  // Sync dockview panels when browsers are created/removed externally (e.g. CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "browser-created" && typeof event.browserId === "string") {
        // Skip if this panel already exists (we created it ourselves)
        if (api.getPanel(event.browserId)) return;
        api.addPanel({
          id: event.browserId,
          component: "browserTab",
          tabComponent: "browserTab",
          title: "New Tab",
          params: { workspaceId, browserId: event.browserId },
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

  // Visibility is now propagated via BrowserVisibilityContext (React context)
  // instead of updateParameters — see the Provider wrapping DockviewReact.

  // Keep module-level refs in sync for stable Dockview components
  addTabRef.current = { onAdd: handleAddTab };
  closeTabRef.current = closeTab;

  // Use refs for the initial data so onReady's closure captures the latest
  const initialLayoutRef = useRef<unknown | null>(null);
  initialLayoutRef.current = initialData?.layout ?? null;
  const initialBrowserIdsRef = useRef<Set<string> | null>(null);
  initialBrowserIdsRef.current = initialData?.browserIds ?? null;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const savedLayout = initialLayoutRef.current;
      const knownBrowserIds = initialBrowserIdsRef.current;

      if (savedLayout && isDockviewLayout(savedLayout)) {
        // Restore full dockview layout (preserves groups, splits, sizes)
        isRestoringRef.current = true;
        try {
          // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON API requires any
          event.api.fromJSON(savedLayout as any);
        } catch (err) {
          console.error("[DockviewBrowserContainer] fromJSON failed, creating default:", err);
          createDefaultPanel(event.api, workspaceId);
        }

        // Prune panels whose browser records no longer exist on the server.
        if (knownBrowserIds) {
          const orphans = event.api.panels.filter((p) => !knownBrowserIds.has(p.id));
          for (const orphan of orphans) {
            event.api.removePanel(orphan);
          }
          // If all panels were orphaned, create a fresh default tab.
          if (event.api.panels.length === 0) {
            createDefaultPanel(event.api, workspaceId);
          }
        }

        // Allow persistence after restoration settles
        setTimeout(() => {
          isRestoringRef.current = false;
        }, 0);
      } else {
        // No saved layout — create a default tab
        createDefaultPanel(event.api, workspaceId);
        persistToServer(workspaceId, event.api.toJSON(), { queryClient: queryClientRef.current });
      }

      // Listen for any layout changes and auto-persist
      const persist = () => schedulePersist();
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);
      event.api.onDidActivePanelChange(persist);
      event.api.onDidAddGroup(persist);
      event.api.onDidRemoveGroup(persist);
    },
    [workspaceId, schedulePersist],
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
    <div className="flex h-full w-full flex-col overflow-hidden">
      <BrowserVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={browserTabTheme}
          className="h-full"
          components={browserPanelComponents}
          tabComponents={browserTabComponents}
          defaultTabComponent={BrowserTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </BrowserVisibilityContext.Provider>
    </div>
  );
}

function createDefaultPanel(api: DockviewApi, workspaceId: string): void {
  const browserId = newBrowserId();
  // Create server-side record for the default tab
  trpc.browsers.create.mutate({ workspaceId, id: browserId }).catch((err) => {
    console.error("[DockviewBrowserContainer] error creating default browser:", err);
  });
  api.addPanel({
    id: browserId,
    component: "browserTab",
    tabComponent: "browserTab",
    title: "Browser",
    params: {
      workspaceId,
      browserId,
    },
  });
}
