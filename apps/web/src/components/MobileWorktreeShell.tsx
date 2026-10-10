import { ClientPluginHostProvider } from "@band-app/plugin-api/client";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@band-app/ui";
import { useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown, FolderOpen, GitCompare, Menu, MoreVertical } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  DashboardShell,
  FileBrowser,
  parseFileLocation,
  QuickOpenDialog,
  SearchFilesDialog,
  toWorktreeId,
  useRepos,
  useWorktreePath,
  WorktreeLabel,
  WorktreePickerDialog,
} from "@/dashboard";
import { countChangedPaths, useWorktreeChanges } from "../hooks/useWorktreeChanges";
import { isDesktop } from "../lib/is-desktop";
import { parseWorktreeFromPath } from "../lib/parse-worktree";
import { clientPluginHost } from "../plugins/client-plugin-host";
import { PluginErrorBoundary } from "../plugins/PluginErrorBoundary";
import { useWorktreeSideTabs } from "../plugins/use-plugin-slot";
import { ChangesSections } from "./ChangesSections";
import { DesktopDragRegion } from "./DesktopTitleBar";
import { MultiWorktreePanelHost } from "./MultiWorktreePanelHost";
import { StartedFromBar } from "./StartedFromBar";
import { ToolbarActionBar, ToolbarOverflowProvider } from "./ToolbarButtons";
import { getWorktreeLeafActions, WorktreeCenterDockview } from "./WorktreeCenterDockview";

// ---------------------------------------------------------------------------
// The mobile worktree layout (narrow viewport, not the desktop app). Mounted
// once by AppShell, like the desktop `SharedDockviewLayout`, so it outlives
// route changes:
//   - the center dockview of every visited worktree stays mounted in a
//     `MultiWorktreePanelHost`, so switching back to a worktree doesn't
//     replay its chats, restore its layout or refetch anything;
//   - the header, the Explorer / Changes / plugin sheets and the dialogs exist
//     once, for the worktree on screen, and reset on each switch (keyed by
//     worktree, like the desktop `RightSidepanel`).
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
      // iOS scrolls the document to reveal a focused input even with
      // `overflow: hidden` on html and body, and lets a drag scroll it by up
      // to the keyboard's height. A scrolled document adds to the visual
      // viewport's own pan, which opens a gap between the composer and the
      // keyboard and slides the header under iOS 26's top-edge blur. Undo it,
      // so `offsetTop` is the only shift. Panes scroll their own elements.
      // Skipped while a Radix dialog or sheet locks the page
      // (`data-scroll-locked`): those are sized to the window, and iOS
      // scrolls the document to keep their focused input above the keyboard.
      const scrolled = window.scrollX !== 0 || window.scrollY !== 0;
      if (scrolled && !document.body.hasAttribute("data-scroll-locked")) window.scrollTo(0, 0);
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
    window.addEventListener("scroll", update);
    // A scroll iOS made while a sheet held the lock is undone once it lets go.
    const scrollLock = new MutationObserver(update);
    scrollLock.observe(document.body, { attributeFilter: ["data-scroll-locked"] });
    return () => {
      scrollLock.disconnect();
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, []);
  return { height, offsetTop, keyboardOpen };
}

/** Live Changes sections for the mobile Changes sheet and the count on the
 *  menu's Changes row. Tracks the same compare branch the user picked,
 *  mirroring the desktop RightSidepanel query so the count matches the lists. */
function useChangesSummary(worktreeId: string) {
  const changesQuery = useWorktreeChanges(worktreeId, { refetchInterval: 15_000 });
  return { changes: changesQuery.data, changeCount: countChangedPaths(changesQuery.data) };
}

/** The worktree and repo names of a worktree, for the header label. Falls
 *  back to the worktree id until the repos query has answered. */
function useWorktreeNames(worktreeId: string): { name: string; repoName: string } {
  const { repos } = useRepos();
  return useMemo(() => {
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        if (toWorktreeId(repo.name, worktree.name, worktree.hostId) === worktreeId) {
          return { name: worktree.name, repoName: repo.name };
        }
      }
    }
    return { name: worktreeId, repoName: "" };
  }, [repos, worktreeId]);
}

