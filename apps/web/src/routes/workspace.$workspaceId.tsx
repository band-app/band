import {
  type DiffStats,
  QuickOpenDialog,
  SearchFilesDialog,
  useDashboardStore,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@band/dashboard-core";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Clock, Code, GitCompare, Terminal } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { WorkspaceChatPanel } from "../components/WorkspaceChatPanel";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { SessionListContext } from "../hooks/useSessionListContext";
import { trpc } from "../lib/trpc-client";
import { inTauri } from "./__root";

export const Route = createFileRoute("/workspace/$workspaceId")({
  component: WorkspaceLayout,
});

// Context for child routes to report diff stats back to the layout tab nav
interface DiffStatsContextValue {
  diffStats: DiffStats | null;
  setDiffStats: (stats: DiffStats | null) => void;
}

const DiffStatsContext = createContext<DiffStatsContextValue>({
  diffStats: null,
  setDiffStats: () => {},
});

export function useDiffStatsContext() {
  return useContext(DiffStatsContext);
}

// Context for child routes to register a find-in-file callback with the layout
interface FindInFileContextValue {
  setFindInFile: (fn: (() => void) | null) => void;
}

const FindInFileContext = createContext<FindInFileContextValue>({
  setFindInFile: () => {},
});

export function useFindInFileContext() {
  return useContext(FindInFileContext);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function useActiveTab(workspaceId: string): WorkspaceTab {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const prefix = `/workspace/${workspaceId}`;
  if (pathname.startsWith(`${prefix}/changes`)) return "diff";
  if (pathname.startsWith(`${prefix}/code`)) return "code";
  return "chat";
}

function useDiffFileCount(workspaceId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiff
        .query({ workspaceId })
        .then((result) => {
          if (!cancelled) setCount(result.stats?.filesChanged ?? 0);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId]);
  return count;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const isDesktop = useIsDesktop() && !inTauri;
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);

  // Sync zustand active workspace from URL
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    setActiveWorkspace(decoded);
    return () => setActiveWorkspace(null);
  }, [decoded, setActiveWorkspace]);

  return (
    <DiffStatsContext.Provider value={{ diffStats, setDiffStats }}>
      {isDesktop ? (
        <DesktopWorkspaceLayout workspaceId={decoded} encodedId={workspaceId} />
      ) : (
        <MobileWorkspaceLayout workspaceId={decoded} encodedId={workspaceId} />
      )}
    </DiffStatsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Desktop 3-panel layout
// ---------------------------------------------------------------------------

function DesktopDetailTabNav({
  workspaceId,
  diffStats,
}: {
  workspaceId: string;
  diffStats: DiffStats | null;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const prefix = `/workspace/${workspaceId}`;
  const isChanges = pathname.startsWith(`${prefix}/changes`);
  const isCode = pathname.startsWith(`${prefix}/code`);
  const isTerminal = pathname.startsWith(`${prefix}/terminal`);

  const tabClass = (active: boolean) =>
    `flex h-full flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${
      active
        ? "border-b border-foreground text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-white/20">
      <Link
        to="/workspace/$workspaceId/changes"
        params={{ workspaceId }}
        className={tabClass(isChanges)}
      >
        <GitCompare className="size-4" />
        Changes
        {diffStats && diffStats.filesChanged > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 text-blue-400 px-1.5 text-xs font-medium">
            {diffStats.filesChanged}
          </span>
        )}
      </Link>
      <Link to="/workspace/$workspaceId/code" params={{ workspaceId }} className={tabClass(isCode)}>
        <Code className="size-4" />
        Code
      </Link>
      <Link
        to="/workspace/$workspaceId/terminal"
        params={{ workspaceId }}
        className={tabClass(isTerminal)}
      >
        <Terminal className="size-4" />
        Terminal
      </Link>
    </div>
  );
}

function DesktopWorkspaceLayout({
  workspaceId,
  encodedId,
}: {
  workspaceId: string;
  encodedId: string;
}) {
  const { diffStats } = useDiffStatsContext();
  const navigate = useNavigate();

  // Dialog state
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);

  // Find-in-file: child code routes register a callback here
  const findInFileRef = useRef<(() => void) | null>(null);
  const setFindInFile = useCallback((fn: (() => void) | null) => {
    findInFileRef.current = fn;
  }, []);

  // Global keyboard shortcuts (capture phase to beat browser defaults)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey) {
        if (findInFileRef.current) {
          e.preventDefault();
          findInFileRef.current();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Open file from Quick Open / Search dialogs → navigate to code route
  const handleOpenFile = useCallback(
    (path: string) => {
      navigate({
        to: "/workspace/$workspaceId/code/$",
        params: { workspaceId: encodedId, _splat: path },
      });
    },
    [navigate, encodedId],
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* Middle Panel — Changes / Code / Terminal */}
      <div className="flex-1 min-w-0 border-r border-white/20 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          <DesktopDetailTabNav workspaceId={encodedId} diffStats={diffStats} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <FindInFileContext.Provider value={{ setFindInFile }}>
              <Outlet />
            </FindInFileContext.Provider>
          </div>
        </div>
      </div>

      {/* Right Panel — Chat */}
      <div className="max-w-[768px] flex-1 min-w-0 overflow-hidden">
        <WorkspaceChatPanel key={workspaceId} workspaceId={workspaceId} />
      </div>

      {/* Dialogs */}
      <QuickOpenDialog
        workspaceId={workspaceId}
        open={quickOpenOpen}
        onOpenChange={setQuickOpenOpen}
        onOpenFile={handleOpenFile}
      />
      <SearchFilesDialog
        workspaceId={workspaceId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile layout
// ---------------------------------------------------------------------------

function MobileWorkspaceLayout({
  workspaceId,
  encodedId,
}: {
  workspaceId: string;
  encodedId: string;
}) {
  const activeTab = useActiveTab(encodedId);
  const diffFileCount = useDiffFileCount(workspaceId);
  const navigate = useNavigate();
  const appHeight = useAppHeight();
  const isTasksWindow = useRef<boolean | null>(null);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);

  useEffect(() => {
    if (!inTauri) {
      isTasksWindow.current = false;
      return;
    }
    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      isTasksWindow.current = getCurrentWebviewWindow().label === "tasks";
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    trpc.sessions.list
      .query({ workspaceId })
      .then((data) => {
        if (cancelled) return;
        if (data.supported) setSupportsSessionListing(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleBack = useCallback(() => {
    navigate({ to: isTasksWindow.current ? "/tasks" : "/" });
  }, [navigate]);

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  const handleSetShowSessionList = useCallback((show: boolean) => {
    setShowSessionList(show);
  }, []);

  const tabHrefs = {
    chat: `/workspace/${encodedId}`,
    diff: `/workspace/${encodedId}/changes`,
    code: `/workspace/${encodedId}/code`,
  };

  return (
    <SessionListContext.Provider
      value={{ showSessionList, setShowSessionList: handleSetShowSessionList }}
    >
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
            <h1 className="truncate text-sm font-semibold">{workspaceId}</h1>
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
        <WorkspaceTabNav activeTab={activeTab} tabHrefs={tabHrefs} diffFileCount={diffFileCount} />
        <main className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </SessionListContext.Provider>
  );
}
