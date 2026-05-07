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
import { PanelLeft, PanelTop } from "lucide-react";
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

interface DesktopTitleBarProps {
  /** Static title. If omitted, fetches the app title from the desktop shell. */
  title?: string;
  /** Callback to toggle the sidebar. When provided, a toggle button is shown. */
  onToggleSidebar?: () => void;
  /** Whether the sidebar is currently collapsed. */
  sidebarCollapsed?: boolean;
  /** Active workspace name to display prominently. */
  workspaceName?: string;
  /** The workspace path for open-in / copy-path actions. */
  workspacePath?: string;
  /** Callback to copy the workspace path to clipboard. */
  onCopyPath?: () => void;
  /** Panel definitions for the panel switcher dropdown. */
  panelItems?: PanelItem[];
  /** Panel IDs that are currently hidden from the layout. */
  hiddenPanels?: string[];
  /** Callback to toggle a panel's visibility on/off. */
  onTogglePanelVisibility?: (panelId: string) => void;
}

/** Draggable desktop title bar that works with external-URL Electron webviews. */
export function DesktopTitleBar({
  title,
  onToggleSidebar,
  sidebarCollapsed,
  workspaceName,
  workspacePath,
  onCopyPath,
  panelItems,
  hiddenPanels,
  onTogglePanelVisibility,
}: DesktopTitleBarProps) {
  const [appTitle, setAppTitle] = useState(title ?? "Band");

  useEffect(() => {
    if (title) return;
    if (!isDesktop) return;
    desktopInvoke<string>("get_app_title")
      .then(setAppTitle)
      .catch(() => {});
  }, [title]);

  const hasEditorPicker = workspaceName && workspacePath;
  const hasPanels = workspaceName && panelItems && panelItems.length > 0 && onTogglePanelVisibility;

  return (
    <div
      className="h-[38px] shrink-0 flex items-center justify-center relative border-b border-border"
      style={DRAG_STYLE}
    >
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          style={NO_DRAG_STYLE}
          className="absolute left-[80px] top-1/2 -translate-y-1/2 flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors pointer-events-auto"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <PanelLeft className="size-5" />
        </button>
      )}

      {workspaceName ? (
        <span className="text-sm font-semibold text-foreground select-none pointer-events-none truncate max-w-[50%]">
          {workspaceName}
        </span>
      ) : (
        <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
          {appTitle}
        </span>
      )}

      {(hasEditorPicker || hasPanels) && (
        <div
          className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 pointer-events-auto"
          style={NO_DRAG_STYLE}
        >
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
