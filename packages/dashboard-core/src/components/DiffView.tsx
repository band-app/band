import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@band-app/ui";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { SearchQuery } from "@codemirror/search";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Rows2,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import { useIsDark } from "../hooks/use-is-dark";
import { useSearch } from "../hooks/use-search";
import { baseViewerExtensions, loadLanguage, searchHighlightOnly } from "../lib/codemirror-setup";
import { formatFileLocation } from "../lib/file-location";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import { selectionToChatExtension } from "../lib/selection-to-chat";
import type { SSEEvent } from "../lib/sse";
import type { DiffMode, FileStatus, WorkspaceDiffSummary } from "../types";
import { ChangesFileTree } from "./ChangesFileTree";
import { FileStatusBadge } from "./FileStatusBadge";
import { SearchBar, type SearchOptions } from "./SearchBar";

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

type ViewMode = "unified" | "split";

const VIEW_MODE_KEY = "band:diff-view-mode";

function getStoredViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === "split" || v === "unified") return v;
  } catch {}
  return "unified";
}

function storeViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {}
}

const DIFF_MODE_KEY = "band:diff-mode";

function getStoredDiffMode(): DiffMode {
  try {
    const v = localStorage.getItem(DIFF_MODE_KEY);
    if (v === "uncommitted" || v === "branch") return v;
  } catch {}
  return "branch";
}

function storeDiffMode(mode: DiffMode) {
  try {
    localStorage.setItem(DIFF_MODE_KEY, mode);
  } catch {}
}

const EXPAND_ALL_KEY = "band:diff-expand-all";

function getStoredExpandAll(): boolean {
  try {
    return localStorage.getItem(EXPAND_ALL_KEY) === "true";
  } catch {}
  return false;
}

function storeExpandAll(v: boolean) {
  try {
    localStorage.setItem(EXPAND_ALL_KEY, v ? "true" : "false");
  } catch {}
}

const SIDEBAR_OPEN_KEY = "band:diff-sidebar-open";

function getStoredSidebarOpen(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_OPEN_KEY);
    if (v === "false") return false;
  } catch {}
  return true;
}

function storeSidebarOpen(v: boolean) {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, v ? "true" : "false");
  } catch {}
}

const SIDEBAR_WIDTH_KEY = "band:diff-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 120;
const SIDEBAR_MAX_WIDTH = 500;

function getStoredSidebarWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
    }
  } catch {}
  return SIDEBAR_DEFAULT_WIDTH;
}

function storeSidebarWidth(v: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(v));
  } catch {}
}

interface DiffViewProps {
  workspaceId: string;
  active?: boolean;
  onStatsChange?: (stats: DiffStats | null) => void;
  onOpenFile?: (filename: string) => void;
  onFindInFile?: (fn: (() => void) | null) => void;
}

