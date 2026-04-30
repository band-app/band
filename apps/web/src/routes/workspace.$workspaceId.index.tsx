import { useSettingsQuery } from "@band-app/dashboard-core";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
import { useAgentSwitcherContext } from "../hooks/useAgentSwitcherContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useSessionListContext } from "../hooks/useSessionListContext";
import { isTauri } from "../lib/is-tauri";
import { trpc } from "../lib/trpc-client";

export const Route = createFileRoute("/workspace/$workspaceId/")({
  component: WorkspaceIndex,
});

function WorkspaceIndex() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const { settings } = useSettingsQuery();
  const appMode = settings.appMode ?? "side-panel";
  const isWideScreen = useIsDesktop();
  const isDesktop = (isWideScreen && !isTauri) || (isTauri && appMode === "full-editor");

  // Desktop: chat is always visible in the left panel — redirect to changes tab
  if (isDesktop) {
    return <Navigate to="/workspace/$workspaceId/changes" params={{ workspaceId }} replace />;
  }

  // Mobile: show chat view
  return <MobileChatContent workspaceId={decoded} />;
}

function MobileChatContent({ workspaceId }: { workspaceId: string }) {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey intentionally triggers reload after agent switch
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    trpc.sessions.list
      .query({ workspaceId, chatId })
      .then((data) => {
        if (cancelled) return;
        if (data.supported) {
          setSupportsSessionListing(true);
          const latest = [...data.sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
          if (latest) setInitialSessionId(latest.sessionId);
        }
        setSessionQueryDone(true);
      })
      .catch((err) => {
        if (!cancelled) setSessionQueryDone(true);
        console.error("[sessions] error:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatId, chatKey]);

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
