import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@band-app/ui";
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon, type ChatInsertDetail, useAdapter } from "@/dashboard";
import { writeClipboardText } from "../lib/clipboard";
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
import { trpc } from "../lib/trpc-client";
import { ChatPane, type CodingAgentDef, useChatPaneState } from "./ChatPane";
import { PanelVisibilityContext, usePanelVisibility } from "./panel-visibility-context";
// `crossPanelHandlers` is a module-level mutable registry exported from
// SharedDockviewLayout. Importing it here closes an ESM cycle
// (SharedDockviewLayout → DockviewChatContainer → SharedDockviewLayout),
// but we only read it inside a click handler (call time, never module
// eval), so the live binding is always populated by then — same pattern
// `__root.tsx` uses to drive the dockview without a dockview API ref.
import { crossPanelHandlers } from "./SharedDockviewLayout";

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
// Shared settings fetch
//
// `settings.get` is global. When a workspace with several chat tabs loads,
// each tab's mount would otherwise fire its own `settings.get` (N small
// server-side file reads). A short-TTL shared promise collapses that burst
// into a single fetch, while staying fresh enough that an agent change made
// in the Settings UI is picked up on the next tab mount.
// ---------------------------------------------------------------------------

let sharedSettingsPromise: Promise<unknown> | null = null;
let sharedSettingsAt = 0;
const SHARED_SETTINGS_TTL_MS = 5_000;

