import { useSettingsQuery } from "@band-app/dashboard-core";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

  if (!chatId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatView
        key={chatKey}
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
        agentType={agentType}
        codingAgentId={codingAgentId}
        onSwitchAgent={switchAgent}
      />
    </div>
  );
}
