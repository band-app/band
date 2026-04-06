import {
  AgentIcon,
  type DiffStats,
  QuickOpenDialog,
  SearchFilesDialog,
  useDashboardStore,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@band-app/dashboard-core";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  Clock,
  FolderOpen,
  GitCompare,
  Plus,
  Terminal,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PanelResizer } from "../components/PanelResizer";
import { WorkspaceChatPanel } from "../components/WorkspaceChatPanel";
import { AgentSwitcherContext } from "../hooks/useAgentSwitcherContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { SessionListContext } from "../hooks/useSessionListContext";
import { isTauri } from "../lib/is-tauri";
import { trpc } from "../lib/trpc-client";

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
  const [offsetTop, setOffsetTop] = useState(0);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      setHeight(vv ? vv.height : window.innerHeight);
      setOffsetTop(vv ? vv.offsetTop : 0);
    };
    update();
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("resize", update);
    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
    };
  }, []);
  return { height, offsetTop };
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
      trpc.workspace.getDiffSummary
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
  const isDesktop = useIsDesktop() && !isTauri;
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Sync zustand active workspace from URL
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    setActiveWorkspace(decoded);
    return () => setActiveWorkspace(null);
  }, [decoded, setActiveWorkspace]);

  // Clear needs_attention status when viewing this workspace
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  useEffect(() => {
    clearNeedsAttention(decoded);
  }, [decoded, clearNeedsAttention]);

  // Persist the full sub-path (e.g. "/code/src/index.ts") so it can be
  // restored when navigating back — this remembers both the active tab
  // and the specific file the user was viewing.
  useEffect(() => {
    const prefix = `/workspace/${workspaceId}`;
    if (pathname.length > prefix.length && pathname.startsWith(prefix)) {
      const subPath = pathname.slice(prefix.length); // e.g. "/code/src/index.ts"
      try {
        sessionStorage.setItem(`band-tab:${decoded}`, subPath);
      } catch {}
    }
  }, [pathname, workspaceId, decoded]);

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
// Resizable split panel
// ---------------------------------------------------------------------------

const PANEL_WIDTH_KEY = "band:chat-panel-width";
const DEFAULT_PANEL_PCT = 50;
const MIN_PANEL_PCT = 20;
const MAX_PANEL_PCT = 80;

function getStoredPanelWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (v >= MIN_PANEL_PCT && v <= MAX_PANEL_PCT) return v;
  } catch {}
  return DEFAULT_PANEL_PCT;
}

// ---------------------------------------------------------------------------
// Desktop 3-panel layout
// ---------------------------------------------------------------------------

