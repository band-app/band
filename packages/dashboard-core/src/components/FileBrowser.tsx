import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import type { FileEntry } from "../types";

interface FileBrowserProps {
  workspaceId: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Compact mode for sidebar use — smaller items */
  compact?: boolean;
  /** Currently selected file path for highlighting */
  selectedFile?: string;
}

export function FileBrowser({
  workspaceId,
  currentPath,
  onNavigate,
  onOpenFile,
  compact,
  selectedFile,
}: FileBrowserProps) {
  const adapter = useAdapter();
  const breadcrumbsRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adapter.listWorkspaceFiles) {
      setError("File browsing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    adapter
      .listWorkspaceFiles(workspaceId, currentPath)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to list files");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, workspaceId, currentPath]);

  const breadcrumbs = currentPath ? currentPath.split("/") : [];

  // Scroll breadcrumbs to the end so the current folder is visible
  useEffect(() => {
    const el = breadcrumbsRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [currentPath]);

  const handleBreadcrumb = (index: number) => {
    if (index < 0) {
      onNavigate("");
    } else {
      onNavigate(breadcrumbs.slice(0, index + 1).join("/"));
    }
  };

  const handleClick = (entry: FileEntry) => {
    const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    if (entry.type === "directory") {
      onNavigate(entryPath);
    } else {
      onOpenFile(entryPath);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Breadcrumbs */}
      <div
        ref={breadcrumbsRef}
        className={`flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${compact ? "h-9 px-2" : "px-4 py-2"}`}
      >
        <button
          type="button"
          onClick={() => handleBreadcrumb(-1)}
          className={`shrink-0 ${currentPath ? "text-muted-foreground hover:text-foreground" : "font-medium text-foreground"}`}
        >
          root
        </button>
        {breadcrumbs.map((segment, i) => (
          <span key={breadcrumbs.slice(0, i + 1).join("/")} className="flex shrink-0 items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => handleBreadcrumb(i)}
              className={`shrink-0 ${
                i === breadcrumbs.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {/* File list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {error && (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Empty directory
          </div>
        )}
        {!loading &&
          !error &&
          entries.map((entry) => {
            const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
            const isSelected = entry.type === "file" && selectedFile === entryPath;
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => handleClick(entry)}
                className={`flex w-full items-center text-left hover:bg-accent/50 ${
                  compact ? "gap-2 px-3 py-2 text-sm" : "gap-3 px-4 py-2.5 text-sm"
                } ${isSelected ? "bg-accent/50 text-foreground" : ""}`}
              >
                {entry.type === "directory" ? (
                  <Folder className={`shrink-0 text-blue-400 ${compact ? "size-4" : "size-4"}`} />
                ) : (
                  <File
                    className={`shrink-0 text-muted-foreground ${compact ? "size-4" : "size-4"}`}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!compact && entry.type === "directory" && (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}
