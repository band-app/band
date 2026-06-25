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
import { AlertTriangle, ChevronDown, ChevronRight, ClipboardCopy, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import { useDeferredMenuAction } from "../hooks/use-deferred-menu-action";
import { buildFileTree, type FileTreeNode } from "../lib/build-file-tree";
import { getFileIcon, getFolderIcon } from "../lib/file-icon";
import { joinWorkspacePath } from "../lib/workspace-path";
import type { FileStatus } from "../types";
import { FileStatusBadge } from "./FileStatusBadge";

interface ChangesFileTreeProps {
  fileStatuses: Record<string, FileStatus>;
  onSelectFile: (filePath: string) => void;
  activeFile?: string | null;
  /**
   * Revert every path in the list — used by the right-click "Reset
   * changes" action. For a folder right-click the tree collects all
   * descendant file paths and passes them all at once. Pass `undefined`
   * (or leave the prop unset) to hide the menu item entirely.
   */
  onRevertPaths?: (paths: string[]) => void | Promise<void>;
  /**
   * Absolute filesystem path of the workspace root. When provided, the
   * right-click menu offers "Copy absolute path"; when omitted (e.g. still
   * loading) that item is hidden but "Copy relative path" remains.
   */
  workspacePath?: string;
}

interface ChangesTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (filePath: string) => void;
  onRequestReset: (node: FileTreeNode) => void;
  canReset: boolean;
  workspacePath?: string;
  activeFile?: string | null;
}

/**
 * Collect every leaf (file) path inside this subtree. For a leaf node
 * the result is just the node's own path; for a directory it's a flat
 * list of all descendants. Used to expand a folder right-click into the
 * full set of files to revert.
 */
function collectLeafPaths(node: FileTreeNode): string[] {
  if (!node.children) return [node.path];
  return node.children.flatMap(collectLeafPaths);
}

function ChangesTreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  onSelectFile,
  onRequestReset,
  canReset,
  workspacePath,
  activeFile,
}: ChangesTreeNodeProps) {
  const isDir = node.children !== undefined;
  const isExpanded = isDir && expandedPaths.has(node.path);
  const isActive = !isDir && activeFile === node.path;
  const btnRef = useRef<HTMLButtonElement>(null);

  // Defer the context-menu action until the menu finishes closing — see
  // useDeferredMenuAction for the full reasoning. Without this the
  // confirmation dialog would mount while Radix's FocusScope is still
  // alive and lose focus management.
  const menu = useDeferredMenuAction();

  // Auto-scroll the active file into view within the sidebar
  useEffect(() => {
    if (isActive && btnRef.current) {
      btnRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isActive]);

  const handleClick = () => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelectFile(node.path);
    }
  };

  const button = (
    <button
      ref={isActive ? btnRef : undefined}
      type="button"
      // data-band-active marks this button so the workspace-level
      // ⇧⌘G "focus Changes" handler can target it from outside the
      // file tree.
      data-band-active={isActive ? "true" : undefined}
      data-testid={`changes-tree__row--${node.path}`}
      onClick={handleClick}
      // Suppress the iOS text-selection / callout that fires on
      // long-press alongside the Radix contextmenu event.
      className={`flex h-[28px] w-full select-none items-center gap-1 pr-3 text-left text-[13px] hover:bg-accent/50 [-webkit-touch-callout:none] ${
        isActive
          ? "bg-blue-500/30 text-foreground outline outline-1 -outline-offset-1 outline-blue-400/60 hover:bg-blue-500/30 dark:bg-blue-500/40 dark:outline-blue-400/70 dark:hover:bg-blue-500/40"
          : ""
      }`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
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
      {isDir
        ? (() => {
            const folderName = node.name.includes("/") ? node.name.split("/").pop()! : node.name;
            const FolderIcon = getFolderIcon(folderName, isExpanded);
            return <FolderIcon className="size-4 shrink-0" />;
          })()
        : (() => {
            // Use the last segment of the node name for icon detection
            const fileName = node.name.includes("/") ? node.name.split("/").pop()! : node.name;
            const FileIcon = getFileIcon(fileName);
            return <FileIcon className="size-4 shrink-0" />;
          })()}

      {/* Name */}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>

      {/* Status badge for files */}
      {!isDir && node.status && <FileStatusBadge status={node.status} />}
    </button>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={menu.flush}>
          <ContextMenuItem
            data-testid="changes-tree__copy-relative-path"
            onSelect={() => menu.queue(() => void writeClipboardText(node.path))}
          >
            <ClipboardCopy className="size-4" />
            Copy relative path
          </ContextMenuItem>
          {workspacePath && (
            <ContextMenuItem
              data-testid="changes-tree__copy-absolute-path"
              onSelect={() =>
                menu.queue(
                  () => void writeClipboardText(joinWorkspacePath(workspacePath, node.path)),
                )
              }
            >
              <ClipboardCopy className="size-4" />
              Copy absolute path
            </ContextMenuItem>
          )}
          {canReset && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => menu.queue(() => onRequestReset(node))}
              >
                <RotateCcw className="size-4" />
                Reset changes
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Children — rendered when directory is expanded */}
      {isExpanded &&
        node.children?.map((child) => (
          <ChangesTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
            onRequestReset={onRequestReset}
            canReset={canReset}
            workspacePath={workspacePath}
            activeFile={activeFile}
          />
        ))}
    </>
  );
}

/**
 * Collects all directory paths from a file tree (for initial expanded state).
 */
function collectDirPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.children) {
      paths.push(node.path);
      paths.push(...collectDirPaths(node.children));
    }
  }
  return paths;
}

