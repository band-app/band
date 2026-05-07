import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { SearchQuery } from "@codemirror/search";
import { EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, WidgetType } from "@codemirror/view";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  PanelLeft,
  RefreshCw,
  Rows2,
  Search,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import { useIsDark } from "../hooks/use-is-dark";
import { useSearch } from "../hooks/use-search";
import { buildFileTree, flattenFileTreeOrder } from "../lib/build-file-tree";
import { baseViewerExtensions, loadLanguage, searchHighlightOnly } from "../lib/codemirror-setup";
import { formatFileLocation } from "../lib/file-location";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import { selectionToChatExtension } from "../lib/selection-to-chat";
import type { SSEEvent } from "../lib/sse";
import type { DiffMode, FileStatus, WorkspaceDiffSummary } from "../types";
import { ChangesFileTree } from "./ChangesFileTree";
import { FileStatusBadge } from "./FileStatusBadge";
import { RevertFileDialog } from "./RevertFileDialog";
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

const COMPARE_BRANCH_KEY_PREFIX = "band:diff-compare-branch:";

function getStoredCompareBranch(workspaceId: string): string | null {
  try {
    return localStorage.getItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId);
  } catch {
    return null;
  }
}

function storeCompareBranch(workspaceId: string, branch: string | null) {
  try {
    if (branch) {
      localStorage.setItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId, branch);
    } else {
      localStorage.removeItem(COMPARE_BRANCH_KEY_PREFIX + workspaceId);
    }
  } catch {}
}

const UNCOMMITTED_VALUE = "__uncommitted__";

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
  /** 1-based line numbers in newText where each hunk after the first begins. */
  newHunkBoundaryLines: number[];
  /** 1-based line numbers in oldText where each hunk after the first begins. */
  oldHunkBoundaryLines: number[];
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
  const newHunkBoundaryLines: number[] = [];
  const oldHunkBoundaryLines: number[] = [];

  let inHunk = false;
  let oldLineNum = 1;
  let newLineNum = 1;
  let hunkCount = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunkCount++;
      if (hunkCount > 1) {
        // Record the boundary: the next content line will start a new hunk
        newHunkBoundaryLines.push(newLines.length + 1);
        oldHunkBoundaryLines.push(oldLines.length + 1);
      }
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
    newHunkBoundaryLines,
    oldHunkBoundaryLines,
  };
}

// SVG chevron icons (24x24 viewBox, rendered at 14px)
const CHEVRON_UP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const CHEVRON_DOWN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

class HunkSeparatorWidget extends WidgetType {
  private onLoadMore: () => void;

  constructor(onLoadMore: () => void) {
    super();
    this.onLoadMore = onLoadMore;
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-hunk-separator";
    wrapper.title = "Expand context";
    wrapper.addEventListener("click", (e) => {
      e.preventDefault();
      this.onLoadMore();
    });

    // Arrow indicators in gutter area
    const gutter = document.createElement("div");
    gutter.className = "cm-hunk-separator-gutter";

    const upIcon = document.createElement("span");
    upIcon.className = "cm-hunk-separator-arrow";
    upIcon.innerHTML = CHEVRON_UP;

    const downIcon = document.createElement("span");
    downIcon.className = "cm-hunk-separator-arrow";
    downIcon.innerHTML = CHEVRON_DOWN;

    gutter.appendChild(upIcon);
    gutter.appendChild(downIcon);
    wrapper.appendChild(gutter);

    // Dashed line area
    const line = document.createElement("div");
    line.className = "cm-hunk-separator-line";
    wrapper.appendChild(line);

    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Creates a CodeMirror extension that inserts a clickable separator widget at
 * hunk boundaries. Clicking anywhere on the widget loads more context.
 */
function hunkSeparatorExtension(boundaryLines: number[], onLoadMore: () => void) {
  if (boundaryLines.length === 0) return [];
  return EditorView.decorations.compute(["doc"], (state) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const lineNum of boundaryLines) {
      if (lineNum >= 1 && lineNum <= state.doc.lines) {
        const lineStart = state.doc.line(lineNum).from;
        builder.add(
          lineStart,
          lineStart,
          Decoration.widget({ widget: new HunkSeparatorWidget(onLoadMore), side: -1, block: true }),
        );
      }
    }
    return builder.finish();
  });
}