function getSharedSettings(): Promise<unknown> {
  const now = Date.now();
  if (!sharedSettingsPromise || now - sharedSettingsAt > SHARED_SETTINGS_TTL_MS) {
    sharedSettingsAt = now;
    sharedSettingsPromise = trpc.settings.get.query().catch(() => {
      // Don't cache a failed fetch for the whole TTL — a transient error
      // would otherwise leave every tab mount in the window with null
      // settings. Reset so the next mount retries.
      sharedSettingsPromise = null;
      return null;
    });
  }
  return sharedSettingsPromise;
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

// Visibility is propagated from DockviewChatContainer via the shared
// PanelVisibilityContext instead of dockview's updateParameters (which
// clobbers params).

interface ChatTabParams {
  workspaceId: string;
  chatId: string;
}

function ChatTabPanel({ params, api }: IDockviewPanelProps<ChatTabParams>) {
  // Track visibility: combine parent visibility context with dockview's own active state
  const [tabActive, setTabActive] = useState(api.isActive);
  const { visible: parentVisible, wsActive } = usePanelVisibility();

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
    // `data-testid` encodes the visibility signal the SHARED
    // `PanelVisibilityContext` propagated into this tab panel
    // (see `panel-visibility-context.tsx`), so an integration test can
    // assert that the context plumbing — not just dockview's outer
    // detach behaviour — actually reaches the leaf. Pinned to the wrapper
    // div so the BEM convention matches the rest of the codebase.
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid={`dockview-chat-tab__visible-${visible ? "true" : "false"}`}
    >
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

/**
 * Coding-agent types whose vendor CLI can resume a session by ID in an
 * interactive terminal (`resumeCliInvocation`). Used to disable the chat
 * tab's "Continue in terminal" item for agents that can't (gemini-cli has
 * no session model; cursor-cli is SDK-only).
 */
const RESUME_CAPABLE_AGENT_TYPES = new Set(["claude-code", "codex", "opencode"]);

function ChatTab(props: IDockviewPanelHeaderProps<ChatTabParams>) {
  const initialChatId = props.params.chatId;
  const initialCache = readCachedTabMeta(initialChatId);
  const [title, setTitle] = useState(initialCache.title ?? props.api.title ?? "Chat");
  const [agentType, setAgentType] = useState<string | undefined>(initialCache.agentType);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
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

  // Resolve agent type (for the icon) + active session id (for the
  // context-menu actions). The global `settings` blob (agent id → type
  // map) is fetched once on mount and cached in a ref; the per-menu-open
  // refresh re-reads only the chat (for the active session id AND the
  // agent, which often only resolves after the first message creates the
  // chat record) and maps the agent through the cached settings — so a
  // right-click never re-fetches the global settings blob.
  const chatId = props.params.chatId;
  const workspaceId = props.params.workspaceId;

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Cached settings (populated on mount) so the per-open refresh can map a
  // chat's agent id to its type without re-fetching the global blob.
  const codingAgentsRef = useRef<CodingAgentDef[]>([]);
  const defaultAgentIdRef = useRef<string | undefined>(undefined);

  // Apply a `chats.get` result: update the active session id and (via the
  // cached settings) the agent type. The chat record is created lazily on
  // the first message, so the agent type frequently only resolves on a
  // later refresh — recompute it here rather than only on mount.
  const applyChatMeta = useCallback(
    (chat: { agent?: string; activeSessionId?: string } | null | undefined) => {
      if (!mountedRef.current) return;
      setSessionId(chat?.activeSessionId ?? undefined);
      const agentId = chat?.agent ?? defaultAgentIdRef.current ?? "";
      const found = codingAgentsRef.current.find((a) => a.id === agentId);
      if (found) {
        setAgentType(found.type);
        writeCachedTabMeta(chatId, { agentType: found.type });
      }
    },
    [chatId],
  );

  const refreshTabMeta = useCallback(() => {
    if (!chatId || !workspaceId) return;
    Promise.all([
      getSharedSettings(),
      trpc.chats.get.query({ chatId }).catch(() => ({ chat: null })),
    ])
      .then(([settings, chatResult]) => {
        if (!mountedRef.current) return;
        const raw = (settings as Record<string, unknown> | null)?.codingAgents;
        codingAgentsRef.current = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
        defaultAgentIdRef.current = (settings as Record<string, unknown> | null)
          ?.defaultCodingAgent as string | undefined;
        applyChatMeta(chatResult.chat);
      })
      // Defensive: both inputs catch internally today, but guard the chain
      // so a future change that drops one can't surface an unhandled
      // rejection from this fire-and-forget mount effect.
      .catch(() => {});
  }, [chatId, workspaceId, applyChatMeta]);

  // Lightweight refresh for the context-menu open path: re-reads only the
  // chat (session id + agent), mapping the agent through the settings
  // cached on mount — no redundant global `settings.get`.
  const refreshChatMeta = useCallback(() => {
    if (!chatId) return;
    trpc.chats.get
      .query({ chatId })
      .then((res) => applyChatMeta(res.chat))
      .catch(() => {});
  }, [chatId, applyChatMeta]);

  useEffect(() => {
    refreshTabMeta();
  }, [refreshTabMeta]);

  const canResume = !!sessionId && !!agentType && RESUME_CAPABLE_AGENT_TYPES.has(agentType);

  const handleContinueInTerminal = useCallback(() => {
    trpc.chats.continueInTerminal
      .mutate({ chatId })
      .then(() => {
        // Surface the Terminal panel so the user lands on the resumed
        // session. The server already spawned the pane + emitted
        // `terminal-created`; this just flips the outer panel switcher.
        crossPanelHandlers.onActivateTerminalPanel(workspaceId);
      })
      .catch((err) => {
        console.error("[ChatTab] continue in terminal failed:", err);
      });
  }, [chatId, workspaceId]);

  const handleCopySessionId = useCallback(() => {
    if (!sessionId) return;
    // Use the shared helper, not `navigator.clipboard` directly:
    // `navigator.clipboard` is undefined in a non-secure context (Band
    // served over plain HTTP on a LAN IP / non-HTTPS tunnel), so the raw
    // API silently no-ops there. `writeClipboardText` falls back to the
    // legacy execCommand path that works without a secure context.
    void writeClipboardText(sessionId);
  }, [sessionId]);

  const containerApi = props.containerApi;
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Route to the handlers owned by THIS tab's dockview (keyed by
      // `containerApi.id`) so closing a tab in the visible workspace never
      // operates on a cached, hidden workspace's dockview.
      panelActionsByApiId.get(containerApi.id)?.current?.onClose(chatId);
    },
    [containerApi, chatId],
  );

  const showClose = panelCount > 1;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        // Refresh the chat's session id + agent each time the menu opens so
        // the items' enabled state reflects the latest values (both can
        // change as the user works — the chat record itself is created
        // lazily on the first message). Settings stay cached from mount.
        if (open) refreshChatMeta();
      }}
    >
      <ContextMenuTrigger asChild>
        <div className="dv-default-tab" data-testid={`chat-tab__trigger--${chatId}`}>
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
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="chat-tab__context-menu">
        <ContextMenuItem
          disabled={!canResume}
          onClick={handleContinueInTerminal}
          data-testid="chat-tab__context-menu-item--continue-in-terminal"
        >
          Continue in terminal
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!sessionId}
          onClick={handleCopySessionId}
          data-testid="chat-tab__context-menu-item--copy-session-id"
        >
          Copy session ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Per-instance action registry for stable Dockview components
