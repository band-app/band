import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
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
  compact?: boolean;
  selectedFile?: string;
  selectedRef?: React.RefObject<HTMLButtonElement | null>;
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
  compact,
  selectedFile,
  selectedRef,
}: TreeNodeProps) {
  const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const isDir = entry.type === "directory";
  const isExpanded = isDir && expandedPaths.has(entryPath);
  const isSelected = !isDir && selectedFile === entryPath;
  const isLoading = isDir && loadingPaths.has(entryPath);
  const children = isDir ? dirContents.get(entryPath) : undefined;

  const indent = compact ? 12 : 16;
  const basePad = compact ? 4 : 8;

  const handleClick = () => {
    if (isDir) {
      onToggle(entryPath);
    } else {
      onOpenFile(entryPath);
    }
  };

  const handleDoubleClick = () => {
    if (!isDir && onOpenFilePinned) {
      onOpenFilePinned(entryPath);
    }
  };

  return (
    <>
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
        className={`flex w-full items-center text-left hover:bg-accent/50 ${
          compact ? "h-[26px] gap-1 pr-3 text-xs" : "h-[30px] gap-1.5 pr-4 text-sm"
        } ${isSelected ? "bg-accent text-accent-foreground" : ""}`}
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

      {/* Children — rendered when directory is expanded */}
      {isExpanded && (
        <>
          {isLoading && !children?.length && (
            <div
              className="flex items-center text-xs text-muted-foreground/70"
              style={{
                paddingLeft: `${(depth + 1) * indent + basePad + 18}px`,
                height: compact ? 26 : 30,
              }}
            >
              Loading…
            </div>
          )}
          {!isLoading && children && children.length === 0 && (
            <div
              className="flex items-center text-xs italic text-muted-foreground/50"
              style={{
                paddingLeft: `${(depth + 1) * indent + basePad + 18}px`,
                height: compact ? 26 : 30,
              }}
            >
              Empty
            </div>
          )}
          {children?.map((child) => (
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
              compact={compact}
              selectedFile={selectedFile}
              selectedRef={selectedRef}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// FileBrowser — tree root, manages state & data fetching
// ---------------------------------------------------------------------------
export function FileBrowser({
  workspaceId,
  onOpenFile,
  onOpenFilePinned,
  compact,
  selectedFile,
}: FileBrowserProps) {
  const adapter = useAdapter();

  // React state mirroring the module-level caches so changes trigger renders
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(getCachedExpanded(workspaceId)),
  );
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(
    () => new Map(getCachedContents(workspaceId)),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

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
    }
  }, [workspaceId]);

  // ------- Fetch helpers -------
  const fetchDir = useCallback(
    async (dirPath: string): Promise<void> => {
      if (!adapter.listWorkspaceFiles) return;

      const cache = getCachedContents(workspaceId);
      if (cache.has(dirPath)) {
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rootLoading && rootEntries.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {!rootLoading && rootEntries.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Empty directory
          </div>
        )}
        {rootEntries.map((entry) => (
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
            compact={compact}
            selectedFile={selectedFile}
            selectedRef={selectedRef}
          />
        ))}
      </div>
    </div>
  );
}
