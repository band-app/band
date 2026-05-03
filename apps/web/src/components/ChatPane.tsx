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
const sessionsKey = (workspaceId: string, chatId: string) =>
  ["sessions.list", workspaceId, chatId] as const;

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
  /** Notify that the active session changed — persists to the server. */
  onActiveSessionChange: (sessionId: string | undefined) => void;
  /** Summary of the active session (if any). Used for tab titles. */
  activeSessionSummary: string | undefined;
  /** Switch to a different coding agent — triggers chat reload. */
  onSwitchAgent: (agentId: string) => void;
  /** Key that increments on agent switch to force ChatView remount. */
  paneKey: number;
}

/**
 * Hook that loads agent config and session state for a chat pane.
 * Used by both the pane titlebar (for controls) and ChatView (for rendering).
 *
 * Caching strategy: chats.get and sessions.list go through React Query with
 * `placeholderData: keepPreviousData` so revisiting a workspace renders from
 * cache instantly while the latest values revalidate in the background. The
 * cache key includes workspaceId + chatId so concurrent panes are isolated.
 */
export function useChatPaneState(workspaceId: string, chatId: string): ChatPaneState {
  // Check once at mount whether this is a freshly-split pane.
  const isFreshRef = useRef(consumeChatFresh(chatId));
  // One-shot guards. These prevent background refetches from clobbering
  // user-driven state (session switches, agent switches) after the initial
  // hydration has already happened for this pane.
  const sessionInitRef = useRef(isFreshRef.current);
  const agentInitRef = useRef(false);

  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
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
  // Keep a ref to the sessions list for looking up summaries on session switch
  const sessionsRef = useRef<Array<{ sessionId: string; summary: string }>>([]);

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
  // instant.
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

  // Sessions list: keyed per (workspaceId, chatId). The big win of caching:
  // returning to a recently-visited workspace gets the (potentially stale)
  // list immediately from cache while a fresh fetch runs in background.
  type SessionsListResult = Awaited<ReturnType<typeof trpc.sessions.list.query>>;
  const sessionsQuery = useQuery<SessionsListResult>({
    queryKey: sessionsKey(workspaceId, chatId),
    queryFn: async () => {
      try {
        return await trpc.sessions.list.query({ workspaceId, chatId });
      } catch {
        return { sessions: [], supported: false } as SessionsListResult;
      }
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

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

  // --- Session list ref + supportsSessionListing ---
  // Always reflects the latest sessions data (even on background refetch)
  // so onActiveSessionChange's summary lookups stay current.
  useEffect(() => {
    const data = sessionsQuery.data;
    if (!data) return;
    if (data.supported) setSupportsSessionListing(true);
    sessionsRef.current = data.sessions as Array<{
      sessionId: string;
      summary: string;
      lastModified: number;
    }>;
  }, [sessionsQuery.data]);

  // --- Session state initialisation ---
  //
  // Two-phase resolution so chat rendering doesn't wait on the slow
  // sessions.list call:
  //
  //   Phase A (fast): chats.get resolves. If a persisted activeSessionId
  //     exists, surface it and flip sessionQueryDone immediately so
  //     ChatView can start loading messages.
  //
  //   Phase B (slow): sessions.list resolves. Used to populate the
  //     session sidebar/dropdown, the active-session summary for the
  //     tab title, and to fall back to the most recently modified
  //     session when no activeSessionId was persisted.
  //
  // For panes with no persisted active session we still wait for both
  // (otherwise ChatView would resumeStream() against `undefined` and we
  // would never auto-load the latest session).
  useEffect(() => {
    if (sessionInitRef.current) return;
    const chatResult = chatQuery.data;
    if (!chatResult) return;
    const persisted = chatResult.chat?.activeSessionId;
    if (typeof persisted === "string" && persisted) {
      setInitialSessionId(persisted);
      setSessionQueryDone(true);
      sessionInitRef.current = true;
    }
  }, [chatQuery.data]);

  useEffect(() => {
    if (sessionInitRef.current) return;
    const chatResult = chatQuery.data;
    const sessionsResult = sessionsQuery.data;
    if (!chatResult || !sessionsResult) return;

    const sessions = sessionsResult.sessions as Array<{
      sessionId: string;
      summary: string;
      lastModified: number;
    }>;
    if (sessionsResult.supported && sessions.length > 0) {
      const latest = [...sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
      if (latest) {
        setInitialSessionId(latest.sessionId);
        if (latest.summary) setActiveSessionSummary(latest.summary);
      }
    }
    setSessionQueryDone(true);
    sessionInitRef.current = true;
  }, [chatQuery.data, sessionsQuery.data]);

  // Whenever both queries are resolved, populate the active-session summary
  // for the tab title. Re-runs on background refetches so the title stays
  // in sync with the persisted activeSessionId.
  useEffect(() => {
    const chatResult = chatQuery.data;
    const sessionsResult = sessionsQuery.data;
    if (!chatResult || !sessionsResult) return;
    const persisted = chatResult.chat?.activeSessionId;
    if (typeof persisted !== "string" || !persisted) return;
    const sessions = sessionsResult.sessions as Array<{
      sessionId: string;
      summary: string;
    }>;
    const match = sessions.find((s) => s.sessionId === persisted);
    if (match?.summary) setActiveSessionSummary(match.summary);
  }, [chatQuery.data, sessionsQuery.data]);

  const toggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  // Persist active session to the server and update the summary for the tab title.
  const onActiveSessionChange = useCallback(
    (sessionId: string | undefined) => {
      trpc.chats.setActiveSession
        .mutate({ workspaceId, chatId, sessionId: sessionId ?? undefined })
        .catch((err) => {
          console.error("[ChatPane] error persisting active session:", err);
        });

      // Update session summary from cached sessions list
      if (sessionId) {
        const match = sessionsRef.current.find((s) => s.sessionId === sessionId);
        setActiveSessionSummary(match?.summary || undefined);
      } else {
        setActiveSessionSummary(undefined);
      }
    },
    [workspaceId, chatId],
  );

  const queryClient = useQueryClient();

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
    onActiveSessionChange,
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
        onActiveSessionChange={state.onActiveSessionChange}
        agentType={state.agentType}
        codingAgentId={state.codingAgentId}
        onSwitchAgent={state.onSwitchAgent}
        visible={visible}
        wsActive={wsActive}
      />
    </div>
  );
}