//
// dockview's `rightHeaderActionsComponent` and tab header components must be
// STABLE references — a closure-capturing component can't be passed directly
// (see the comment on `RightHeaderActions`). The handlers those components
// invoke, however, are per-container-instance: each mounted
// DockviewChatContainer has its own `workspaceId` and inner dockview api.
//
// MultiWorkspacePanelHost keeps up to `DEFAULT_MAX_CACHED_WORKSPACES` (3)
// workspaces mounted at once — inactive ones are only `visibility: hidden`,
// so several DockviewChatContainer instances are live simultaneously and all
// keep re-rendering. A single module-level handler ref therefore suffered
// last-writer-wins: whichever hidden instance rendered most recently left ITS
// handlers in the global, and clicking "+" / split in the VISIBLE workspace
// created the chat in the wrong (cached, hidden) workspace.
//
// Fix: key the handlers by the owning dockview's `api.id`. dockview passes the
// owning `containerApi` into both header-action props and tab-header props, so
// the visible group always resolves to its own workspace's handlers. We key by
// `api.id` (not the DockviewApi object): dockview hands out a fresh
// `DockviewApi` *wrapper* per group, so `props.containerApi !== onReadyApi` by
// reference — but every wrapper exposes the same underlying component `id`.
// The value is the instance's `useRef` holder, so clicks always read the
// latest closures via `.current`.
// ---------------------------------------------------------------------------

interface ChatPanelActions {
  onAdd: (agentId?: string, groupId?: string) => void;
  onSplit: (groupId: string, direction: "right" | "below") => void;
  onClose: (chatId: string) => void;
}