function DesktopDetailTabNav({ workspaceId }: { workspaceId: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const prefix = `/workspace/${workspaceId}`;
  const isChanges = pathname.startsWith(`${prefix}/changes`);
  const isCode = pathname.startsWith(`${prefix}/code`);
  const isTerminal = pathname.startsWith(`${prefix}/terminal`);
  const diffFileCount = useDiffFileCount(decodeURIComponent(workspaceId));

  const tabClass = (active: boolean) =>
    `flex h-full flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${
      active
        ? "border-b border-foreground text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-border">
      <Link
        to="/workspace/$workspaceId/changes"
        params={{ workspaceId }}
        className={tabClass(isChanges)}
      >
        <GitCompare className="size-4" />
        Changes
        {diffFileCount > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 text-blue-600 dark:text-blue-400 px-1.5 text-xs font-medium">
            {diffFileCount}
          </span>
        )}
      </Link>
      <Link to="/workspace/$workspaceId/code" params={{ workspaceId }} className={tabClass(isCode)}>
        <FolderOpen className="size-4" />
        Files
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
        e.preventDefault();
        if (findInFileRef.current) {
          findInFileRef.current();
        } else {
          window.dispatchEvent(new CustomEvent("band:find-in-file"));
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Resizable panel width
  const [panelPct, setPanelPct] = useState(getStoredPanelWidth);
  const handleResize = useCallback((pct: number) => {
    setPanelPct(pct);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(pct)));
    } catch {}
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
      {/* Left Panel — Chat */}
      <div className="min-w-0 overflow-hidden" style={{ width: `${panelPct}%` }}>
        <WorkspaceChatPanel key={workspaceId} workspaceId={workspaceId} />
      </div>

      <PanelResizer onResize={handleResize} />

      {/* Right Panel — Changes / Code / Terminal */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          <DesktopDetailTabNav workspaceId={encodedId} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <FindInFileContext.Provider value={{ setFindInFile }}>
              <Outlet />
            </FindInFileContext.Provider>
          </div>
        </div>
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

interface CodingAgentDef {
  id: string;
  type: string;
  label: string;
}

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
  const { height: appHeight, offsetTop: appOffsetTop } = useAppHeight();
  const isTasksWindow = useRef<boolean | null>(null);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);

  // Agent switcher state
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string>("");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [taskRunning, setTaskRunning] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const newSessionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isTauri) {
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

  // Load available agents from settings and current workspace agent
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey intentionally triggers reload after agent switch; currentAgentId excluded to avoid infinite loop
  useEffect(() => {
    let cancelled = false;

    trpc.settings.get.query().then((settings) => {
      if (cancelled) return;
      const raw = (settings as Record<string, unknown>).codingAgents;
      const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
      if (codingAgents.length > 0) {
        const seen = new Set<string>();
        const unique = codingAgents.filter((a) => {
          if (seen.has(a.type)) return false;
          seen.add(a.type);
          return true;
        });
        setAgents(unique);
      }
      const defaultAgent = (settings as Record<string, unknown>).defaultCodingAgent as
        | string
        | undefined;
      if (defaultAgent && !currentAgentId) {
        setCurrentAgentId(defaultAgent);
      }
    });

    trpc.statuses.get
      .query({ workspaceId })
      .then((status) => {
        if (cancelled) return;
        if (status?.agent?.codingAgentId) {
          setCurrentAgentId(status.agent.codingAgentId);
        }
      })
      .catch(() => {
        // Status might not exist yet
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSwitchAgent = useCallback(
    async (agentId: string) => {
      setShowAgentMenu(false);
      if (agentId === currentAgentId) return;
      try {
        await trpc.workspace.switchAgent.mutate({ workspaceId, agentId });
        setCurrentAgentId(agentId);
        setChatKey((k) => k + 1);
      } catch (err) {
        console.error("[switchAgent] error:", err);
      }
    },
    [workspaceId, currentAgentId],
  );

  const handleBack = useCallback(() => {
    navigate({ to: isTasksWindow.current ? "/tasks" : "/" });
  }, [navigate]);

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  const handleSetShowSessionList = useCallback((show: boolean) => {
    setShowSessionList(show);
  }, []);

  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const switchDisabled = taskRunning;

  const tabHrefs = {
    chat: `/workspace/${encodedId}`,
    diff: `/workspace/${encodedId}/changes`,
    code: `/workspace/${encodedId}/code`,
  };

  return (
    <SessionListContext.Provider
      value={{ showSessionList, setShowSessionList: handleSetShowSessionList }}
    >
      <AgentSwitcherContext.Provider
        value={{ chatKey, setTaskRunning, agentType: currentAgent?.type, newSessionRef }}
      >
        <div
          className="flex flex-col overflow-hidden"
          style={{
            height: appHeight ? `${appHeight}px` : "100dvh",
            transform: appOffsetTop ? `translateY(${appOffsetTop}px)` : undefined,
          }}
        >
          {isTauri && <div data-tauri-drag-region className="h-[28px] shrink-0" />}
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
            {agents.length > 1 && activeTab === "chat" && (
              <div className="relative">
                <button
                  type="button"
                  disabled={switchDisabled}
                  onClick={() => setShowAgentMenu((prev) => !prev)}
                  className={`inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors ${
                    switchDisabled
                      ? "opacity-50 cursor-not-allowed text-muted-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {currentAgent && (
                    <AgentIcon type={currentAgent.type} className="size-3.5 shrink-0" />
                  )}
                  <span className="max-w-[120px] truncate">{currentAgent?.label ?? "Default"}</span>
                  <ChevronDown className="size-3 opacity-50" />
                </button>
                {showAgentMenu && !switchDisabled && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowAgentMenu(false)}
                      onKeyDown={() => {}}
                      role="presentation"
                    />
                    <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-md">
                      {agents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent ${
                            agent.id === currentAgentId
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground"
                          }`}
                          onClick={() => handleSwitchAgent(agent.id)}
                        >
                          <AgentIcon type={agent.type} className="size-3.5 shrink-0" />
                          {agent.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {supportsSessionListing && activeTab === "chat" && (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleToggleSessionList}
                  className={`inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent ${showSessionList ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                >
                  <Clock className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => newSessionRef.current?.()}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="New session"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            )}
          </header>
          <WorkspaceTabNav
            activeTab={activeTab}
            tabHrefs={tabHrefs}
            diffFileCount={diffFileCount}
          />
          <main className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </main>
        </div>
      </AgentSwitcherContext.Provider>
    </SessionListContext.Provider>
  );
}
