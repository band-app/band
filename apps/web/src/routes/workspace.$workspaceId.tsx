import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@band-app/ui";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ChevronsUpDown, Menu } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DashboardShell,
  DiffView,
  QuickOpenDialog,
  SearchFilesDialog,
  useDashboardStore,
  useDiffTarget,
  useSettingsQuery,
  WorkspacePickerDialog,
  type WorkspaceTab,
  WorkspaceTabNav,
} from "@/dashboard";
import { agentTypeSupportsSessionListing } from "../components/ChatPane";
import { ChatView } from "../components/ChatView";
import { CodeBrowserView } from "../components/CodeBrowserView";
import { DesktopDragRegion } from "../components/DesktopTitleBar";
import { ToolbarOverflowMenuItems, ToolbarOverflowProvider } from "../components/ToolbarButtons";
import { AgentSwitcherContext, useAgentSwitcherContext } from "../hooks/useAgentSwitcherContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { SessionListContext, useSessionListContext } from "../hooks/useSessionListContext";
import { isDesktop } from "../lib/is-desktop";
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
  // Bookmarks / shared links from before route unification (`/workspace/$id/changes`,
  // `/workspace/$id/code/foo.ts`, `/workspace/$id/terminal`) used to resolve to
  // child routes that no longer exist. Redirect them to the canonical workspace
  // URL instead of showing the root 404. See issue #467.
  //
  // CAVEAT: this catches ANY unmatched sub-path under `/workspace/$id`, not
  // just the five retired routes. If a future child route is added here, a
  // typo'd link (e.g. `/workspace/$id/settigns` for a real `/settings` route)
  // will silently land on the workspace root rather than surfacing a 404.
  // If that becomes a problem, narrow this to an allowlist of known retired
  // path prefixes.
  notFoundComponent: WorkspaceNotFoundRedirect,
});

function WorkspaceNotFoundRedirect() {
  const { workspaceId } = Route.useParams();
  return <Navigate to="/workspace/$workspaceId" params={{ workspaceId }} replace />;
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

  // Sync zustand active workspace from URL. We set on param change but never
  // clear on unmount: on mobile the project-list "menu" lives on a *separate*
  // route (`/`) from the workspace (`/workspace/$id`), so unmounting this route
  // to show the menu would wipe `activeWorkspaceId` and leave the menu unable
  // to bold the workspace the user just came from. Keeping the last-opened id
  // lets the menu mark it active on every viewport. The title bar reads the
  // active id from the pathname (`parseWorkspaceFromPath` in __root), not this
  // store, so it still clears correctly when no workspace route is mounted.
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    setActiveWorkspace(decoded);
  }, [decoded, setActiveWorkspace]);

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
      {useDesktopLayout ? null : <MobileWorkspaceLayout key={decoded} workspaceId={decoded} />}
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

function MobileWorkspaceLayout({ workspaceId }: { workspaceId: string }) {
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

  // Workspace switcher (recent / previous workspaces). Tapping the header
  // title opens it so the user can jump to another worktree without first
  // navigating back to the full project list — and can dismiss it (backdrop /
  // Esc) to stay on the current workspace if they change their mind.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Project-list fly-out. The hamburger opens the full project list as a
  // left-edge drawer *over* the current workspace. This is pure local state:
  // opening or closing it never changes the route, so the workspace stays
  // mounted underneath. Selecting a workspace inside the drawer navigates
  // (remounting this keyed layout), which resets this back to closed.
  const [projectListOpen, setProjectListOpen] = useState(false);

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

  // Listen for file link clicks from chat messages → open Quick Open with query.
  //
  // Filter by `detail.workspaceId` so a click whose owning chat lives in
  // a different workspace doesn't open against this one. A missing detail
  // (legacy dispatcher / non-chat caller) falls through to this workspace
  // so unrelated dispatchers keep working. See `dispatchOpenFile` in
  // `file-link-components.tsx` and issue #539.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename?: string; workspaceId?: string }>).detail;
      if (!detail?.filename) return;
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return;
      setQuickOpenQuery(detail.filename);
      setQuickOpenOpen(true);
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [workspaceId]);

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
            {/* Hamburger — opens the project list as a left fly-out drawer over
                this workspace. Purely local state; the route never changes. */}
            <button
              type="button"
              onClick={() => setProjectListOpen(true)}
              aria-label="Open project list"
              aria-haspopup="dialog"
              data-testid="mobile-workspace__project-list-trigger"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            >
              <Menu className="size-4" />
            </button>
            {/* Tapping the title opens the workspace switcher — the fast path
                to jump to a recent/previous worktree without going back to the
                full project list. The chevron signals it's interactive. */}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
              aria-label="Switch workspace"
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent active:bg-accent"
            >
              <h1 className="truncate text-sm font-semibold">{workspaceId}</h1>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
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
          <WorkspacePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
          <Sheet open={projectListOpen} onOpenChange={setProjectListOpen}>
            {/* The project list fly-out reuses the exact same DashboardShell
                the `/` home route renders, so labels, add-project, settings
                and the full workspace tree are all available from here. */}
            <SheetContent side="left" showCloseButton={false} data-testid="project-list-flyout">
              <SheetTitle className="sr-only">Projects</SheetTitle>
              <SheetDescription className="sr-only">
                Browse projects and open a workspace
              </SheetDescription>
              <ToolbarOverflowProvider>
                <DashboardShell toolbarMenuItems={<ToolbarOverflowMenuItems />} hideTitleBar />
              </ToolbarOverflowProvider>
            </SheetContent>
          </Sheet>
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
      // Reset before bumping the pane key so the remounted `ChatView`
      // doesn't see a stale `sessionQueryDone={true}` on its first render
      // — the `chats.get` effect re-runs and flips it back to true once
      // the new session is resolved. Without this, the remount would
      // bypass the "wait for session" gate. (Pre-existing bug preserved
      // verbatim when this code moved out of `workspace.$workspaceId.index.tsx`.)
      setSessionQueryDone(false);
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
