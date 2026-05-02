import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { ChatView } from "./ChatView";
import { consumeChatFresh } from "./DockviewChatContainer";

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
 */
export function useChatPaneState(workspaceId: string, chatId: string): ChatPaneState {
  // Check once at mount whether this is a freshly-split pane.
  const isFreshRef = useRef(consumeChatFresh(chatId));

  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  // Fresh panes can render immediately — no session to restore.
  // sessionQueryDone gates ChatView rendering; supportsSessionListing
  // (for the history button) is set asynchronously by the effect below.
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

  // Load agent config + sessions on mount.
  // Agent config always loads. Session restoration is skipped for fresh panes
  // (they start clean) but we still check whether sessions are supported so
  // the history/new-session buttons appear.
  useEffect(() => {
    const isFresh = isFreshRef.current;
    let cancelled = false;

    const settingsP = trpc.settings.get.query().catch(() => null);
    const chatP = trpc.chats.get.query({ chatId }).catch(() => ({ chat: null as null }));
    const sessionsP = trpc.sessions.list
      .query({ workspaceId, chatId })
      .catch(() => ({ sessions: [] as never[], supported: false }));

    // --- Agent config: settings + chat record ---
    Promise.all([settingsP, chatP]).then(([settings, chatResult]) => {
      if (cancelled) return;
      const raw = (settings as Record<string, unknown> | null)?.codingAgents;
      const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
      setAgents(codingAgents);

      const defaultAgentId = (settings as Record<string, unknown> | null)?.defaultCodingAgent as
        | string
        | undefined;
      const agentId = chatResult.chat?.agent ?? defaultAgentId ?? "";
      setCodingAgentId(agentId);
      const found = codingAgents.find((a) => a.id === agentId);
      if (found) {
        setAgentType(found.type);
        setAgentLabel(found.label);
      }
    });

    // --- Session state ---
    //
    // Two-phase resolution so chat rendering doesn't wait on the slow
    // sessions.list call:
    //
    //   Phase A (fast): chats.get resolves. If a persisted activeSessionId
    //     exists, surface it and flip sessionQueryDone immediately so
    //     ChatView can start loading messages. This is the common case
    //     for any workspace the user has visited before.
    //
    //   Phase B (slow): sessions.list resolves. Used to populate the
    //     session sidebar/dropdown, the active-session summary for the
    //     tab title, and to fall back to the most recently modified
    //     session when no activeSessionId was persisted.
    //
    // For panes with no persisted active session we still wait for both
    // (otherwise ChatView would resumeStream() against `undefined` and we
    // would never auto-load the latest session).
    chatP.then((chatResult) => {
      if (cancelled) return;
      // Fresh panes skip session restoration — start clean.
      if (isFresh) {
        setSessionQueryDone(true);
        return;
      }
      const persisted = chatResult.chat?.activeSessionId;
      if (typeof persisted === "string" && persisted) {
        setInitialSessionId(persisted);
        setSessionQueryDone(true);
      }
    });

    sessionsP.then((sessionsResult) => {
      if (cancelled) return;
      if (sessionsResult.supported) {
        setSupportsSessionListing(true);
      }
      const sessions = sessionsResult.sessions as Array<{
        sessionId: string;
        summary: string;
        lastModified: number;
      }>;
      sessionsRef.current = sessions;
    });

    // Once both have resolved, fill in the active-session summary for the
    // tab title and (if no persisted session existed) pick a fallback +
    // flip sessionQueryDone so ChatView unblocks.
    Promise.all([chatP, sessionsP]).then(([chatResult, sessionsResult]) => {
      if (cancelled || isFresh) return;
      const sessions = sessionsResult.sessions as Array<{
        sessionId: string;
        summary: string;
        lastModified: number;
      }>;
      const persisted = chatResult.chat?.activeSessionId;
      if (typeof persisted === "string" && persisted) {
        const match = sessions.find((s) => s.sessionId === persisted);
        if (match?.summary) setActiveSessionSummary(match.summary);
      } else if (sessionsResult.supported && sessions.length > 0) {
        const latest = [...sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
        if (latest) {
          setInitialSessionId(latest.sessionId);
          if (latest.summary) setActiveSessionSummary(latest.summary);
        }
      }
      setSessionQueryDone(true);
    });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatId]);

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
        })
        .catch((err) => {
          console.error("[ChatPane] error switching agent:", err);
        });
    },
    [workspaceId, chatId, codingAgentId, agents],
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
