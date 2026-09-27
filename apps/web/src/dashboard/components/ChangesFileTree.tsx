import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@band-app/ui";
import { ChevronDown, ChevronRight, ClipboardCopy } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import { useDeferredMenuAction } from "../hooks/use-deferred-menu-action";
import { buildFileTree, type FileTreeNode } from "../lib/build-file-tree";
import { getFileIcon, getFolderIcon } from "../lib/file-icon";
import { joinWorkspacePath } from "../lib/workspace-path";
import type { ChangeEntry } from "../types";
import { FileStatusBadge } from "./FileStatusBadge";

/**
 * A row action (stage, unstage, discard, …). It shows as a hover button on
 * file and folder rows and as an item in the right-click menu. On a folder
 * it runs on every file below it that it applies to.
 */
export interface ChangesTreeAction {
  /** Stable id, used in the button's test id: `changes-tree__action--<id>`. */
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  destructive?: boolean;
  /** Whether the action applies to `entry`; every entry when omitted. */
  appliesTo?: (entry: ChangeEntry) => boolean;
  run: (entries: ChangeEntry[]) => void;
}

interface ChangesFileTreeProps {
  entries: ChangeEntry[];
  onSelectFile: (entry: ChangeEntry) => void;
  /** Double-click a file — pins the diff (vs the single-click preview). When
   *  omitted, a double-click does nothing beyond the single-click select. */
  onSelectFilePinned?: (entry: ChangeEntry) => void;
  activeFile?: string | null;
  actions?: ChangesTreeAction[];
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
  onSelectFile: (entry: ChangeEntry) => void;
  onSelectFilePinned?: (entry: ChangeEntry) => void;
  actions: ChangesTreeAction[];
  workspacePath?: string;
  activeFile?: string | null;
}

/** Every change inside this subtree (just the node's own for a file). */
function collectEntries(node: FileTreeNode): ChangeEntry[] {
  if (!node.children) return node.entry ? [node.entry] : [];
  return node.children.flatMap(collectEntries);
}

/** `+N -M` line counts; zero or unknown sides are left out. */
function LineCounts({ entry }: { entry: ChangeEntry }) {
  const { additions, deletions } = entry;
  if (!additions && !deletions) return null;
  return (
    <span className="flex shrink-0 gap-1 text-[11px] tabular-nums">
      {!!additions && (
        <span className="text-green-600 dark:text-green-400" data-testid="changes-tree__additions">
          +{additions}
        </span>
      )}
      {!!deletions && (
        <span className="text-red-600 dark:text-red-400" data-testid="changes-tree__deletions">
          -{deletions}
        </span>
      )}
    </span>
  );
}

function ChangesTreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  onSelectFile,
  onSelectFilePinned,
  actions,
  workspacePath,
  activeFile,
}: ChangesTreeNodeProps) {
  const isDir = node.children !== undefined;
  const isExpanded = isDir && expandedPaths.has(node.path);
  const isActive = !isDir && activeFile === node.path;
  const btnRef = useRef<HTMLButtonElement>(null);

  // Defer the context-menu action until the menu finishes closing — see
  // useDeferredMenuAction for the full reasoning. Without this a
  // confirmation dialog would mount while Radix's FocusScope is still
  // alive and lose focus management.
  const menu = useDeferredMenuAction();

  // Auto-scroll the active file into view within the sidebar
  useEffect(() => {
    if (isActive && btnRef.current) {
      btnRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isActive]);

  const entries = useMemo(() => collectEntries(node), [node]);
  const applicable = actions
    .map((action) => ({
      action,
      targets: action.appliesTo ? entries.filter(action.appliesTo) : entries,
    }))
    .filter(({ targets }) => targets.length > 0);

  const handleClick = () => {
    if (isDir) onToggle(node.path);
    else if (node.entry) onSelectFile(node.entry);
  };

  const handleDoubleClick = () => {
    if (!isDir && node.entry) onSelectFilePinned?.(node.entry);
  };

  const name = node.name.includes("/") ? node.name.split("/").pop()! : node.name;
  const Icon = isDir ? getFolderIcon(name, isExpanded) : getFileIcon(name);

  const row = (
    <div
      data-testid={`changes-tree__item--${node.path}`}
      className={`group flex h-[28px] w-full items-center pr-2 hover:bg-accent/50 ${
        isActive
          ? "bg-blue-500/30 text-foreground outline outline-1 -outline-offset-1 outline-blue-400/60 hover:bg-blue-500/30 dark:bg-blue-500/40 dark:outline-blue-400/70 dark:hover:bg-blue-500/40"
          : ""
      }`}
    >
      <button
        ref={isActive ? btnRef : undefined}
        type="button"
        // data-band-active marks this button so the workspace-level
        // ⇧⌘G "focus Changes" handler can target it from outside the
        // file tree.
        data-band-active={isActive ? "true" : undefined}
        data-testid={`changes-tree__row--${node.path}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        title={node.entry?.oldPath ? `${node.entry.oldPath} → ${node.path}` : node.path}
        // Suppress the iOS text-selection / callout that fires on
        // long-press alongside the Radix contextmenu event.
        className="flex h-full min-w-0 flex-1 select-none items-center gap-1 pr-1 text-left text-[13px] [-webkit-touch-callout:none]"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {isDir && (
          <span
            className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
            data-testid="changes-tree__file-count"
          >
            {node.fileCount}
          </span>
        )}
        {!isDir && node.entry && <LineCounts entry={node.entry} />}
        {!isDir && node.entry && (
          <FileStatusBadge status={node.entry.status} conflict={node.entry.conflict} />
        )}
      </button>
      {/* Hover actions, as in orca and VS Code; devices without hover always
          show them. */}
      {applicable.length > 0 && (
        <div className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
          {applicable.map(({ action, targets }) => (
            <button
              key={action.id}
              type="button"
              title={action.label}
              aria-label={action.label}
              data-testid={`changes-tree__action--${action.id}`}
              onClick={() => action.run(targets)}
              className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <action.icon className="size-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
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
          {applicable.length > 0 && <ContextMenuSeparator />}
          {applicable.map(({ action, targets }) => (
            <ContextMenuItem
              key={action.id}
              variant={action.destructive ? "destructive" : undefined}
              data-testid={`changes-tree__menu--${action.id}`}
              onSelect={() => menu.queue(() => action.run(targets))}
            >
              <action.icon className="size-4" />
              {action.label}
            </ContextMenuItem>
          ))}
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
            onSelectFilePinned={onSelectFilePinned}
            actions={actions}
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

const NO_ACTIONS: ChangesTreeAction[] = [];

export function ChangesFileTree({
  entries,
  onSelectFile,
  onSelectFilePinned,
  activeFile,
  actions = NO_ACTIONS,
  workspacePath,
}: ChangesFileTreeProps) {
  const tree = useMemo(() => buildFileTree(entries), [entries]);

  // Track every directory path we've ever seen. Used so newly-appearing
  // directories default to expanded, while preserving the user's explicit
  // collapses for paths that were already in the tree on a previous render
  // (including paths that temporarily disappeared, e.g. when switching the
  // compare branch between branches with different file sets).
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
  // entry. `seenDirPathsRef` is intentionally never pruned — that's how
  // user collapses survive paths that disappear from the tree. Memory cost
  // is negligible because changed-file sets are small.
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
          onSelectFilePinned={onSelectFilePinned}
          actions={actions}
          workspacePath={workspacePath}
          activeFile={activeFile}
        />
      ))}
    </>
  );
}