const panelActionsByApiId = new Map<string, { current: ChatPanelActions }>();

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
  // the "+" button there so users can add another chat tab to the
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
    // gives integration tests a stable hook for the central action row
    // without the fragile CSS `:has(button[title=...])` workaround.
    <div
      className="flex h-full w-full items-center justify-center"
      data-testid={isGridGroup ? "dockview-chat__toolbar" : undefined}
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
        onClick={() => panelActionsByApiId.get(apiId)?.current?.onAdd(undefined, groupId)}
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
  // Mirror `wsActive` for use inside stable closures (onReady, event handlers)
  // so focus reporting only fires for the workspace the user is looking at —
  // never for the cached, hidden workspaces MultiWorkspacePanelHost keeps alive.
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

  // Report the active chat tab to the server as the workspace's last-focused
  // chat. Gated on `wsActive` (skip cached/hidden workspaces) and skipped while
  // restoring the saved layout (fromJSON fires spurious activePanelChange).
  // Fire-and-forget — this is a best-effort hint for "Add to Chat" routing.
  const reportChatFocus = useCallback(() => {
    if (isRestoringRef.current) return;
    if (wsActiveRef.current === false) return;
    const panelId = apiRef.current?.activePanel?.id;
    if (!panelId) return;
    trpc.panelFocus.set.mutate({ workspaceId, panelType: "chat", panelId }).catch(() => {});
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

    selectNeighbourBeforeRemove(api, chatId);
    const panel = api.getPanel(chatId);
    if (panel) {
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
      cycleTabsInActiveGroup(apiRef.current, direction, () => {
        apiRef.current?.activeGroup?.model.focusContent();
      });
    };

    const cycleGroups = (direction: 1 | -1) => {
      cycleGridGroups(apiRef.current, direction, () => {
        apiRef.current?.activeGroup?.model.focusContent();
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
      // Record a baseline last-focused chat as soon as the section is shown,
      // so "Add to Chat" has a target even if the user never switches tabs.
      reportChatFocus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, reportChatFocus]);

  // Bring the last-focused chat tab forward when "Add to Chat" targets it.
  // SharedDockviewLayout resolves the workspace's last-focused chat, surfaces
  // the outer Chat panel, and dispatches the scoped `band:chat-insert`; here we
  // activate the matching inner tab so the pane that receives the reference is
  // the one the user sees. PromptInput does the actual text insertion.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail?.chatId || detail.workspaceId !== workspaceId) return;
      apiRef.current?.getPanel(detail.chatId)?.api.setActive();
    };
    window.addEventListener("band:chat-insert", handler);
    return () => window.removeEventListener("band:chat-insert", handler);
  }, [workspaceId]);

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
        // Pin the new panel to the inner dockview's central area.
        // Without this explicit position, dockview's fallback uses
        // `activeGroup`, which can be one of the collapsed edge
        // groups added by `ensureEdgeGroups` — making the panel
        // render as a thin docked strip instead of in the center.
        // See `centralPanelPosition` for the full rationale.
        api.addPanel({
          id: event.chatId,
          component: "chatTab",
          tabComponent: "chatTab",
          title: "Chat",
          params: { workspaceId, chatId: event.chatId },
          position: centralPanelPosition(api),
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

  // Visibility is now propagated via PanelVisibilityContext (React context)
  // instead of updateParameters — see the Provider wrapping DockviewReact.

  // Per-instance action handlers for the stable Dockview header/tab
  // components. Registered in `panelActionsByApiId` (keyed by this inner
  // dockview's `api.id`) from `onReady`; mutated every render so the registry
  // always holds this instance's latest closures. See the registry comment
  // for why a module-level singleton was wrong.
  const actionsRef = useRef<ChatPanelActions>({
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
  const initialChatIdsRef = useRef<Set<string> | null>(null);
  initialChatIdsRef.current = initialData?.chatIds ?? null;

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

        // Visibility is propagated via PanelVisibilityContext — no param update needed.

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
        reportChatFocus();
      });
      event.api.onDidAddGroup(persist);
      event.api.onDidRemoveGroup(persist);
    },
    [workspaceId, schedulePersist, reportChatFocus],
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
      <PanelVisibilityContext.Provider value={visibilityValue}>
        <DockviewReact
          theme={chatTabTheme}
          className="h-full"
          components={chatPanelComponents}
          tabComponents={chatTabComponents}
          defaultTabComponent={ChatTab}
          onReady={onReady}
          rightHeaderActionsComponent={RightHeaderActions}
        />
      </PanelVisibilityContext.Provider>
    </div>
  );
}

function createDefaultPanel(api: DockviewApi, workspaceId: string): void {
  const chatId = newChatId();
  // Pin the default panel to the inner dockview's central area so it
  // lands there instead of leaking into an edge group that
  // `ensureEdgeGroups` may have already added. See
  // `centralPanelPosition` for the full rationale.
  api.addPanel({
    id: chatId,
    component: "chatTab",
    tabComponent: "chatTab",
    title: "Chat",
    params: {
      workspaceId,
      chatId,
    },
    position: centralPanelPosition(api),
  });
}
