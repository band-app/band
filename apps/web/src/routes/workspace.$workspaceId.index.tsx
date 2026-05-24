import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useSettingsQuery } from "@/dashboard";
import { agentTypeSupportsSessionListing } from "../components/ChatPane";
import { ChatView } from "../components/ChatView";
import { useAgentSwitcherContext } from "../hooks/useAgentSwitcherContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useSessionListContext } from "../hooks/useSessionListContext";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";

export const Route = createFileRoute("/workspace/$workspaceId/")({
  component: WorkspaceIndex,
});

function WorkspaceIndex() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;

  // Desktop: chat is always visible in the left panel — redirect to changes tab
  if (useDesktopLayout) {
    return <Navigate to="/workspace/$workspaceId/changes" params={{ workspaceId }} replace />;
  }

  // Mobile: show chat view
  return <MobileChatContent workspaceId={decoded} />;
}

function MobileChatContent({ workspaceId }: { workspaceId: string }) {
  const { settings } = useSettingsQuery();
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const [sessionQueryDone, setSessionQueryDone] = useState(false);
  // Local remount key for user-initiated session switches. Combined with the
  // context-owned `chatKey` (which bumps on agent switch) so either kind of
  // switch forces ChatView to remount and reopen its event-log subscription
  // against the new session.
  const [sessionPaneKey, setSessionPaneKey] = useState(0);
  const { showSessionList, setShowSessionList } = useSessionListContext();
  const { chatKey, setTaskRunning, agentType, codingAgentId, switchAgent, newSessionRef } =
    useAgentSwitcherContext();

  // Resolve default chat for mobile view
  useEffect(() => {
    let cancelled = false;
    trpc.chats.list
      .query({ workspaceId })
      .then((data) => {
        if (cancelled) return;
        if (data.chats.length > 0) {
          setChatId(data.chats[0].id);
        } else {
          return trpc.chats.create.mutate({ workspaceId }).then((result) => {
            if (!cancelled) setChatId(result.chat.id);
          });
        }
      })
      .catch((err) => console.error("[MobileChatContent] error resolving chat:", err));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Resolve initial session + session-listing support from the persisted
  // chat row. This mirrors `useChatPaneState` (ChatPane.tsx): the server
  // persists `activeSessionId` (and the cached summary) on the chat row
  // so the hot path is a pure SQLite read with no filesystem walk over
  // `~/.claude/projects/<workspace>/`. Falls back to the latest session
  // (mtime-sorted) inside `chats.get` when no activeSessionId is
  // persisted yet. `sessions.list` is only invoked lazily when the user
  // opens the history dropdown (see `SessionHistoryMenu` in ChatView).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey intentionally triggers reload after agent switch
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    trpc.chats.get
      .query({ chatId })
      .then((data) => {
        if (cancelled) return;
        const chat = data?.chat;
        // Fall back to the default coding agent when the chat row hasn't
        // been created yet (lazy creation on first message send) so the
        // session-history dropdown is available on a brand-new empty chat.
        const agentId = chat?.agent ?? settings.defaultCodingAgent;
        const found = agentId ? settings.codingAgents?.find((a) => a.id === agentId) : undefined;
        setSupportsSessionListing(agentTypeSupportsSessionListing(found?.type));
        if (chat?.activeSessionId) setInitialSessionId(chat.activeSessionId);
        setSessionQueryDone(true);
      })
      .catch((err) => {
        if (!cancelled) setSessionQueryDone(true);
        console.error("[chats.get] error:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatId, chatKey, settings]);

  // User-initiated session switch from the SessionHistoryMenu. Mirrors the
  // desktop pane's `onSwitchSession` (see `useChatPaneState` in ChatPane.tsx):
  // persist the new active session to the server, pin local
  // `initialSessionId`, then bump `sessionPaneKey` so ChatView remounts and
  // its useChatSubscription opens a fresh stream against the new session.
  //
  // Before this existed, ChatView's `onSwitchSession` prop was undefined on
  // mobile, so tapping a session in the history menu cleared the queue and
  // closed the Radix dropdown (its default on-select behavior) but never
  // actually switched sessions — the chat kept rendering the previous one.
  const onSwitchSession = useCallback(
    async (sessionId: string | undefined) => {
      if (!chatId) return;
      try {
        await trpc.chats.setActiveSession.mutate({
          workspaceId,
          chatId,
          sessionId: sessionId ?? undefined,
        });
      } catch (err) {
        console.error("[MobileChatContent] error persisting active session:", err);
        return;
      }
      setInitialSessionId(sessionId);
      setSessionPaneKey((k) => k + 1);
    },
    [workspaceId, chatId],
  );

  if (!chatId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatView
        key={`${chatKey}-${sessionPaneKey}`}
        chatKey={chatKey}
        workspaceId={workspaceId}
        chatId={chatId}
        workspaceName={workspaceId}
        supportsSessionListing={supportsSessionListing}
        initialSessionId={initialSessionId}
        sessionQueryDone={sessionQueryDone}
        showSessionList={showSessionList}
        onShowSessionListChange={setShowSessionList}
        onStreamingChange={setTaskRunning}
        onNewSessionRef={newSessionRef}
        onSwitchSession={onSwitchSession}
        agentType={agentType}
        codingAgentId={codingAgentId}
        onSwitchAgent={switchAgent}
      />
    </div>
  );
}
