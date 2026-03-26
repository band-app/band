import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Columns2, Loader2, Rows2, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import { useIsDark } from "../hooks/use-is-dark";
import { baseViewerExtensions, loadLanguage } from "../lib/codemirror-setup";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileStatus, WorkspaceDiffSummary } from "../types";

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

type ViewMode = "unified" | "split";

interface DiffViewProps {
  workspaceId: string;
  active?: boolean;
  onStatsChange?: (stats: DiffStats | null) => void;
  onOpenFile?: (filename: string) => void;
}

interface ParsedFile {
  filename: string;
  hunks: string;
}

function parseDiffFiles(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const fileDiffs = diff.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split("\n");
    const firstLine = lines[0] || "";
    const match = firstLine.match(/ b\/(.+)$/);
    const filename = match ? match[1] : firstLine;

    files.push({
      filename,
      hunks: `diff --git ${fileDiff}`,
    });
  }

  return files;
}

const statusColors: Record<FileStatus, string> = {
  A: "text-green-600 dark:text-green-400",
  M: "text-blue-600 dark:text-blue-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-purple-600 dark:text-purple-400",
  U: "text-yellow-600 dark:text-yellow-400",
};

function FileStatusBadge({ status }: { status: FileStatus | undefined }) {
  if (!status) return null;
  return <span className={`shrink-0 text-xs font-bold ${statusColors[status]}`}>{status}</span>;
}

function detectLanguage(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return extensionToLanguage(ext) || filenameToLanguage(name) || "plaintext";
}

interface DiffLine {
  type: "add" | "del" | "context";
  text: string;
}

function parseDiffLines(hunks: string): DiffLine[] {
  const lines = hunks.split("\n");
  const result: DiffLine[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      // Skip hunk headers — the merge view shows its own markers
    } else if (inHunk) {
      if (line.startsWith("+")) {
        result.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        result.push({ type: "del", text: line.slice(1) });
      } else if (line.startsWith(" ") || line === "") {
        result.push({ type: "context", text: line.slice(1) || "" });
      }
    }
  }
  return result;
}

function buildOldNew(diffLines: DiffLine[]): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of diffLines) {
    if (line.type === "context") {
      oldLines.push(line.text);
      newLines.push(line.text);
    } else if (line.type === "add") {
      newLines.push(line.text);
    } else if (line.type === "del") {
      oldLines.push(line.text);
    }
  }

  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

const diffTheme = EditorView.theme({
  ".cm-insertedLine": { backgroundColor: "rgba(34, 197, 94, 0.1)" },
  ".cm-deletedLine": { backgroundColor: "rgba(239, 68, 68, 0.1)" },
});

function DiffFileContent({
  hunks,
  filename,
  viewMode,
}: {
  hunks: string;
  filename: string;
  viewMode: ViewMode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);
  const isDark = useIsDark();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const setup = async () => {
      const lang = detectLanguage(filename);
      const langSupport = await loadLanguage(lang);
      if (cancelled) return;

      // Destroy previous instance
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }

      const diffLines = parseDiffLines(hunks);
      const { oldText, newText } = buildOldNew(diffLines);

      if (viewMode === "split") {
        const sharedExtensions = [...baseViewerExtensions(isDark), diffTheme];
        if (langSupport) {
          sharedExtensions.push(langSupport);
        }

        viewRef.current = new MergeView({
          a: {
            doc: oldText,
            extensions: sharedExtensions,
          },
          b: {
            doc: newText,
            extensions: sharedExtensions,
          },
          parent: container,
          highlightChanges: false,
          gutter: true,
        });
      } else {
        const extensions = [
          ...baseViewerExtensions(isDark),
          unifiedMergeView({
            original: Text.of(oldText.split("\n")),
            mergeControls: false,
            syntaxHighlightDeletions: true,
            highlightChanges: false,
          }),
          diffTheme,
        ];
        if (langSupport) {
          extensions.push(langSupport);
        }

        const state = EditorState.create({
          doc: newText,
          extensions,
        });

        viewRef.current = new EditorView({
          state,
          parent: container,
        });
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [hunks, filename, viewMode, isDark]);

  return <div ref={containerRef} />;
}

