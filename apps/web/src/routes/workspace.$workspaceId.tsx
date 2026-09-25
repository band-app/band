import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ChevronsUpDown, FolderOpen, GitCompare, Menu, SquareTerminal } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ChangesFileTree,
  DashboardShell,
  FileBrowser,
  type FileStatus,
  parseFileLocation,
  QuickOpenDialog,
  SearchFilesDialog,
  useDashboardStore,
  useDiffTarget,
  useWorkspacePath,
  WorkspacePickerDialog,
} from "@/dashboard";
import { DesktopDragRegion } from "../components/DesktopTitleBar";
import { ToolbarActionBar, ToolbarOverflowProvider } from "../components/ToolbarButtons";
import {
  getWorkspaceLeafActions,
  WorkspaceCenterDockview,
} from "../components/WorkspaceCenterDockview";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";

/** Stable empty fileStatuses reference so a "no changes" render doesn't churn. */
const EMPTY_STATUSES: Record<string, FileStatus> = {};

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

/** Live changes summary for the mobile Changes sheet + bar badge. Tracks the
 *  same diff target (mode + compare branch) the user picked, mirroring the
 *  desktop RightSidepanel query so the badge count matches the tree. */
function useChangesSummary(workspaceId: string) {
  const { diffMode, compareBranch } = useDiffTarget(workspaceId);
  const summaryQuery = useQuery({
    queryKey: ["mobileChanges", workspaceId, diffMode, compareBranch],
    queryFn: () =>
      trpc.workspace.getDiffSummary.query({
        workspaceId,
        diffMode,
        compareBranch: compareBranch ?? undefined,
      }),
    refetchInterval: 15_000,
  });
  // The server types `fileStatuses` values as plain `string`; the tree wants
  // the `FileStatus` union. Same runtime values — cast at this single seam.
  const fileStatuses = (summaryQuery.data?.fileStatuses ?? EMPTY_STATUSES) as Record<
    string,
    FileStatus
  >;
  return { fileStatuses, changeCount: Object.keys(fileStatuses).length };
}

// Which mobile view the bottom bar is showing. "editor" is the dockview;
// "explorer" / "changes" open a bottom sheet holding the tree and, on select,
// return the bar to "editor" (the opened file/diff leaf is now the active tab).
type MobileView = "editor" | "explorer" | "changes";

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

/** One entry in the mobile bottom bar (icon + label + optional count badge). */
function MobileBarButton({
  label,
  icon: Icon,
  active,
  onClick,
  badge,
  testid,
}: {
  label: string;
  icon: React.FC<{ className?: string }>;
  active: boolean;
  onClick: () => void;
  badge?: number;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <span className="relative">
        <Icon className="size-5" />
        {badge != null && badge > 0 && (
          <span className="absolute -top-1.5 -right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[9px] font-medium text-blue-600 dark:text-blue-400">
            {badge}
          </span>
        )}
      </span>
      {label}
    </button>
  );
}

