import {
  DashboardProvider,
  DiffView,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@band/dashboard-core";
import { WebCapabilities, WebDashboardAdapter } from "@band/dashboard-core/adapters/web";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Clock } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatView } from "../components/ChatView";
import { CodeBrowserView } from "../components/CodeBrowserView";
import { trpc } from "../lib/trpc-client";

const adapter = new WebDashboardAdapter();
const capabilities = new WebCapabilities();

export const Route = createFileRoute("/chat/$workspaceId")({
  component: ChatPage,
});

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function useAppHeight() {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const update = () => setHeight(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return height;
}

function ChatPage() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const [showSessionList, setShowSessionList] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat");
  const [diffFileCount, setDiffFileCount] = useState(0);
  const isTasksWindow = useRef<boolean | null>(null);
  const navigate = useNavigate();
  const appHeight = useAppHeight();

  useEffect(() => {
    if (!isTauri()) {
      isTasksWindow.current = false;
      return;
    }
    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      isTasksWindow.current = getCurrentWebviewWindow().label === "tasks";
    });
  }, []);

  const handleBack = useCallback(() => {
    navigate({ to: isTasksWindow.current ? "/tasks" : "/" });
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;

    trpc.sessions.list
      .query({ workspaceId: decoded })
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
  }, [decoded]);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiff
        .query({ workspaceId: decoded })
        .then((result) => {
          if (!cancelled) setDiffFileCount(result.stats?.filesChanged ?? 0);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [decoded]);

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: appHeight ? `${appHeight}px` : "100dvh" }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
        </button>
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
      <WorkspaceTabNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        diffFileCount={diffFileCount}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <div className={activeTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <ChatView
            workspaceId={decoded}
            workspaceName={decoded}
            supportsSessionListing={supportsSessionListing}
            initialSessionId={initialSessionId}
            showSessionList={showSessionList}
            onShowSessionListChange={setShowSessionList}
          />
        </div>
        <DashboardProvider adapter={adapter} capabilities={capabilities}>
          <div className={activeTab === "diff" ? "min-h-0 flex-1" : "hidden"}>
            <DiffView workspaceId={decoded} active={activeTab === "diff"} />
          </div>
          <div className={activeTab === "code" ? "min-h-0 flex-1" : "hidden"}>
            <CodeBrowserView workspaceId={decoded} />
          </div>
        </DashboardProvider>
      </main>
    </div>
  );
}
