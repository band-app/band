import { getFileIcon } from "@band-app/dashboard-core";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { ChevronLeft, ChevronRight, Clipboard, Copy, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FileTab } from "../hooks/useFileTabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBasename(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FileTabBarProps {
  /** Absolute filesystem path of the workspace root (for "Copy Absolute Path") */
  workspacePath?: string;
  tabs: FileTab[];
  activeTabPath: string | null;
  onSelectTab: (filePath: string) => void;
  onCloseTab: (filePath: string) => void;
  /** Navigate back in editor history */
  onGoBack?: () => void;
  /** Navigate forward in editor history */
  onGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Check if a file has unsaved edits (from tab state) */
  isDirty?: (filePath: string) => boolean;
  /** Action buttons rendered at the right end of the tab bar (e.g. markdown toggle) */
  actions?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// FileTabBar
// ---------------------------------------------------------------------------

export function FileTabBar({
  workspacePath,
  tabs,
  activeTabPath,
  onSelectTab,
  onCloseTab,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
  isDirty: isDirtyFn,
  actions,
}: FileTabBarProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State for the unsaved-changes confirmation dialog
  const [confirmClosePath, setConfirmClosePath] = useState<string | null>(null);

  // Re-render when dirty state changes (FileViewer dispatches "band:dirty-change")
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    window.addEventListener("band:dirty-change", forceUpdate);
    return () => window.removeEventListener("band:dirty-change", forceUpdate);
  }, []);

  // Auto-scroll active tab into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeTabPath triggers re-scroll when tab changes
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [activeTabPath]);

  // Horizontal wheel scrolling — scroll tabs left/right with the mouse wheel
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleClose = useCallback(
    (filePath: string) => {
      if (isDirtyFn?.(filePath)) {
        setConfirmClosePath(filePath);
        return;
      }
      onCloseTab(filePath);
    },
    [onCloseTab, isDirtyFn],
  );

  const handleConfirmClose = useCallback(() => {
    if (confirmClosePath) {
      onCloseTab(confirmClosePath);
      setConfirmClosePath(null);
    }
  }, [confirmClosePath, onCloseTab]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, filePath: string) => {
      // Middle-click to close
      if (e.button === 1) {
        e.preventDefault();
        handleClose(filePath);
      }
    },
    [handleClose],
  );

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      // clipboard unavailable
    });
  }, []);

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="flex h-9 shrink-0 items-center border-b border-border/50 bg-background">
        {/* Navigation arrows */}
        {(onGoBack || onGoForward) && (
          <div className="flex shrink-0 items-center gap-0.5 px-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onGoBack}
                  disabled={!canGoBack}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Go Back{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⌃-
                </kbd>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onGoForward}
                  disabled={!canGoForward}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Go Forward{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⌃⇧-
                </kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Scrollable tabs area */}
        <div
          ref={containerRef}
          className="flex min-w-0 flex-1 items-end self-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
        >
          {tabs.map((tab) => {
            const isActive = tab.filePath === activeTabPath;
            const isDirty = isDirtyFn?.(tab.filePath) ?? false;
            const basename = getBasename(tab.filePath);
            const Icon = getFileIcon(basename);
            const absolutePath = workspacePath
              ? `${workspacePath.replace(/\/$/, "")}/${tab.filePath}`
              : tab.filePath;

            return (
              <ContextMenu key={tab.filePath}>
                <ContextMenuTrigger asChild>
                  <button
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tab.filePath}
                    onClick={() => onSelectTab(tab.filePath)}
                    onMouseDown={(e) => handleMouseDown(e, tab.filePath)}
                    className={cn(
                      "group relative flex h-full w-[160px] shrink-0 items-center gap-1.5 border-r border-border/30 px-3 text-xs transition-colors",
                      isActive
                        ? "bg-background text-foreground"
                        : "bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    {/* Active tab indicator */}
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary" />
                    )}

                    {/* File icon */}
                    <Icon className="size-3.5 shrink-0" />

                    {/* File name */}
                    <span className="min-w-0 flex-1 truncate">{basename}</span>

                    {/* Dirty indicator dot OR close button */}
                    <button
                      type="button"
                      className="relative flex size-4 shrink-0 items-center justify-center bg-transparent border-none p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClose(tab.filePath);
                      }}
                      tabIndex={-1}
                      aria-label={`Close ${basename}`}
                    >
                      {isDirty ? (
                        <>
                          {/* Dirty dot — visible by default, hidden on hover (close shows instead) */}
                          <span className="absolute size-2 rounded-full bg-yellow-400 group-hover:hidden" />
                          {/* Close icon — hidden by default, visible on hover */}
                          <X className="absolute hidden size-3.5 rounded-sm hover:bg-accent group-hover:block" />
                        </>
                      ) : (
                        /* Close icon — subtle, visible on tab hover */
                        <X className="size-3.5 rounded-sm opacity-0 hover:bg-accent group-hover:opacity-100 transition-opacity" />
                      )}
                    </button>
                  </button>
                </ContextMenuTrigger>

                <ContextMenuContent>
                  <ContextMenuItem onClick={() => copyToClipboard(tab.filePath)}>
                    <Copy className="size-4" />
                    Copy Relative Path
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => copyToClipboard(absolutePath)}>
                    <Clipboard className="size-4" />
                    Copy Absolute Path
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => handleClose(tab.filePath)}>
                    <X className="size-4" />
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* Action buttons (e.g. markdown preview toggle) */}
        {actions && <div className="flex shrink-0 items-center gap-0.5 px-1.5">{actions}</div>}
      </div>

      {/* Unsaved changes confirmation dialog */}
      <Dialog
        open={confirmClosePath !== null}
        onOpenChange={(open) => !open && setConfirmClosePath(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              &ldquo;{confirmClosePath ? getBasename(confirmClosePath) : ""}&rdquo; has unsaved
              changes that will be lost if you close it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClosePath(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmClose}>
              Close Without Saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
