import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy as CopyIcon,
  File as FileIconLucide,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Scissors,
  Trash2,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAdapter } from "../context";
import { useDeferredMenuAction } from "../hooks/use-deferred-menu-action";
import { getFileIcon } from "../lib/file-icon";
import type { FileEntry } from "../types";

interface FileBrowserProps {
  workspaceId: string;
  /**
   * Called on single-click on a file. The caller decides whether this
   * opens as a preview or pinned tab (this component just emits the
   * event with the file path).
   */
  onOpenFile: (path: string) => void;
  /**
   * Called on double-click on a file. Optional — when provided, the
   * caller typically opens the file as a pinned (persistent) tab.
   */
  onOpenFilePinned?: (path: string) => void;
  /** Compact mode for sidebar use — smaller items */
  compact?: boolean;
  /** Currently selected file path for highlighting and auto-expand */
  selectedFile?: string;
  /**
   * Called after a path is renamed via the file browser context menu.
   * `oldPath` and `newPath` are workspace-relative. For directory
   * renames the caller should also rewrite any descendant tabs whose
   * paths sit inside `oldPath + "/"`.
   */
  onPathRenamed?: (oldPath: string, newPath: string, kind: "file" | "directory") => void;
  /**
   * Called after a path is deleted via the file browser context menu.
   * For directories, the caller should also drop any descendant tabs.
   */
  onPathDeleted?: (path: string, kind: "file" | "directory") => void;
}

/**
 * Imperative handle exposed via `ref` so external toolbars (e.g. the file
 * tree toolbar in CodeBrowserView) can trigger an inline "new file" or
 * "new folder" input at the workspace root.
 */
export interface FileBrowserHandle {
  /** Begin creating a new file at the given parent (defaults to root). */
  startNewFile(parentPath?: string): void;
  /** Begin creating a new folder at the given parent (defaults to root). */
  startNewFolder(parentPath?: string): void;
}

// ---------------------------------------------------------------------------
// Module-level caches — survive re-mounts so tree state is preserved when
// the user switches between workspaces.
// ---------------------------------------------------------------------------
const expandedStateCache = new Map<string, Set<string>>();
const dirContentsCache = new Map<string, Map<string, FileEntry[]>>();

function getCachedExpanded(wsId: string): Set<string> {
  let set = expandedStateCache.get(wsId);
  if (!set) {
    set = new Set([""]);
    expandedStateCache.set(wsId, set);
  }
  return set;
}

