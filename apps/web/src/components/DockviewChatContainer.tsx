import { AgentIcon } from "@band-app/dashboard-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { Clock, Plus, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { ChatPane, type CodingAgentDef, useChatPaneState } from "./ChatPane";

// ---------------------------------------------------------------------------
// Track chat IDs that were just created by an "add tab" action.
// ChatPane checks this to skip session loading and start fresh.
// ---------------------------------------------------------------------------

const freshChatIds = new Set<string>();

/** Mark a chatId as freshly created (by add-tab). */
export function markChatFresh(chatId: string): void {
  freshChatIds.add(chatId);
}

/** Check (and consume) whether a chatId is fresh. */
export function consumeChatFresh(chatId: string): boolean {
  return freshChatIds.delete(chatId);
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

export function newChatId(): string {
  return `chat_${uuid()}`;
}

// ---------------------------------------------------------------------------
// Debounced server persistence (500ms)
// ---------------------------------------------------------------------------

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistToServer(workspaceId: string, layout: unknown): void {
  const existing = saveTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    workspaceId,
    setTimeout(() => {
      saveTimers.delete(workspaceId);
      trpc.chatLayout.save.mutate({ workspaceId, tree: layout }).catch((err) => {
        console.error("[DockviewChatContainer] failed to persist layout:", err);
      });
    }, 500),
  );
}

// ---------------------------------------------------------------------------
// Legacy layout migration helpers
// ---------------------------------------------------------------------------

// Dockview serialized format
function isDockviewLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.grid === "object" && typeof o.panels === "object";
}

// ---------------------------------------------------------------------------
// Dockview theme (reuse the band theme from the outer instance)
// ---------------------------------------------------------------------------

const chatTabTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band dockview-chat-tabs",
};

// ---------------------------------------------------------------------------
// Chat tab panel component (renders inside each dockview tab)
// ---------------------------------------------------------------------------

interface ChatTabParams {
  workspaceId: string;
  chatId: string;
  visible: boolean;
  wsActive: boolean;
}

function ChatTabPanel({ params, api }: IDockviewPanelProps<ChatTabParams>) {
  // Track visibility: combine parent visibility param with dockview's own active state.
  // Read params directly from props — dockview-react's bridge re-renders with merged
  // params on every updateParameters call. Calling api.getParameters() returns only
  // the last update payload (not merged), which would drop workspaceId/chatId after
  // a partial { visible, wsActive } update and blank the panel.
  const [tabActive, setTabActive] = useState(api.isActive);

  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => d.dispose();
  }, [api]);

  if (!params.workspaceId || !params.chatId) return null;

  const visible = params.visible && tabActive;
  const wsActive = params.wsActive;

  return (
    <ChatTabContent
      workspaceId={params.workspaceId}
      chatId={params.chatId}
      visible={visible}
      wsActive={wsActive}
      tabActive={tabActive}
      setTitle={(title: string) => api.setTitle(title)}
    />
  );
}

