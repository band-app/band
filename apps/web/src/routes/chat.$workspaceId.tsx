import {
  DashboardProvider,
  DiffView,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@band/dashboard-core";
import { WebCapabilities, WebDashboardAdapter } from "@band/dashboard-core/adapters/web";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Clock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
import { CodeBrowserView } from "../components/CodeBrowserView";

const adapter = new WebDashboardAdapter();
const capabilities = new WebCapabilities();

export const Route = createFileRoute("/chat/$workspaceId")({
  component: ChatPage,
});

function ChatPage() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(decoded)}`)
      .then((res) => {
        if (!res.ok) {
          console.error("[sessions] fetch failed:", res.status, res.statusText);
          return null;
        }
        return res.json();
      })
      .then((data: { supported?: boolean } | null) => {
        console.log("[sessions] response:", data);
        if (!cancelled && data?.supported) {
          setSupportsSessionListing(true);
        }
      })
      .catch((err) => {
        console.error("[sessions] error:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [decoded]);

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          to="/"
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{decoded}</h1>
        </div>
        {supportsSessionListing && activeTab === "chat" && (
          <button
            type="button"
            onClick={handleToggleSessionList}
            className={`inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent ${showSessionList ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            <Clock className="size-4" />
          </button>
        )}
      </header>
      <WorkspaceTabNav activeTab={activeTab} onTabChange={setActiveTab} />
      <main className="min-h-0 flex-1">
        {activeTab === "chat" && (
          <ChatView
            workspaceId={decoded}
            workspaceName={decoded}
            supportsSessionListing={supportsSessionListing}
            showSessionList={showSessionList}
            onShowSessionListChange={setShowSessionList}
          />
        )}
        {(activeTab === "diff" || activeTab === "code") && (
          <DashboardProvider adapter={adapter} capabilities={capabilities}>
            {activeTab === "diff" && <DiffView workspaceId={decoded} />}
            {activeTab === "code" && <CodeBrowserView workspaceId={decoded} />}
          </DashboardProvider>
        )}
      </main>
    </div>
  );
}