function getCachedContents(wsId: string): Map<string, FileEntry[]> {
  let map = dirContentsCache.get(wsId);
  if (!map) {
    map = new Map();
    dirContentsCache.set(wsId, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Inline name input — shown when the user is creating a new file/folder or
// renaming an existing one.
// ---------------------------------------------------------------------------
interface EntryNameInputProps {
  kind: "file" | "directory";
  depth: number;
  compact?: boolean;
  /** Pre-filled value (used by the rename flow). Defaults to "". */
  initialValue?: string;
  /** Existing sibling names so we can flag duplicates client-side. */
  siblings: Set<string>;
  /** Placeholder when the input is empty. */
  placeholder?: string;
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}

function EntryNameInput({
  kind,
  depth,
  compact,
  initialValue = "",
  siblings,
  placeholder,
  onSubmit,
  onCancel,
}: EntryNameInputProps) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input on mount. When there's an initial value (rename
  // flow), pre-select the basename portion so typing replaces it without
  // clobbering the extension.
  //
  // Callers that mount this input from a Radix menu defer the action to
  // `onCloseAutoFocus` (see `useDeferredMenuAction`), so by the time we
  // run there's no FocusScope competing for focus and a single
  // `el.focus()` call sticks on the first try.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (initialValue) {
      const dotIdx = initialValue.lastIndexOf(".");
      // Select basename only for files, everything for directories and
      // dotfiles like ".env".
      const end = dotIdx > 0 ? dotIdx : initialValue.length;
      try {
        el.setSelectionRange(0, end);
      } catch {
        // Some browsers throw on certain input states — silently ignore.
      }
    }
  }, [initialValue]);

  const indent = compact ? 12 : 16;
  const basePad = compact ? 4 : 8;
  const height = compact ? 28 : 32;

  const validate = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return "Name is required";
    if (trimmed === "." || trimmed === "..") return "Invalid name";
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return "Name cannot contain slashes";
    }
    if (siblings.has(trimmed)) return "A file or folder with this name already exists";
    return null;
  };

  const handleSubmit = async () => {
    const trimmed = value.trim();
    // Unchanged name in rename mode → treat as cancel.
    if (trimmed === initialValue) {
      onCancel();
      return;
    }
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  const Icon = kind === "directory" ? Folder : FileIconLucide;

  return (
    <div className="flex w-full flex-col" style={{ paddingLeft: `${depth * indent + basePad}px` }}>
      <div
        className={`flex items-center ${
          compact ? "h-[28px] gap-1 pr-3 text-[13px]" : "h-[32px] gap-1.5 pr-4 text-[15px]"
        }`}
        style={{ height }}
      >
        <span className="size-3.5 shrink-0" />
        <Icon
          className={
            kind === "directory"
              ? "size-4 shrink-0 text-blue-600 dark:text-blue-400"
              : "size-4 shrink-0 text-muted-foreground"
          }
        />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          disabled={submitting}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            // Cancel on blur unless we're submitting (in which case the
            // input is already disabled and we don't want to fight the
            // submit flow).
            if (!submitting) {
              if (value.trim()) {
                void handleSubmit();
              } else {
                onCancel();
              }
            }
          }}
          placeholder={placeholder ?? (kind === "directory" ? "Folder name" : "File name")}
          className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 py-0 text-foreground outline-none ring-1 ring-ring/40 focus:ring-2 focus:ring-ring disabled:opacity-60"
          aria-label={kind === "directory" ? "Folder name" : "File name"}
        />
      </div>
      {error && (
        <div
          className="pointer-events-none text-xs text-destructive"
          style={{ paddingLeft: `${18 + 6}px`, paddingBottom: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreeNode — renders a single file or directory row + children recursively
// ---------------------------------------------------------------------------
interface TreeNodeProps {
  entry: FileEntry;
  parentPath: string;
  depth: number;
  expandedPaths: Set<string>;
  dirContents: Map<string, FileEntry[]>;
  loadingPaths: Set<string>;
  onToggle: (dirPath: string) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFilePinned?: (filePath: string) => void;
  /**
   * Mark a row as the current tree selection. Set on left-click, on the
   * file open path, and when a row's context menu opens — so right-click
   * also drives selection.
   */
  onSelectRow: (path: string, kind: "file" | "directory") => void;
  onRequestNewEntry: (parentPath: string, kind: "file" | "directory") => void;
  onRequestDelete: (path: string, kind: "file" | "directory") => void;
  onRequestRename: (path: string) => void;
  onCut: (path: string, kind: "file" | "directory") => void;
  onCopy: (path: string, kind: "file" | "directory") => void;
  onPaste: (destFolder: string) => void | Promise<void>;
  canDelete: boolean;
  canRename: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  compact?: boolean;
  /** Single source of truth for the currently-highlighted tree row. */
  treeSelection: { path: string; kind: "file" | "directory" } | null;
  /**
   * App-internal clipboard. Drives the "cut" dim-on-row visual: a row
   * (or a descendant of a cut folder) renders at reduced opacity until
   * the cut is pasted, cleared, or another entry is cut/copied.
   */
  clipboard: { path: string; kind: "file" | "directory"; op: "copy" | "cut" } | null;
  selectedRef?: React.RefObject<HTMLButtonElement | null>;
  /** Render an inline new-entry input as the first child of this directory. */
  newEntry: { parentPath: string; kind: "file" | "directory" } | null;
  onNewEntrySubmit: (name: string) => Promise<void>;
  onNewEntryCancel: () => void;
  /** When set to this row's path, render an inline rename input. */
  renamingPath: string | null;
  onRenameSubmit: (newName: string) => Promise<void>;
  onRenameCancel: () => void;
}

function TreeNode({
  entry,
  parentPath,
  depth,
  expandedPaths,
  dirContents,
  loadingPaths,
  onToggle,
  onOpenFile,
  onOpenFilePinned,
  onSelectRow,
  onRequestNewEntry,
  onRequestDelete,
  onRequestRename,
  onCut,
  onCopy,
  onPaste,
  canDelete,
  canRename,
  canCut,
  canCopy,
  canPaste,
  compact,
  treeSelection,
  clipboard,
  selectedRef,
  newEntry,
  onNewEntrySubmit,
  onNewEntryCancel,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
}: TreeNodeProps) {
  const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const isDir = entry.type === "directory";
  const isExpanded = isDir && expandedPaths.has(entryPath);
  // One unified tree selection — kind must match so a folder doesn't
  // accidentally light up a file row with the same path or vice versa.
  const isSelected =
    treeSelection?.path === entryPath && (treeSelection.kind === "directory") === isDir;
  // "Cut" visual: dim this row when it's the cut source or a descendant
  // of a cut folder, so the user can see what's about to move.
  const isCut =
    clipboard?.op === "cut" &&
    (clipboard.path === entryPath || entryPath.startsWith(`${clipboard.path}/`));
  const isLoading = isDir && loadingPaths.has(entryPath);
  const children = isDir ? dirContents.get(entryPath) : undefined;

  // Defer every menu action until after the menu's close transition
  // finishes — see `useDeferredMenuAction` for the why.
  const menu = useDeferredMenuAction();

  const indent = compact ? 12 : 16;
  const basePad = compact ? 4 : 8;

  const handleClick = () => {
    if (isDir) {
      onSelectRow(entryPath, "directory");
      onToggle(entryPath);
    } else {
      onSelectRow(entryPath, "file");
      onOpenFile(entryPath);
    }
  };

  const handleDoubleClick = () => {
    if (!isDir && onOpenFilePinned) {
      onOpenFilePinned(entryPath);
    }
  };

  const button = (
    <button
      ref={isSelected ? selectedRef : undefined}
      type="button"
      // data-band-active marks this button so the workspace-level
      // ⇧⌘E "focus Files" handler can target it from outside the
      // FileBrowser without depending on the brittle Tailwind class
      // pair below.
      data-band-active={isSelected ? "true" : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      // Stop the events Radix uses to detect a context-menu open from
      // bubbling to the outer FileBrowser-root ContextMenuTrigger:
      //   * `contextmenu` — fires on mouse right-click. Catches desktop.
      //   * `pointerdown` — what Radix arms its long-press timer on for
      //     touch. Without this, BOTH the inner per-row trigger AND the
      //     outer root trigger see the same pointerdown, each start
      //     their own 700ms timer, and 700ms later both menus open
      //     (the "two menus on long-press" issue).
      // We compose with Radix's own handlers on the same element via
      // asChild → Slot prop merging, so the inner Trigger's logic still
      // runs (it sees the pointerdown / right-click and opens this row's
      // menu); only propagation to the parent is killed.
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={`flex w-full items-center text-left select-none hover:bg-accent/50 [-webkit-touch-callout:none] ${
        compact ? "h-[28px] gap-1 pr-3 text-[13px]" : "h-[32px] gap-1.5 pr-4 text-[15px]"
      } ${
        isSelected
          ? "bg-blue-500/30 text-foreground outline outline-1 -outline-offset-1 outline-blue-400/60 hover:bg-blue-500/30 dark:bg-blue-500/40 dark:outline-blue-400/70 dark:hover:bg-blue-500/40"
          : ""
      } ${isCut ? "opacity-50" : ""}`}
      style={{ paddingLeft: `${depth * indent + basePad}px` }}
    >
      {/* Chevron / spacer */}
      {isDir ? (
        isExpanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}

      {/* Icon */}
      {isDir ? (
        isExpanded ? (
          <FolderOpen className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        ) : (
          <Folder className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
        )
      ) : (
        (() => {
          const FileIcon = getFileIcon(entry.name);
          return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
        })()
      )}

      {/* Name */}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </button>
  );

  const isRenaming = renamingPath === entryPath;

  // Sibling names used to validate the rename input — exclude the
  // current name so submitting the same name is treated as a cancel.
  const renameSiblings = (() => {
    const set = new Set<string>();
    const cached = dirContents.get(parentPath);
    if (cached) {
      for (const e of cached) {
        if (e.name !== entry.name) set.add(e.name);
      }
    }
    return set;
  })();

  // Every row exposes a right-click context menu. Directories get the
  // "New File" / "New Folder" actions scoped inside themselves; both
  // files and directories get "Rename" and a destructive "Delete" item.
  const row = isRenaming ? (
    // EntryNameInput computes its own `paddingLeft = depth * indent + basePad`
    // — passing the row's actual depth keeps the input row perfectly aligned
    // with sibling row buttons (which use the same formula). Wrapping it in
    // a padding div with `depth={0}` would double-apply `basePad`, shifting
    // the input ~4px to the right and giving it visibly less horizontal
    // room than the rest of the tree.
    <EntryNameInput
      key={`rename-${entryPath}`}
      kind={isDir ? "directory" : "file"}
      depth={depth}
      compact={compact}
      initialValue={entry.name}
      siblings={renameSiblings}
      placeholder={isDir ? "Folder name" : "File name"}
      onSubmit={onRenameSubmit}
      onCancel={onRenameCancel}
    />
  ) : (
    <ContextMenu
      // Right-clicking a row should select it before the menu opens, so
      // the user can see which row they're acting on (matters most for
      // folders, where "New File" creates inside the selected dir).
      onOpenChange={(open) => {
        if (open) onSelectRow(entryPath, isDir ? "directory" : "file");
      }}
    >
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      {/* Each item queues its action; `menu.flush` runs it once the
          menu finishes closing (and stops Radix from restoring focus
          to the trigger). See `useDeferredMenuAction` for the why. */}
      <ContextMenuContent onCloseAutoFocus={menu.flush}>
        {isDir && (
          <>
            <ContextMenuItem
              onSelect={() => menu.queue(() => onRequestNewEntry(entryPath, "file"))}
            >
              <FileIconLucide className="size-4" />
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => menu.queue(() => onRequestNewEntry(entryPath, "directory"))}
            >
              <FolderPlus className="size-4" />
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {canCut && (
          <ContextMenuItem
            onSelect={() => menu.queue(() => onCut(entryPath, isDir ? "directory" : "file"))}
          >
            <Scissors className="size-4" />
            Cut
          </ContextMenuItem>
        )}
        {canCopy && (
          <ContextMenuItem
            onSelect={() => menu.queue(() => onCopy(entryPath, isDir ? "directory" : "file"))}
          >
            <CopyIcon className="size-4" />
            Copy
          </ContextMenuItem>
        )}
        {/* Paste only appears on folder rows — pasting onto a file is
            ambiguous (do you mean its parent dir?). Users who want to
            paste alongside a file can right-click the parent folder or
            the empty tree area instead. */}
        {isDir && canPaste && (
          <ContextMenuItem onSelect={() => menu.queue(() => void onPaste(entryPath))}>
            <ClipboardPaste className="size-4" />
            Paste
          </ContextMenuItem>
        )}
        {(canCut || canCopy || (isDir && canPaste)) && (canRename || canDelete) && (
          <ContextMenuSeparator />
        )}
        {canRename && (
          <ContextMenuItem onSelect={() => menu.queue(() => onRequestRename(entryPath))}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
        )}
        {canDelete && (
          <ContextMenuItem
            variant="destructive"
            onSelect={() =>
              menu.queue(() => onRequestDelete(entryPath, isDir ? "directory" : "file"))
            }
          >
            <Trash2 className="size-4" />
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );

  const showInlineInput = newEntry?.parentPath === entryPath;

  return (
    <>
      {row}

      {/* Children — rendered when directory is expanded.
          Children come from the backend already sorted (folders first,
          then files). When the user is creating a new entry inline we
          slot the input where the eventual entry will land so the cursor
          appears in its final sort position:
            - new folder  → above all folder children (top of the list)
            - new file    → between folder children and file children
                            (top of the file section) */}
      {isExpanded &&
        (() => {
          const splitIdx = children?.findIndex((c) => c.type === "file") ?? -1;
          const folderChildren =
            splitIdx === -1 ? (children ?? []) : (children ?? []).slice(0, splitIdx);
          const fileChildren = splitIdx === -1 ? [] : (children ?? []).slice(splitIdx);
          const renderChild = (child: FileEntry) => (
            <TreeNode
              key={child.name}
              entry={child}
              parentPath={entryPath}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              dirContents={dirContents}
              loadingPaths={loadingPaths}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onOpenFilePinned={onOpenFilePinned}
              onSelectRow={onSelectRow}
              onRequestNewEntry={onRequestNewEntry}
              onRequestDelete={onRequestDelete}
              onRequestRename={onRequestRename}
              onCut={onCut}
              onCopy={onCopy}
              onPaste={onPaste}
              canDelete={canDelete}
              canRename={canRename}
              canCut={canCut}
              canCopy={canCopy}
              canPaste={canPaste}
              compact={compact}
              treeSelection={treeSelection}
              clipboard={clipboard}
              selectedRef={selectedRef}
              newEntry={newEntry}
              onNewEntrySubmit={onNewEntrySubmit}
              onNewEntryCancel={onNewEntryCancel}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
            />
          );
          const newEntryInput = showInlineInput ? (
            <EntryNameInput
              key={`new-${newEntry.kind}-${entryPath}`}
              kind={newEntry.kind}
              depth={depth + 1}
              compact={compact}
              siblings={new Set((children ?? []).map((c) => c.name))}
              onSubmit={onNewEntrySubmit}
              onCancel={onNewEntryCancel}
            />
          ) : null;
          return (
            <>
              {showInlineInput && newEntry.kind === "directory" && newEntryInput}
              {isLoading && !children?.length && (
                <div
                  className={`flex items-center text-muted-foreground/70 ${
                    compact ? "text-[13px]" : "text-[15px]"
                  }`}
                  style={{
                    paddingLeft: `${(depth + 1) * indent + basePad + 18}px`,
                    height: compact ? 28 : 32,
                  }}
                >
                  Loading…
                </div>
              )}
              {!isLoading && !showInlineInput && children && children.length === 0 && (
                <div
                  className={`flex items-center italic text-muted-foreground/50 ${
                    compact ? "text-[13px]" : "text-[15px]"
                  }`}
                  style={{
                    paddingLeft: `${(depth + 1) * indent + basePad + 18}px`,
                    height: compact ? 28 : 32,
                  }}
                >
                  Empty
                </div>
              )}
              {folderChildren.map(renderChild)}
              {showInlineInput && newEntry.kind === "file" && newEntryInput}
              {fileChildren.map(renderChild)}
            </>
          );
        })()}
    </>
  );
}

// ---------------------------------------------------------------------------
// FileBrowser — tree root, manages state & data fetching
// ---------------------------------------------------------------------------
export const FileBrowser = forwardRef<FileBrowserHandle, FileBrowserProps>(function FileBrowser(
  {
    workspaceId,
    onOpenFile,
    onOpenFilePinned,
    compact,
    selectedFile,
    onPathRenamed,
    onPathDeleted,
  },
  handleRef,
) {
  const adapter = useAdapter();

  // React state mirroring the module-level caches so changes trigger renders
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(getCachedExpanded(workspaceId)),
  );
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(
    () => new Map(getCachedContents(workspaceId)),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  // Inline new-entry input state. Only one new entry is shown at a time,
  // and it's tracked by its parent directory + kind.
  const [newEntry, setNewEntry] = useState<{
    parentPath: string;
    kind: "file" | "directory";
  } | null>(null);

  // Deletion confirmation state. When non-null, the dialog is shown.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    kind: "file" | "directory";
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Inline rename state. When set to a path, that row renders the
  // rename input in place of the usual file/folder button.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // App-internal clipboard for Cut / Copy / Paste. Persisted only in
  // memory (not the OS clipboard) so it can hold paths to entries we
  // own; the OS clipboard is reserved for actual text the user expects
  // to land in their system buffer.
  const [clipboard, setClipboard] = useState<{
    path: string;
    kind: "file" | "directory";
    op: "copy" | "cut";
  } | null>(null);

  // The currently-highlighted tree row. Tracks files AND folders in a
  // single source of truth so:
  //  * Only one row ever shows the selection highlight at a time.
  //  * Right-click (which doesn't open a file in the editor) can still
  //    mark a row as selected.
  //  * Right-click on the empty tree area can clear the highlight so
  //    the user understands new entries will land at the root.
  // The parent-owned `selectedFile` prop seeds this on mount and on
  // change, so opening a file via QuickOpen / tabs still highlights it.
  const [treeSelection, setTreeSelection] = useState<{
    path: string;
    kind: "file" | "directory";
  } | null>(() => (selectedFile ? { path: selectedFile, kind: "file" } : null));

  // Ref for scrolling the selected file into view
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Track workspace switches — restore cached state
  const prevWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspaceId) {
      prevWorkspaceRef.current = workspaceId;
      setExpandedPaths(new Set(getCachedExpanded(workspaceId)));
      setDirContents(new Map(getCachedContents(workspaceId)));
      setLoadingPaths(new Set());
      setNewEntry(null);
      // The selectedFile-sync effect below will re-seed treeSelection
      // when the parent passes a new open file for the next workspace.
      setTreeSelection(null);
      setPendingDelete(null);
      setDeleteError(null);
      setDeleteSubmitting(false);
      setRenamingPath(null);
      setClipboard(null);
    }
  }, [workspaceId]);

  // Mirror the parent-owned `selectedFile` into the tree selection
  // whenever it changes (e.g. user opened a file from QuickOpen or the
  // tabs strip). Don't fight an active folder selection when the parent
  // re-renders with the same selectedFile — only react to actual changes.
  useEffect(() => {
    if (selectedFile) {
      setTreeSelection({ path: selectedFile, kind: "file" });
    }
  }, [selectedFile]);

  const handleSelectRow = useCallback((path: string, kind: "file" | "directory") => {
    setTreeSelection({ path, kind });
  }, []);

  const clearTreeSelection = useCallback(() => {
    setTreeSelection(null);
  }, []);

  // ------- Fetch helpers -------
  const fetchDir = useCallback(
    async (dirPath: string, opts?: { force?: boolean }): Promise<void> => {
      if (!adapter.listWorkspaceFiles) return;

      const cache = getCachedContents(workspaceId);
      if (!opts?.force && cache.has(dirPath)) {
        // Already fetched — make sure React state includes it
        setDirContents((prev) => (prev.has(dirPath) ? prev : new Map(cache)));
        return;
      }

      setLoadingPaths((prev) => new Set(prev).add(dirPath));

      try {
        const result = await adapter.listWorkspaceFiles(workspaceId, dirPath);
        cache.set(dirPath, result.entries);
        setDirContents(new Map(cache));
      } catch {
        // Individual directory failures are silently ignored — the folder
        // will simply show as empty or won't expand.
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [adapter, workspaceId],
  );

  // Load root on mount / workspace change
  useEffect(() => {
    fetchDir("");
  }, [fetchDir]);

  // ------- External file-change invalidation -------
  //
  // The server watches each workspace's worktree and emits a `file-change`
  // event with the parent directory of any touched path. We invalidate
  // only directories the user has already visited (i.e. live in the cache):
  //  * If the directory is expanded, a force-refetch updates the tree in
  //    place.
  //  * If the directory is collapsed but cached, we still re-fetch so the
  //    next expand shows the current contents instead of a stale snapshot.
  //  * Paths the user has never visited stay out of cache and are fetched
  //    on first expand — no invalidation needed.
  useEffect(() => {
    if (!adapter.subscribeFileChanges) return;
    const unsubscribe = adapter.subscribeFileChanges(workspaceId, (changedPath) => {
      // `getCachedContents` is a stable module-level helper (defined at
      // the top of this file), so it doesn't need to be in the effect's
      // dependency array.
      const cache = getCachedContents(workspaceId);
      if (!cache.has(changedPath)) return;
      void fetchDir(changedPath, { force: true });
    });
    return unsubscribe;
    // `fetchDir` is wrapped in `useCallback` above with `[adapter,
    // workspaceId]`, so it's stable across renders of this component —
    // the effect only tears the subscription down on workspace switch,
    // not on every render.
  }, [adapter, workspaceId, fetchDir]);

  // ------- Auto-expand to selected file -------
  const prevSelectedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!selectedFile || selectedFile === prevSelectedRef.current) {
      prevSelectedRef.current = selectedFile;
      return;
    }
    prevSelectedRef.current = selectedFile;

    // Compute all parent directories that need to be expanded
    const parts = selectedFile.split("/");
    const dirsToExpand: string[] = [""];
    for (let i = 0; i < parts.length - 1; i++) {
      dirsToExpand.push(parts.slice(0, i + 1).join("/"));
    }

    const cached = getCachedExpanded(workspaceId);
    let changed = false;
    for (const dir of dirsToExpand) {
      if (!cached.has(dir)) {
        cached.add(dir);
        changed = true;
      }
    }

    if (changed) {
      expandedStateCache.set(workspaceId, new Set(cached));
      setExpandedPaths(new Set(cached));
    }

    // Fetch any directories whose contents haven't been loaded yet
    for (const dir of dirsToExpand) {
      fetchDir(dir);
    }
  }, [selectedFile, workspaceId, fetchDir]);

  // Scroll to selected file after tree updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll after tree settles for new selection
  useEffect(() => {
    if (selectedFile && selectedRef.current) {
      // Small delay so the DOM has settled after lazy-loaded children render
      const timer = setTimeout(() => {
        selectedRef.current?.scrollIntoView({ block: "nearest" });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedFile, dirContents]);

  // ------- Toggle expand/collapse -------
  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        expandedStateCache.set(workspaceId, new Set(next));
        return next;
      });

      // Fetch if not yet loaded
      fetchDir(dirPath);
    },
    [workspaceId, fetchDir],
  );

  // ------- New file / folder flow -------
  const ensureDirExpanded = useCallback(
    async (dirPath: string) => {
      // Make sure the directory is expanded and its contents are loaded
      // before we show the inline input inside it.
      const cached = getCachedExpanded(workspaceId);
      if (!cached.has(dirPath)) {
        cached.add(dirPath);
        expandedStateCache.set(workspaceId, new Set(cached));
        setExpandedPaths(new Set(cached));
      }
      await fetchDir(dirPath);
    },
    [workspaceId, fetchDir],
  );

  const requestNewEntry = useCallback(
    (parentPath: string, kind: "file" | "directory") => {
      void ensureDirExpanded(parentPath);
      setNewEntry({ parentPath, kind });
    },
    [ensureDirExpanded],
  );

  const cancelNewEntry = useCallback(() => {
    setNewEntry(null);
  }, []);

  const submitNewEntry = useCallback(
    async (name: string) => {
      if (!newEntry) return;
      const fullPath = newEntry.parentPath ? `${newEntry.parentPath}/${name}` : name;

      if (newEntry.kind === "file") {
        if (!adapter.createWorkspaceFile) {
          throw new Error("Creating files is not supported");
        }
        await adapter.createWorkspaceFile(workspaceId, fullPath);
      } else {
        if (!adapter.createWorkspaceDirectory) {
          throw new Error("Creating folders is not supported");
        }
        await adapter.createWorkspaceDirectory(workspaceId, fullPath);
      }

      // Refresh the parent directory so the new entry shows up. Force
      // a refetch to bypass the cache.
      await fetchDir(newEntry.parentPath, { force: true });

      // Close the input
      setNewEntry(null);

      // If we created a file, open it for editing. For folders, expand
      // them and mark them as the active selection so subsequent
      // "New File" actions land inside the newly-created folder.
      if (newEntry.kind === "file") {
        setTreeSelection({ path: fullPath, kind: "file" });
        onOpenFile(fullPath);
      } else {
        const cached = getCachedExpanded(workspaceId);
        if (!cached.has(fullPath)) {
          cached.add(fullPath);
          expandedStateCache.set(workspaceId, new Set(cached));
          setExpandedPaths(new Set(cached));
        }
        setTreeSelection({ path: fullPath, kind: "directory" });
      }
    },
    [adapter, newEntry, fetchDir, onOpenFile, workspaceId],
  );

  // ------- Delete flow -------
  const canDelete = Boolean(adapter.deleteWorkspacePath);

  const requestDelete = useCallback((path: string, kind: "file" | "directory") => {
    setDeleteError(null);
    setPendingDelete({ path, kind });
  }, []);

  const cancelDelete = useCallback(() => {
    if (deleteSubmitting) return;
    setPendingDelete(null);
    setDeleteError(null);
  }, [deleteSubmitting]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !adapter.deleteWorkspacePath) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await adapter.deleteWorkspacePath(workspaceId, pendingDelete.path);

      // Drop cached contents for the deleted path (if it was a directory)
      // and any descendants, so they aren't resurrected when the user
      // re-expands a parent.
      const cache = getCachedContents(workspaceId);
      const prefix = `${pendingDelete.path}/`;
      cache.delete(pendingDelete.path);
      for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix)) cache.delete(key);
      }

      // Collapse and drop the expanded-state for any descendants
      const cachedExpanded = getCachedExpanded(workspaceId);
      cachedExpanded.delete(pendingDelete.path);
      for (const key of Array.from(cachedExpanded)) {
        if (key.startsWith(prefix)) cachedExpanded.delete(key);
      }
      expandedStateCache.set(workspaceId, new Set(cachedExpanded));
      setExpandedPaths(new Set(cachedExpanded));

      // If the deleted entry (or one of its descendants) was the
      // currently-selected tree row, clear it so the toolbar doesn't try
      // to create new entries inside a missing directory.
      setTreeSelection((prev) => {
        if (prev == null) return prev;
        if (prev.path === pendingDelete.path || prev.path.startsWith(prefix)) {
          return null;
        }
        return prev;
      });

      // Cancel any in-flight inline new-entry input whose parent was
      // inside the deleted tree.
      setNewEntry((prev) => {
        if (!prev) return prev;
        if (prev.parentPath === pendingDelete.path || prev.parentPath.startsWith(prefix)) {
          return null;
        }
        return prev;
      });

      // Refresh the parent so the row disappears from the tree.
      const idx = pendingDelete.path.lastIndexOf("/");
      const parent = idx === -1 ? "" : pendingDelete.path.slice(0, idx);
      await fetchDir(parent, { force: true });

      // Notify the host (CodeBrowserView) so it can drop matching tabs.
      onPathDeleted?.(pendingDelete.path, pendingDelete.kind);

      setPendingDelete(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDeleteError(message);
    } finally {
      setDeleteSubmitting(false);
    }
  }, [adapter, pendingDelete, fetchDir, workspaceId, onPathDeleted]);

  // ------- Rename flow -------
  const canRename = Boolean(adapter.renameWorkspacePath);

  const requestRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const submitRename = useCallback(
    async (newName: string) => {
      if (renamingPath == null || !adapter.renameWorkspacePath) return;
      const oldPath = renamingPath;
      const slashIdx = oldPath.lastIndexOf("/");
      const parent = slashIdx === -1 ? "" : oldPath.slice(0, slashIdx);
      const newPath = parent ? `${parent}/${newName}` : newName;

      const result = await adapter.renameWorkspacePath(workspaceId, oldPath, newPath);

      // Rewrite path-keyed caches: anything sitting in the renamed
      // subtree needs to be moved to its new prefix.
      const cache = getCachedContents(workspaceId);
      const oldPrefix = `${oldPath}/`;
      const newKeys = new Map<string, FileEntry[]>();
      for (const [key, value] of cache.entries()) {
        if (key === oldPath) {
          newKeys.set(newPath, value);
        } else if (key.startsWith(oldPrefix)) {
          newKeys.set(newPath + key.slice(oldPath.length), value);
        } else {
          newKeys.set(key, value);
        }
      }
      cache.clear();
      for (const [k, v] of newKeys) cache.set(k, v);

      const cachedExpanded = getCachedExpanded(workspaceId);
      const newExpanded = new Set<string>();
      for (const key of cachedExpanded) {
        if (key === oldPath) {
          newExpanded.add(newPath);
        } else if (key.startsWith(oldPrefix)) {
          newExpanded.add(newPath + key.slice(oldPath.length));
        } else {
          newExpanded.add(key);
        }
      }
      expandedStateCache.set(workspaceId, newExpanded);
      setExpandedPaths(new Set(newExpanded));

      // Update tree selection if it was inside the renamed subtree.
      setTreeSelection((prev) => {
        if (prev == null) return prev;
        if (prev.path === oldPath) return { ...prev, path: newPath };
        if (prev.path.startsWith(oldPrefix)) {
          return { ...prev, path: newPath + prev.path.slice(oldPath.length) };
        }
        return prev;
      });

      // Drop any pending new-entry input rooted in the renamed subtree
      // (its parentPath is now stale).
      setNewEntry((prev) => {
        if (!prev) return prev;
        if (prev.parentPath === oldPath || prev.parentPath.startsWith(oldPrefix)) {
          return null;
        }
        return prev;
      });

      // Refresh the parent directory listing so the row reflects the new name.
      await fetchDir(parent, { force: true });

      setRenamingPath(null);

      // Tell the host to update open tabs / editor state for the rename.
      onPathRenamed?.(oldPath, newPath, result.kind);
    },
    [adapter, renamingPath, fetchDir, onPathRenamed, workspaceId],
  );

  // Derive the implicit target for "New File" / "New Folder" actions
  // initiated from the parent toolbar (i.e. callers that don't pass an
  // explicit parent). Priority: selected folder → selected file's parent
  // directory → workspace root. The right-click-on-empty-area flow
  // clears `treeSelection`, which intentionally falls through to root.
  const resolveDefaultTarget = useCallback((): string => {
    if (treeSelection?.kind === "directory") return treeSelection.path;
    if (treeSelection?.kind === "file") {
      const idx = treeSelection.path.lastIndexOf("/");
      return idx === -1 ? "" : treeSelection.path.slice(0, idx);
    }
    return "";
  }, [treeSelection]);

  // ------- Cut / Copy / Paste -------
  const canCutCopy = Boolean(adapter.renameWorkspacePath);
  const canCopyOp = Boolean(adapter.copyWorkspacePath);
  const canPaste = Boolean(
    clipboard &&
      ((clipboard.op === "copy" && adapter.copyWorkspacePath) ||
        (clipboard.op === "cut" && adapter.renameWorkspacePath)),
  );

  const cutPath = useCallback((path: string, kind: "file" | "directory") => {
    setClipboard({ path, kind, op: "cut" });
  }, []);

  const copyPath = useCallback((path: string, kind: "file" | "directory") => {
    setClipboard({ path, kind, op: "copy" });
  }, []);

  // Build a "copy"-suffixed name unique within the destination folder.
  // Mirrors Finder/Explorer behaviour: `foo.txt` → `foo copy.txt`,
  // then `foo copy 2.txt`, `foo copy 3.txt`, ...
  const uniqueCopyName = useCallback(
    (baseName: string, destFolder: string, kind: "file" | "directory"): string => {
      const siblings = new Set(
        (getCachedContents(workspaceId).get(destFolder) ?? []).map((e) => e.name),
      );
      if (!siblings.has(baseName)) return baseName;

      // Split extension only for files; preserve dotfile / dir names whole.
      const dotIdx = kind === "file" ? baseName.lastIndexOf(".") : -1;
      const stem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
      const ext = dotIdx > 0 ? baseName.slice(dotIdx) : "";

      let n = 1;
      while (true) {
        const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
        if (!siblings.has(candidate)) return candidate;
        n += 1;
      }
    },
    [workspaceId],
  );

  /**
   * Paste the current clipboard entry into `destFolder` (workspace
   * root if empty string). For copy operations, the entry's name is
   * auto-suffixed with "copy" if it would collide. For cut operations,
   * we surface a collision as an error (matching rename semantics).
   */
  const pasteInto = useCallback(
    async (destFolder: string): Promise<void> => {
      if (!clipboard) return;
      const sourcePath = clipboard.path;
      const sourceParent = (() => {
        const idx = sourcePath.lastIndexOf("/");
        return idx === -1 ? "" : sourcePath.slice(0, idx);
      })();
      const baseName = sourcePath.slice(sourceParent.length === 0 ? 0 : sourceParent.length + 1);

      // Refuse to paste a directory into itself or any descendant of
      // itself — the backend rejects this too, but failing fast keeps
      // the cached filesystem state consistent.
      if (clipboard.kind === "directory") {
        if (destFolder === sourcePath || destFolder.startsWith(`${sourcePath}/`)) {
          return;
        }
      }

      if (clipboard.op === "copy") {
        if (!adapter.copyWorkspacePath) return;
        const newName = uniqueCopyName(baseName, destFolder, clipboard.kind);
        const destPath = destFolder ? `${destFolder}/${newName}` : newName;
        await adapter.copyWorkspacePath(workspaceId, sourcePath, destPath);
        await fetchDir(destFolder, { force: true });
        setTreeSelection({ path: destPath, kind: clipboard.kind });
      } else {
        // cut → move. If the destination is the same as the source's
        // current parent the move is a no-op; bail out to avoid an
        // "already exists" error from the backend.
        if (destFolder === sourceParent) return;
        if (!adapter.renameWorkspacePath) return;
        const destPath = destFolder ? `${destFolder}/${baseName}` : baseName;
        const result = await adapter.renameWorkspacePath(workspaceId, sourcePath, destPath);

        // Patch the path-keyed caches: anything in the moved subtree
        // needs its key rewritten to the new prefix.
        const cache = getCachedContents(workspaceId);
        const oldPrefix = `${sourcePath}/`;
        const remapped = new Map<string, FileEntry[]>();
        for (const [key, value] of cache.entries()) {
          if (key === sourcePath) {
            remapped.set(destPath, value);
          } else if (key.startsWith(oldPrefix)) {
            remapped.set(destPath + key.slice(sourcePath.length), value);
          } else {
            remapped.set(key, value);
          }
        }
        cache.clear();
        for (const [k, v] of remapped) cache.set(k, v);

        const cachedExpanded = getCachedExpanded(workspaceId);
        const remappedExpanded = new Set<string>();
        for (const key of cachedExpanded) {
          if (key === sourcePath) {
            remappedExpanded.add(destPath);
          } else if (key.startsWith(oldPrefix)) {
            remappedExpanded.add(destPath + key.slice(sourcePath.length));
          } else {
            remappedExpanded.add(key);
          }
        }
        expandedStateCache.set(workspaceId, remappedExpanded);
        setExpandedPaths(new Set(remappedExpanded));

        // Both source-parent and destination need a re-fetch so the
        // row appears in its new home and vanishes from its old one.
        await Promise.all([
          fetchDir(sourceParent, { force: true }),
          fetchDir(destFolder, { force: true }),
        ]);

        // Notify the host so it can keep open tabs / editor state
        // pointed at the moved path — identical to a rename.
        onPathRenamed?.(sourcePath, destPath, result.kind);

        setTreeSelection({ path: destPath, kind: clipboard.kind });
        // Cut is one-shot. Clear the clipboard so a subsequent ⌘V
        // doesn't try to re-move an already-moved entry.
        setClipboard(null);
      }
    },
    [adapter, clipboard, fetchDir, onPathRenamed, uniqueCopyName, workspaceId],
  );

  // ------- Imperative handle for parent toolbars -------
  useImperativeHandle(
    handleRef,
    () => ({
      startNewFile(parentPath) {
        requestNewEntry(parentPath ?? resolveDefaultTarget(), "file");
      },
      startNewFolder(parentPath) {
        requestNewEntry(parentPath ?? resolveDefaultTarget(), "directory");
      },
    }),
    [requestNewEntry, resolveDefaultTarget],
  );

  // Defer the root-area context menu's items the same way the per-row
  // menu does — the menu's FocusScope would otherwise eat the inline
  // new-entry input's focus on mount. Declared up here (before the
  // early return below) so the hook call order is stable.
  const rootMenu = useDeferredMenuAction();

  // ------- Render -------
  if (!adapter.listWorkspaceFiles) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        File browsing not supported
      </div>
    );
  }

  const rootEntries = dirContents.get("") ?? [];
  const rootLoading = loadingPaths.has("");
  const rootSiblings = new Set(rootEntries.map((e) => e.name));
  const showRootInput = newEntry?.parentPath === "";

  // Keyboard shortcuts. We attach to the outer div so they only fire
  // when focus is somewhere inside the file tree — the editor's own
  // ⌘C / ⌘X / ⌘V handlers stay in charge when the user is typing.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Bail when focus is in an inline input (rename / new-entry).
    // Otherwise Backspace would try to delete the row instead of a
    // character, and ⌘C would copy the row's path instead of the text
    // the user has selected inside the input.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }

    // Delete / Backspace (no modifiers) → delete the selected row.
    // Matches VS Code's Explorer behaviour: both keys trigger the same
    // action, since macOS keyboards label Backspace as "Delete" and
    // many users reach for that key first.
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      if (!treeSelection || !canDelete) return;
      e.preventDefault();
      requestDelete(treeSelection.path, treeSelection.kind);
      return;
    }

    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const key = e.key.toLowerCase();

    if (key === "c") {
      if (!treeSelection || !canCutCopy) return;
      e.preventDefault();
      copyPath(treeSelection.path, treeSelection.kind);
      return;
    }
    if (key === "x") {
      if (!treeSelection || !canCutCopy) return;
      e.preventDefault();
      cutPath(treeSelection.path, treeSelection.kind);
      return;
    }
    if (key === "v") {
      if (!canPaste) return;
      e.preventDefault();
      // Paste into the folder under the cursor (selected folder), the
      // parent of the selected file, or the workspace root — same
      // priority order resolveDefaultTarget uses for "New File…".
      void pasteInto(resolveDefaultTarget());
    }
  };

  // The empty area below the tree captures right-clicks targeting the
  // root, so users can quickly create at the top level even when the
  // tree itself is dense or fully scrolled.
  return (
    <div className="flex h-full flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      <ContextMenu
        // Right-clicking the empty tree area clears any active row
        // selection so the user can see that the new entry will land at
        // the workspace root. Radix's nested ContextMenu triggers stop
        // propagation, so right-clicks on individual row buttons fire
        // the per-row menu only and never reach this outer onOpenChange.
        onOpenChange={(open) => {
          if (open) clearTreeSelection();
        }}
      >
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto py-1 pl-px">
            {(() => {
              // rootEntries is pre-sorted folders-first; slot the new
              // entry input at its natural landing position so the user
              // sees the cursor where the new row will actually appear:
              //   - new folder  → at the top (before any folder rows)
              //   - new file    → between the folder section and the
              //                   file section (top of the file rows)
              const rootSplitIdx = rootEntries.findIndex((e) => e.type === "file");
              const rootFolders =
                rootSplitIdx === -1 ? rootEntries : rootEntries.slice(0, rootSplitIdx);
              const rootFiles = rootSplitIdx === -1 ? [] : rootEntries.slice(rootSplitIdx);
              const renderRow = (entry: FileEntry) => (
                <TreeNode
                  key={entry.name}
                  entry={entry}
                  parentPath=""
                  depth={0}
                  expandedPaths={expandedPaths}
                  dirContents={dirContents}
                  loadingPaths={loadingPaths}
                  onToggle={toggleExpand}
                  onOpenFile={onOpenFile}
                  onOpenFilePinned={onOpenFilePinned}
                  onSelectRow={handleSelectRow}
                  onRequestNewEntry={requestNewEntry}
                  onRequestDelete={requestDelete}
                  onRequestRename={requestRename}
                  onCut={cutPath}
                  onCopy={copyPath}
                  onPaste={pasteInto}
                  canDelete={canDelete}
                  canRename={canRename}
                  canCut={canCutCopy}
                  canCopy={canCopyOp}
                  canPaste={canPaste}
                  compact={compact}
                  treeSelection={treeSelection}
                  clipboard={clipboard}
                  selectedRef={selectedRef}
                  newEntry={newEntry}
                  onNewEntrySubmit={submitNewEntry}
                  onNewEntryCancel={cancelNewEntry}
                  renamingPath={renamingPath}
                  onRenameSubmit={submitRename}
                  onRenameCancel={cancelRename}
                />
              );
              const rootInput = showRootInput ? (
                <EntryNameInput
                  key={`new-${newEntry.kind}-root`}
                  kind={newEntry.kind}
                  depth={0}
                  compact={compact}
                  siblings={rootSiblings}
                  onSubmit={submitNewEntry}
                  onCancel={cancelNewEntry}
                />
              ) : null;
              return (
                <>
                  {showRootInput && newEntry.kind === "directory" && rootInput}
                  {rootLoading && rootEntries.length === 0 && !showRootInput && (
                    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                      Loading…
                    </div>
                  )}
                  {!rootLoading && rootEntries.length === 0 && !showRootInput && (
                    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                      Empty directory
                    </div>
                  )}
                  {rootFolders.map(renderRow)}
                  {showRootInput && newEntry.kind === "file" && rootInput}
                  {rootFiles.map(renderRow)}
                </>
              );
            })()}
            {/* Filler so the right-click area extends to the bottom of the panel */}
            <div className="min-h-[40px] flex-1" />
          </div>
        </ContextMenuTrigger>
        {/* Each item queues its action; `rootMenu.flush` runs it once
            the menu has finished closing — see `useDeferredMenuAction`. */}
        <ContextMenuContent onCloseAutoFocus={rootMenu.flush}>
          <ContextMenuItem onSelect={() => rootMenu.queue(() => requestNewEntry("", "file"))}>
            <FileIconLucide className="size-4" />
            New File
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => rootMenu.queue(() => requestNewEntry("", "directory"))}>
            <FolderPlus className="size-4" />
            New Folder
          </ContextMenuItem>
          {canPaste && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => rootMenu.queue(() => void pasteInto(""))}>
                <ClipboardPaste className="size-4" />
                Paste
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) cancelDelete();
        }}
      >
        <DialogContent className="sm:max-w-[425px]" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>
              Delete {pendingDelete?.kind === "directory" ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{pendingDelete?.path}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            {pendingDelete?.kind === "directory" && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
                <span>
                  The folder and all of its contents will be deleted from disk. This cannot be
                  undone.
                </span>
              </div>
            )}
            {pendingDelete?.kind === "file" && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
                <span>The file will be deleted from disk. This cannot be undone.</span>
              </div>
            )}
            {deleteError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>{deleteError}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelDelete} disabled={deleteSubmitting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteSubmitting}
            >
              {deleteSubmitting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