/** Separate component so hooks work properly (params change via updateParameters). */
function ChatTabContent({
  workspaceId,
  chatId,
  visible,
  wsActive,
  tabActive,
  setTitle,
}: {
  workspaceId: string;
  chatId: string;
  visible: boolean;
  wsActive: boolean;
  tabActive: boolean;
  setTitle: (title: string) => void;
}) {
  const state = useChatPaneState(workspaceId, chatId);

  // Update the dockview tab title based on session summary or agent label
  const setTitleRef = useRef(setTitle);
  setTitleRef.current = setTitle;
  useEffect(() => {
    const title = state.activeSessionSummary || state.agentLabel || state.codingAgentId || "Chat";
    setTitleRef.current(title);
  }, [state.activeSessionSummary, state.agentLabel, state.codingAgentId]);

  // Sync this tab's session history state to the shared ref so the
  // RightHeaderActions component can render the history toggle button
  // for whichever tab is currently active.
  useEffect(() => {
    if (!tabActive) return;
    historyToggleRef.current = {
      supported: state.supportsSessionListing,
      active: state.showSessionList,
      toggle: state.toggleSessionList,
    };
    return () => {
      // Clear when this tab deactivates or unmounts
      historyToggleRef.current = { supported: false, active: false, toggle: () => {} };
    };
  }, [tabActive, state.supportsSessionListing, state.showSessionList, state.toggleSessionList]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
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
// Custom tab header: agent icon + name + close button
// ---------------------------------------------------------------------------

function ChatTab(props: IDockviewPanelHeaderProps<ChatTabParams>) {
  const [title, setTitle] = useState(props.api.title ?? "Chat");
  const [agentType, setAgentType] = useState<string | undefined>(undefined);
  const [panelCount, setPanelCount] = useState(props.containerApi.panels.length);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? "Chat"));
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

  // Load agent type once for the icon
  const chatId = props.params.chatId;
  const workspaceId = props.params.workspaceId;

  useEffect(() => {
    if (!chatId || !workspaceId) return;
    let cancelled = false;
    Promise.all([
      trpc.settings.get.query().catch(() => null),
      trpc.chats.get.query({ chatId }).catch(() => ({ chat: null })),
    ]).then(([settings, chatResult]) => {
      if (cancelled) return;
      const raw = (settings as Record<string, unknown> | null)?.codingAgents;
      const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
      const defaultAgentId = (settings as Record<string, unknown> | null)?.defaultCodingAgent as
        | string
        | undefined;
      const agentId = chatResult.chat?.agent ?? defaultAgentId ?? "";
      const found = codingAgents.find((a) => a.id === agentId);
      if (found) setAgentType(found.type);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, workspaceId]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeTabRef.current?.(chatId);
    },
    [chatId],
  );

  const showClose = panelCount > 1;

  return (
    <div className="dv-default-tab">
      <div className="flex items-center gap-1.5 min-w-0">
        {agentType && <AgentIcon type={agentType} className="size-3.5 shrink-0" />}
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
  current: { agents: CodingAgentDef[]; onAdd: (agentId?: string, groupId?: string) => void };
} = {
  current: { agents: [], onAdd: () => {} },
};

/** Shared ref for the close-tab action — used by ChatTab's close button. */
const closeTabRef: { current: ((chatId: string) => void) | null } = {
  current: null,
};

/** Shared ref for the active tab's session history state — used by RightHeaderActions. */
const historyToggleRef: {
  current: { supported: boolean; active: boolean; toggle: () => void };
} = {
  current: { supported: false, active: false, toggle: () => {} },
};

/**
 * Stable component for DockviewReact's rightHeaderActionsComponent.
 * Reads agents and callback from the module-level ref to avoid the
 * "only React.memo/forwardRef/function components accepted" error.
 */
const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  // Force re-render when agents or history state change via polling.
  const [, forceUpdate] = useState(0);
  const agentsRef = useRef(addTabRef.current.agents);
  const historyRef = useRef(historyToggleRef.current);

  useEffect(() => {
    const id = setInterval(() => {
      let changed = false;
      if (addTabRef.current.agents !== agentsRef.current) {
        agentsRef.current = addTabRef.current.agents;
        changed = true;
      }
      const h = historyToggleRef.current;
      if (
        h.supported !== historyRef.current.supported ||
        h.active !== historyRef.current.active ||
        h.toggle !== historyRef.current.toggle
      ) {
        historyRef.current = h;
        changed = true;
      }
      if (changed) forceUpdate((n) => n + 1);
    }, 200);
    return () => clearInterval(id);
  }, []);

  const { agents, onAdd } = addTabRef.current;
  const history = historyToggleRef.current;
  const groupId = props.group.id;
  return (
    <div className="flex items-center">
      {history.supported && (
        <button
          type="button"
          onClick={history.toggle}
          className={`inline-flex size-8 items-center justify-center rounded transition-colors hover:bg-accent ${
            history.active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title="Session history"
        >
          <Clock className="size-3.5" />
        </button>
      )}
      <AddTabButton agents={agents} onAdd={(agentId) => onAdd(agentId, groupId)} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Dockview panel/tab component registries
// ---------------------------------------------------------------------------

const chatPanelComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelProps<ChatTabParams>>
> = {
  chatTab: ChatTabPanel,
};

const chatTabComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelHeaderProps<ChatTabParams>>
> = {
  chatTab: ChatTab,
};

// ---------------------------------------------------------------------------
// Main container
// ---------------------------------------------------------------------------

interface DockviewChatContainerProps {
  workspaceId: string;
  visible: boolean;
  wsActive?: boolean;
}

export function DockviewChatContainer({
  workspaceId,
  visible,
  wsActive,
}: DockviewChatContainerProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const isRestoringRef = useRef(false);
  const visibleRef = useRef(visible);
  const wsActiveRef = useRef(wsActive);
  visibleRef.current = visible;
  wsActiveRef.current = wsActive;

  // Pre-fetch layout from server before mounting dockview
  const [initialData, setInitialData] = useState<{
    loaded: boolean;
    layout: unknown | null;
  }>({ loaded: false, layout: null });

  useEffect(() => {
    trpc.chatLayout.get
      .query({ workspaceId })
      .then(({ tree }) => {
        setInitialData({ loaded: true, layout: tree });
      })
      .catch(() => {
        setInitialData({ loaded: true, layout: null });
      });
  }, [workspaceId]);

  // Load agents for the "add tab" dropdown
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  useEffect(() => {
    trpc.settings.get
      .query()
      .then((settings) => {
        const raw = (settings as Record<string, unknown>)?.codingAgents;
        if (Array.isArray(raw)) {
          setAgents(raw as CodingAgentDef[]);
        }
      })
      .catch(() => {});
  }, []);

  // Debounced persist: serialize the full dockview layout
  const schedulePersist = useCallback(() => {
    if (isRestoringRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    persistToServer(workspaceId, api.toJSON());
  }, [workspaceId]);

  const handleAddTab = useCallback(
    async (agentId?: string, groupId?: string) => {
      const api = apiRef.current;
      if (!api) return;

      let chatId: string;
      let isFresh = true;

      // When opening a tab for a specific agent, try to reuse an existing
      // chat record that isn't currently open in any tab.  This preserves
      // session history across close/reopen cycles.
      if (agentId) {
        const openChatIds = new Set(api.panels.map((p) => p.id));
        try {
          const { chats } = await trpc.chats.list.query({ workspaceId });
          const reusable = chats.find((c) => c.agent === agentId && !openChatIds.has(c.id));
          if (reusable) {
            chatId = reusable.id;
            isFresh = false; // has existing session history
          } else {
            chatId = newChatId();
          }
        } catch {
          chatId = newChatId();
        }
      } else {
        chatId = newChatId();
      }

      if (isFresh) {
        markChatFresh(chatId);
      }

      // Create the server-side chat record BEFORE adding the panel so that
      // useChatPaneState finds the correct agent when it queries on mount.
      // Skip if we're reusing an existing chat.
      if (agentId && isFresh) {
        try {
          await trpc.chats.create.mutate({ workspaceId, id: chatId, agent: agentId });
        } catch (err) {
          console.error("[DockviewChatContainer] error pre-creating chat:", err);
        }
      }

      // Build panel options, targeting the specific group if provided
      const options: Parameters<typeof api.addPanel>[0] = {
        id: chatId,
        component: "chatTab",
        tabComponent: "chatTab",
        title: "Chat",
        params: {
          workspaceId,
          chatId,
          visible: visibleRef.current && wsActiveRef.current !== false,
          wsActive: wsActiveRef.current !== false,
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

  const closeTab = useCallback((chatId: string) => {
    const api = apiRef.current;
    if (!api || api.panels.length <= 1) return; // don't close last tab

    const panel = api.getPanel(chatId);
    if (panel) {
      api.removePanel(panel);
    }

    // Don't delete the chat record — it holds the active session and
    // agent config so the user can reopen a tab for the same agent
    // later.  The record is lightweight and cleaned up when the
    // workspace is deleted.
    // Layout change listeners will auto-persist
  }, []);

  // Cmd/Ctrl+W → close the active chat tab
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

  // Update visibility params when parent visibility changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      panel.api.updateParameters({
        visible: visible && wsActive !== false,
        wsActive: wsActive !== false,
      });
    }
  }, [visible, wsActive]);

  // Keep module-level refs in sync for stable Dockview components
  addTabRef.current = { agents, onAdd: handleAddTab };
  closeTabRef.current = closeTab;

  // Use a ref for the initial layout so onReady's closure captures the latest
  const initialLayoutRef = useRef<unknown | null>(null);
  initialLayoutRef.current = initialData.layout;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const savedLayout = initialLayoutRef.current;

      if (savedLayout && isDockviewLayout(savedLayout)) {
        // Restore full dockview layout (preserves groups, splits, sizes)
        isRestoringRef.current = true;
        try {
          // biome-ignore lint/suspicious/noExplicitAny: dockview fromJSON API requires any
          event.api.fromJSON(savedLayout as any);
        } catch (err) {
          console.error("[DockviewChatContainer] fromJSON failed, creating default:", err);
          createDefaultPanel(event.api, workspaceId);
        }

        // Update visibility params to current values (may be stale in saved data)
        for (const panel of event.api.panels) {
          panel.api.updateParameters({
            visible: visibleRef.current && wsActiveRef.current !== false,
            wsActive: wsActiveRef.current !== false,
          });
        }

        // Allow persistence after restoration settles
        setTimeout(() => {
          isRestoringRef.current = false;
        }, 0);
      } else {
        // No saved layout — create a default tab
        const chatId = newChatId();
        event.api.addPanel({
          id: chatId,
          component: "chatTab",
          tabComponent: "chatTab",
          title: "Chat",
          params: {
            workspaceId,
            chatId,
            visible: visibleRef.current && wsActiveRef.current !== false,
            wsActive: wsActiveRef.current !== false,
          },
        });

        persistToServer(workspaceId, event.api.toJSON());
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

  // Don't render dockview until the initial layout is fetched from the server
  if (!initialData.loaded) {
    return <div className="flex h-full w-full items-center justify-center" />;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DockviewReact
        theme={chatTabTheme}
        className="h-full"
        components={chatPanelComponents}
        tabComponents={chatTabComponents}
        defaultTabComponent={ChatTab}
        onReady={onReady}
        rightHeaderActionsComponent={RightHeaderActions}
      />
    </div>
  );
}

function createDefaultPanel(api: DockviewApi, workspaceId: string): void {
  const chatId = newChatId();
  api.addPanel({
    id: chatId,
    component: "chatTab",
    tabComponent: "chatTab",
    title: "Chat",
    params: {
      workspaceId,
      chatId,
      visible: true,
      wsActive: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Add tab button (with agent picker dropdown)
// ---------------------------------------------------------------------------

function AddTabButton({
  agents,
  onAdd,
}: {
  agents: CodingAgentDef[];
  onAdd: (agentId?: string) => void;
}) {
  const hasMultipleAgents = agents.length > 1;

  if (!hasMultipleAgents) {
    return (
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => onAdd()}
        title="New chat tab"
      >
        <Plus className="size-4" />
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title="New chat tab"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onClick={() => onAdd(agent.id)}>
            <AgentIcon type={agent.type} className="size-3.5 shrink-0" />
            <span className="truncate">{agent.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
