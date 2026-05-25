import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DiffView,
  QuickOpenDialog,
  SearchFilesDialog,
  useDashboardStore,
  useDiffTarget,
  useSettingsQuery,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@/dashboard";
import { agentTypeSupportsSessionListing } from "../components/ChatPane";
import { ChatView } from "../components/ChatView";
import { CodeBrowserView } from "../components/CodeBrowserView";
import { DesktopDragRegion } from "../components/DesktopTitleBar";
import { AgentSwitcherContext, useAgentSwitcherContext } from "../hooks/useAgentSwitcherContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { SessionListContext, useSessionListContext } from "../hooks/useSessionListContext";
import { isDesktop } from "../lib/is-desktop";
import {
  consumeMobilePendingAction,
  subscribeMobilePendingActions,
} from "../lib/mobile-pending-action";
import { trpc } from "../lib/trpc-client";

// Lazy-load to avoid importing @xterm/xterm (CJS) in SSR context. The
// Terminal tab is mounted on demand the first time the user activates it.
const DockviewTerminalContainer = lazy(() =>
  import("../components/DockviewTerminalContainer").then((m) => ({
    default: m.DockviewTerminalContainer,
  })),
);

export const Route = createFileRoute("/workspace/$workspaceId")({
  component: WorkspaceLayout,
});

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

