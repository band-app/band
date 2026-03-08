import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import type { FileEntry } from "../types";

interface FileBrowserProps {
  workspaceId: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export function FileBrowser({
  workspaceId,
  currentPath,
  onNavigate,
  onOpenFile,
}: FileBrowserProps) {
  const adapter = useAdapter();
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
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-4 py-2 text-xs">
        <button
          type="button"
          onClick={() => handleBreadcrumb(-1)}
          className={`shrink-0 ${currentPath ? "text-muted-foreground hover:text-foreground" : "font-medium text-foreground"}`}
        >
          root
        </button>
        {breadcrumbs.map((segment, i) => (
          <span key={`${segment}-${i}`} className="flex items-center gap-1">
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
          entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => handleClick(entry)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent/50"
            >
              {entry.type === "directory" ? (
                <Folder className="size-4 shrink-0 text-blue-400" />
              ) : (
                <File className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.type === "directory" && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
              )}
            </button>
          ))}
      </div>
    </div>
  );
}
