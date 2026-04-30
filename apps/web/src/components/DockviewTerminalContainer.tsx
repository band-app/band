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
import { Columns2, Plus, Rows2, TerminalSquare, X } from "lucide-react";
import React, {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { trpc } from "../lib/trpc-client";

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

const TerminalVisibilityContext = createContext({ visible: true, wsActive: true });

interface TerminalTabParams {
  workspaceId: string;
  terminalId: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  autoFocus?: boolean;
}

function TerminalTabPanel({ params, api }: IDockviewPanelProps<TerminalTabParams>) {
  const { visible } = useContext(TerminalVisibilityContext);

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
    <div className="flex h-full w-full flex-col overflow-hidden">
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

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeTabRef.current?.(props.params.terminalId);
    },
    [props.params.terminalId],
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
// Shared refs for stable Dockview components
// ---------------------------------------------------------------------------

const addTabRef: {
  current: {
    onAdd: (groupId?: string) => void;
    onSplit: (groupId: string, direction: "right" | "below") => void;
  };
} = {
  current: { onAdd: () => {}, onSplit: () => {} },
};

const closeTabRef: { current: ((terminalId: string) => void) | null } = {
  current: null,
};

const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  const groupId = props.group.id;
  return (
    <div className="flex items-center">
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => addTabRef.current.onSplit(groupId, "right")}
        title="Split right"
      >
        <Columns2 className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => addTabRef.current.onSplit(groupId, "below")}
        title="Split down"
      >
        <Rows2 className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => addTabRef.current.onAdd(groupId)}
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

    // Kill the terminal on the server (kills PTY + removes from layout + emits event)
    trpc.terminal.kill.mutate({ terminalId }).catch((err) => {
      console.error("[DockviewTerminalContainer] failed to kill terminal:", err);
    });
  }, []);

  // Keyboard shortcuts:
  // - Cmd/Ctrl+T → open a new terminal tab
  // - Cmd/Ctrl+W → close the active terminal tab
  // - Cmd/Ctrl+D → split right (vertical split)
  // - Cmd/Ctrl+Shift+D → split down (horizontal split)
  // - Ctrl+(Shift)+Tab → cycle through tabs in the active group
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      // Only handle shortcut if this container (or a descendant) has focus
      if (!containerRef.current?.contains(document.activeElement)) return;

      const key = e.key.toLowerCase();

      // Ctrl+(Shift)+Tab → cycle tabs within the active group
      if (e.ctrlKey && !e.metaKey && key === "tab") {
        e.preventDefault();
        e.stopPropagation();
        const api = apiRef.current;
        const group = api?.activeGroup;
        if (!group) return;
        if (e.shiftKey) {
          group.model.moveToPrevious();
        } else {
          group.model.moveToNext();
        }
        // Focus the xterm helper textarea inside the newly active panel
        // so the terminal actually receives keyboard input.
        // focusContent() only focuses the dockview wrapper which makes the
        // cursor blink but doesn't route keypresses to xterm.
        requestAnimationFrame(() => {
          const panel = api.activePanel;
          if (!panel) return;
          panel.view.content.element
            .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
            ?.focus();
        });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleAddTab();
      } else if (key === "w" && !e.shiftKey) {
        const api = apiRef.current;
        if (!api || api.panels.length <= 1) return;
        e.preventDefault();
        e.stopPropagation();
        const active = api.activePanel;
        if (active) {
          closeTab(active.id);
        }
      } else if (key === "d") {
        e.preventDefault();
        e.stopPropagation();
        const api = apiRef.current;
        if (!api) return;
        const activeGroup = api.activeGroup;
        if (!activeGroup) return;
        const direction = e.shiftKey ? "below" : "right";
        handleSplit(activeGroup.id, direction);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, closeTab, handleSplit, handleAddTab]);

  // Sync dockview panels when terminals are created/killed externally (e.g. CLI).
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "terminal-created" && typeof event.terminalId === "string") {
        // Skip if this panel already exists (we created it ourselves)
        if (api.getPanel(event.terminalId)) return;
        api.addPanel({
          id: event.terminalId,
          component: "terminalTab",
          tabComponent: "terminalTab",
          title: "Terminal",
          params: { workspaceId, terminalId: event.terminalId },
        });
      } else if (event.kind === "terminal-killed" && typeof event.terminalId === "string") {
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

  // Keep module-level refs in sync for stable Dockview components
  addTabRef.current = { onAdd: handleAddTab, onSplit: handleSplit };
  closeTabRef.current = closeTab;

  // Use refs for the initial data so onReady's closure captures the latest
  const initialLayoutRef = useRef<unknown | null>(null);
  initialLayoutRef.current = initialData?.layout ?? null;
  const initialTerminalIdsRef = useRef<Set<string> | null>(null);
  initialTerminalIdsRef.current = initialData?.terminalIds ?? null;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
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
        if (knownTerminalIds) {
          const orphans = event.api.panels.filter((p) => !knownTerminalIds.has(p.id));
          for (const orphan of orphans) {
            event.api.removePanel(orphan);
          }
          // If all panels were orphaned, create a fresh default terminal.
          if (event.api.panels.length === 0) {
            createDefaultTerminal(event.api, workspaceId);
          }
        }

        // Allow persistence after restoration settles
        setTimeout(() => {
          isRestoringRef.current = false;
        }, 0);
      } else {
        // No saved layout — check for workspace terminal config, then create default
        seedFromConfigOrDefault(event.api, workspaceId, queryClientRef.current);
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
  if (!initialData) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <TerminalVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={terminalTabTheme}
          className="h-full"
          components={terminalPanelComponents}
          tabComponents={terminalTabComponents}
          defaultTabComponent={TerminalTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </TerminalVisibilityContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default terminal creation
// ---------------------------------------------------------------------------

function createDefaultTerminal(api: DockviewApi, workspaceId: string): void {
  // Generate ID client-side so we can add the panel immediately.
  const terminalId = newTerminalId();

  api.addPanel({
    id: terminalId,
    component: "terminalTab",
    tabComponent: "terminalTab",
    title: "Terminal",
    params: {
      workspaceId,
      terminalId,
    },
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
