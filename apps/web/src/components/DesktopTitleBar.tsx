import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { ChevronLeft, ChevronRight, ChevronsUpDown, Menu, PanelLeft, PanelTop } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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

/** Props for the navigation cluster (sidebar toggle + menu + back/forward).
 *  This cluster lives in the SidebarTitleBar while the project list is
 *  visible, and relocates into the WorkspaceTitleBar when the list is
 *  collapsed — so both bars accept the same set of props. */
interface NavControlsProps {
  /** Items rendered inside the global hamburger dropdown. When undefined, the
   *  hamburger button is not rendered. */
  menuItems?: ReactNode;
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

/** The traffic-light gutter class: on macOS desktop (outside fullscreen) the
 *  window controls occupy the top-left ~80px, so whichever title-bar half sits
 *  at the window's left edge must clear that space. Computed once in `AppShell`
 *  (a single `useIsFullscreen` subscription) and passed to both halves. */
interface TitleBarOffsetProps {
  /** Left-padding class to apply when the bar is at the window's left edge. */
  offsetClass: string;
}

/** The sidebar half takes the shared nav-control props verbatim;
 *  `sidebarVisible` (inherited from NavControlsProps) gates the cluster. */
type SidebarTitleBarProps = NavControlsProps & TitleBarOffsetProps;

interface WorkspaceTitleBarProps extends NavControlsProps, TitleBarOffsetProps {
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
  /** Panel definitions for the panel switcher dropdown. */
  panelItems?: PanelItem[];
  /** Panel IDs that are currently hidden from the layout. */
  hiddenPanels?: string[];
  /** Callback to toggle a panel's visibility on/off. */
  onTogglePanelVisibility?: (panelId: string) => void;
}

/** Sidebar toggle + hamburger menu + back/forward arrows. Shared by both
 *  title-bar halves; rendered in exactly one of them at a time. */
function NavControls({
  menuItems,
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
              aria-pressed={sidebarVisible ?? false}
              data-testid="desktop-title-bar__sidebar-toggle"
              className={`flex items-center justify-center rounded p-1 transition-colors hover:bg-accent/50 hover:text-foreground ${sidebarVisible ? "text-foreground" : "text-muted-foreground"}`}
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
      {menuItems && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  aria-label="Menu"
                  // This hamburger is the collapsed-sidebar fallback: while
                  // the project list is visible its actions live in the
                  // list's bottom action bar (`DashboardShell.tsx`), and
                  // `AppShell` (`__root.tsx`) only passes `menuItems` to the
                  // WorkspaceTitleBar — so this renders once the list
                  // collapses. Retains the historical testid for any direct
                  // `page.getByTestId` spec use (page objects target the
                  // bottom-bar buttons now).
                  data-testid="dashboard__menu-trigger"
                >
                  <Menu className="size-5" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              More
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">{menuItems}</DropdownMenuContent>
        </DropdownMenu>
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

/** Draggable title bar over the project-list sidebar. Holds the navigation
 *  cluster (sidebar toggle, menu, back/forward) while the list is visible.
 *  Painted with the sidebar surface so it reads as one panel with the list
 *  below it, visually separated from the workspace layout to its right. */
export function SidebarTitleBar({ sidebarVisible, offsetClass, ...nav }: SidebarTitleBarProps) {
  return (
    <div
      className={`h-[38px] shrink-0 flex items-center gap-0.5 border-b border-border bg-sidebar pr-2 ${offsetClass}`}
      style={DRAG_STYLE}
    >
      {/* Gate the cluster on visibility: when the list is collapsed the bar is
          clipped to 0px but stays mounted, so rendering the cluster here would
          duplicate it (the WorkspaceTitleBar shows it while collapsed) and put
          two `…__sidebar-toggle` nodes in the DOM. `AppShell` passes
          `menuItems={undefined}` here, so this variant renders only the toggle
          + back/forward arrows — the overflow menu lives in the WorkspaceTitleBar
          fallback (collapsed) and the project-list bottom action bar (visible). */}
      {sidebarVisible && <NavControls sidebarVisible={sidebarVisible} {...nav} />}
    </div>
  );
}

/** Draggable title bar over the workspace layout. Holds the workspace name
 *  (center), the open-in-editor picker, and the panel/layout switcher. When
 *  the project-list sidebar is collapsed, the navigation cluster relocates
 *  here (far left, clearing the traffic lights) so the menu and back/forward
 *  arrows stay reachable. */
export function WorkspaceTitleBar({
  title,
  workspaceName,
  workspacePath,
  onCopyPath,
  onWorkspaceNameClick,
  panelItems,
  hiddenPanels,
  onTogglePanelVisibility,
  sidebarVisible,
  offsetClass,
  ...nav
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
  const hasPanels = workspaceName && panelItems && panelItems.length > 0 && onTogglePanelVisibility;

  return (
    <div
      // Left padding clears the macOS traffic lights only when this bar sits at
      // the window's left edge — i.e. while the sidebar is collapsed and the
      // nav cluster lives here. When the sidebar is visible it owns that gutter.
      className={`h-[38px] shrink-0 flex items-center gap-1 border-b border-border bg-background pr-2 ${sidebarVisible ? "pl-2" : offsetClass}`}
      style={DRAG_STYLE}
    >
      {/* Nav cluster relocates here (left-aligned, in normal flow) while the
          project list is collapsed, so it never overlaps the centered title. */}
      {!sidebarVisible && <NavControls sidebarVisible={sidebarVisible} {...nav} />}

      <div className="flex flex-1 items-center justify-center min-w-0 px-1">
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

      {(hasEditorPicker || hasPanels) && (
        <div className="flex shrink-0 items-center gap-1 pointer-events-auto" style={NO_DRAG_STYLE}>
          {hasEditorPicker && (
            <EditorPicker workspacePath={workspacePath} onCopyPath={onCopyPath} />
          )}

          {hasPanels && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <PanelTop className="size-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Switch Panel</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {panelItems?.map((item) => {
                  const Icon = item.icon;
                  const isVisible = !hiddenPanels?.includes(item.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={item.id}
                      checked={isVisible}
                      onCheckedChange={() => {
                        onTogglePanelVisibility?.(item.id);
                      }}
                    >
                      <Icon className="size-4" />
                      {item.label}
                      {item.shortcut && (
                        <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
                      )}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
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