function useDiffFileCount(workspaceId: string): number {
  // Track the same diff target (mode + compare branch) the user picked in the
  // Changes tab — without this, the badge always queried the default branch
  // and ignored Uncommitted / non-default branch selections (issue #396).
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      trpc.workspace.getDiffSummary
        .query({
          workspaceId,
          diffMode,
          compareBranch: compareBranch ?? undefined,
        })
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
  }, [workspaceId, diffMode, compareBranch]);
  return count;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  const [hydrated, setHydrated] = useState(false);

  // Mark as hydrated after first client render to prevent SSR layout flash
  useLayoutEffect(() => {
    setHydrated(true);
  }, []);

  // Sync zustand active workspace from URL.
  // Two effects: one updates on param change, the other clears only on unmount.
  // Combining them caused a brief null-then-set toggle on every workspace
  // switch, which made sidebar cards flash inactive for one frame.
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    setActiveWorkspace(decoded);
  }, [decoded, setActiveWorkspace]);
  useEffect(() => {
    return () => setActiveWorkspace(null);
  }, [setActiveWorkspace]);

  // Clear needs_attention status when viewing this workspace
  const clearNeedsAttention = useDashboardStore((s) => s.clearNeedsAttention);
  useEffect(() => {
    clearNeedsAttention(decoded);
  }, [decoded, clearNeedsAttention]);

  // Desktop: the shared dockview (mounted at AppShell) renders every panel —
  // Chat/Changes/Files/Terminal/Browser — at once, so this route has nothing
  // of its own to render. Keeping the URL canonical at `/workspace/$id` (no
  // sub-paths) means workspace switches don't churn the AppShell's
  // `<Outlet />`.
  //
  // Mobile: the per-workspace `MobileWorkspaceLayout` is keyed on the decoded
  // workspace id so each workspace gets a clean tab state. This matches the
  // pre-route-unification behaviour where the `/changes` / `/code` /
  // `/terminal` child routes remounted per workspace via URL navigation. See
  // issue #467.
  return (
    <div className={`h-full ${hydrated ? "" : "invisible"}`}>
      {useDesktopLayout ? null : (
        <MobileWorkspaceLayout key={decoded} workspaceId={decoded} encodedId={workspaceId} />
      )}
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
  encodedId: _encodedId,
}: {
  workspaceId: string;
  encodedId: string;
}) {
  const navigate = useNavigate();
  const { height: appHeight, offsetTop: appOffsetTop } = useAppHeight();
  const diffFileCount = useDiffFileCount(workspaceId);

  // Active tab + selected file are now PURELY local state — no URL involvement.
  // Always start on Chat (we deliberately do not persist the last tab across
  // workspace visits; the previous sessionStorage `band-tab:` mechanism was
  // removed when child routes were folded in — see issue #467).
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat");
  const [currentFile, setCurrentFile] = useState<string | undefined>(undefined);

  const [showSessionList, setShowSessionList] = useState(false);

  // Agent switcher state
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string>("");
  const [, setTaskRunning] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const newSessionRef = useRef<(() => void) | null>(null);

  // Drain any pending mobile action (queued by the `band open` SSE handler
  // before this layout mounted). Run once on mount, then subscribe so calls
  // that arrive while we ARE mounted reach us through the listener.
  useEffect(() => {
    const drain = () => {
      const action = consumeMobilePendingAction(workspaceId);
      if (!action) return;
      setActiveTab(action.tab);
      if (action.filePath !== undefined) {
        setCurrentFile(action.filePath);
      }
    };
    drain();
    return subscribeMobilePendingActions(drain);
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

  // Quick Open state for file link clicks from chat
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  // Search-in-Files state for the file-tree toolbar (mobile / non-dockview).
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);

  // Open a file in the Files tab. Switches tab + sets the selected file in
  // a single transition.
  const handleOpenFile = useCallback((filename: string) => {
    setCurrentFile(filename);
    setActiveTab("code");
  }, []);

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

  // Window-event triggers for the file-tree toolbar's Quick Open / Search
  // in Files buttons. We use a window event (rather than threading the
  // setters through a React Context) because the toolbar is rendered by
  // CodeBrowserView several levels down, and routing the setter via
  // context proved unreliable on the iOS Simulator's tree. The toolbar
  // dispatches the event; this layout owns the dialog state.
  useEffect(() => {
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
    };
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

  const handleSelectFile = useCallback((filePath: string | null) => {
    setCurrentFile(filePath ?? undefined);
  }, []);

  const currentAgent = agents.find((a) => a.id === currentAgentId);

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
          {isDesktop && <DesktopDragRegion />}
          <header className="flex h-[calc(2.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border/50 px-3 pt-[env(safe-area-inset-top)]">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-center text-sm font-semibold">{workspaceId}</h1>
            </div>
            <div aria-hidden="true" className="size-7 shrink-0" />
          </header>
          <WorkspaceTabNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            diffFileCount={diffFileCount}
          />
          <main className="flex min-h-0 flex-1 flex-col">
            {/* Tab content. Conditional render — switching tabs unmounts the
             *  previous tab, matching the pre-refactor mobile behaviour where
             *  each tab was its own route. */}
            {activeTab === "chat" && <MobileChatContent workspaceId={workspaceId} />}
            {activeTab === "diff" && (
              <DiffView workspaceId={workspaceId} active onOpenFile={handleOpenFile} />
            )}
            {activeTab === "code" && (
              <CodeBrowserView
                workspaceId={workspaceId}
                file={currentFile}
                onSelectFile={handleSelectFile}
              />
            )}
            {activeTab === "terminal" && (
              <Suspense fallback={null}>
                <DockviewTerminalContainer workspaceId={workspaceId} visible={true} />
              </Suspense>
            )}
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
          <SearchFilesDialog
            workspaceId={workspaceId}
            open={searchFilesOpen}
            onOpenChange={setSearchFilesOpen}
            onOpenFile={handleOpenFile}
          />
        </div>
      </AgentSwitcherContext.Provider>
    </SessionListContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Mobile chat content
// ---------------------------------------------------------------------------

function MobileChatContent({ workspaceId }: { workspaceId: string }) {
  const { settings } = useSettingsQuery();
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const [sessionQueryDone, setSessionQueryDone] = useState(false);
  // Local remount key for user-initiated session switches. Combined with the
  // context-owned `chatKey` (which bumps on agent switch) so either kind of
  // switch forces ChatView to remount and reopen its event-log subscription
  // against the new session.
  const [sessionPaneKey, setSessionPaneKey] = useState(0);
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

  // User-initiated session switch from the SessionHistoryMenu. Mirrors the
  // desktop pane's `onSwitchSession` (see `useChatPaneState` in ChatPane.tsx):
  // persist the new active session to the server, pin local
  // `initialSessionId`, then bump `sessionPaneKey` so ChatView remounts and
  // its useChatSubscription opens a fresh stream against the new session.
  const onSwitchSession = useCallback(
    async (sessionId: string | undefined) => {
      if (!chatId) return;
      try {
        await trpc.chats.setActiveSession.mutate({
          workspaceId,
          chatId,
          sessionId: sessionId ?? undefined,
        });
      } catch (err) {
        console.error("[MobileChatContent] error persisting active session:", err);
        return;
      }
      setInitialSessionId(sessionId);
      setSessionPaneKey((k) => k + 1);
    },
    [workspaceId, chatId],
  );

  if (!chatId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatView
        key={`${chatKey}-${sessionPaneKey}`}
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
        onSwitchSession={onSwitchSession}
        agentType={agentType}
        codingAgentId={codingAgentId}
        onSwitchAgent={switchAgent}
      />
    </div>
  );
}