// ---------------------------------------------------------------------------
// Lazy file row — fetches diff on first expand
// ---------------------------------------------------------------------------

interface LazyFileRowProps {
  filename: string;
  status: FileStatus | undefined;
  workspaceId: string;
  mergeBase: string;
  viewMode: ViewMode;
  onOpenFile?: (filename: string) => void;
}

function LazyFileRow({
  filename,
  status,
  workspaceId,
  mergeBase,
  viewMode,
  onOpenFile,
}: LazyFileRowProps) {
  const adapter = useAdapter();
  const [isOpen, setIsOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Track which mergeBase the cached diff belongs to
  const cachedMergeBaseRef = useRef<string | null>(null);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // Fetch diff when expanded and not cached (or mergeBase changed)
  useEffect(() => {
    if (!isOpen) return;
    if (diff !== null && cachedMergeBaseRef.current === mergeBase) return;

    const getFileDiff = adapter.getFileDiff;
    if (!getFileDiff) return;

    let cancelled = false;
    setLoadingDiff(true);
    setDiffError(null);

    getFileDiff
      .call(adapter, workspaceId, filename, mergeBase)
      .then((result) => {
        if (!cancelled) {
          setDiff(result.diff);
          cachedMergeBaseRef.current = mergeBase;
        }
      })
      .catch((err) => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, adapter, workspaceId, filename, mergeBase, diff]);

  // Invalidate cache when mergeBase changes
  useEffect(() => {
    if (cachedMergeBaseRef.current && cachedMergeBaseRef.current !== mergeBase) {
      setDiff(null);
      cachedMergeBaseRef.current = null;
    }
  }, [mergeBase]);

  return (
    <div id={`diff-file-${encodeURIComponent(filename)}`} className="border-b border-border/30">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent/50"
      >
        <span
          className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">
          {filename} <FileStatusBadge status={status} />
        </span>
        {onOpenFile && (
          <span
            title="Open in code browser"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenFile(filename);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onOpenFile(filename);
              }
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </span>
        )}
      </button>
      {isOpen && (
        <div className="border-t border-border/20 bg-muted/30">
          {loadingDiff && (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading diff...
            </div>
          )}
          {diffError && <div className="px-4 py-4 text-sm text-destructive">{diffError}</div>}
          {diff !== null && !loadingDiff && (
            <DiffFileContent hunks={diff} filename={filename} viewMode={viewMode} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback: legacy full-diff mode (when adapter lacks new methods)
// ---------------------------------------------------------------------------

function LegacyDiffView({ workspaceId, active, onStatsChange, onOpenFile }: DiffViewProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<{
    diff: string;
    stats: DiffStats;
    baseBranch: string;
    headBranch: string;
    fileStatuses: Record<string, FileStatus>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("unified");

  useEffect(() => {
    const getWorkspaceDiff = adapter.getWorkspaceDiff;
    if (!getWorkspaceDiff) {
      setError("Diff viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const fetchDiff = () => {
      getWorkspaceDiff
        .call(adapter, workspaceId)
        .then((result) => {
          if (!cancelled) {
            setData(result);
            setError(null);
            onStatsChange?.(result?.diff ? result.stats : null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load diff");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchDiff();
    const interval = active ? setInterval(fetchDiff, 15_000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [adapter, workspaceId, active, onStatsChange]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading changes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!data || !data.diff) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes
      </div>
    );
  }

  const files = parseDiffFiles(data.diff);
  const fileStatuses = data.fileStatuses || {};

  const toggleFile = (filename: string) => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{data.stats.filesChanged}</span>{" "}
            {data.stats.filesChanged === 1 ? "file" : "files"} changed
            {data.stats.insertions > 0 && (
              <span className="ml-2 text-green-600 dark:text-green-400">
                +{data.stats.insertions}
              </span>
            )}
            {data.stats.deletions > 0 && (
              <span className="ml-1 text-red-600 dark:text-red-400">-{data.stats.deletions}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {data.baseBranch} ← {data.headBranch}
          </div>
        </div>
        <div className="hidden items-center rounded-md border border-border/50 bg-muted/50 md:flex">
          <button
            type="button"
            onClick={() => setViewMode("unified")}
            className={`inline-flex items-center gap-1 rounded-l-md px-2 py-1 text-xs transition-colors ${
              viewMode === "unified"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Unified view"
          >
            <Rows2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("split")}
            className={`inline-flex items-center gap-1 rounded-r-md px-2 py-1 text-xs transition-colors ${
              viewMode === "split"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Split view"
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.map((file) => {
          const isOpen = openFiles.has(file.filename);
          return (
            <div
              key={file.filename}
              id={`diff-file-${encodeURIComponent(file.filename)}`}
              className="border-b border-border/30"
            >
              <button
                type="button"
                onClick={() => toggleFile(file.filename)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent/50"
              >
                <span
                  className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.filename} <FileStatusBadge status={fileStatuses[file.filename]} />
                </span>
                {onOpenFile && (
                  <span
                    title="Open in code browser"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenFile(file.filename);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        onOpenFile(file.filename);
                      }
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <SquareArrowOutUpRight className="size-3.5" />
                  </span>
                )}
              </button>
              {isOpen && (
                <div className="border-t border-border/20 bg-muted/30">
                  <DiffFileContent
                    hunks={file.hunks}
                    filename={file.filename}
                    viewMode={viewMode}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main DiffView — uses lazy summary + per-file when available
// ---------------------------------------------------------------------------

export function DiffView({ workspaceId, active = true, onStatsChange, onOpenFile }: DiffViewProps) {
  const adapter = useAdapter();
  const [summary, setSummary] = useState<WorkspaceDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("unified");

  // Fall back to legacy if adapter doesn't support new methods
  const supportsLazy = !!(adapter.getWorkspaceDiffSummary && adapter.getFileDiff);

  useEffect(() => {
    if (!supportsLazy) return;

    const getWorkspaceDiffSummary = adapter.getWorkspaceDiffSummary!;

    let cancelled = false;
    const fetchSummary = () => {
      getWorkspaceDiffSummary
        .call(adapter, workspaceId)
        .then((result) => {
          if (!cancelled) {
            setSummary(result);
            setError(null);
            const hasChanges = result.stats.filesChanged > 0;
            onStatsChange?.(hasChanges ? result.stats : null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load diff");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchSummary();
    const interval = active ? setInterval(fetchSummary, 15_000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [adapter, workspaceId, active, onStatsChange, supportsLazy]);

  if (!supportsLazy) {
    return (
      <LegacyDiffView
        workspaceId={workspaceId}
        active={active}
        onStatsChange={onStatsChange}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading changes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!summary || summary.stats.filesChanged === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes
      </div>
    );
  }

  const fileStatuses = summary.fileStatuses || {};
  const filenames = Object.keys(fileStatuses);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{summary.stats.filesChanged}</span>{" "}
            {summary.stats.filesChanged === 1 ? "file" : "files"} changed
            {summary.stats.insertions > 0 && (
              <span className="ml-2 text-green-600 dark:text-green-400">
                +{summary.stats.insertions}
              </span>
            )}
            {summary.stats.deletions > 0 && (
              <span className="ml-1 text-red-600 dark:text-red-400">
                -{summary.stats.deletions}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {summary.baseBranch} ← {summary.headBranch}
          </div>
        </div>
        <div className="hidden items-center rounded-md border border-border/50 bg-muted/50 md:flex">
          <button
            type="button"
            onClick={() => setViewMode("unified")}
            className={`inline-flex items-center gap-1 rounded-l-md px-2 py-1 text-xs transition-colors ${
              viewMode === "unified"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Unified view"
          >
            <Rows2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("split")}
            className={`inline-flex items-center gap-1 rounded-r-md px-2 py-1 text-xs transition-colors ${
              viewMode === "split"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Split view"
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filenames.map((filename) => (
          <LazyFileRow
            key={filename}
            filename={filename}
            status={fileStatuses[filename]}
            workspaceId={workspaceId}
            mergeBase={summary.mergeBase}
            viewMode={viewMode}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </div>
  );
}