export function ChangesFileTree({
  fileStatuses,
  onSelectFile,
  activeFile,
  onRevertPaths,
  workspacePath,
}: ChangesFileTreeProps) {
  const tree = useMemo(() => buildFileTree(fileStatuses), [fileStatuses]);

  // Track every directory path we've ever seen. Used so newly-appearing
  // directories default to expanded, while preserving the user's explicit
  // collapses for paths that were already in the tree on a previous render
  // (including paths that temporarily disappeared, e.g. when switching the
  // changes selector between branches with different file sets).
  //
  // `useRef`'s initial value is only consumed on the first render; later
  // updates flow through the `useEffect` below. The `expandedPaths`
  // initialiser copies the set rather than aliasing it so a future
  // mutation of `seenDirPathsRef.current` can't accidentally bleed into
  // expansion state.
  const seenDirPathsRef = useRef<Set<string>>(new Set(collectDirPaths(tree)));
  // All directories expanded by default (changed-file sets are typically small).
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(seenDirPathsRef.current),
  );

  // When the tree changes, expand any directories we haven't seen before
  // and remember them for future renders. Directories the user has
  // explicitly collapsed stay collapsed — we never overwrite an existing
  // entry — so switching between branches (including one with no changes
  // at all) doesn't reset the expansion state.
  // `seenDirPathsRef` accumulates every directory path observed during the
  // workspace session and is intentionally never pruned — that's how user
  // collapses survive paths that disappear from the tree (e.g. switching
  // selectors). Memory cost is negligible because changed-file sets are
  // small; if a future "reset expansion to defaults" action is added it
  // must clear this ref alongside `expandedPaths`.
  useEffect(() => {
    const currentDirs = collectDirPaths(tree);
    const newDirs = currentDirs.filter((p) => !seenDirPathsRef.current.has(p));
    if (newDirs.length === 0) return;
    for (const p of newDirs) seenDirPathsRef.current.add(p);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const p of newDirs) next.add(p);
      return next;
    });
  }, [tree]);

  const handleToggle = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // ---------- Reset-changes flow ----------
  const [pendingReset, setPendingReset] = useState<{
    /** Display label — file name for a leaf, folder path for a directory. */
    label: string;
    /** Whether the user right-clicked a folder (affects dialog copy). */
    isFolder: boolean;
    /** Every leaf path under the right-clicked node. */
    paths: string[];
    /** Status for single-file resets — drives the precise warning text. */
    status?: FileStatus;
  } | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  const handleRequestReset = useCallback((node: FileTreeNode) => {
    const paths = collectLeafPaths(node);
    if (paths.length === 0) return;
    if (node.children) {
      setPendingReset({
        label: node.path,
        isFolder: true,
        paths,
      });
    } else {
      setPendingReset({
        label: node.path,
        isFolder: false,
        paths: [node.path],
        status: node.status,
      });
    }
  }, []);

  const cancelReset = useCallback(() => {
    if (resetSubmitting) return;
    setPendingReset(null);
  }, [resetSubmitting]);

  const confirmReset = useCallback(async () => {
    if (!pendingReset || !onRevertPaths) return;
    setResetSubmitting(true);
    try {
      await onRevertPaths(pendingReset.paths);
      setPendingReset(null);
    } finally {
      setResetSubmitting(false);
    }
  }, [pendingReset, onRevertPaths]);

  const canReset = Boolean(onRevertPaths);

  // When there are no changes the tree is empty — render nothing so the
  // surrounding panel layout stays stable rather than collapsing or
  // showing a placeholder that competes with the "No changes" message in
  // the diff area.

  return (
    <>
      {tree.map((node) => (
        <ChangesTreeNode
          key={node.path}
          node={node}
          depth={0}
          expandedPaths={expandedPaths}
          onToggle={handleToggle}
          onSelectFile={onSelectFile}
          onRequestReset={handleRequestReset}
          canReset={canReset}
          workspacePath={workspacePath}
          activeFile={activeFile}
        />
      ))}

      <Dialog
        open={pendingReset !== null}
        onOpenChange={(open) => {
          if (!open) cancelReset();
        }}
      >
        <DialogContent className="sm:max-w-[425px]" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Reset changes</DialogTitle>
            <DialogDescription>
              {pendingReset?.isFolder ? (
                <>
                  Reset changes for all {pendingReset.paths.length} file
                  {pendingReset.paths.length === 1 ? "" : "s"} inside{" "}
                  <strong className="break-all">{pendingReset.label}</strong>?
                </>
              ) : (
                <>
                  Reset changes to <strong className="break-all">{pendingReset?.label}</strong>?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-yellow-500" />
              <span>
                {pendingReset?.isFolder
                  ? "Every change inside this folder will be discarded. Added files are deleted, deleted files are restored, modifications are reverted. This action cannot be undone."
                  : resetDescriptionForFile(pendingReset?.status)}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelReset} disabled={resetSubmitting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmReset()}
              disabled={resetSubmitting}
            >
              {resetSubmitting ? "Resetting…" : "Reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function resetDescriptionForFile(status: FileStatus | undefined): string {
  switch (status) {
    case "A":
      return "This file was added and will be deleted. This action cannot be undone.";
    case "U":
      return "This file is untracked and will be deleted. This action cannot be undone.";
    case "D":
      return "This file was deleted and will be restored. This action cannot be undone.";
    case "M":
      return "All changes to this file will be discarded. This action cannot be undone.";
    case "R":
      return "This file was renamed and will be restored to its original path. This action cannot be undone.";
    default:
      return "All changes to this file will be discarded. This action cannot be undone.";
  }
}
