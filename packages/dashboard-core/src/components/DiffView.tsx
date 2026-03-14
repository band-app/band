import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Columns2, Rows2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import { baseViewerExtensions, loadLanguage } from "../lib/codemirror-setup";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileStatus, WorkspaceDiff } from "../types";

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
  A: "text-green-400",
  M: "text-blue-400",
  D: "text-red-400",
  R: "text-purple-400",
  U: "text-yellow-400",
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
        const sharedExtensions = [...baseViewerExtensions(), diffTheme];
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
          ...baseViewerExtensions(),
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
  }, [hunks, filename, viewMode]);

  return <div ref={containerRef} />;
}

export function DiffView({ workspaceId, active = true, onStatsChange }: DiffViewProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<WorkspaceDiff | null>(null);
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
      <div className="flex shrink-0 items-center justify-between border-b border-white/20 px-4 py-2">
        <div>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{data.stats.filesChanged}</span>{" "}
            {data.stats.filesChanged === 1 ? "file" : "files"} changed
            {data.stats.insertions > 0 && (
              <span className="ml-2 text-green-400">+{data.stats.insertions}</span>
            )}
            {data.stats.deletions > 0 && (
              <span className="ml-1 text-red-400">-{data.stats.deletions}</span>
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
                  className={`text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.filename} <FileStatusBadge status={fileStatuses[file.filename]} />
                </span>
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
