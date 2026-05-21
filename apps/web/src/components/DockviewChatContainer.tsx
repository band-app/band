import { AgentIcon, useAdapter } from "@band-app/dashboard-core";
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
import { Columns2, Plus, Rows2, X } from "lucide-react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
// React Query cache key
// ---------------------------------------------------------------------------

function chatLayoutKey(workspaceId: string) {
  return ["chatLayout", workspaceId] as const;
}

// ---------------------------------------------------------------------------
// Debounced server persistence (500ms) — also updates React Query cache
// so the next mount renders instantly from cached data.
// ---------------------------------------------------------------------------

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface ChatPersistOptions {
  queryClient?: ReturnType<typeof useQueryClient>;
}

interface ChatLayoutData {
  layout: unknown | null;
  /**
   * Set of chat ids that exist on the server *right now*. Used at mount
   * time to prune orphan panels from the saved layout — same defense
   * that `DockviewBrowserContainer` and `DockviewTerminalContainer`
   * already apply.
   */
  chatIds: Set<string>;
}

function persistToServer(workspaceId: string, layout: unknown, opts?: ChatPersistOptions): void {
  // Update React Query cache immediately so next mount is instant
  if (opts?.queryClient) {
    opts.queryClient.setQueryData(chatLayoutKey(workspaceId), { layout });
  }

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

// Visibility context — propagated from DockviewChatContainer via React
// context instead of dockview's updateParameters (which clobbers params).
const ChatVisibilityContext = createContext({ visible: true, wsActive: true });

interface ChatTabParams {
  workspaceId: string;
  chatId: string;
}

function ChatTabPanel({ params, api }: IDockviewPanelProps<ChatTabParams>) {
  // Track visibility: combine parent visibility context with dockview's own active state
  const [tabActive, setTabActive] = useState(api.isActive);
  const { visible: parentVisible, wsActive } = useContext(ChatVisibilityContext);

  useEffect(() => {
    const d = api.onDidActiveChange((e) => setTabActive(e.isActive));
    return () => {
      d.dispose();
    };
  }, [api]);

  if (!params.workspaceId || !params.chatId) return null;

  const visible = parentVisible && tabActive;

  return (
    <ChatTabContent
      workspaceId={params.workspaceId}
      chatId={params.chatId}
      visible={visible}
      wsActive={wsActive}
      setTitle={(title: string) => api.setTitle(title)}
    />
  );
}

/** Separate component so hooks work properly. */
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

  // Update the dockview tab title based on session summary or agent label.
  // Wait for sessionQueryDone before pushing a title so we don't flicker
  // through agentLabel → sessionSummary on cold mount. Once the session
  // query has resolved (with or without a summary), pick the best value.
  const setTitleRef = useRef(setTitle);
  setTitleRef.current = setTitle;
  useEffect(() => {
    if (!state.sessionQueryDone) return;
    const title = state.activeSessionSummary || state.agentLabel || state.codingAgentId || "Chat";
    setTitleRef.current(title);
  }, [state.sessionQueryDone, state.activeSessionSummary, state.agentLabel, state.codingAgentId]);

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

// Persist last-known tab title + agent type per chatId so a remount of the tab
// header (workspace switch, dockview re-init) starts with the previous values
// instead of the bare "Chat" placeholder + missing icon — eliminates the
// fade-in flicker users saw when title/icon resolved asynchronously.
function readCachedTabMeta(chatId: string): { title?: string; agentType?: string } {
  if (!chatId) return {};
  try {
    const raw = sessionStorage.getItem(`band:chat-tab-meta:${chatId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCachedTabMeta(chatId: string, patch: { title?: string; agentType?: string }) {
  if (!chatId) return;
  try {
    const prev = readCachedTabMeta(chatId);
    sessionStorage.setItem(`band:chat-tab-meta:${chatId}`, JSON.stringify({ ...prev, ...patch }));
  } catch {}
}

function ChatTab(props: IDockviewPanelHeaderProps<ChatTabParams>) {
  const initialChatId = props.params.chatId;
  const initialCache = readCachedTabMeta(initialChatId);
  const [title, setTitle] = useState(initialCache.title ?? props.api.title ?? "Chat");
  const [agentType, setAgentType] = useState<string | undefined>(initialCache.agentType);
  const [panelCount, setPanelCount] = useState(props.containerApi.panels.length);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => {
      const next = props.api.title ?? "Chat";
      setTitle(next);
      writeCachedTabMeta(initialChatId, { title: next });
    });
    return () => d.dispose();
  }, [props.api, initialChatId]);

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
      if (found) {
        setAgentType(found.type);
        writeCachedTabMeta(chatId, { agentType: found.type });
      }
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
        {/* Reserve icon slot — opacity fades in once agentType resolves so
            the icon does not pop in. Width is reserved either way. */}
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150"
          style={{ opacity: agentType ? 1 : 0 }}
        >
          {agentType && <AgentIcon type={agentType} className="size-3.5" />}
        </span>
        {/* Bounded width so chat tab does not reflow as title loads/changes. */}
        <span className="truncate min-w-[6rem] max-w-[14rem]">{title}</span>
      </div>
      {/* Always render the close button slot — toggle visibility via opacity
          instead of mounting/unmounting so panelCount swings (1 ↔ 2) do not
          shift the tab width. */}
      <button
        type="button"
        aria-hidden={!showClose}
        tabIndex={showClose ? 0 : -1}
        className="ml-1 inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 hover:bg-accent transition-opacity"
        style={{
          opacity: showClose ? undefined : 0,
          pointerEvents: showClose ? undefined : "none",
        }}
        onClick={handleClose}
        title="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared refs for stable Dockview components
// ---------------------------------------------------------------------------

const addTabRef: {
  current: {
    onAdd: (agentId?: string, groupId?: string) => void;
    onSplit: (groupId: string, direction: "right" | "below") => void;
  };
} = {
  current: { onAdd: () => {}, onSplit: () => {} },
};

/** Shared ref for the close-tab action — used by ChatTab's close button. */
const closeTabRef: { current: ((chatId: string) => void) | null } = {
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
  const { onAdd, onSplit } = addTabRef.current;
  const groupId = props.group.id;
  return (
    <div className="flex h-full items-center">
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => onSplit(groupId, "right")}
        title="Split right"
      >
        <Columns2 className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => onSplit(groupId, "below")}
        title="Split down"
      >
        <Rows2 className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        onClick={() => onAdd(undefined, groupId)}
        title="New chat tab"
      >
        <Plus className="size-4" />
      </button>
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
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const apiRef = useRef<DockviewApi | null>(null);
  const isRestoringRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch layout AND chat records via React Query — cached across mounts
  // so re-visiting a workspace renders instantly from the cache. Mirrors
  // the dual-query pattern in `DockviewBrowserContainer`.
  const { data: initialData } = useQuery<ChatLayoutData>({
    queryKey: chatLayoutKey(workspaceId),
    queryFn: async () => {
      const [{ tree }, { chats }] = await Promise.all([
        trpc.chatLayout.get.query({ workspaceId }).catch(() => ({ tree: null })),
        trpc.chats.list.query({ workspaceId }).catch(() => ({ chats: [] as { id: string }[] })),
      ]);
      return {
        layout: tree,
        chatIds: new Set(chats.map((c: { id: string }) => c.id)),
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

  const handleSplit = useCallback(
    async (groupId: string, direction: "right" | "below") => {
      const api = apiRef.current;
      if (!api) return;

      const chatId = newChatId();
      markChatFresh(chatId);

      api.addPanel({
        id: chatId,
        component: "chatTab",
        tabComponent: "chatTab",
        title: "Chat",
        params: {
          workspaceId,
          chatId,
        },
        position: {
          referenceGroup: groupId,
          direction,
        },
      } as Parameters<typeof api.addPanel>[0]);
    },
    [workspaceId],
  );

  const closeTab = useCallback((chatId: string) => {
    const api = apiRef.current;
    if (!api || api.panels.length <= 1) return; // don't close last tab

    const panel = api.getPanel(chatId);
    if (panel) {
      // Pre-select the neighbour to the left (or the right if we're closing
      // the first tab) so focus doesn't snap to the first tab in the group.
      // Matches the behaviour in DockviewTerminalContainer.closeTab.
      const group = panel.group;
      const groupPanels = group?.panels ?? [];
      const idx = groupPanels.findIndex((p) => p.id === chatId);
      if (idx >= 0 && groupPanels.length > 1) {
        const neighbour = groupPanels[idx === 0 ? 1 : idx - 1];
        neighbour?.api.setActive();
      }
      api.removePanel(panel);
    }

    // Re-focus the panel content so the section-scoped keydown handler keeps
    // seeing events on the next press.
    requestAnimationFrame(() => {
      apiRef.current?.activeGroup?.model.focusContent();
    });

    // Delete the server-side chat record so closed tabs don't linger —
    // mirrors `browsers.remove` and `terminal.kill`. The mutation also
    // strips the panel from the saved layout and emits `chat-removed`
    // so any other open dashboard tabs sync automatically.
    trpc.chats.remove.mutate({ chatId }).catch((err) => {
      console.error("[DockviewChatContainer] failed to remove chat:", err);
    });
    // Layout change listeners will auto-persist
  }, []);

  // Keyboard shortcuts (capture phase, scoped to this section's focus):
  // - Cmd/Ctrl+T              → open a new chat tab (default coding agent)
  // - Cmd/Ctrl+W              → close the active chat tab
  // - Cmd/Ctrl+D              → split right (vertical split)
  // - Cmd/Ctrl+Shift+D        → split down (horizontal split)
  // - Ctrl+(Shift)+Tab        → cycle tabs in the active group
  // - Cmd/Ctrl+[ / Cmd/Ctrl+] → cycle between split chat groups (panels)
  // - Cmd/Ctrl+Shift+[/]      → cycle tabs in the active group
  useEffect(() => {
    if (!visible) return;

    const cycleTabs = (direction: 1 | -1) => {
      const api = apiRef.current;
      const group = api?.activeGroup;
      if (!api || !group) return;
      if (direction === 1) group.model.moveToNext();
      else group.model.moveToPrevious();
      group.model.focusContent();
    };

    const cycleGroups = (direction: 1 | -1) => {
      const api = apiRef.current;
      if (!api) return;
      const groups = api.groups.filter((g) => g.api.location.type === "grid");
      if (groups.length < 2) return;
      const current = api.activeGroup;
      const idx = current ? groups.findIndex((g) => g.id === current.id) : -1;
      const next = groups[(idx + direction + groups.length) % groups.length];
      next?.activePanel?.api.setActive();
      next?.model.focusContent();
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

  // Auto-focus the active chat panel whenever the section becomes visible
  // (e.g. user clicked the outer "Chat" panel tab) so the section-scoped
  // keydown handler above starts seeing events without the user having to
  // click into a tab first.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const group = apiRef.current?.activeGroup;
      if (!group) return;
      group.model.focusContent();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Sync dockview panels when chats are created/removed externally (e.g. CLI).
  // Mirrors the `browser-created` / `terminal-created` subscription in the
  // sibling containers — without this, a `band chats create` (or the lazy
  // `getOrCreateDefaultChat` path triggered by `band workspaces create
  // --prompt`) would not show up in an already-open dashboard until reload.
  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      const api = apiRef.current;
      if (!api) return;

      if (event.kind === "chat-created" && typeof event.chatId === "string") {
        // Skip if this panel already exists (we created it ourselves)
        if (api.getPanel(event.chatId)) return;
        api.addPanel({
          id: event.chatId,
          component: "chatTab",
          tabComponent: "chatTab",
          title: "Chat",
          params: { workspaceId, chatId: event.chatId },
        });
      } else if (event.kind === "chat-removed" && typeof event.chatId === "string") {
        const panel = api.getPanel(event.chatId);
        if (panel) {
          api.removePanel(panel);
          // If that was the last panel, create a fresh default tab.
          if (api.panels.length === 0) {
            createDefaultPanel(api, workspaceId);
          }
        }
      }
    });
  }, [adapter, workspaceId]);

  // Visibility is now propagated via ChatVisibilityContext (React context)
  // instead of updateParameters — see the Provider wrapping DockviewReact.

  // Keep module-level refs in sync for stable Dockview components
  addTabRef.current = { onAdd: handleAddTab, onSplit: handleSplit };
  closeTabRef.current = closeTab;

  // Use refs for the initial data so onReady's closure captures the latest
  const initialLayoutRef = useRef<unknown | null>(null);
  initialLayoutRef.current = initialData?.layout ?? null;
  const initialChatIdsRef = useRef<Set<string> | null>(null);
  initialChatIdsRef.current = initialData?.chatIds ?? null;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const savedLayout = initialLayoutRef.current;
      const knownChatIds = initialChatIdsRef.current;

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

        // Visibility is propagated via ChatVisibilityContext — no param update needed.

        // Prune panels whose chat records no longer exist on the server —
        // e.g. the user removed them via `band chats remove` while the
        // dashboard was closed. Mirrors `DockviewBrowserContainer`'s
        // orphan check.
        let dropped = 0;
        if (knownChatIds) {
          const orphans = event.api.panels.filter((p) => !knownChatIds.has(p.id));
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

        // If we removed orphans (or replaced them with a default), persist
        // the cleaned-up layout immediately. The dockview events that
        // fired while `removePanel` was running landed inside the
        // restoration window and were swallowed by `schedulePersist`'s
        // `isRestoringRef` guard. Without this explicit save, the saved
        // `chat_layout` row would still reference the dead panels — the
        // dashboard would prune them on every mount but the DB would
        // never converge.
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
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <ChatVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={chatTabTheme}
          className="h-full"
          components={chatPanelComponents}
          tabComponents={chatTabComponents}
          defaultTabComponent={ChatTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </ChatVisibilityContext.Provider>
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
    },
  });
}