// Which mobile view is showing. "editor" is the dockview; the others open a
// bottom sheet over it: "menu" lists the panels below, "explorer" / "changes"
// hold a tree and return to "editor" on select or dismiss, and
// `plugin:<pluginId>.<tabId>` holds a plugin's `worktree.sideTabs` tab (named
// as in `RightSidepanel`).
type MobileView = "editor" | "menu" | "explorer" | "changes" | `plugin:${string}`;

function isMobileView(value: unknown): value is MobileView {
  return (
    value === "explorer" ||
    value === "changes" ||
    (typeof value === "string" && value.startsWith("plugin:"))
  );
}

/** A sheet asked for through `band:right-sidepanel-set-tab` (the PR badge's
 *  `showChecksTab`), waiting for its worktree to be on screen. */
interface SheetRequest {
  worktreeId: string;
  view: MobileView;
}

// Hoisted so the root div gets a reference-equal style while no worktree is
// shown. It stays mounted and laid out (so hidden dockviews keep their size)
// under the route's own page, but never paints or takes a tap.
const NO_WORKTREE_STYLE: React.CSSProperties = {
  height: "100dvh",
  visibility: "hidden",
  pointerEvents: "none",
};

export function MobileWorktreeShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeWorktreeId = parseWorktreeFromPath(pathname);
  const { height: appHeight, offsetTop: appOffsetTop, keyboardOpen } = useAppHeight();

  // Render nothing on the server: the SSR pass can't know the viewport, and
  // the mounted set is client state.
  const [hydrated, setHydrated] = useState(false);
  useLayoutEffect(() => {
    setHydrated(true);
  }, []);

  // The PR badge asks for the Checks sheet and then navigates to the badge's
  // worktree, whose header may not be mounted yet. Hold the request here,
  // where it survives the switch, until that worktree's header takes it.
  const activeWorktreeIdRef = useRef(activeWorktreeId);
  activeWorktreeIdRef.current = activeWorktreeId;
  const [sheetRequest, setSheetRequest] = useState<SheetRequest | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: unknown; worktreeId?: string }>).detail;
      const worktreeId = detail?.worktreeId ?? activeWorktreeIdRef.current;
      if (!worktreeId || !isMobileView(detail?.tab)) return;
      setSheetRequest({ worktreeId, view: detail.tab });
    };
    window.addEventListener("band:right-sidepanel-set-tab", handler);
    return () => window.removeEventListener("band:right-sidepanel-set-tab", handler);
  }, []);
  // A request for a worktree the user didn't go to is dropped, so it can't
  // pop a sheet open on a later visit.
  useEffect(() => {
    setSheetRequest((r) => (r && r.worktreeId !== activeWorktreeId ? null : r));
  }, [activeWorktreeId]);
  const clearSheetRequest = useCallback(() => setSheetRequest(null), []);

  if (!hydrated) return null;

  return (
    // Fixed, so a document scroll iOS makes to reveal the focused input can't
    // move it; `offsetTop` then follows the visual viewport as it pans.
    <div
      data-testid="mobile-worktree"
      className="fixed inset-x-0 top-0 flex flex-col overflow-hidden"
      style={
        activeWorktreeId
          ? {
              height: appHeight ? `${appHeight}px` : "100dvh",
              transform: appOffsetTop ? `translateY(${appOffsetTop}px)` : undefined,
            }
          : NO_WORKTREE_STYLE
      }
      inert={!activeWorktreeId}
    >
      {isDesktop && <DesktopDragRegion />}
      {activeWorktreeId && (
        <MobileWorktreeChrome
          key={activeWorktreeId}
          worktreeId={activeWorktreeId}
          requestedView={sheetRequest?.worktreeId === activeWorktreeId ? sheetRequest.view : null}
          onRequestedViewShown={clearSheetRequest}
        />
      )}
      {/* The unified center dockview is the ONLY editor surface on mobile —
       *  chat / terminal / browser leaves plus per-path file / diff leaves,
       *  all as tabs (mobile mode disables drag→split and the maximize
       *  toggle). One per visited worktree, the shown one visible and the
       *  rest hidden and inert. The sheets float over it and open leaves into
       *  it. It reaches the bottom screen edge, so it pads the home-indicator
       *  inset, except while the keyboard covers that edge: then the chat
       *  composer sits right on the keyboard. */}
      <main
        data-testid="mobile-worktree__main"
        className={`flex min-h-0 flex-1 flex-col ${
          keyboardOpen ? "" : "pb-[env(safe-area-inset-bottom)]"
        }`}
      >
        <MultiWorktreePanelHost emptyState={null}>
          {(worktreeId, wsActive) => (
            <div className="flex h-full w-full flex-col">
              <StartedFromBar worktreeId={worktreeId} />
              <div className="relative min-h-0 flex-1">
                <WorktreeCenterDockview
                  worktreeId={worktreeId}
                  visible={wsActive}
                  wsActive={wsActive}
                  mobile
                />
              </div>
            </div>
          )}
        </MultiWorktreePanelHost>
      </main>
    </div>
  );
}

