import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { ChevronLeft, ChevronRight, ChevronsUpDown, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { EditorPicker } from "./EditorPicker";

// Native window dragging is wired via CSS `-webkit-app-region: drag` on the
// title-bar root, with `no-drag` reapplied to the interactive children
// (buttons, dropdown triggers) so clicks aren't swallowed by the drag region.
// This is Electron's recommended pattern and replaces the JS
// `mousedown → startDragging` listener used during the Tauri era.
const DRAG_STYLE: React.CSSProperties = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG_STYLE: React.CSSProperties = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export interface PanelItem {
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  shortcut?: string;
}

/** Props for the navigation cluster (sidebar toggle + back/forward). The
 *  cluster is hosted ONCE, in `AppShell`'s stationary overlay pinned over the
 *  title-bar row's left edge (absolutely positioned on the app root, which
 *  spans the window) — never inside either title bar. Earlier revisions
 *  relocated it between the two bars on sidebar toggle, but the handoff
 *  remounted the buttons inside an overflow-clipped, animating panel, so
 *  they visibly flickered mid-tween. A stationary overlay can't flicker:
 *  the panels slide beneath it. The overflow actions always live in
 *  DashboardShell's bottom action bar, so the cluster carries no menu. */
export interface NavControlsProps {
  /** Toggle the project-list sidebar's visibility (⌘B). When undefined, the
   *  sidebar toggle button is not rendered. */
  onToggleSidebar?: () => void;
  /** Whether the sidebar is currently visible — drives the toggle button's
   *  pressed state. */
  sidebarVisible?: boolean;
  /** Navigate to the previous workspace in the history stack (⌘[). */
  onGoBack?: () => void;
  /** Navigate to the next workspace in the history stack (⌘]). */
  onGoForward?: () => void;
  /** Whether back navigation is currently available (enables/disables the button). */
  canGoBack?: boolean;
  /** Whether forward navigation is currently available (enables/disables the button). */
  canGoForward?: boolean;
}

interface WorkspaceTitleBarProps {
  /** Static title. If omitted, fetches the app title from the desktop shell. */
  title?: string;
  /** Active workspace name to display prominently. */
  workspaceName?: string;
  /** The workspace path for open-in / copy-path actions. */
  workspacePath?: string;
  /** Callback to copy the workspace path to clipboard. */
  onCopyPath?: () => void;
  /** When provided alongside a `workspaceName`, the name renders as a button
   *  (with a chevron) that invokes this on click — opens the workspace picker,
   *  mirroring the mobile header's tap-to-switch affordance. When omitted, the
   *  name stays a non-interactive label. */
  onWorkspaceNameClick?: () => void;
  /** Toggle the right sidepanel (Explorer / Changes). When provided alongside a
   *  `workspaceName`, a toggle button renders at the bar's right edge. */
  onToggleRightPanel?: () => void;
  /** Whether the right sidepanel is currently visible (drives the toggle's
   *  pressed state). */
  rightPanelVisible?: boolean;
}

/** Sidebar toggle + back/forward arrows. Rendered once by `AppShell` in a
 *  stationary overlay pinned over the title-bar row's left edge. */
export function NavControls({
  onToggleSidebar,
  sidebarVisible,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
}: NavControlsProps) {
  return (
    <div className="flex items-center gap-0.5 pointer-events-auto" style={NO_DRAG_STYLE}>
      {onToggleSidebar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              // `aria-pressed` still reflects the sidebar state for a11y (and
              // is the observable signal the toggle tests assert on), but the
              // icon no longer changes color when active — it stays muted like
              // the sibling nav buttons so it doesn't read as a selected tab.
              aria-pressed={sidebarVisible ?? false}
              data-testid="desktop-title-bar__sidebar-toggle"
              className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <PanelLeft className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Toggle Sidebar{" "}
            <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
              ⌘B
            </kbd>
          </TooltipContent>
        </Tooltip>
      )}
      {(onGoBack || onGoForward) && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onGoBack}
                disabled={!canGoBack}
                aria-label="Back"
                data-testid="desktop-title-bar__back"
                className="flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <ChevronLeft className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Back{" "}
              <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                ⌘[
              </kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onGoForward}
                disabled={!canGoForward}
                aria-label="Forward"
                data-testid="desktop-title-bar__forward"
                className="flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <ChevronRight className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Forward{" "}
              <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                ⌘]
              </kbd>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** Draggable title bar over the project-list sidebar. A pure drag/paint
 *  surface: the navigation cluster that used to live here is now hosted in
 *  `AppShell`'s stationary overlay (see NavControlsProps), which sits on top of
 *  this bar while the list is visible. Painted with the sidebar surface so
 *  it reads as one panel with the list below it, visually separated from
 *  the workspace layout to its right. */
export function SidebarTitleBar() {
  return (
    <div
      data-testid="desktop-title-bar__sidebar-surface"
      className="h-[38px] shrink-0 flex items-center border-b border-border bg-sidebar"
      style={DRAG_STYLE}
    />
  );
}

/** Draggable title bar over the workspace layout. Holds the workspace name
 *  (centered on the bar) and the open-in-editor / panel-switcher controls
 *  (right). The navigation cluster lives in `AppShell`'s stationary overlay, not
 *  here — see NavControlsProps. */
export function WorkspaceTitleBar({
  title,
  workspaceName,
  workspacePath,
  onCopyPath,
  onWorkspaceNameClick,
  onToggleRightPanel,
  rightPanelVisible,
}: WorkspaceTitleBarProps) {
  const [appTitle, setAppTitle] = useState(title ?? "Band");

  useEffect(() => {
    if (title) return;
    if (!isDesktop) return;
    desktopInvoke<string>("get_app_title")
      .then(setAppTitle)
      .catch(() => {});
  }, [title]);

  // EditorPicker invokes native IPC (open in VS Code/Finder/etc.) — keep it
  // desktop-only so it doesn't render a non-functional button in the web app.
  const hasEditorPicker = isDesktop && workspaceName && workspacePath;
  const hasRightToggle = !!(workspaceName && onToggleRightPanel);

  return (
    <div
      data-testid="desktop-title-bar__workspace-surface"
      className="relative h-[38px] shrink-0 flex items-center gap-1 border-b border-border bg-background pr-2 pl-2"
      style={DRAG_STYLE}
    >
      {/* The title is centered on the BAR (absolute overlay), not on the
          leftover flex space — flex-centering re-centers it whenever the
          bar's other flex children change (an instant jump layered on top
          of the bar's own smooth 200ms slide during a sidebar toggle).
          Anchored to the bar, it only ever moves with the bar.
          pointer-events pass through the overlay; the picker button
          re-enables them for itself. */}
      <div className="absolute inset-x-0 top-0 flex h-full items-center justify-center min-w-0 px-1 pointer-events-none">
        {workspaceName ? (
          onWorkspaceNameClick ? (
            // Interactive: clicking opens the workspace picker (mirrors the
            // mobile header). Lives inside the drag region, so it must reapply
            // NO_DRAG_STYLE and keep pointer events enabled, like the other
            // interactive title-bar children (back/forward, dropdown triggers).
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onWorkspaceNameClick}
                  aria-haspopup="dialog"
                  aria-label="Switch workspace"
                  data-testid="desktop-title-bar__workspace-name"
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 max-w-[50%] text-sm font-semibold text-foreground hover:bg-accent/50 transition-colors pointer-events-auto"
                  style={NO_DRAG_STYLE}
                >
                  <span className="truncate">{workspaceName}</span>
                  <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {/* Both modifiers are shown: SharedDockviewLayout binds ⌘K on
                  macOS and Ctrl+K on Windows/Linux (where this title bar also
                  renders in the wide-viewport web layout). */}
                Switch Workspace{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⌘K / Ctrl+K
                </kbd>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-sm font-semibold text-foreground select-none pointer-events-none truncate max-w-[50%]">
              {workspaceName}
            </span>
          )
        ) : (
          <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
            {appTitle}
          </span>
        )}
      </div>

      {/* `relative` lifts the controls above the absolutely-positioned title
          overlay (positioned siblings later in the DOM paint on top) so a
          long workspace name can never sit over these buttons and steal
          their clicks on a narrow bar. */}
      {(hasEditorPicker || hasRightToggle) && (
        <div
          className="relative ml-auto flex shrink-0 items-center gap-1 pointer-events-auto"
          style={NO_DRAG_STYLE}
        >
          {hasEditorPicker && (
            <EditorPicker workspacePath={workspacePath} onCopyPath={onCopyPath} />
          )}

          {hasRightToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Toggle Explorer / Changes panel"
                  aria-pressed={rightPanelVisible}
                  onClick={onToggleRightPanel}
                  className={`flex items-center justify-center rounded-md p-1 transition-colors hover:bg-accent/50 ${
                    rightPanelVisible
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <PanelRight className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Toggle Explorer / Changes{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⇧⌘E
                </kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** Invisible draggable region for desktop windows (no title text). */
export function DesktopDragRegion() {
  return <div className="h-[38px] shrink-0" style={DRAG_STYLE} />;
}
