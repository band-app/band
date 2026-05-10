import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildFileTree, type FileTreeNode } from "../lib/build-file-tree";
import { getFileIcon } from "../lib/file-icon";
import type { FileStatus } from "../types";
import { FileStatusBadge } from "./FileStatusBadge";

interface ChangesFileTreeProps {
  fileStatuses: Record<string, FileStatus>;
  onSelectFile: (filePath: string) => void;
  activeFile?: string | null;
}

interface ChangesTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (filePath: string) => void;
  activeFile?: string | null;
}

function ChangesTreeNode({
  node,
  depth,
  expandedPaths,
  onToggle,
  onSelectFile,
  activeFile,
}: ChangesTreeNodeProps) {
  const isDir = node.children !== undefined;
  const isExpanded = isDir && expandedPaths.has(node.path);
  const isActive = !isDir && activeFile === node.path;
  const btnRef = useRef<HTMLButtonElement>(null);

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

  return (
    <>
      <button
        ref={isActive ? btnRef : undefined}
        type="button"
        // data-band-active marks this button so the workspace-level
        // ⇧⌘G "focus Changes" handler can target it from outside the
        // file tree.
        data-band-active={isActive ? "true" : undefined}
        onClick={handleClick}
        className={`flex h-[26px] w-full items-center gap-1 pr-3 text-left text-xs ${
          isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
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
        {isDir ? (
          isExpanded ? (
            <FolderOpen className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          ) : (
            <Folder className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          )
        ) : (
          (() => {
            // Use the last segment of the node name for icon detection
            const fileName = node.name.includes("/") ? node.name.split("/").pop()! : node.name;
            const FileIcon = getFileIcon(fileName);
            return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
          })()
        )}

        {/* Name */}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>

        {/* Status badge for files */}
        {!isDir && node.status && <FileStatusBadge status={node.status} />}
      </button>

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

export function ChangesFileTree({ fileStatuses, onSelectFile, activeFile }: ChangesFileTreeProps) {
  const tree = useMemo(() => buildFileTree(fileStatuses), [fileStatuses]);

  // All directories expanded by default (changed-file sets are typically small)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    return new Set(collectDirPaths(tree));
  });

  // Re-expand all when tree changes (new diff summary)
  useEffect(() => {
    setExpandedPaths(new Set(collectDirPaths(tree)));
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

  if (tree.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
        No files
      </div>
    );
  }

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
          activeFile={activeFile}
        />
      ))}
    </>
  );
}
