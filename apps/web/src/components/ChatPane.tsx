import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { ChatView } from "./ChatView";
import { consumeChatFresh } from "./DockviewChatContainer";

// Query keys — kept in one place so the agent-switch handler can invalidate
// the chats.get cache after a successful switch and refetches honour the
// shared placeholderData policy.
const settingsKey = () => ["settings.get"] as const;
const chatKey = (chatId: string) => ["chats.get", chatId] as const;

/**
 * Agent types whose adapters report `supportedFeatures.sessionListing: true`.
 * Keep in sync with `CodingAgentFeatures.sessionListing` on each adapter in
 * `packages/coding-agent/src/adapters/`.
 */
const SESSION_LISTING_AGENT_TYPES = new Set(["claude-code", "codex", "opencode"]);

export function agentTypeSupportsSessionListing(type: string | undefined): boolean {
  return type !== undefined && SESSION_LISTING_AGENT_TYPES.has(type);
}

export interface CodingAgentDef {
  id: string;
  type: string;
  label: string;
}

/** State returned by useChatPaneState — consumed by the pane titlebar and ChatView. */
export interface ChatPaneState {
  supportsSessionListing: boolean;
  initialSessionId: string | undefined;
  sessionQueryDone: boolean;
  showSessionList: boolean;
  setShowSessionList: (show: boolean) => void;
  toggleSessionList: () => void;
  agentType: string | undefined;
  codingAgentId: string;
  /** Human-readable label for the agent (e.g. "Claude Code"). */
  agentLabel: string;
  agents: CodingAgentDef[];
  newSessionRef: React.MutableRefObject<(() => void) | null>;
  /**
   * Background-notify path: called when the subscription resolves a new
   * session id on its own (server auto-started one on first message). Just
   * refreshes the chatQuery so the tab title updates — server-side
   * task-runner already persisted `activeSessionId` on `session-start`, so
   * no client mutation is needed and no remount is triggered.
   */
  onSessionDiscovered: (sessionId: string) => void;
  /**
   * User-initiated path: called from "Select past session" / "New session"
   * affordances. Persists the change to the server, invalidates the
   * chatQuery cache, AND bumps `paneKey` to remount ChatView so its
   * subscription opens fresh against the new session.
   */
  onSwitchSession: (sessionId: string | undefined) => Promise<void>;
  /** Summary of the active session (if any). Used for tab titles. */
  activeSessionSummary: string | undefined;
  /** Switch to a different coding agent — triggers chat reload. */
  onSwitchAgent: (agentId: string) => void;
  /** Key that increments on agent switch / session switch to force ChatView remount. */
  paneKey: number;
}

/**
 * Hook that loads agent config and session state for a chat pane.
 * Used by both the pane titlebar (for controls) and ChatView (for rendering).
 *
 * Caching strategy: `chats.get` is the only query on the first-paint hot
 * path. The server persists `activeSessionId` AND the cached
 * `activeSessionSummary` on the chat row, so a workspace switch is a pure
 * SQLite read with zero filesystem access. `sessions.list` is no longer
 * eagerly called here — it fires only when the user opens the history
 * dropdown (see `SessionHistoryMenu` in ChatView).
 */