/** Extracts the start line of the first hunk in a diff (new-file side). */
function firstChangeLine(hunks: string): number | undefined {
  const match = hunks.match(/@@ [^ ]+ \+(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

function detectLanguage(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return extensionToLanguage(ext) || filenameToLanguage(name) || "plaintext";
}

interface ParsedDiff {
  oldText: string;
  newText: string;
  /** Actual file line number for each line in oldText (0-indexed array, values are 1-based line numbers). */
  oldLineNumbers: number[];
  /** Actual file line number for each line in newText (0-indexed array, values are 1-based line numbers). */
  newLineNumbers: number[];
}

/**
 * Parses a unified diff string into old/new text with their actual file line numbers.
 * Hunk headers (@@ -oldStart,count +newStart,count @@) are used to track the real
 * line offsets so that trimmed/collapsed diffs display correct line numbers.
 */
function parseDiff(hunks: string): ParsedDiff {
  const lines = hunks.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldLineNumbers: number[] = [];
  const newLineNumbers: number[] = [];

  let inHunk = false;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
      }
    } else if (inHunk) {
      if (line.startsWith("+")) {
        newLines.push(line.slice(1));
        newLineNumbers.push(newLineNum);
        newLineNum++;
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
        oldLineNumbers.push(oldLineNum);
        oldLineNum++;
      } else if (line.startsWith(" ") || line === "") {
        const text = line.slice(1) || "";
        oldLines.push(text);
        newLines.push(text);
        oldLineNumbers.push(oldLineNum);
        newLineNumbers.push(newLineNum);
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    oldLineNumbers,
    newLineNumbers,
  };
}

const diffTheme = EditorView.theme({
  ".cm-insertedLine": { backgroundColor: "rgba(34, 197, 94, 0.1)" },
  ".cm-deletedLine": { backgroundColor: "rgba(239, 68, 68, 0.1)" },
});

function DiffFileContent({
  hunks,
  filename,
  viewMode,
  onEditorViews,
}: {
  hunks: string;
  filename: string;
  viewMode: ViewMode;
  onEditorViews?: (views: EditorView[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);
  const isDark = useIsDark();

  // Use ref pattern so callback identity changes don't re-run the setup effect
  const onEditorViewsRef = useRef(onEditorViews);
  onEditorViewsRef.current = onEditorViews;

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

      const { oldText, newText, oldLineNumbers, newLineNumbers } = parseDiff(hunks);

      /** Creates a lineNumbers extension that maps document lines to actual file line numbers. */
      const makeLineNumbers = (lineMap: number[]) =>
        lineNumbers({
          formatNumber: (n) => {
            if (n >= 1 && n <= lineMap.length) {
              return String(lineMap[n - 1]);
            }
            return String(n);
          },
        });

      if (viewMode === "split") {
        const sharedExtensions = [searchHighlightOnly(), diffTheme];
        if (langSupport) {
          sharedExtensions.push(langSupport);
        }

        viewRef.current = new MergeView({
          a: {
            doc: oldText,
            extensions: [
              ...baseViewerExtensions(isDark, { skipLineNumbers: true }),
              makeLineNumbers(oldLineNumbers),
              selectionToChatExtension(filename, oldLineNumbers),
              ...sharedExtensions,
            ],
          },
          b: {
            doc: newText,
            extensions: [
              ...baseViewerExtensions(isDark, { skipLineNumbers: true }),
              makeLineNumbers(newLineNumbers),
              selectionToChatExtension(filename, newLineNumbers),
              ...sharedExtensions,
            ],
          },
          parent: container,
          highlightChanges: false,
          gutter: true,
        });

        onEditorViewsRef.current?.([viewRef.current.a, viewRef.current.b]);
      } else {
        const extensions = [
          ...baseViewerExtensions(isDark, { skipLineNumbers: true }),
          makeLineNumbers(newLineNumbers),
          searchHighlightOnly(),
          selectionToChatExtension(filename, newLineNumbers),
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

        onEditorViewsRef.current?.([viewRef.current]);
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      onEditorViewsRef.current?.([]);
    };
  }, [hunks, filename, viewMode, isDark]);

  return <div ref={containerRef} />;
}

// ---------------------------------------------------------------------------
// Context expansion helpers
// ---------------------------------------------------------------------------

const CONTEXT_STEPS = [3, 10, 25, 100, 99999] as const;

function getNextContextStep(current: number): number | null {
  for (const step of CONTEXT_STEPS) {
    if (step > current) return step;
  }
  return null;
}

function ContextToolbar({
  contextLines,
  onLoadMore,
  onShowFullFile,
}: {
  contextLines: number;
  onLoadMore: () => void;
  onShowFullFile: () => void;
}) {
  const nextStep = getNextContextStep(contextLines);
  if (nextStep === null) return null;

  const isLastStep = nextStep >= 99999;

  return (
    <div className="flex items-center justify-center gap-2 border-b border-border/20 px-4 py-1.5">
      {isLastStep ? (
        <button
          type="button"
          onClick={onShowFullFile}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Show full file
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={onLoadMore}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Load more context
          </button>
          <span className="text-muted-foreground/50">|</span>
          <button
            type="button"
            onClick={onShowFullFile}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Show full file
          </button>
        </>
      )}
    </div>
  );
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
  expandAll: boolean;
  focusedFile: { path: string; seq: number } | null;
  onOpenFile?: (filename: string) => void;
  onEditorViews?: (filename: string, views: EditorView[]) => void;
}

function LazyFileRow({
  filename,
  status,
  workspaceId,
  mergeBase,
  viewMode,
  expandAll,
  focusedFile,
  onOpenFile,
  onEditorViews,
}: LazyFileRowProps) {
  const adapter = useAdapter();
  const [isOpen, setIsOpen] = useState(expandAll);
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [contextLines, setContextLines] = useState(3);
  // Track which mergeBase + contextLines the cached diff belongs to
  const cachedMergeBaseRef = useRef<string | null>(null);
  const cachedContextRef = useRef<number | null>(null);

  const handleEditorViews = useCallback(
    (views: EditorView[]) => {
      onEditorViews?.(filename, views);
    },
    [filename, onEditorViews],
  );

  // Clear editor views when collapsing
  useEffect(() => {
    if (!isOpen) {
      onEditorViews?.(filename, []);
    }
  }, [isOpen, filename, onEditorViews]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // Sync with parent expand-all toggle
  useEffect(() => {
    setIsOpen(expandAll);
  }, [expandAll]);

  // Open and scroll into view when focused from the file tree sidebar
  useEffect(() => {
    if (focusedFile && focusedFile.path === filename) {
      setIsOpen(true);
      // Defer scroll to allow the DOM to update after opening
      requestAnimationFrame(() => {
        const elementId = `diff-file-${encodeURIComponent(filename)}`;
        const element = document.getElementById(elementId);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    }
  }, [focusedFile, filename]);

  // Fetch diff when expanded and not cached (or mergeBase/contextLines changed)
  useEffect(() => {
    if (!isOpen) return;
    if (
      diff !== null &&
      cachedMergeBaseRef.current === mergeBase &&
      cachedContextRef.current === contextLines
    ) {
      return;
    }

    const getFileDiff = adapter.getFileDiff;
    if (!getFileDiff) return;

    let cancelled = false;
    setLoadingDiff(true);
    setDiffError(null);

    getFileDiff
      .call(adapter, workspaceId, filename, mergeBase, contextLines > 3 ? contextLines : undefined)
      .then((result) => {
        if (!cancelled) {
          setDiff(result.diff);
          cachedMergeBaseRef.current = mergeBase;
          cachedContextRef.current = contextLines;
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
  }, [isOpen, adapter, workspaceId, filename, mergeBase, contextLines, diff]);

  // Invalidate cache when mergeBase changes
  useEffect(() => {
    if (cachedMergeBaseRef.current && cachedMergeBaseRef.current !== mergeBase) {
      setDiff(null);
      cachedMergeBaseRef.current = null;
      cachedContextRef.current = null;
      setContextLines(3);
    }
  }, [mergeBase]);

  const isUntracked = status === "U";
  const canLoadMore = !isUntracked && getNextContextStep(contextLines) !== null;

  const handleLoadMore = useCallback(() => {
    const next = getNextContextStep(contextLines);
    if (next !== null) {
      setDiff(null);
      setContextLines(next);
    }
  }, [contextLines]);

  const handleShowFullFile = useCallback(() => {
    setDiff(null);
    setContextLines(99999);
  }, []);

  return (
    <div id={`diff-file-${encodeURIComponent(filename)}`} className="border-b border-border/30">
      <button
        type="button"
        onClick={toggle}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-background px-4 py-2.5 text-left text-sm hover:bg-accent/50"
      >
        <span
          className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono [scrollbar-width:none]">
          {filename} <FileStatusBadge status={status} />
        </span>
        {onOpenFile && (
          <span
            title="Open in code browser"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const line = diff ? firstChangeLine(diff) : undefined;
              onOpenFile(formatFileLocation(filename, line));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                const line = diff ? firstChangeLine(diff) : undefined;
                onOpenFile(formatFileLocation(filename, line));
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
            <>
              {canLoadMore && (
                <ContextToolbar
                  contextLines={contextLines}
                  onLoadMore={handleLoadMore}
                  onShowFullFile={handleShowFullFile}
                />
              )}
              <DiffFileContent
                hunks={diff}
                filename={filename}
                viewMode={viewMode}
                onEditorViews={handleEditorViews}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

function collectAllMatches(
  editorViewsMap: Map<string, EditorView[]>,
  filenames: string[],
  query: string,
  opts?: SearchOptions,
): Array<{ view: EditorView; from: number; to: number }> {
  if (!query) return [];
  const cmQuery = new SearchQuery({
    search: query,
    caseSensitive: opts?.caseSensitive ?? false,
    literal: !opts?.regex,
    regexp: opts?.regex ?? false,
    wholeWord: opts?.wholeWord ?? false,
  });
  const matches: Array<{ view: EditorView; from: number; to: number }> = [];

  for (const filename of filenames) {
    const views = editorViewsMap.get(filename) || [];
    for (const view of views) {
      const cursor = cmQuery.getCursor(view.state);
      let result = cursor.next();
      while (!result.done) {
        matches.push({ view, from: result.value.from, to: result.value.to });
        result = cursor.next();
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Main DiffView
// ---------------------------------------------------------------------------

export function DiffView({
  workspaceId,
  active = true,
  onStatsChange,
  onOpenFile,
  onFindInFile,
}: DiffViewProps) {
  const adapter = useAdapter();
  const [summary, setSummary] = useState<WorkspaceDiffSummary | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewMode, setViewModeState] = useState<ViewMode>(getStoredViewMode);
  const [diffMode, setDiffModeState] = useState<DiffMode>(getStoredDiffMode);
  const [expandAll, setExpandAllState] = useState(getStoredExpandAll);
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    storeViewMode(mode);
  }, []);
  const setDiffMode = useCallback((mode: DiffMode) => {
    setDiffModeState(mode);
    storeDiffMode(mode);
  }, []);
  const setExpandAll = useCallback((v: boolean) => {
    setExpandAllState(v);
    storeExpandAll(v);
  }, []);
  const [sidebarOpen, setSidebarOpenState] = useState(getStoredSidebarOpen);
  const setSidebarOpen = useCallback((v: boolean) => {
    setSidebarOpenState(v);
    storeSidebarOpen(v);
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(getStoredSidebarWidth);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      let lastWidth = startWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        lastWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
        setSidebarWidth(lastWidth);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        storeSidebarWidth(lastWidth);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  // -------------------------------------------------------------------------
  // Find-in-diff state
  // -------------------------------------------------------------------------
  const editorViewsRef = useRef<Map<string, EditorView[]>>(new Map());
  // Track filenames in a ref for stable access in navigation callbacks
  const filenamesRef = useRef<string[]>([]);

  const getViews = useCallback(() => Array.from(editorViewsRef.current.values()).flat(), []);

  const collectMatches = useCallback(
    (query: string, opts: SearchOptions) =>
      collectAllMatches(editorViewsRef.current, filenamesRef.current, query, opts),
    [],
  );

  const search = useSearch({ getViews, collectMatches, onFindInFile });

  // Track which file was clicked in the file tree sidebar so LazyFileRow can
  // expand and scroll to it. We use a counter to allow re-clicking the same file.
  const [focusedFile, setFocusedFile] = useState<{ path: string; seq: number } | null>(null);
  const focusSeqRef = useRef(0);

  const handleScrollToFile = useCallback((filePath: string) => {
    focusSeqRef.current += 1;
    setFocusedFile({ path: filePath, seq: focusSeqRef.current });
  }, []);

  // Editor views registry — also dispatches active search to newly registered views
  const handleEditorViews = useCallback(
    (filename: string, views: EditorView[]) => {
      if (views.length === 0) {
        editorViewsRef.current.delete(filename);
      } else {
        editorViewsRef.current.set(filename, views);
        search.dispatchToViews(views);
      }
    },
    [search.dispatchToViews],
  );

  // -------------------------------------------------------------------------
  // Fetch diff summary
  // -------------------------------------------------------------------------

  useEffect(() => {
    const getWorkspaceDiffSummary = adapter.getWorkspaceDiffSummary;
    if (!getWorkspaceDiffSummary) return;

    let cancelled = false;
    setLoading(true);
    setSummary(null);

    const fetchSummary = () => {
      getWorkspaceDiffSummary
        .call(adapter, workspaceId, diffMode)
        .then((result) => {
          if (!cancelled) {
            setSummary(result);
            setBaseBranch(result.baseBranch);
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

    // Subscribe to branch-status events to auto-refresh when files change.
    // The branch-status-poller emits events every ~5s with the workspace's
    // git dirty state, so the diff view stays in sync without slow polling.
    let unsubscribe: (() => void) | undefined;
    if (active) {
      unsubscribe = adapter.subscribeStatusEvents((event) => {
        const data = event as SSEEvent;
        if (data.kind === "branch-status" && data.workspaceId === workspaceId) {
          fetchSummary();
        }
      });
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [adapter, workspaceId, active, onStatsChange, diffMode, refreshKey]);

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
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-end border-b border-border px-4 py-2">
          <Select value={diffMode} onValueChange={(v) => setDiffMode(v as DiffMode)}>
            <SelectTrigger className="h-7 w-auto gap-1 rounded-md border-border/50 bg-muted/50 px-2.5 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="uncommitted">Uncommitted</SelectItem>
              <SelectItem value="branch">{baseBranch ?? "base"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No changes
        </div>
      </div>
    );
  }

  const fileStatuses = summary.fileStatuses || {};
  const filenames = Object.keys(fileStatuses);
  filenamesRef.current = filenames;

  return (
    <div className="flex h-full overflow-hidden">
      {/* LEFT: File tree sidebar — desktop only */}
      {sidebarOpen && (
        <div
          data-diff-sidebar
          className="hidden shrink-0 flex-col md:flex"
          style={{ width: sidebarWidth }}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">Files</span>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              title="Hide file tree"
            >
              <PanelLeftClose className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <ChangesFileTree fileStatuses={fileStatuses} onSelectFile={handleScrollToFile} />
          </div>
        </div>
      )}

      {/* Resize handle between sidebar and main content */}
      {sidebarOpen && (
        <div
          onMouseDown={handleResizeStart}
          className="hidden w-[3px] shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-accent-foreground/20 active:bg-accent-foreground/30 md:block"
        />
      )}

      {/* RIGHT: Main content (toolbar + file list) */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-3">
            {/* Sidebar toggle — only visible on desktop when sidebar is closed */}
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="hidden items-center rounded-md border border-border/50 bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
                title="Show file tree"
              >
                <PanelLeftOpen className="size-3.5" />
              </button>
            )}
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
                {summary.baseBranch} &larr; {summary.headBranch}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="inline-flex items-center rounded-md border border-border/50 bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title="Reload changes"
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={search.handleOpenSearch}
              className="inline-flex items-center rounded-md border border-border/50 bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title="Find in changes (⌘F)"
            >
              <Search className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setExpandAll(!expandAll)}
              className={`inline-flex items-center rounded-md border border-border/50 px-2 py-1 text-xs transition-colors ${
                expandAll
                  ? "bg-accent text-foreground"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
              title={expandAll ? "Collapse all files" : "Expand all files"}
            >
              {expandAll ? (
                <ChevronsDownUp className="size-3.5" />
              ) : (
                <ChevronsUpDown className="size-3.5" />
              )}
            </button>
            <Select value={diffMode} onValueChange={(v) => setDiffMode(v as DiffMode)}>
              <SelectTrigger className="h-7 w-auto gap-1 rounded-md border-border/50 bg-muted/50 px-2.5 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="uncommitted">Uncommitted</SelectItem>
                <SelectItem value="branch">{baseBranch ?? "base"}</SelectItem>
              </SelectContent>
            </Select>
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
        </div>
        {search.searchOpen && (
          <SearchBar
            ref={search.searchBarRef}
            query={search.searchQuery}
            onQueryChange={search.setSearchQuery}
            options={search.searchOptions}
            onOptionsChange={search.setSearchOptions}
            placeholder="Find in changes..."
            matchInfo={search.matchInfo}
            onNext={search.handleNext}
            onPrevious={search.handlePrevious}
            onClose={search.handleCloseSearch}
          />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filenames.map((filename) => (
            <LazyFileRow
              key={filename}
              filename={filename}
              status={fileStatuses[filename]}
              workspaceId={workspaceId}
              mergeBase={summary.mergeBase}
              viewMode={viewMode}
              expandAll={expandAll}
              focusedFile={focusedFile}
              onOpenFile={onOpenFile}
              onEditorViews={handleEditorViews}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
