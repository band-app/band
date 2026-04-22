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
import { type RefObject, useEffect, useRef, useState } from "react";
import { EditorPicker } from "./EditorPicker";

/** Attaches a native mousedown → startDragging listener to a ref. */
function useTauriDrag(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let appWindow: { startDragging: () => Promise<void> } | null = null;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      appWindow = getCurrentWindow();
    });

    const onMouseDown = (e: MouseEvent) => {
      if (e.buttons === 1 && appWindow) {
        appWindow.startDragging();
      }
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [ref]);
}

export interface PanelItem {
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  shortcut?: string;
}

interface TauriTitleBarProps {
  /** Static title. If omitted, fetches the app title from Tauri. */
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

/** Draggable Tauri title bar that works with external-URL webviews. */
export function TauriTitleBar({
  title,
  onToggleSidebar,
  sidebarCollapsed,
  workspaceName,
  workspacePath,
  onCopyPath,
  panelItems,
  hiddenPanels,
  onTogglePanelVisibility,
}: TauriTitleBarProps) {
  const [appTitle, setAppTitle] = useState(title ?? "Band");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (title) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_app_title").then(setAppTitle);
    });
  }, [title]);

  useTauriDrag(ref);

  const hasEditorPicker = workspaceName && workspacePath;
  const hasPanels = workspaceName && panelItems && panelItems.length > 0 && onTogglePanelVisibility;

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="h-[38px] shrink-0 flex items-center justify-center relative"
    >
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          onMouseDown={(e) => e.stopPropagation()}
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
          onMouseDown={(e) => e.stopPropagation()}
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
                  const isChat = item.id === "chat";
                  const isVisible = isChat || !hiddenPanels?.includes(item.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={item.id}
                      checked={isVisible}
                      disabled={isChat}
                      onCheckedChange={() => {
                        if (isChat) return;
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

/** Invisible draggable region for Tauri windows (no title text). */
export function TauriDragRegion() {
  const ref = useRef<HTMLDivElement>(null);
  useTauriDrag(ref);

  return <div ref={ref} data-tauri-drag-region className="h-[38px] shrink-0" />;
}