export function useChatPaneState(workspaceId: string, chatId: string): ChatPaneState {
  // Check once at mount whether this is a freshly-split pane.
  const isFreshRef = useRef(consumeChatFresh(chatId));
  // One-shot guards. These prevent background refetches from clobbering
  // user-driven state (session switches, agent switches) after the initial
  // hydration has already happened for this pane.
  const sessionInitRef = useRef(isFreshRef.current);
  const agentInitRef = useRef(false);

  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  // Fresh panes can render immediately — no session to restore.
  const [sessionQueryDone, setSessionQueryDone] = useState(isFreshRef.current);
  const [showSessionList, setShowSessionList] = useState(false);
  const [agentType, setAgentType] = useState<string | undefined>(undefined);
  const [codingAgentId, setCodingAgentId] = useState<string>("");
  const [agentLabel, setAgentLabel] = useState<string>("");
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [activeSessionSummary, setActiveSessionSummary] = useState<string | undefined>(undefined);
  const [paneKey, setPaneKey] = useState(0);
  const newSessionRef = useRef<(() => void) | null>(null);

  // Settings: shared across all panes. Long staleTime — settings rarely change.
  const settingsQuery = useQuery<Record<string, unknown> | null>({
    queryKey: settingsKey(),
    queryFn: async () => {
      try {
        return (await trpc.settings.get.query()) as Record<string, unknown> | null;
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
  });

  // Chat record: keyed per chatId. Refetched in the background when stale,
  // but the placeholder keeps the previous data on screen so re-mounts feel
  // instant. The server resolves any missing summary lazily on this call,
  // and kicks off a background refresh so subsequent reads stay fresh.
  type ChatGetResult = Awaited<ReturnType<typeof trpc.chats.get.query>>;
  const chatQuery = useQuery<ChatGetResult>({
    queryKey: chatKey(chatId),
    queryFn: async () => {
      try {
        return await trpc.chats.get.query({ chatId });
      } catch {
        return { chat: null } as ChatGetResult;
      }
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Whether the configured agent supports session listing — derived from
  // the agent definition, no filesystem access required.
  //
  // Note: the server-side chat record is created lazily on first message
  // send (see `task-stream.ts` and `tasks.submit`), so for a brand-new
  // empty chat `chatQuery.data?.chat` is null. Fall back to the default
  // coding agent from settings in that case so the session-history
  // dropdown is available before the user types anything. Mirrors the
  // `chat?.agent ?? defaultAgentId` pattern used in the agent-init effect
  // below.
  const supportsSessionListing = (() => {
    const settings = settingsQuery.data as Record<string, unknown> | null | undefined;
    if (!settings) return false;
    const chat = chatQuery.data?.chat;
    const raw = settings.codingAgents;
    const codingAgents = Array.isArray(raw) ? (raw as Array<{ id: string; type: string }>) : [];
    const defaultAgentId = settings.defaultCodingAgent as string | undefined;
    const agentId = chat?.agent ?? defaultAgentId;
    if (!agentId) return false;
    const found = codingAgents.find((a) => a.id === agentId);
    return found ? agentTypeSupportsSessionListing(found.type) : false;
  })();

  // --- Agent config: derived from settings + chat record ---
  // Runs on first arrival and on chatId change. Subsequent background
  // refetches don't reapply because agentInitRef gates re-init; user-driven
  // switches via onSwitchAgent invalidate the cache and reset the ref.
  useEffect(() => {
    const settings = settingsQuery.data;
    const chatResult = chatQuery.data;
    if (agentInitRef.current) return;
    if (!settings || !chatResult) return;

    const raw = (settings as Record<string, unknown>).codingAgents;
    const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
    setAgents(codingAgents);

    const defaultAgentId = (settings as Record<string, unknown>).defaultCodingAgent as
      | string
      | undefined;
    const agentId = chatResult.chat?.agent ?? defaultAgentId ?? "";
    setCodingAgentId(agentId);
    const found = codingAgents.find((a) => a.id === agentId);
    if (found) {
      setAgentType(found.type);
      setAgentLabel(found.label);
    }
    agentInitRef.current = true;
  }, [settingsQuery.data, chatQuery.data]);

  // --- Session state initialisation ---
  //
  // Single-phase: `chats.get` returns both the persisted activeSessionId
  // and the cached summary. The server-side fallback (no activeSessionId)
  // resolves the latest session via mtime-sorted readdir + a single
  // getSessionInfo and persists the result, so the row we see here is
  // always self-contained.
  useEffect(() => {
    if (sessionInitRef.current) return;
    const chatResult = chatQuery.data;
    if (!chatResult) return;
    const persisted = chatResult.chat?.activeSessionId;
    if (typeof persisted === "string" && persisted) {
      setInitialSessionId(persisted);
      const summary = chatResult.chat?.activeSessionSummary;
      if (typeof summary === "string" && summary) setActiveSessionSummary(summary);
    }
    setSessionQueryDone(true);
    sessionInitRef.current = true;
  }, [chatQuery.data]);

  // Keep the tab title in sync with background refetches — the server
  // refreshes the cached summary after each chats.get and the next read
  // (≤30 s later) reflects any drift (e.g. /rename).
  useEffect(() => {
    const chatResult = chatQuery.data;
    if (!chatResult) return;
    const persisted = chatResult.chat?.activeSessionId;
    if (typeof persisted !== "string" || !persisted) return;
    const summary = chatResult.chat?.activeSessionSummary;
    if (typeof summary === "string" && summary) setActiveSessionSummary(summary);
  }, [chatQuery.data]);

  const queryClient = useQueryClient();

  const toggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  // Persist active session to the server AND remount the ChatView so its
  // event-log subscription opens against the new session. Without the
  // remount, the existing subscription would keep streaming the old
  // session's events into the reducer's already-populated `messages`
  // array, double-rendering the conversation.
  //
  // Sequence: await the setActiveSession mutation (so the server's chat
  // row reflects the new sessionId by the time the new subscription
  // opens) → update local `initialSessionId` → bump `paneKey`. ChatView
  // remounts, its useChatSubscription opens a fresh stream, and the
  // server's chat-events handler picks up the new chat.activeSessionId
  // for replay.
  // Background-notify path. Called when the subscription resolves a session
  // id on its own (server's task-runner.session-start already persisted
  // chat.activeSessionId — we just need to refresh the chatQuery so the
  // tab title / cached summary update). Crucially: NO remount. The user
  // is mid-conversation; tearing down the subscription would lose state.
  const onSessionDiscovered = useCallback(
    (sessionId: string) => {
      setActiveSessionSummary(undefined);
      setInitialSessionId(sessionId);
      sessionInitRef.current = true;
      queryClient.invalidateQueries({ queryKey: chatKey(chatId) });
    },
    [chatId, queryClient],
  );

  // User-initiated path. Persists to server, then bumps `paneKey` to
  // remount ChatView with the new session loaded from scratch.
  //
  // Sequence: await the setActiveSession mutation (so the chat row reflects
  // the new sessionId by the time the new subscription opens) → update
  // local `initialSessionId` → bump `paneKey`. ChatView remounts, its
  // `useChatSubscription` opens a fresh stream, and the server's
  // chat-events handler picks up the new chat.activeSessionId for replay.
  const onSwitchSession = useCallback(
    async (sessionId: string | undefined) => {
      setActiveSessionSummary(undefined);
      try {
        await trpc.chats.setActiveSession.mutate({
          workspaceId,
          chatId,
          sessionId: sessionId ?? undefined,
        });
      } catch (err) {
        console.error("[ChatPane] error persisting active session:", err);
        return;
      }
      queryClient.invalidateQueries({ queryKey: chatKey(chatId) });
      // Pin the local state — chatQuery refetch could re-promote the prior
      // session via `ensureActiveSessionSummary`'s latest-on-disk fallback.
      setInitialSessionId(sessionId);
      sessionInitRef.current = true;
      setPaneKey((k) => k + 1);
    },
    [workspaceId, chatId, queryClient],
  );

  // Switch to a different coding agent — calls server, updates local state, increments paneKey.
  const onSwitchAgent = useCallback(
    (agentId: string) => {
      if (agentId === codingAgentId) return;
      trpc.workspace.switchAgent
        .mutate({ workspaceId, agentId, chatId })
        .then(() => {
          setCodingAgentId(agentId);
          const found = agents.find((a) => a.id === agentId);
          if (found) {
            setAgentType(found.type);
            setAgentLabel(found.label);
          }
          setPaneKey((k) => k + 1);
          // Server-side chat record now references a new agent — invalidate
          // the cached chats.get so the next read reflects it.
          queryClient.invalidateQueries({ queryKey: chatKey(chatId) });
        })
        .catch((err) => {
          console.error("[ChatPane] error switching agent:", err);
        });
    },
    [workspaceId, chatId, codingAgentId, agents, queryClient],
  );

  return {
    supportsSessionListing,
    initialSessionId,
    sessionQueryDone,
    showSessionList,
    setShowSessionList,
    toggleSessionList,
    agentType,
    codingAgentId,
    agentLabel,
    agents,
    newSessionRef,
    onSessionDiscovered,
    onSwitchSession,
    activeSessionSummary,
    onSwitchAgent,
    paneKey,
  };
}

// ---------------------------------------------------------------------------
// ChatPane — headless wrapper that renders ChatView with loaded state.
// The pane titlebar (with agent info, session buttons, split/close) is
// rendered by the tab header in DockviewChatContainer.
// ---------------------------------------------------------------------------

interface ChatPaneProps {
  workspaceId: string;
  chatId: string;
  visible?: boolean;
  wsActive?: boolean;
  state: ChatPaneState;
}

export function ChatPane({ workspaceId, chatId, visible, wsActive, state }: ChatPaneProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ChatView
        key={state.paneKey}
        workspaceId={workspaceId}
        chatId={chatId}
        workspaceName={workspaceId}
        supportsSessionListing={state.supportsSessionListing}
        initialSessionId={state.initialSessionId}
        sessionQueryDone={state.sessionQueryDone}
        showSessionList={state.showSessionList}
        onShowSessionListChange={state.setShowSessionList}
        onNewSessionRef={state.newSessionRef}
        onSessionDiscovered={state.onSessionDiscovered}
        onSwitchSession={state.onSwitchSession}
        agentType={state.agentType}
        codingAgentId={state.codingAgentId}
        onSwitchAgent={state.onSwitchAgent}
        visible={visible}
        wsActive={wsActive}
      />
    </div>
  );
}
