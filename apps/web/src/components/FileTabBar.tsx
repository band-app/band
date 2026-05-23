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
import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  ExternalLink,
  FileText,
  PanelLeft,
  Pin,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getFileIcon } from "@/dashboard";
import type { FileTab } from "../hooks/useFileTabs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBasename(filePath: string): string {
  // Defensive coerce: tab paths originate from localStorage, which can contain
  // unexpected shapes from older builds. The primary fix is in useFileTabs
  // (loadTabState filters non-strings), but a non-string slipping through here
  // shouldn't crash the entire workspace.
  if (typeof filePath !== "string") return String(filePath ?? "");
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
  /** Pin a preview tab — typically called on double-click of a preview tab. */
  onPinTab?: (filePath: string) => void;
  /** Navigate back in editor history */
  onGoBack?: () => void;
  /** Navigate forward in editor history */
  onGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Check if a file has unsaved edits (from tab state) */
  isDirty?: (filePath: string) => boolean;
  /**
   * Run the save-as flow for an untitled tab (issue #434). Returns
   * `true` when the user picked a path and the file was saved, `false`
   * when they cancelled the dialog. The close-confirm dialog uses this
   * to wire the "Save" button: if the save resolves, we close the tab;
   * if it returns false, we leave the tab open (matching VS Code).
   */
  onSaveUntitled?: (filePath: string) => Promise<boolean>;
  /** Action buttons rendered at the right end of the tab bar (e.g. markdown toggle) */
  actions?: React.ReactNode;
  /** Whether the file-tree sidebar is collapsed (used to flip the toggle icon's tooltip). */
  treeCollapsed?: boolean;
  /** When provided, renders a leading button that toggles the file-tree sidebar.
   *  The button auto-hides when the tab bar's container becomes too narrow. */
  onToggleTree?: () => void;
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
  onPinTab,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
  isDirty: isDirtyFn,
  onSaveUntitled,
  actions,
  treeCollapsed,
  onToggleTree,
}: FileTabBarProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State for the unsaved-changes confirmation dialog. We latch
  // `confirmCloseIsUntitled` at dialog-open time instead of deriving
  // it from `tabs` on every render. The Save… flow calls
  // `renameUntitledToFile` upstream, which removes the `untitled:N`
  // entry from `tabs` BEFORE this component's
  // `setConfirmClosePath(null)` runs — and during that render window
  // a `tabs.some(...)` lookup would observe the renamed (no-longer-
  // untitled) tab and flip the button row from "Discard / Save…" to
  // "Close Without Saving" momentarily, producing a flicker. Latching
  // at open time pins the variant for the dialog's whole lifetime.
  const [confirmClosePath, setConfirmClosePath] = useState<string | null>(null);
  const [confirmCloseIsUntitled, setConfirmCloseIsUntitled] = useState(false);
  const [confirmCloseLabel, setConfirmCloseLabel] = useState<string>("");
  const openConfirmClose = useCallback(
    (filePath: string) => {
      const tab = tabs.find((t) => t.filePath === filePath);
      setConfirmClosePath(filePath);
      setConfirmCloseIsUntitled(!!tab?.isUntitled);
      // Pin the display name at open time too — the renamed (now
      // file-backed) tab keeps a workspace path, but the dialog should
      // still announce the original "Untitled-N" the user clicked.
      setConfirmCloseLabel(
        tab?.isUntitled ? (tab.untitledLabel ?? "Untitled") : getBasename(filePath),
      );
    },
    [tabs],
  );
  const closeConfirmDialog = useCallback(() => {
    setConfirmClosePath(null);
    setConfirmCloseIsUntitled(false);
    setConfirmCloseLabel("");
  }, []);

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
        openConfirmClose(filePath);
        return;
      }
      onCloseTab(filePath);
    },
    [onCloseTab, isDirtyFn, openConfirmClose],
  );

  const handleConfirmClose = useCallback(() => {
    if (confirmClosePath) {
      onCloseTab(confirmClosePath);
      closeConfirmDialog();
    }
  }, [confirmClosePath, onCloseTab, closeConfirmDialog]);

  // Save-then-close for untitled tabs. Runs the OS save dialog via
  // `onSaveUntitled`; if the user picks a path we close the (now file-
  // backed) tab, if they cancel we keep the dialog and the tab open —
  // matches the acceptance criterion "cancelling the save dialog
  // cancels the close".
  //
  // `saveAndClosePending` guards the brief window between the dialog
  // resolving and React processing `setConfirmClosePath(null)`. Without
  // it a second click on "Save…" (impatient user / a touchpad double-
  // tap) would launch a second save with the same content, surfacing
  // two save dialogs in sequence.
  const [saveAndClosePending, setSaveAndClosePending] = useState(false);
  const handleSaveAndClose = useCallback(async () => {
    if (!confirmClosePath || !onSaveUntitled || saveAndClosePending) return;
    setSaveAndClosePending(true);
    try {
      const saved = await onSaveUntitled(confirmClosePath);
      if (saved) {
        // The save flow renamed the tab to the saved path — the
        // original untitled key is gone, so closing it is a no-op.
        // Just dismiss the dialog.
        closeConfirmDialog();
      }
      // Cancelled: leave the dialog open so the user can pick
      // Discard or Cancel without re-clicking the X.
    } finally {
      setSaveAndClosePending(false);
    }
  }, [confirmClosePath, onSaveUntitled, saveAndClosePending, closeConfirmDialog]);

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
      <div className="@container flex h-9 shrink-0 items-center border-b border-border/50 bg-background">
        {/* File-tree toggle — always visible except when the parent
            container is too narrow to fit it alongside tabs. */}
        {onToggleTree && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleTree}
                className="ml-1 hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors @[16rem]:inline-flex"
              >
                <PanelLeft className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {treeCollapsed ? "Show" : "Hide"} File Explorer
            </TooltipContent>
          </Tooltip>
        )}

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
            const isPreview = tab.isPreview ?? false;
            const isExternal = tab.isExternal ?? false;
            const isUntitled = tab.isUntitled ?? false;
            // Untitled tabs render their `untitledLabel` ("Untitled-1")
            // because the synthetic `untitled:N` filePath is just a key.
            // File-backed tabs continue using the basename.
            const basename = isUntitled
              ? (tab.untitledLabel ?? "Untitled")
              : getBasename(tab.filePath);
            // No file icon to derive from an untitled tab — render a
            // generic FileText. Existing tabs keep their extension-
            // based icon (TypeScript, Markdown, etc.).
            const Icon = isUntitled ? FileText : getFileIcon(basename);
            // External tabs already carry the absolute path; workspace
            // tabs join with the worktree root for the "Copy Absolute
            // Path" item. Untitled tabs have no on-disk path, so we
            // leave `absolutePath` as `null` — the context-menu render
            // below omits the "Copy Absolute Path" entry entirely (VS
            // Code's behaviour for unsaved buffers) rather than copy a
            // bare label that looks like a path but isn't.
            const absolutePath: string | null = isUntitled
              ? null
              : isExternal
                ? tab.filePath
                : workspacePath
                  ? `${workspacePath.replace(/\/$/, "")}/${tab.filePath}`
                  : tab.filePath;
            // Tooltip / native title: external tabs surface the full
            // absolute path so the user can tell at a glance where edits
            // will be written. Untitled tabs show a hint that the buffer
            // hasn't been saved — phrased without a platform-specific
            // shortcut since Band's Electron shell runs on macOS,
            // Windows, and Linux (Cmd on macOS / Ctrl elsewhere).
            const tabTitle = isUntitled
              ? `${basename} (unsaved — Save to write to disk)`
              : isExternal
                ? `${tab.filePath} (external file)`
                : isPreview
                  ? `${tab.filePath} (preview — double-click to keep open)`
                  : tab.filePath;

            return (
              <ContextMenu key={tab.filePath}>
                <ContextMenuTrigger asChild>
                  <button
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tabTitle}
                    onClick={() => onSelectTab(tab.filePath)}
                    onDoubleClick={() => isPreview && onPinTab?.(tab.filePath)}
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

                    {/* External-file badge. Sits between the file icon and
                        the name so the user can tell at a glance that the
                        tab's filePath is an absolute path outside the
                        workspace root. */}
                    {isExternal && (
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground/70" />
                    )}

                    {/* File name — italic when in preview mode, muted
                        when external so the badge is reinforced visually. */}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        isPreview && "italic",
                        isExternal && "text-muted-foreground/90",
                      )}
                    >
                      {basename}
                    </span>

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
                  {isPreview && onPinTab && (
                    <>
                      <ContextMenuItem onClick={() => onPinTab(tab.filePath)}>
                        <Pin className="size-4" />
                        Keep Open
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* "Copy Relative Path" is meaningless for an
                      untitled buffer (the path is a synthetic
                      `untitled:N` key, not a real workspace-relative
                      path). Match VS Code's behaviour for unsaved
                      editors and hide the item in that case. */}
                  {!isUntitled && (
                    <ContextMenuItem onClick={() => copyToClipboard(tab.filePath)}>
                      <Copy className="size-4" />
                      Copy Relative Path
                    </ContextMenuItem>
                  )}
                  {/* Untitled tabs leave `absolutePath` as `null`, so
                      the "Copy Absolute Path" item is dropped entirely
                      — pasting `"Untitled-1"` somewhere would look
                      like a valid path and fail confusingly. */}
                  {absolutePath !== null && (
                    <ContextMenuItem onClick={() => copyToClipboard(absolutePath)}>
                      <Clipboard className="size-4" />
                      Copy Absolute Path
                    </ContextMenuItem>
                  )}
                  {!isUntitled && <ContextMenuSeparator />}
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
        onOpenChange={(open) => !open && closeConfirmDialog()}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              &ldquo;{confirmCloseLabel}&rdquo; has unsaved changes that will be lost if you close
              it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={closeConfirmDialog}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmClose}>
              {confirmCloseIsUntitled ? "Discard" : "Close Without Saving"}
            </Button>
            {confirmCloseIsUntitled && onSaveUntitled && (
              // Save flows through the OS dialog (Cmd+S on an untitled
              // tab). On success the untitled tab is renamed to the
              // chosen path and the close completes; on cancel we
              // leave both the dialog and the tab open.
              <Button onClick={handleSaveAndClose} disabled={saveAndClosePending}>
                Save…
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