const diffTheme = EditorView.theme({
  ".cm-insertedLine": { backgroundColor: "rgba(34, 197, 94, 0.1)" },
  ".cm-deletedLine": { backgroundColor: "rgba(239, 68, 68, 0.1)" },
  ".cm-hunk-separator": {
    display: "flex",
    alignItems: "stretch",
    height: "32px",
    cursor: "pointer",
    transition: "background-color 0.15s",
    "&:hover": {
      backgroundColor: "color-mix(in srgb, currentColor 5%, transparent)",
    },
    "&:hover .cm-hunk-separator-arrow": {
      color: "color-mix(in srgb, currentColor 70%, transparent)",
    },
    "&:hover .cm-hunk-separator-line": {
      backgroundImage:
        "linear-gradient(to right, color-mix(in srgb, currentColor 35%, transparent) 50%, transparent 50%)",
    },
  },
  ".cm-hunk-separator-gutter": {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: "4px",
    paddingRight: "4px",
    flexShrink: "0",
  },
  ".cm-hunk-separator-arrow": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "14px",
    color: "color-mix(in srgb, currentColor 30%, transparent)",
    transition: "color 0.15s",
  },
  ".cm-hunk-separator-line": {
    flex: "1",
    alignSelf: "center",
    height: "3px",
    backgroundImage:
      "linear-gradient(to right, color-mix(in srgb, currentColor 20%, transparent) 50%, transparent 50%)",
    backgroundSize: "8px 3px",
    backgroundRepeat: "repeat-x",
    backgroundPosition: "center",
    transition: "background-image 0.15s",
  },
});

