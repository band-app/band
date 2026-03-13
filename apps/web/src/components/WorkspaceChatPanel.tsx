import { Clock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { ChatView } from "./ChatView";

interface WorkspaceChatPanelProps {
  workspaceId: string;
}

export function WorkspaceChatPanel({ workspaceId }: WorkspaceChatPanelProps) {
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const [showSessionList, setShowSessionList] = useState(false);

  useEffect(() => {
    let cancelled = false;

    trpc.sessions.list
      .query({ workspaceId })
      .then((data) => {
        if (cancelled) return;
        if (data.supported) {
          setSupportsSessionListing(true);
          const latest = [...data.sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
          if (latest) {
            setInitialSessionId(latest.sessionId);
          }
        }
      })
      .catch((err) => {
        console.error("[sessions] error:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/20 px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{workspaceId}</h1>
        </div>
        {supportsSessionListing && (
          <button
            type="button"
            onClick={handleToggleSessionList}
            className={`inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent ${showSessionList ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            <Clock className="size-4" />
          </button>
        )}
      </header>
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
    </div>
  );
}