function MobileWorkspaceLayout({ workspaceId }: { workspaceId: string }) {
  const { height: appHeight, offsetTop: appOffsetTop } = useAppHeight();
  const workspacePath = useWorkspacePath(workspaceId);
  const { fileStatuses, changeCount } = useChangesSummary(workspaceId);

  // The dockview (WorkspaceCenterDockview, mobile mode) is always the main
  // editor surface. The bottom bar's "Editor" entry just closes any open
  // tree sheet; "Explorer" / "Changes" open a bottom sheet with the tree.
  const [view, setView] = useState<MobileView>("editor");

  // Open a file leaf in the center dockview, then return the bar to Editor.
  // Used by the Explorer sheet + the file-link / Quick Open flows.
  const openFileLeaf = useCallback(
    (filePath: string, opts?: { line?: number; column?: number }) => {
      getWorkspaceLeafActions(workspaceId)?.openFile(filePath, opts);
      setView("editor");
    },
    [workspaceId],
  );

  // Open a diff leaf in the center dockview, then return the bar to Editor.
  const openDiffLeaf = useCallback(
    (filePath: string) => {
      getWorkspaceLeafActions(workspaceId)?.openDiff(filePath);
      setView("editor");
    },
    [workspaceId],
  );

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

  // Open a file (from Quick Open / Search in Files / a chat file link) as a
  // file leaf in the center dockview. `filename` may carry a `:line[:column]`
  // suffix — parse it into a jump target before opening.
  const handleOpenFile = useCallback(
    (filename: string) => {
      const { filePath, line, column } = parseFileLocation(filename);
      openFileLeaf(filePath, { line, column });
    },
    [openFileLeaf],
  );

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

  // Window-event triggers for the Quick Open / Search in Files dialogs. We use
  // a window event (rather than threading the setters through a React Context)
  // because the dispatchers live several levels down (file-tree toolbars, chat
  // file links), and routing the setter via context proved unreliable on the
  // iOS Simulator's tree. The dispatcher fires the event; this layout owns the
  // dialog state.
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

  return (
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
      {/* The unified center dockview is the ONLY editor surface on mobile —
       *  chat / terminal / browser leaves plus per-path file / diff leaves,
       *  all as tabs (mobile mode disables drag→split and the maximize
       *  toggle). It stays mounted regardless of the bottom-bar view; the
       *  Explorer / Changes sheets float over it and open leaves into it. */}
      <main className="flex min-h-0 flex-1 flex-col">
        <WorkspaceCenterDockview workspaceId={workspaceId} visible wsActive mobile />
      </main>
      {/* Bottom bar: Editor | Explorer | Changes. Editor closes any open tree
       *  sheet; the other two open a bottom sheet with the corresponding tree.
       *  Changes carries a badge with the live changed-file count. */}
      <nav
        className="flex h-[calc(3rem+env(safe-area-inset-bottom))] shrink-0 items-stretch border-t border-border/50 pb-[env(safe-area-inset-bottom)]"
        data-testid="mobile-workspace__bottom-bar"
      >
        <MobileBarButton
          label="Editor"
          icon={SquareTerminal}
          active={view === "editor"}
          onClick={() => setView("editor")}
          testid="mobile-workspace__bar--editor"
        />
        <MobileBarButton
          label="Explorer"
          icon={FolderOpen}
          active={view === "explorer"}
          onClick={() => setView("explorer")}
          testid="mobile-workspace__bar--explorer"
        />
        <MobileBarButton
          label="Changes"
          icon={GitCompare}
          active={view === "changes"}
          badge={changeCount}
          onClick={() => setView("changes")}
          testid="mobile-workspace__bar--changes"
        />
      </nav>
      {/* Explorer sheet — the file tree. Selecting a file opens it as a leaf in
       *  the dockview and closes the sheet (openFileLeaf resets view to
       *  "editor"). Single vs pinned map to preview vs pinned leaves. */}
      <Sheet
        open={view === "explorer"}
        onOpenChange={(open) => setView(open ? "explorer" : "editor")}
      >
        <SheetContent
          side="bottom"
          className="h-[75dvh] p-0"
          data-testid="mobile-workspace__explorer-sheet"
        >
          <SheetTitle className="border-b border-border/50 px-4 py-3 text-sm">Explorer</SheetTitle>
          <SheetDescription className="sr-only">
            Browse workspace files and open one in the editor
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-auto">
            <FileBrowser
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              onOpenFile={(p) => openFileLeaf(p)}
              onOpenFilePinned={(p) => openFileLeaf(p)}
              compact
            />
          </div>
        </SheetContent>
      </Sheet>
      {/* Changes sheet — the diff tree. Selecting a file opens its diff leaf in
       *  the dockview and closes the sheet. */}
      <Sheet
        open={view === "changes"}
        onOpenChange={(open) => setView(open ? "changes" : "editor")}
      >
        <SheetContent
          side="bottom"
          className="h-[75dvh] p-0"
          data-testid="mobile-workspace__changes-sheet"
        >
          <SheetTitle className="border-b border-border/50 px-4 py-3 text-sm">Changes</SheetTitle>
          <SheetDescription className="sr-only">
            Browse changed files and open one as a diff
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-auto">
            {changeCount === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No changes</p>
            ) : (
              <ChangesFileTree
                fileStatuses={fileStatuses}
                onSelectFile={openDiffLeaf}
                onSelectFilePinned={openDiffLeaf}
                workspacePath={workspacePath}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
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
            <DashboardShell bottomActions={<ToolbarActionBar />} hideTitleBar />
          </ToolbarOverflowProvider>
        </SheetContent>
      </Sheet>
    </div>
  );
}
