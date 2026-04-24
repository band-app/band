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
      trpc.chatLayout.save
        .mutate({ workspaceId, tree: layout })
        .catch((err) => {
          console.error("[DockviewChatContainer] failed to persist layout:", err);
        });
    }, 500),
  );
}

// ---------------------------------------------------------------------------
// Legacy layout migration helpers
// ---------------------------------------------------------------------------

// Old flat tab layout format (v2)
interface LegacyChatTabLayout {
  chatIds: string[];
  activeChatId: string | null;
}

function isLegacyChatTabLayout(obj: unknown): obj is LegacyChatTabLayout {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.chatIds);
}

// Old binary split-tree layout format (v1)
interface TreeNode {
  type: "split" | "leaf";
  chatId?: string;
  children?: [TreeNode, TreeNode];
}

function isLegacyTreeLayout(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return o.type === "split" || o.type === "leaf";
}

function extractChatIdsFromTree(node: TreeNode): string[] {
  if (node.type === "leaf" && node.chatId) return [node.chatId];
  if (node.children) {
    return [
      ...extractChatIdsFromTree(node.children[0]),
      ...extractChatIdsFromTree(node.children[1]),
    ];
  }
  return [];
}

// Dockview serialized format (v3 — current)
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
  // Track visibility: combine parent visibility param with dockview's own active state
  const [tabActive, setTabActive] = useState(api.isActive);
  const [currentParams, setCurrentParams] = useState(params);

  useEffect(() => {
    const d1 = api.onDidActiveChange((e) => setTabActive(e.isActive));
    const d2 = api.onDidParametersChange(() => {
      setCurrentParams(api.getParameters<ChatTabParams>());
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api]);

  if (!currentParams.workspaceId || !currentParams.chatId) return null;

  const visible = currentParams.visible && tabActive;
  const wsActive = currentParams.wsActive;

  return (
    <ChatTabContent
      workspaceId={currentParams.workspaceId}
      chatId={currentParams.chatId}
      visible={visible}
      wsActive={wsActive}
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
  setTitle,
}: {
  workspaceId: string;
  chatId: string;
  visible: boolean;
  wsActive: boolean;
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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {state.supportsSessionListing && (
        <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-border px-2">
          <button
            type="button"
            onClick={state.toggleSessionList}
            className={`inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent ${
              state.showSessionList
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
            }`}
            title="Session history"
          >
            <Clock className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => state.newSessionRef.current?.()}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="New session"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
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
      const defaultAgentId = (settings as Record<string, unknown> | null)
        ?.defaultCodingAgent as string | undefined;
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

/**
 * Stable component for DockviewReact's rightHeaderActionsComponent.
 * Reads agents and callback from the module-level ref to avoid the
 * "only React.memo/forwardRef/function components accepted" error.
 */
const RightHeaderActions = React.memo(function RightHeaderActions(
  props: IDockviewHeaderActionsProps,
) {
  // Force re-render when agents change via a subscriber pattern
  const [, forceUpdate] = useState(0);
  const agentsRef = useRef(addTabRef.current.agents);

  useEffect(() => {
    // Poll isn't ideal but agents load once — this ensures the + button
    // appears after the async settings fetch completes.
    const id = setInterval(() => {
      if (addTabRef.current.agents !== agentsRef.current) {
        agentsRef.current = addTabRef.current.agents;
        forceUpdate((n) => n + 1);
      }
    }, 200);
    return () => clearInterval(id);
  }, []);

  const { agents, onAdd } = addTabRef.current;
  const groupId = props.group.id;
  return (
    <AddTabButton
      agents={agents}
      onAdd={(agentId) => onAdd(agentId, groupId)}
    />
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
          const seen = new Set<string>();
          const unique = (raw as CodingAgentDef[]).filter((a) => {
            if (seen.has(a.type)) return false;
            seen.add(a.type);
            return true;
          });
          setAgents(unique);
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
          const reusable = chats.find(
            (c) => c.agent === agentId && !openChatIds.has(c.id),
          );
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

  const closeTab = useCallback(
    (chatId: string) => {
      const api = apiRef.current;
      if (!api || api.panels.length <= 1) return; // don't close last tab

      const panel = api.getPanel(chatId);
      if (panel) {
        api.removePanel(panel);
      }

      // Don't delete the chat record — it holds sessionIds that allow the
      // user to see their session history if they reopen a tab for the same
      // agent later.  The record is lightweight and cleaned up when the
      // workspace is deleted.
      // Layout change listeners will auto-persist
    },
    [],
  );

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          event.api.fromJSON(savedLayout as any);
        } catch (err) {
          console.error(
            "[DockviewChatContainer] fromJSON failed, creating default:",
            err,
          );
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
        // Migrate legacy formats or create default
        let chatIds: string[] = [];
        if (savedLayout && isLegacyChatTabLayout(savedLayout)) {
          chatIds = savedLayout.chatIds;
        } else if (savedLayout && isLegacyTreeLayout(savedLayout)) {
          chatIds = extractChatIdsFromTree(savedLayout as TreeNode);
        }

        if (chatIds.length === 0) {
          chatIds = [newChatId()];
        }

        for (const chatId of chatIds) {
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
        }

        // Persist the migrated/new layout in dockview format
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

function createDefaultPanel(
  api: DockviewApi,
  workspaceId: string,
): void {
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