/** The changed-file count on the menu's Changes row. */
function CountBadge({ count, testid }: { count: number; testid: string }) {
  return (
    <span
      data-testid={testid}
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[9px] font-medium text-blue-600 dark:text-blue-400"
    >
      {count}
    </span>
  );
}

/** One of the worktree panels the header menu lists: Explorer, Changes and
 *  each plugin tab. */
interface PanelItem {
  view: MobileView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  testid: string;
}

/** A row of the header menu's bottom drawer. The label is its accessible
 *  name, with the count joined so a screen reader hears it too. */
function MobileMenuItem({ item, onSelect }: { item: PanelItem; onSelect: () => void }) {
  const { label, icon: Icon, badge, testid } = item;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={badge ? `${label}, ${badge}` : label}
      data-testid={testid}
      className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors hover:bg-accent active:bg-accent"
    >
      <Icon className="size-[18px] shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && <CountBadge count={badge} testid={`${testid}-badge`} />}
    </button>
  );
}

/** A bottom sheet over the editor, 75% of the screen tall unless
 *  `className` sets another height. */
function MobileSheet({
  open,
  onOpenChange,
  title,
  description,
  testid,
  className = "h-[75dvh]",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  testid: string;
  /** The sheet's height. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className={`${className} p-0`} data-testid={`${testid}-sheet`}>
        <SheetTitle className="border-b border-border/50 px-4 py-3 text-sm">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        <div
          data-testid={`${testid}-body`}
          className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]"
        >
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The header, sheets and dialogs of the worktree on screen. Keyed by
 *  worktree, so none of their state carries over to the next one. */
function MobileWorktreeChrome({
  worktreeId,
  requestedView,
  onRequestedViewShown,
}: {
  worktreeId: string;
  requestedView: MobileView | null;
  onRequestedViewShown: () => void;
}) {
  const worktreePath = useWorktreePath(worktreeId);
  const { changes, changeCount } = useChangesSummary(worktreeId);
  const { name, repoName } = useWorktreeNames(worktreeId);
  const pluginTabs = useWorktreeSideTabs();

  // The dockview is always the main editor surface. The header menu opens
  // Explorer / Changes / plugin tabs as a bottom sheet; closing it returns to
  // the editor.
  const [view, setView] = useState<MobileView>("editor");
  const sheetOpenChange = (sheet: MobileView) => (open: boolean) =>
    setView(open ? sheet : "editor");

  const panelItems: PanelItem[] = [
    {
      view: "explorer",
      label: "Explorer",
      icon: FolderOpen,
      testid: "mobile-worktree__menu-explorer",
    },
    {
      view: "changes",
      label: "Changes",
      icon: GitCompare,
      badge: changeCount,
      testid: "mobile-worktree__menu-changes",
    },
    ...pluginTabs.map(
      ({ key, slug, tab }): PanelItem => ({
        view: `plugin:${key}`,
        label: tab.label,
        icon: tab.icon,
        testid: `mobile-worktree__menu-${slug}`,
      }),
    ),
  ];

  // Open a file leaf in the center dockview, then close the tree sheet.
  // Used by the Explorer sheet + the file-link / Quick Open flows.
  const openFileLeaf = useCallback(
    (filePath: string, opts?: { line?: number; column?: number }) => {
      getWorktreeLeafActions(worktreeId)?.openFile(filePath, opts);
      setView("editor");
    },
    [worktreeId],
  );

  // Open a diff leaf in the center dockview, then close the tree sheet.
  const openDiffLeaf = useCallback(
    (section: ChangeSection, entry: ChangeEntry) => {
      getWorktreeLeafActions(worktreeId)?.openDiff(entry.path, {
        section,
        oldPath: entry.oldPath,
      });
      setView("editor");
    },
    [worktreeId],
  );

  // Worktree switcher (recent / previous worktrees). Tapping the header
  // title opens it so the user can jump to another worktree without first
  // navigating back to the full repo list — and can dismiss it (backdrop /
  // Esc) to stay on the current worktree if they change their mind.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Repo-list fly-out. The hamburger opens the full repo list as a
  // left-edge drawer *over* the current worktree. This is pure local state:
  // opening or closing it never changes the route. Selecting a worktree
  // inside the drawer navigates, which remounts this keyed component and so
  // closes the drawer.
  const [repoListOpen, setRepoListOpen] = useState(false);

  // Show a sheet the PR badge asked for (see `MobileWorktreeShell`). The
  // badge may sit in this worktree's own fly-out, so close that too.
  useEffect(() => {
    if (!requestedView) return;
    setView(requestedView);
    setRepoListOpen(false);
    setPickerOpen(false);
    onRequestedViewShown();
  }, [requestedView, onRequestedViewShown]);

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
  // Filter by `detail.worktreeId` so a click whose owning chat lives in
  // a different worktree (a hidden one stays mounted) doesn't open against
  // this one. A missing detail (legacy dispatcher / non-chat caller) falls
  // through to this worktree so unrelated dispatchers keep working. See
  // `dispatchOpenFile` in `file-link-components.tsx` and issue #539.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename?: string; worktreeId?: string }>).detail;
      if (!detail?.filename) return;
      if (detail.worktreeId && detail.worktreeId !== worktreeId) return;
      setQuickOpenQuery(detail.filename);
      setQuickOpenOpen(true);
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [worktreeId]);

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
    <>
      {/* sync-with: the `h-12` Repos header of DashboardShell's `matchMobileHeader`,
          so the repo-list fly-out lines up with this header. */}
      <header
        data-testid="mobile-worktree__header"
        className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-border/50 px-2 pt-[env(safe-area-inset-top)]"
      >
        {/* Hamburger — opens the repo list as a left fly-out drawer over
            this worktree. Purely local state; the route never changes. */}
        <button
          type="button"
          onClick={() => setRepoListOpen(true)}
          aria-label="Open repo list"
          aria-haspopup="dialog"
          data-testid="mobile-worktree__repo-list-trigger"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-accent"
        >
          <Menu className="size-4" />
        </button>
        {/* Tapping the title opens the worktree switcher — the fast path
            to jump to a recent/previous worktree without going back to the
            full repo list. The chevron signals it's interactive. The
            label is the Pinned section's two-row block, worktree over
            repo, centered in the header. */}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          aria-label="Switch worktree"
          data-testid="mobile-worktree__switcher"
          className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-center hover:bg-accent active:bg-accent"
        >
          {/* As wide as the chevron, so the label sits in the header's
              center. The hamburger and the menu button are the same width,
              which centers this button. */}
          <span aria-hidden className="size-3.5 shrink-0" />
          <WorktreeLabel name={name} repoName={repoName} isActive />
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {/* The vertical 3-dot menu lists the worktree panels (Explorer,
            Changes, plugin tabs) in a bottom drawer. Picking one opens its
            sheet over the editor; picking a file or closing the sheet
            returns to it. */}
        <button
          type="button"
          onClick={() => setView("menu")}
          aria-label="Worktree panels"
          aria-haspopup="dialog"
          data-testid="mobile-worktree__header-menu"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          <MoreVertical className="size-[18px]" />
        </button>
      </header>
      {/* The header menu's drawer. Picking a panel swaps this sheet for the
       *  panel's own in one render (both follow `view`). */}
      <MobileSheet
        open={view === "menu"}
        onOpenChange={sheetOpenChange("menu")}
        title="Worktree"
        description="Open a worktree panel"
        testid="mobile-worktree__menu"
        className="h-auto"
      >
        <ul>
          {panelItems.map((item) => (
            <li key={item.view}>
              <MobileMenuItem item={item} onSelect={() => setView(item.view)} />
            </li>
          ))}
        </ul>
      </MobileSheet>
      {/* Explorer sheet — the file tree. Selecting a file opens it as a leaf in
       *  the dockview and closes the sheet (openFileLeaf resets view to
       *  "editor"). Single vs pinned map to preview vs pinned leaves. */}
      <MobileSheet
        open={view === "explorer"}
        onOpenChange={sheetOpenChange("explorer")}
        title="Explorer"
        description="Browse worktree files and open one in the editor"
        testid="mobile-worktree__explorer"
      >
        <FileBrowser
          worktreeId={worktreeId}
          worktreePath={worktreePath}
          onOpenFile={(p) => openFileLeaf(p)}
          onOpenFilePinned={(p) => openFileLeaf(p)}
          compact
        />
      </MobileSheet>
      {/* Changes sheet — the diff tree. Selecting a file opens its diff leaf in
       *  the dockview and closes the sheet. */}
      <MobileSheet
        open={view === "changes"}
        onOpenChange={sheetOpenChange("changes")}
        title="Changes"
        description="Browse changed files and open one as a diff"
        testid="mobile-worktree__changes"
      >
        <ChangesSections
          worktreeId={worktreeId}
          changes={changes}
          onOpen={openDiffLeaf}
          worktreePath={worktreePath}
        />
      </MobileSheet>
      {/* One sheet per plugin tab (the desktop right sidepanel's
       *  `worktree.sideTabs` slot), each inside `PluginErrorBoundary`. */}
      {pluginTabs.map(({ key, slug, pluginId, tab }) => {
        const open = view === `plugin:${key}`;
        return (
          <MobileSheet
            key={key}
            open={open}
            onOpenChange={sheetOpenChange(`plugin:${key}`)}
            title={tab.label}
            description={`The ${tab.label} tab of this worktree`}
            testid={`mobile-worktree__plugin--${slug}`}
          >
            <div className="flex h-full flex-col overflow-hidden">
              <PluginErrorBoundary pluginId={pluginId}>
                <ClientPluginHostProvider value={clientPluginHost}>
                  <tab.component worktreeId={worktreeId} visible={open} />
                </ClientPluginHostProvider>
              </PluginErrorBoundary>
            </div>
          </MobileSheet>
        );
      })}
      <QuickOpenDialog
        worktreeId={worktreeId}
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
        worktreeId={worktreeId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
      <WorktreePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
      <Sheet open={repoListOpen} onOpenChange={setRepoListOpen}>
        {/* The repo list fly-out reuses the exact same DashboardShell
            the `/` home route renders, so labels, add-repo, settings
            and the full worktree tree are all available from here. */}
        <SheetContent
          side="left"
          showCloseButton={false}
          data-testid="repo-list-flyout"
          // Focus the drawer itself on open, not its first button. That
          // button ("Add repo") has a tooltip that opens on focus, and an
          // open tooltip takes the first Escape, so Escape didn't close the
          // drawer whenever it was pressed after the auto-focus landed.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <SheetTitle className="sr-only">Repos</SheetTitle>
          <SheetDescription className="sr-only">Browse repos and open a worktree</SheetDescription>
          <ToolbarOverflowProvider>
            <DashboardShell
              bottomActions={<ToolbarActionBar />}
              hideTitleBar
              padBottomInset
              matchMobileHeader
            />
          </ToolbarOverflowProvider>
        </SheetContent>
      </Sheet>
    </>
  );
}
