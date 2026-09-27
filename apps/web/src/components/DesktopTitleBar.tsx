import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight } from "lucide-react";
import { createContext, useContext } from "react";
import { formatShortcut } from "@/dashboard";
import { isDesktop } from "../lib/is-desktop";
import { EditorPicker } from "./EditorPicker";

// Native window dragging is wired via CSS `-webkit-app-region: drag` on the
// title-bar root, with `no-drag` reapplied to the interactive children
// (buttons, dropdown triggers) so clicks aren't swallowed by the drag region.
// This is Electron's recommended pattern and replaces the JS
// `mousedown → startDragging` listener used during the Tauri era.
export const DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "drag",
} as React.CSSProperties;
export const NO_DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

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
  /** Navigate to the previous workspace in the history stack (⌥⌘←). */
  onGoBack?: () => void;
  /** Navigate to the next workspace in the history stack (⌥⌘→). */
  onGoForward?: () => void;
  /** Whether back navigation is currently available (enables/disables the button). */
  canGoBack?: boolean;
  /** Whether forward navigation is currently available (enables/disables the button). */
  canGoForward?: boolean;
}

/** Window chrome the center tab strip needs from `AppShell`. The desktop
 *  layout has no title bar over the center column: the dockview tab strip is
 *  the top row, so its top-left group leaves room for the nav cluster while the
 *  sidebar is collapsed, and its top-right group hosts the right sidepanel's
 *  expand button while that panel is collapsed. `null` outside the desktop
 *  layout (the mobile workspace route), where none of this renders. */
export interface WorkspaceChrome {
  /** Whether the project-list sidebar is visible. */
  sidebarVisible: boolean;
  /** Rendered width of `AppShell`'s nav-cluster overlay, in CSS px. */
  navOverlayWidth: number;
  /** Whether the right sidepanel (Explorer / Changes) is visible. */
  rightPanelVisible: boolean;
  /** Toggle the right sidepanel. Undefined when no workspace is active. */
  onToggleRightPanel?: () => void;
}

export const WorkspaceChromeContext = createContext<WorkspaceChrome | null>(null);

export function useWorkspaceChrome(): WorkspaceChrome | null {
  return useContext(WorkspaceChromeContext);
}

/** Toggle for the right sidepanel. Rendered by the sidepanel header while the
 *  panel is visible and by the center tab strip (or `CenterDragBar` when there
 *  is no tab strip) while it is collapsed, so exactly one copy is on screen at
 *  a time. */
export function RightPanelToggle({
  onToggle,
  visible,
}: {
  onToggle: () => void;
  visible: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Toggle Explorer / Changes panel"
          // `aria-pressed` still reflects panel state for a11y, but the
          // icon stays muted whether open or closed (matches the sidebar
          // toggle) so it doesn't read as a selected/active control.
          aria-pressed={visible}
          onClick={onToggle}
          className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <PanelRight className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Toggle Explorer / Changes{" "}
        <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
          {formatShortcut("Cmd+Shift+E")}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}

interface RightPanelHeaderActionsProps {
  /** The workspace path for open-in / copy-path actions. */
  workspacePath?: string;
  /** Callback to copy the workspace path to clipboard. */
  onCopyPath?: () => void;
  /** Collapse the right sidepanel. When undefined, no toggle renders. */
  onToggleRightPanel?: () => void;
}

/** Open-in-editor picker + collapse button, shown at the right edge of the
 *  right sidepanel's header row (beside the Explorer / Changes tabs). */
export function RightPanelHeaderActions({
  workspacePath,
  onCopyPath,
  onToggleRightPanel,
}: RightPanelHeaderActionsProps) {
  // EditorPicker invokes native IPC (open in VS Code/Finder/etc.) — keep it
  // desktop-only so it doesn't render a non-functional button in the web app.
  const hasEditorPicker = isDesktop && !!workspacePath;
  if (!hasEditorPicker && !onToggleRightPanel) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-1 self-center"
      style={NO_DRAG_STYLE}
      data-testid="right-sidepanel__header-actions"
    >
      {hasEditorPicker && <EditorPicker workspacePath={workspacePath} onCopyPath={onCopyPath} />}
      {onToggleRightPanel && <RightPanelToggle onToggle={onToggleRightPanel} visible />}
    </div>
  );
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
              {formatShortcut("Cmd+B")}
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
                {formatShortcut("Cmd+Alt+←")}
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
                {formatShortcut("Cmd+Alt+→")}
              </kbd>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** Draggable title bar over the project-list sidebar. A pure drag surface:
 *  the navigation cluster that used to live here is now hosted in
 *  `AppShell`'s stationary overlay (see NavControlsProps), which sits on top of
 *  this bar while the list is visible. Unpainted: the sidebar column around it
 *  paints the sidebar surface, so it reads as one panel with the list below
 *  it, and a second layer would double the translucent sidebar's tint. */
export function SidebarTitleBar() {
  return (
    <div
      data-testid="desktop-title-bar__sidebar-surface"
      className="h-[38px] shrink-0 flex items-center border-b border-border"
      style={DRAG_STYLE}
    />
  );
}

/** Draggable space under `AppShell`'s nav-cluster overlay, reserved at the
 *  left edge of the center column's top row while the sidebar is collapsed so
 *  tabs never slide beneath the traffic lights or the nav buttons. Renders
 *  nothing while the sidebar is visible (the overlay then sits over the
 *  sidebar's own title bar). */
export function SidebarGutter() {
  const chrome = useWorkspaceChrome();
  if (!chrome || chrome.sidebarVisible) return null;
  return (
    <div
      data-testid="workspace-center__sidebar-gutter"
      className="h-full shrink-0"
      style={{ ...DRAG_STYLE, width: chrome.navOverlayWidth }}
    />
  );
}

/** Draggable top row for the center column when it has no tab strip: no
 *  workspace is active, or the active one has every tab closed. Carries the
 *  same controls the tab strip would (the sidebar gutter, and the right
 *  sidepanel's expand button while it is collapsed) and no title. */
export function CenterDragBar({ className = "" }: { className?: string }) {
  const chrome = useWorkspaceChrome();
  const onToggleRightPanel = chrome?.onToggleRightPanel;
  return (
    <div
      data-testid="workspace-center__drag-bar"
      className={`flex h-[38px] shrink-0 items-center border-b border-border bg-background pr-2 ${className}`}
      style={DRAG_STYLE}
    >
      <SidebarGutter />
      {onToggleRightPanel && !chrome.rightPanelVisible && (
        <div className="ml-auto flex shrink-0 items-center" style={NO_DRAG_STYLE}>
          <RightPanelToggle onToggle={onToggleRightPanel} visible={false} />
        </div>
      )}
    </div>
  );
}

/** Invisible draggable region for desktop windows (no title text). */
export function DesktopDragRegion() {
  return <div className="h-[38px] shrink-0" style={DRAG_STYLE} />;
}
