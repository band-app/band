import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@band-app/ui";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ChevronsUpDown, FolderOpen, GitCompare, Menu } from "lucide-react";
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
  useWorkspacePath,
  WorkspacePickerDialog,
} from "@/dashboard";
import { DesktopDragRegion } from "../components/DesktopTitleBar";
import { ToolbarActionBar, ToolbarOverflowProvider } from "../components/ToolbarButtons";
import {
  getWorkspaceLeafActions,
  WorkspaceCenterDockview,
} from "../components/WorkspaceCenterDockview";
import { useDiffSummary } from "../hooks/useDiffSummary";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";

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

/** How much shorter than the layout viewport the visual viewport must be
 *  before we treat the gap as a software keyboard (px). Larger than any
 *  browser toolbar, smaller than any keyboard. */
const KEYBOARD_MIN_HEIGHT_PX = 120;

/** The visible area of the page. iOS Safari ignores
 *  `interactive-widget=resizes-content`: the keyboard shrinks only the visual
 *  viewport and may pan it, so the mobile layout sizes and positions itself
 *  from this rather than from `100dvh`. `keyboardOpen` tells the layout to
 *  drop the home-indicator inset, which the keyboard covers. */
function useAppHeight() {
  const [height, setHeight] = useState<number | null>(null);
  const [offsetTop, setOffsetTop] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      setHeight(vv ? vv.height : window.innerHeight);
      setOffsetTop(vv ? vv.offsetTop : 0);
      setKeyboardOpen(vv ? window.innerHeight - vv.height > KEYBOARD_MIN_HEIGHT_PX : false);
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
  return { height, offsetTop, keyboardOpen };
}

/** Live changes summary for the mobile Changes sheet + header badge. Tracks the
 *  same diff target (mode + compare branch) the user picked, mirroring the
 *  desktop RightSidepanel query so the badge count matches the tree. */
function useChangesSummary(workspaceId: string) {
  const summaryQuery = useDiffSummary(workspaceId, { refetchInterval: 15_000 });
  // The server types `fileStatuses` values as plain `string`; the tree wants
  // the `FileStatus` union. Same runtime values — cast at this single seam.
  const fileStatuses = (summaryQuery.data?.fileStatuses ?? EMPTY_STATUSES) as Record<
    string,
    FileStatus
  >;
  return { fileStatuses, changeCount: Object.keys(fileStatuses).length };
}

// Which mobile view is showing. "editor" is the dockview; "explorer" /
// "changes" open a bottom sheet holding the tree and, on select or dismiss,
// return to "editor" (the opened file/diff leaf is now the active tab).
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

/** An icon button at the right of the mobile header (Explorer / Changes),
 *  with an optional count badge. The label is its accessible name. */
function MobileHeaderButton({
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
      aria-label={label}
      aria-pressed={active}
      aria-haspopup="dialog"
      data-testid={testid}
      className={`relative inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent active:bg-accent ${
        active ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <Icon className="size-[18px]" />
      {badge != null && badge > 0 && (
        <span
          data-testid={`${testid}-badge`}
          className="absolute top-0 right-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[9px] font-medium text-blue-600 dark:text-blue-400"
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function MobileWorkspaceLayout({ workspaceId }: { workspaceId: string }) {
  const { height: appHeight, offsetTop: appOffsetTop, keyboardOpen } = useAppHeight();
  const workspacePath = useWorkspacePath(workspaceId);
  const { fileStatuses, changeCount } = useChangesSummary(workspaceId);

  // The dockview (WorkspaceCenterDockview, mobile mode) is always the main
  // editor surface. The header's Explorer / Changes buttons open a bottom
  // sheet with the tree; closing the sheet returns to the editor.
  const [view, setView] = useState<MobileView>("editor");

  // Open a file leaf in the center dockview, then close the tree sheet.
  // Used by the Explorer sheet + the file-link / Quick Open flows.
  const openFileLeaf = useCallback(
    (filePath: string, opts?: { line?: number; column?: number }) => {
      getWorkspaceLeafActions(workspaceId)?.openFile(filePath, opts);
      setView("editor");
    },
    [workspaceId],
  );

  // Open a diff leaf in the center dockview, then close the tree sheet.
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
    // Fixed, so a document scroll iOS makes to reveal the focused input can't
    // move it; `offsetTop` then follows the visual viewport as it pans.
    <div
      className="fixed inset-x-0 top-0 flex flex-col overflow-hidden"
      style={{
        height: appHeight ? `${appHeight}px` : "100dvh",
        transform: appOffsetTop ? `translateY(${appOffsetTop}px)` : undefined,
      }}
    >
      {isDesktop && <DesktopDragRegion />}
      <header
        data-testid="mobile-workspace__header"
        className="flex h-[calc(2.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border/50 px-3 pt-[env(safe-area-inset-top)]"
      >
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
        {/* Explorer / Changes open their tree as a bottom sheet over the
            editor; picking a file or closing the sheet returns to it. */}
        <div className="flex shrink-0 items-center">
          <MobileHeaderButton
            label="Explorer"
            icon={FolderOpen}
            active={view === "explorer"}
            onClick={() => setView("explorer")}
            testid="mobile-workspace__header-explorer"
          />
          <MobileHeaderButton
            label="Changes"
            icon={GitCompare}
            active={view === "changes"}
            badge={changeCount}
            onClick={() => setView("changes")}
            testid="mobile-workspace__header-changes"
          />
        </div>
      </header>
      {/* The unified center dockview is the ONLY editor surface on mobile —
       *  chat / terminal / browser leaves plus per-path file / diff leaves,
       *  all as tabs (mobile mode disables drag→split and the maximize
       *  toggle). It stays mounted while the Explorer / Changes sheets float
       *  over it and open leaves into it. It reaches the bottom screen edge,
       *  so it pads the home-indicator inset, except while the keyboard
       *  covers that edge: then the chat composer sits right on the keyboard. */}
      <main
        data-testid="mobile-workspace__main"
        className={`flex min-h-0 flex-1 flex-col ${
          keyboardOpen ? "" : "pb-[env(safe-area-inset-bottom)]"
        }`}
      >
        <WorkspaceCenterDockview workspaceId={workspaceId} visible wsActive mobile />
      </main>
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
          <div
            data-testid="mobile-workspace__explorer-body"
            className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]"
          >
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
          <div
            data-testid="mobile-workspace__changes-body"
            className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]"
          >
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
        <SheetContent
          side="left"
          showCloseButton={false}
          data-testid="project-list-flyout"
          // Focus the drawer itself on open, not its first button. That
          // button ("Add project") has a tooltip that opens on focus, and an
          // open tooltip takes the first Escape, so Escape didn't close the
          // drawer whenever it was pressed after the auto-focus landed.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <SheetTitle className="sr-only">Projects</SheetTitle>
          <SheetDescription className="sr-only">
            Browse projects and open a workspace
          </SheetDescription>
          <ToolbarOverflowProvider>
            <DashboardShell bottomActions={<ToolbarActionBar />} hideTitleBar padBottomInset />
          </ToolbarOverflowProvider>
        </SheetContent>
      </Sheet>
    </div>
  );
}
