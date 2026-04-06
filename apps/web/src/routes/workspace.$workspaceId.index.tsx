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
  const isDesktop = useIsDesktop() && !isTauri;

  // Desktop: chat is always visible in the left panel — redirect to changes tab
  if (isDesktop) {
    return <Navigate to="/workspace/$workspaceId/changes" params={{ workspaceId }} replace />;
  }

  // Mobile: show chat view
  return <MobileChatContent workspaceId={decoded} />;
}

function MobileChatContent({ workspaceId }: { workspaceId: string }) {
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const { showSessionList, setShowSessionList } = useSessionListContext();
  const { chatKey, setTaskRunning, agentType, newSessionRef } = useAgentSwitcherContext();

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey intentionally triggers reload after agent switch
  useEffect(() => {
    let cancelled = false;
    trpc.sessions.list
      .query({ workspaceId })
      .then((data) => {
        if (cancelled) return;
        if (data.supported) {
          setSupportsSessionListing(true);
          const latest = [...data.sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
          if (latest) setInitialSessionId(latest.sessionId);
        }
      })
      .catch((err) => {
        console.error("[sessions] error:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatView
        key={chatKey}
        chatKey={chatKey}
        workspaceId={workspaceId}
        workspaceName={workspaceId}
        supportsSessionListing={supportsSessionListing}
        initialSessionId={initialSessionId}
        showSessionList={showSessionList}
        onShowSessionListChange={setShowSessionList}
        onStreamingChange={setTaskRunning}
        onNewSessionRef={newSessionRef}
        agentType={agentType}
      />
    </div>
  );
}
