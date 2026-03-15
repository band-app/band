import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
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

  // Desktop: chat is always visible in the right panel — redirect to changes tab
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
  }, [workspaceId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatView
        workspaceId={workspaceId}
        workspaceName={workspaceId}
        supportsSessionListing={supportsSessionListing}
        initialSessionId={initialSessionId}
        showSessionList={showSessionList}
        onShowSessionListChange={setShowSessionList}
      />
    </div>
  );
}