function DiffFileContent({
  hunks,
  filename,
  viewMode,
  onEditorViews,
  onLoadMoreContext,
}: {
  hunks: string;
  filename: string;
  viewMode: ViewMode;
  onEditorViews?: (views: EditorView[]) => void;
  onLoadMoreContext?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);
  const isDark = useIsDark();

  // Use ref pattern so callback identity changes don't re-run the setup effect
  const onEditorViewsRef = useRef(onEditorViews);
  onEditorViewsRef.current = onEditorViews;
  const onLoadMoreRef = useRef(onLoadMoreContext);
  onLoadMoreRef.current = onLoadMoreContext;

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

      const {
        oldText,
        newText,
        oldLineNumbers,
        newLineNumbers,
        newHunkBoundaryLines,
        oldHunkBoundaryLines,
      } = parseDiff(hunks);

      const loadMore = () => onLoadMoreRef.current?.();

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
              hunkSeparatorExtension(oldHunkBoundaryLines, loadMore),
              selectionToChatExtension(filename, oldLineNumbers),
              ...sharedExtensions,
            ],
          },
          b: {
            doc: newText,
            extensions: [
              ...baseViewerExtensions(isDark, { skipLineNumbers: true }),
              makeLineNumbers(newLineNumbers),
              hunkSeparatorExtension(newHunkBoundaryLines, loadMore),
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
          hunkSeparatorExtension(newHunkBoundaryLines, loadMore),
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

// ---------------------------------------------------------------------------
// Lazy file row — renders diff from parent-provided cache
// ---------------------------------------------------------------------------

interface FileDiffCacheEntry {
  diff: string | null;
  loadingDiff: boolean;
  diffError: string | null;
  contextLines: number;
}

interface LazyFileRowProps {
  filename: string;
  status: FileStatus | undefined;
  cacheEntry: FileDiffCacheEntry | undefined;
  viewMode: ViewMode;
  expandAll: boolean;
  focusedFile: { path: string; seq: number } | null;
  isActive?: boolean;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  onToggleFile: (filename: string, isOpen: boolean) => void;
  onLoadMoreContext: (filename: string) => void;
  onShowFullFile: (filename: string) => void;
  onOpenFile?: (filename: string) => void;
  onRevertFile?: (filename: string) => void;
  onEditorViews?: (filename: string, views: EditorView[]) => void;
}

function LazyFileRow({
  filename,
  status,
  cacheEntry,
  viewMode,
  expandAll,
  focusedFile,
  isActive,
  scrollContainerRef,
  onToggleFile,
  onLoadMoreContext,
  onShowFullFile,
  onOpenFile,
  onRevertFile,
  onEditorViews,
}: LazyFileRowProps) {
  const [isOpen, setIsOpen] = useState(expandAll);
  const [copied, setCopied] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);

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

  // Notify parent of expansion state changes (triggers diff fetch for newly opened files)
  useEffect(() => {
    onToggleFile(filename, isOpen);
  }, [isOpen, filename, onToggleFile]);

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
      // Double rAF: first lets React commit, second lets layout complete
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.getElementById(`diff-file-${encodeURIComponent(filename)}`);
          const container = scrollContainerRef?.current;
          if (el && container) {
            const elTop = el.getBoundingClientRect().top;
            const containerTop = container.getBoundingClientRect().top;
            container.scrollTo({
              top: container.scrollTop + (elTop - containerTop),
              behavior: "instant",
            });
          }
        });
      });
    }
  }, [focusedFile, filename, scrollContainerRef]);

  const diff = cacheEntry?.diff ?? null;
  const diffError = cacheEntry?.diffError ?? null;
  const contextLines = cacheEntry?.contextLines ?? 3;

  const isUntracked = status === "U";
  const canLoadMore = !isUntracked && getNextContextStep(contextLines) !== null;

  return (
    <div
      id={`diff-file-${encodeURIComponent(filename)}`}
      className={`overflow-clip rounded-lg border-2 ${isActive ? "border-blue-500/60" : "border-border"}`}
    >
      <button
        type="button"
        onClick={toggle}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-muted px-4 py-2.5 text-left text-sm hover:bg-accent"
      >
        <span
          className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono [scrollbar-width:none]">
          {filename} <FileStatusBadge status={status} />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard.writeText(filename).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  navigator.clipboard.writeText(filename).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copied ? (
                <Check className="size-3.5 text-green-600 dark:text-green-400" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy file path</TooltipContent>
        </Tooltip>
        {onRevertFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRevertDialogOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    setRevertDialogOpen(true);
                  }
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Undo2 className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Revert file</TooltipContent>
          </Tooltip>
        )}
        {onOpenFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
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
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in code browser</TooltipContent>
          </Tooltip>
        )}
      </button>
      {onRevertFile && (
        <RevertFileDialog
          open={revertDialogOpen}
          onOpenChange={setRevertDialogOpen}
          onConfirm={() => {
            setRevertDialogOpen(false);
            onRevertFile(filename);
          }}
          filename={filename}
          fileStatus={status}
        />
      )}
      {isOpen && (
        <div className="border-t border-border/20 bg-muted/30">
          {diffError && <div className="px-4 py-4 text-sm text-destructive">{diffError}</div>}
          {diff !== null && (
            <>
              {canLoadMore && (
                <div className="flex items-center justify-center border-b border-border/20 px-4 py-1.5">
                  <button
                    type="button"
                    onClick={() => onShowFullFile(filename)}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Show full file
                  </button>
                </div>
              )}
              <DiffFileContent
                hunks={diff}
                filename={filename}
                viewMode={viewMode}
                onEditorViews={handleEditorViews}
                onLoadMoreContext={canLoadMore ? () => onLoadMoreContext(filename) : undefined}
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
  const summaryRef = useRef<WorkspaceDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchSummaryRef = useRef<((force?: boolean) => void) | null>(null);
  // Per-file diff cache owned by the parent — eliminates child-level caching
  const [diffCache, setDiffCache] = useState<Map<string, FileDiffCacheEntry>>(new Map());
  const diffCacheRef = useRef<Map<string, FileDiffCacheEntry>>(new Map());
  diffCacheRef.current = diffCache;
  // Tracks which files are currently expanded (ref to avoid stale closures)
  const expandedFilesRef = useRef<Set<string>>(new Set());
  // Fingerprint of the last fetched summary to detect actual data changes from SSE polls
  const prevFingerprintRef = useRef<string>("");
  const [viewMode, setViewModeState] = useState<ViewMode>(getStoredViewMode);
  const [diffMode, setDiffModeState] = useState<DiffMode>(getStoredDiffMode);
  const [expandAll, setExpandAllState] = useState(getStoredExpandAll);
  const [compareBranch, setCompareBranchState] = useState<string | null>(() =>
    getStoredCompareBranch(workspaceId),
  );
  // Seed `availableBranches` with the persisted selection so the picker shows
  // the stored branch immediately on mount, instead of flashing empty until
  // listWorkspaceBranches resolves.
  const [availableBranches, setAvailableBranches] = useState<string[]>(() => {
    const stored = getStoredCompareBranch(workspaceId);
    return stored ? [stored] : [];
  });
  const compareBranchRef = useRef(compareBranch);
  compareBranchRef.current = compareBranch;
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    storeViewMode(mode);
  }, []);
  const setDiffMode = useCallback((mode: DiffMode) => {
    setDiffModeState(mode);
    storeDiffMode(mode);
  }, []);
  const setCompareBranch = useCallback(
    (branch: string | null) => {
      setCompareBranchState(branch);
      storeCompareBranch(workspaceId, branch);
    },
    [workspaceId],
  );

  // Reload stored compareBranch + reseed availableBranches when workspace changes
  useEffect(() => {
    const stored = getStoredCompareBranch(workspaceId);
    setCompareBranchState(stored);
    setAvailableBranches(stored ? [stored] : []);
  }, [workspaceId]);

  // Fetch the list of branches and refresh on branch-status SSE events so a
  // `git checkout -b` from another tool (terminal, IDE) is reflected without
  // a full reload.
  useEffect(() => {
    const listWorkspaceBranches = adapter.listWorkspaceBranches;
    if (!listWorkspaceBranches) return;
    let cancelled = false;

    const fetchBranches = () => {
      listWorkspaceBranches
        .call(adapter, workspaceId)
        .then((result) => {
          if (cancelled) return;
          setAvailableBranches(result.branches);
          // Drop the stored selection if it no longer exists. Read the latest
          // value from a ref so this stays a pure check (no side effects in
          // the setState updater) and avoids stale-closure issues.
          const current = compareBranchRef.current;
          if (current && !result.branches.includes(current)) {
            setCompareBranch(null);
          }
        })
        .catch(() => {
          // Leave existing availableBranches in place on error — the server
          // logs the underlying failure in listBranches.
        });
    };

    fetchBranches();

    let unsubscribe: (() => void) | undefined;
    if (active) {
      unsubscribe = adapter.subscribeStatusEvents((event) => {
        const data = event as SSEEvent;
        if (data.kind === "branch-status" && data.workspaceId === workspaceId) {
          fetchBranches();
        }
      });
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [adapter, workspaceId, active, setCompareBranch]);
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
  // Scroll container ref — used for scroll-to-file and tree sync
  // -------------------------------------------------------------------------
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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

  // Track which file diff is currently in view for tree sidebar highlighting
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when summary changes so the listener is set up after the scroll container mounts
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const names = filenamesRef.current;
        if (names.length === 0) return;
        const rect = container.getBoundingClientRect();
        const EDGE_BUFFER = 40;

        // If scrolled near the top, always select the first file
        if (container.scrollTop <= EDGE_BUFFER) {
          setActiveFile((prev) => (prev === names[0] ? prev : names[0]));
          return;
        }
        // If scrolled near the bottom, always select the last file
        if (container.scrollHeight - container.scrollTop - container.clientHeight <= EDGE_BUFFER) {
          const last = names[names.length - 1];
          setActiveFile((prev) => (prev === last ? prev : last));
          return;
        }

        const center = rect.top + rect.height / 2;
        let closest: string | null = null;
        let closestDist = Infinity;
        for (const name of names) {
          const el = document.getElementById(`diff-file-${encodeURIComponent(name)}`);
          if (!el) continue;
          const elRect = el.getBoundingClientRect();
          // If the element spans the center, it's the active file
          if (elRect.top <= center && elRect.bottom >= center) {
            closest = name;
            break;
          }
          // Otherwise, pick the one whose edge is closest to center
          const dist = Math.min(Math.abs(elRect.top - center), Math.abs(elRect.bottom - center));
          if (dist < closestDist) {
            closestDist = dist;
            closest = name;
          }
        }
        setActiveFile((prev) => (prev === closest ? prev : closest));
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Set initial active file on mount
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [summary]);

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
  // Per-file diff cache callbacks
  // -------------------------------------------------------------------------

  const fetchFileDiff = useCallback(
    (filename: string, mergeBase?: string, contextLines = 3) => {
      const getFileDiff = adapter.getFileDiff;
      if (!getFileDiff) return;

      const effectiveMergeBase = mergeBase ?? summaryRef.current?.mergeBase;
      if (!effectiveMergeBase) return;

      // Only mark as loading when there's no cached diff yet (initial load).
      // During refresh the existing content stays visible.
      const existingDiff = diffCacheRef.current.get(filename)?.diff ?? null;
      if (existingDiff === null) {
        setDiffCache((prev) => {
          const next = new Map(prev);
          next.set(filename, {
            diff: null,
            loadingDiff: true,
            diffError: null,
            contextLines,
          });
          return next;
        });
      }

      getFileDiff
        .call(
          adapter,
          workspaceId,
          filename,
          effectiveMergeBase,
          contextLines > 3 ? contextLines : undefined,
        )
        .then((result) => {
          setDiffCache((prev) => {
            const existing = prev.get(filename);
            // Skip state update if the diff content hasn't changed
            if (
              existing &&
              existing.diff === result.diff &&
              !existing.loadingDiff &&
              !existing.diffError &&
              existing.contextLines === contextLines
            ) {
              return prev;
            }
            const next = new Map(prev);
            next.set(filename, {
              diff: result.diff,
              loadingDiff: false,
              diffError: null,
              contextLines,
            });
            return next;
          });
        })
        .catch((err) => {
          setDiffCache((prev) => {
            const next = new Map(prev);
            const existing = prev.get(filename);
            next.set(filename, {
              diff: existing?.diff ?? null,
              loadingDiff: false,
              diffError: err instanceof Error ? err.message : "Failed to load diff",
              contextLines: existing?.contextLines ?? contextLines,
            });
            return next;
          });
        });
    },
    [adapter, workspaceId],
  );

  const handleToggleFile = useCallback(
    (filename: string, isOpen: boolean) => {
      if (isOpen) {
        expandedFilesRef.current.add(filename);
        if (!diffCacheRef.current.has(filename)) {
          fetchFileDiff(filename);
        }
      } else {
        expandedFilesRef.current.delete(filename);
      }
    },
    [fetchFileDiff],
  );

  const handleLoadMoreContext = useCallback(
    (filename: string) => {
      const entry = diffCacheRef.current.get(filename);
      const current = entry?.contextLines ?? 3;
      const next = getNextContextStep(current);
      if (next !== null) {
        fetchFileDiff(filename, undefined, next);
      }
    },
    [fetchFileDiff],
  );

  const handleShowFullFile = useCallback(
    (filename: string) => {
      fetchFileDiff(filename, undefined, 99999);
    },
    [fetchFileDiff],
  );

  const handleRevertFile = useCallback(
    (filename: string) => {
      const revertFile = adapter.revertFile;
      if (!revertFile) return;

      revertFile
        .call(adapter, workspaceId, filename, diffMode, compareBranch ?? undefined)
        .then(() => {
          // Remove from diff cache
          setDiffCache((prev) => {
            const next = new Map(prev);
            next.delete(filename);
            return next;
          });
          expandedFilesRef.current.delete(filename);
          // Force refresh to update the file list
          fetchSummaryRef.current?.(true);
        })
        .catch((err) => {
          console.error("Failed to revert file:", err);
        });
    },
    [adapter, workspaceId, diffMode, compareBranch],
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
    summaryRef.current = null;
    // Clear diff cache when this effect re-runs (e.g. diffMode change)
    setDiffCache(new Map());
    expandedFilesRef.current = new Set();
    prevFingerprintRef.current = "";

    const fetchSummary = (forceRefresh = false) => {
      getWorkspaceDiffSummary
        .call(adapter, workspaceId, diffMode, compareBranch ?? undefined)
        .then((result) => {
          if (!cancelled) {
            const fingerprint = JSON.stringify({
              fileStatuses: result.fileStatuses,
              stats: result.stats,
              mergeBase: result.mergeBase,
            });

            const dataChanged = fingerprint !== prevFingerprintRef.current;
            prevFingerprintRef.current = fingerprint;

            // Update summary ref before triggering re-fetches so fetchFileDiff
            // reads the new mergeBase
            summaryRef.current = result;
            // Only update state when the summary actually changed to avoid
            // re-rendering the entire file list with identical content.
            if (dataChanged) {
              setSummary(result);
            }
            setError(null);

            // Re-fetch expanded files when data changed or forced.
            // Keep existing cache entries so content doesn't flash —
            // fetchFileDiff will skip the state update if the diff is unchanged.
            if (forceRefresh || dataChanged) {
              // Remove cache entries for files that no longer exist in the summary
              setDiffCache((prev) => {
                let changed = false;
                const next = new Map(prev);
                for (const key of next.keys()) {
                  if (!result.fileStatuses[key]) {
                    next.delete(key);
                    changed = true;
                  }
                }
                return changed ? next : prev;
              });

              // Re-fetch for currently expanded files with preserved context levels
              for (const filename of expandedFilesRef.current) {
                if (result.fileStatuses[filename]) {
                  const entry = diffCacheRef.current.get(filename);
                  fetchFileDiff(filename, result.mergeBase, entry?.contextLines ?? 3);
                }
              }
            }

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

    fetchSummaryRef.current = fetchSummary;
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
      fetchSummaryRef.current = null;
      unsubscribe?.();
    };
  }, [adapter, workspaceId, active, onStatsChange, diffMode, compareBranch, fetchFileDiff]);

  // ---------------------------------------------------------------------------
  // Diff target dropdown — combines diff mode + branch selection into one menu
  // ---------------------------------------------------------------------------
  const summaryCompareBranch = summary?.compareBranch ?? null;
  const branchOptions =
    availableBranches.length > 0
      ? availableBranches
      : summaryCompareBranch
        ? [summaryCompareBranch]
        : [];
  const selectedBranch = compareBranch ?? branchOptions[0] ?? summaryCompareBranch;
  const diffSelectValue =
    diffMode === "uncommitted" ? UNCOMMITTED_VALUE : (selectedBranch ?? UNCOMMITTED_VALUE);

  const handleDiffSelectChange = (value: string) => {
    if (value === UNCOMMITTED_VALUE) {
      setDiffMode("uncommitted");
    } else {
      setDiffMode("branch");
      setCompareBranch(value);
    }
  };

  const renderDiffSelect = () => (
    <Select value={diffSelectValue} onValueChange={handleDiffSelectChange}>
      <SelectTrigger className="h-7 w-auto gap-1 rounded-md border-border/50 bg-muted/50 px-2.5 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNCOMMITTED_VALUE}>Uncommitted</SelectItem>
        {branchOptions.map((branch) => (
          <SelectItem key={branch} value={branch}>
            {branch}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

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
          {renderDiffSelect()}
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No changes
        </div>
      </div>
    );
  }

  const fileStatuses = summary.fileStatuses || {};
  const filenames = flattenFileTreeOrder(buildFileTree(fileStatuses));
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
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-xs font-medium text-muted-foreground">Files</span>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              title="Hide file tree"
            >
              <PanelLeft className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <ChangesFileTree
              fileStatuses={fileStatuses}
              onSelectFile={handleScrollToFile}
              activeFile={activeFile}
            />
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
                <PanelLeft className="size-3.5" />
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
                {summary.compareBranch} &larr; {summary.headBranch}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fetchSummaryRef.current?.(true)}
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
            {renderDiffSelect()}
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
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">
            {filenames.map((filename) => (
              <LazyFileRow
                key={filename}
                filename={filename}
                status={fileStatuses[filename]}
                cacheEntry={diffCache.get(filename)}
                viewMode={viewMode}
                expandAll={expandAll}
                focusedFile={focusedFile}
                isActive={activeFile === filename}
                scrollContainerRef={scrollContainerRef}
                onToggleFile={handleToggleFile}
                onLoadMoreContext={handleLoadMoreContext}
                onShowFullFile={handleShowFullFile}
                onOpenFile={onOpenFile}
                onRevertFile={adapter.revertFile ? handleRevertFile : undefined}
                onEditorViews={handleEditorViews}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
