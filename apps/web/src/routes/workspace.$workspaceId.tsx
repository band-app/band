import {
  type DiffStats,
  QuickOpenDialog,
  useDashboardStore,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@band-app/dashboard-core";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { TauriDragRegion } from "../components/TauriTitleBar";
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
  const isWideScreen = useIsDesktop();
  const isDesktop = isWideScreen || isTauri;
  const [hydrated, setHydrated] = useState(false);
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Mark as hydrated after first client render to prevent SSR layout flash
  useLayoutEffect(() => {
    setHydrated(true);
  }, []);

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
  // and the specific file the user was viewing.  An empty string means
  // the Chat tab (the workspace index route).
  useEffect(() => {
    const prefix = `/workspace/${workspaceId}`;
    if (pathname.startsWith(prefix)) {
      const subPath = pathname.slice(prefix.length); // e.g. "/code/src/index.ts", "" for chat
      try {
        sessionStorage.setItem(`band-tab:${decoded}`, subPath);
      } catch {}
    }
  }, [pathname, workspaceId, decoded]);

  return (
    <DiffStatsContext.Provider value={{ diffStats, setDiffStats }}>
      <div className={`h-full ${hydrated ? "" : "invisible"}`}>
        {isDesktop ? (
          <DesktopWorkspaceLayout workspaceId={decoded} encodedId={workspaceId} />
        ) : (
          <MobileWorkspaceLayout workspaceId={decoded} encodedId={workspaceId} />
        )}
      </div>
    </DiffStatsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Desktop dockview layout
// ---------------------------------------------------------------------------

function DesktopWorkspaceLayout({
  workspaceId: _workspaceId,
  encodedId: _encodedId,
}: {
  workspaceId: string;
  encodedId: string;
}) {
  // Dockview is now managed by DockviewInstanceManager in __root.tsx.
  // Each workspace gets its own persistent DockviewReact instance that is
  // shown/hidden via CSS rather than destroyed/recreated on workspace switch.
  return null;
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
  const [showSessionList, setShowSessionList] = useState(false);

  // Agent switcher state
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string>("");
  const [, setTaskRunning] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const newSessionRef = useRef<(() => void) | null>(null);

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

  // Quick Open state for file link clicks from chat
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);

  const handleOpenFile = useCallback(
    (filename: string) => {
      navigate({
        to: "/workspace/$workspaceId/code/$",
        params: { workspaceId: encodedId, _splat: filename },
      });
    },
    [navigate, encodedId],
  );

  // Listen for file link clicks from chat messages → open Quick Open with query
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail?.filename) {
        setQuickOpenQuery(detail.filename);
        setQuickOpenOpen(true);
      }
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, []);

  const handleSwitchAgent = useCallback(
    async (agentId: string) => {
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
    navigate({ to: "/" });
  }, [navigate]);

  const handleSetShowSessionList = useCallback((show: boolean) => {
    setShowSessionList(show);
  }, []);

  const currentAgent = agents.find((a) => a.id === currentAgentId);

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
        value={{
          chatKey,
          setTaskRunning,
          agentType: currentAgent?.type,
          codingAgentId: currentAgentId,
          switchAgent: handleSwitchAgent,
          newSessionRef,
        }}
      >
        <div
          className="flex flex-col overflow-hidden"
          style={{
            height: appHeight ? `${appHeight}px` : "100dvh",
            transform: appOffsetTop ? `translateY(${appOffsetTop}px)` : undefined,
          }}
        >
          {isTauri && <TauriDragRegion />}
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
          </header>
          <WorkspaceTabNav
            activeTab={activeTab}
            tabHrefs={tabHrefs}
            diffFileCount={diffFileCount}
          />
          <main className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </main>
          <QuickOpenDialog
            workspaceId={workspaceId}
            open={quickOpenOpen}
            onOpenChange={(open) => {
              setQuickOpenOpen(open);
              if (!open) setQuickOpenQuery(undefined);
            }}
            onOpenFile={handleOpenFile}
            initialQuery={quickOpenQuery}
            autoOpen={quickOpenQuery != null}
          />
        </div>
      </AgentSwitcherContext.Provider>
    </SessionListContext.Provider>
  );
}
