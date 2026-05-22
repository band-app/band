import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { SearchQuery } from "@codemirror/search";
import { EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, WidgetType } from "@codemirror/view";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  GitCommit,
  MoreVertical,
  PanelLeft,
  RefreshCw,
  Rows2,
  Search,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAdapter } from "../context";
import { readStoredCompareBranch, useDiffTarget } from "../hooks/use-diff-target";
import { useIsDark } from "../hooks/use-is-dark";
import { useProjectKindForWorkspace } from "../hooks/use-project-kind";
import { useSearch } from "../hooks/use-search";
import { buildFileTree, flattenFileTreeOrder } from "../lib/build-file-tree";
import { baseViewerExtensions, loadLanguage, searchHighlightOnly } from "../lib/codemirror-setup";
import { countDiffLines, type DiffLineCounts, diffContentHeight } from "../lib/diff-row-height";
import { formatFileLocation } from "../lib/file-location";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import { selectionToChatExtension } from "../lib/selection-to-chat";
import type { SSEEvent } from "../lib/sse";
import type { FileStatus, WorkspaceDiffSummary } from "../types";
import { ChangesFileTree } from "./ChangesFileTree";
import { CommitDialog } from "./CommitDialog";
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

// Stable reference for the "no changes" fileStatuses object. Using a fresh
// `{}` literal on every render makes downstream memos / effects keyed on
// the object reference re-fire every render even though the underlying
// value is the same — minor work, but worth eliminating since it's
// trivially fixable.
const EMPTY_FILE_STATUSES: Record<string, FileStatus> = {};

// ---------------------------------------------------------------------------
// Lazy file row — renders diff from parent-provided cache
// ---------------------------------------------------------------------------

interface FileDiffCacheEntry {
  diff: string | null;
  loadingDiff: boolean;
  diffError: string | null;
  contextLines: number;
  /**
   * Pre-computed line counts so the row-height estimator runs in O(1)
   * rather than re-parsing the diff string on every virtualizer query.
   * `null` while the diff is still loading or has errored.
   */
  lineCounts: DiffLineCounts | null;
}

interface LazyFileRowProps {
  filename: string;
  status: FileStatus | undefined;
  cacheEntry: FileDiffCacheEntry | undefined;
  viewMode: ViewMode;
  /**
   * Whether this row's diff is expanded. Lifted to the parent so the user's
   * toggle persists even if a future change unmounts the row.
   */
  isOpen: boolean;
  isActive?: boolean;
  /**
   * Scroll container element used as the IntersectionObserver root so the
   * mount detection is scoped to THIS DiffView's viewport. Passed as a
   * state value (rather than a ref) so a `null` → element transition on
   * first paint actually re-runs the observer effect — with a ref the
   * transition is invisible to React and the observer stays bound to the
   * window viewport, which falsely flags rows in hidden sibling panels
   * (kept alive by MultiWorkspacePanelHost) as visible and mounts
   * CodeMirror editors the user can't even see.
   */
  scrollContainerEl: HTMLDivElement | null;
  onToggle: (filename: string) => void;
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
  isOpen,
  isActive,
  scrollContainerEl,
  onToggle,
  onLoadMoreContext,
  onShowFullFile,
  onOpenFile,
  onRevertFile,
  onEditorViews,
}: LazyFileRowProps) {
  const [copied, setCopied] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether this row's CodeMirror editor should be mounted right now.
  // Driven by an IntersectionObserver scoped to the scroll container: we
  // mount when the row is within `rootMargin` of the viewport (so editors
  // are ready by the time the user scrolls to them), and unmount once it
  // leaves that zone so a workspace with 100+ expanded diffs only ever
  // pays for the handful of editors actually near the screen.
  const [shouldMount, setShouldMount] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setShouldMount(false);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    // Wait for the scroll container to be in the DOM before subscribing —
    // otherwise IntersectionObserver falls back to the window viewport,
    // which doesn't match the actual scroll region. The state dependency
    // re-runs this effect when the container element transitions
    // null → real DOM node on first paint.
    if (!scrollContainerEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setShouldMount(entry.isIntersecting);
      },
      {
        root: scrollContainerEl,
        // ~one full viewport of overscan above and below — wide enough to
        // hide the mount latency of a fast scroll, narrow enough that we
        // don't pay for editors the user is unlikely to read.
        rootMargin: "800px 0px",
        threshold: 0,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen, scrollContainerEl]);

  const handleEditorViews = useCallback(
    (views: EditorView[]) => {
      onEditorViews?.(filename, views);
    },
    [filename, onEditorViews],
  );

  // Drop the row's editor views from the parent registry whenever the
  // CodeMirror instance unmounts — that covers both the "collapsed" and
  // "scrolled away" cases via the cleanup return. `collectAllMatches`
  // (the search backend) reads from that registry, so a stale entry
  // would dispatch into a destroyed view.
  //
  // The cleanup-only pattern avoids the double-clear we'd get if we also
  // called the clear in the early-return body: React's effect lifecycle
  // would run the previous render's cleanup AND the new body, hitting
  // the parent twice on every collapse / mount-toggle.
  useEffect(() => {
    if (!isOpen || !shouldMount) return;
    return () => {
      onEditorViews?.(filename, []);
    };
  }, [isOpen, shouldMount, filename, onEditorViews]);

  const toggle = useCallback(() => {
    onToggle(filename);
  }, [filename, onToggle]);

  const diff = cacheEntry?.diff ?? null;
  const diffError = cacheEntry?.diffError ?? null;
  const contextLines = cacheEntry?.contextLines ?? 3;

  const isUntracked = status === "U";
  const canLoadMore = !isUntracked && getNextContextStep(contextLines) !== null;

  // Placeholder height for the diff-content area when CodeMirror isn't
  // mounted. Returns 0 (no reserved space) until line counts arrive —
  // there's no useful estimate before that, and the row simply grows from
  // header-only to full size when the diff lands.
  const placeholderHeight = useMemo(() => {
    if (!isOpen || !cacheEntry?.lineCounts) return 0;
    return diffContentHeight(cacheEntry.lineCounts, viewMode, canLoadMore);
  }, [isOpen, cacheEntry, viewMode, canLoadMore]);

  return (
    <div
      ref={containerRef}
      data-band-diff-file={filename}
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
          {diff !== null &&
            (shouldMount ? (
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
            ) : (
              // Placeholder occupying the SAME pixel height the CodeMirror
              // editor would render at, so the row's overall size doesn't
              // change when the observer mounts/unmounts the editor. Without
              // this, scrolling past a row would collapse it back to header
              // size and push everything below upward — visually identical
              // to a layout shift, even though no content actually moved.
              <div aria-hidden style={{ height: placeholderHeight }} />
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/**
 * Collect every search match across the currently-mounted CodeMirror views,
 * traversed in `filenames` order so the match counter ("3 of 17") is
 * stable across navigations.
 *
 * KNOWN LIMITATION (introduced by virtualization, issue #489): only mounted
 * rows contribute matches. A file that's marked "expanded" but scrolled
 * far enough offscreen to be virtualized away has no live `EditorView`,
 * so its diff isn't searched until the user scrolls it back into view.
 * This is a deliberate trade-off — the alternative was keeping dozens of
 * `MergeView` instances alive at once, which made scrolling unusably
 * janky on large workspaces.
 */
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
  // Look up the project's kind so we can short-circuit the diff fetch
  // for plain (non-git) projects — `git diff` against a folder without
  // a `.git` directory would otherwise surface as a raw error in the
  // Changes view. The lookup is centralised in `useProjectKindMap` so
  // multiple mounted DiffView instances share a single O(projects ×
  // worktrees) scan; per-instance the cost is a Map.get(). Returns
  // `undefined` while `useProjects()` is loading — the effect below
  // skips the diff fetch in that window. See #427.
  const projectKind = useProjectKindForWorkspace(workspaceId);
  const isPlain = projectKind === "plain";
  const [summary, setSummary] = useState<WorkspaceDiffSummary | null>(null);
  const summaryRef = useRef<WorkspaceDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchSummaryRef = useRef<((force?: boolean) => void) | null>(null);
  // Ref to the latest `fetchBranches` body. The SSE subscription effect
  // (separate from the initial-fetch effect so it can be keyed on `active`
  // without re-running the data fetch on every cache-driven activation)
  // reads this to invoke the latest closure. See issue #484.
  const fetchBranchesRef = useRef<(() => void) | null>(null);
  // Tracks the previous `active` value so the SSE subscription effects
  // below can detect a `false → true` transition and fire one immediate
  // refresh — the inactive period meant we missed any branch-status
  // events, so the cached data might be stale. Initial value `null`
  // distinguishes "first run" (no refresh needed, the data-fetch effect
  // covers it) from "was-inactive → now-active" (refresh).
  const prevActiveRef = useRef<boolean | null>(null);
  // Per-file diff cache owned by the parent — eliminates child-level caching
  const [diffCache, setDiffCache] = useState<Map<string, FileDiffCacheEntry>>(new Map());
  const diffCacheRef = useRef<Map<string, FileDiffCacheEntry>>(new Map());
  diffCacheRef.current = diffCache;
  // Tracks which files are currently expanded. State (not just a ref) because
  // it drives `isOpen` on each LazyFileRow — virtualization unmounts and
  // remounts rows as they scroll in/out of view, so this state has to live
  // here in the parent for the open/closed status to survive the round trip.
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  // Ref mirror so callbacks (fetchFileDiff, fetchSummary, expandAll toggle)
  // can read the latest set without depending on the state. The fetch effect
  // in particular fires on summary refresh and must see the current expansion
  // set to re-request diffs for files that should still be open.
  const expandedFilesRef = useRef<Set<string>>(expandedFiles);
  expandedFilesRef.current = expandedFiles;
  // Fingerprint of the last fetched summary to detect actual data changes from SSE polls
  const prevFingerprintRef = useRef<string>("");
  const [viewMode, setViewModeState] = useState<ViewMode>(getStoredViewMode);
  const [expandAll, setExpandAllState] = useState(getStoredExpandAll);
  // `diffMode` and `compareBranch` are owned by a shared hook so that other
  // subscribers (e.g. the Changes-tab badge in the workspace layout) re-read
  // the same target when the user changes it here. See issue #396.
  const { diffMode, compareBranch, setDiffMode, setCompareBranch } = useDiffTarget(workspaceId);
  // Seed `availableBranches` with the persisted selection so the picker shows
  // the stored branch immediately on mount, instead of flashing empty until
  // listWorkspaceBranches resolves.
  const [availableBranches, setAvailableBranches] = useState<string[]>(() => {
    const stored = readStoredCompareBranch(workspaceId);
    return stored ? [stored] : [];
  });
  // The project's default branch, fetched via listWorkspaceBranches. We track
  // it independently of the diff summary so the dropdown can pin the default
  // (e.g. `main`) to the top section even before the summary loads.
  const [availableDefaultBranch, setAvailableDefaultBranch] = useState<string | null>(null);
  const compareBranchRef = useRef(compareBranch);
  compareBranchRef.current = compareBranch;
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    storeViewMode(mode);
  }, []);

  // Reseed availableBranches when workspace changes — `useDiffTarget` already
  // re-reads the stored compareBranch internally, but availableBranches and
  // availableDefaultBranch belong to this component and need a manual reset.
  useEffect(() => {
    const stored = readStoredCompareBranch(workspaceId);
    setAvailableBranches(stored ? [stored] : []);
    setAvailableDefaultBranch(null);
  }, [workspaceId]);

  // Fetch the list of branches. This effect is intentionally NOT keyed on
  // `active` — the workspace's panel may flip between active/inactive when
  // the user switches workspaces, but the cached panel stays mounted (see
  // MultiWorkspacePanelHost). Re-running the initial fetch on every
  // re-activation would issue redundant `listWorkspaceBranches` requests.
  // The SSE auto-refresh subscription is split into a separate effect below
  // so the listener can come and go with `active` while the data fetch runs
  // only once per workspace. See issue #484.
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
          setAvailableDefaultBranch(result.defaultBranch);
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

    fetchBranchesRef.current = fetchBranches;
    fetchBranches();

    return () => {
      cancelled = true;
      // Null out the ref so a late SSE callback can't invoke a stale
      // closure after we've moved on. The window between this cleanup and
      // the next effect body re-assigning the ref is brief — the
      // subscription effect below shares the same `[adapter, workspaceId]`
      // deps, so it's also tearing down and re-attaching for the same
      // change, and any branch-status events that fire in between would
      // be ignored by both sides anyway.
      fetchBranchesRef.current = null;
    };
  }, [adapter, workspaceId, setCompareBranch]);

  // Subscribe to branch-status SSE events for the active workspace so a
  // `git checkout -b` from another tool (terminal, IDE) is reflected without
  // a full reload. Only attached while `active === true`: inactive cached
  // workspaces don't keep listening to SSE we'd discard anyway.
  //
  // On `active: false → true` we also fire one immediate refresh to close
  // the staleness window — while the panel was inactive the SSE
  // subscription was detached, so any agent edits / terminal `git`
  // operations made during that period haven't refreshed the list yet. The
  // re-activation detection lives in a single effect (below) shared with
  // the summary refresh, so we don't try to coordinate `prevActiveRef`
  // across two siblings.
  useEffect(() => {
    if (!active) return;
    const unsubscribe = adapter.subscribeStatusEvents((event) => {
      const data = event as SSEEvent;
      if (data.kind === "branch-status" && data.workspaceId === workspaceId) {
        fetchBranchesRef.current?.();
      }
    });
    return unsubscribe;
  }, [adapter, workspaceId, active]);
  // NOTE: the `setExpandAll` callback (toolbar button + dropdown item) is
  // declared further down — it needs `fetchFileDiff` in scope to eagerly
  // request diffs for newly-expanded files, and TypeScript's TDZ check
  // doesn't let us forward-reference it. See "Expand-all callback" below.
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
  // Two-shaped binding for the scroll container: a ref (for synchronous
  // reads inside event handlers and effects) and a state slot (so child
  // rows can subscribe to the moment the element becomes available).
  // LazyFileRow's IntersectionObserver needs the DOM node as its `root`,
  // and capturing it through the ref alone risks setting up the observer
  // while the ref is still null on first paint — making `root: null` fall
  // back to the window viewport, which in turn falsely flags rows inside
  // hidden sibling panels as visible.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const setScrollContainerNode = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainerEl(node);
  }, []);

  // -------------------------------------------------------------------------
  // Root ref — used for the workspace-level ⇧⌘G "focus Changes" handler
  // to scope its querySelector to this DiffView instance.
  // -------------------------------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);

  // Listen for ⇧⌘G "focus Changes". Multiple workspaces' DiffViews
  // are mounted simultaneously; the offsetParent check filters down
  // to the visible instance. Prefer the active file row
  // (data-band-active marked in ChangesFileTree); fall back to the
  // first focusable button inside the [data-diff-sidebar] tree.
  useEffect(() => {
    const handler = () => {
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      const sidebar = root.querySelector<HTMLElement>("[data-diff-sidebar]") ?? root;
      const target =
        sidebar.querySelector<HTMLElement>("[data-band-active]") ??
        sidebar.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
    };
    window.addEventListener("band:focus-changes", handler);
    return () => window.removeEventListener("band:focus-changes", handler);
  }, []);

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

  // Track which file diff is currently in view for tree sidebar highlighting
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const handleScrollToFile = useCallback((filePath: string) => {
    focusSeqRef.current += 1;
    setFocusedFile({ path: filePath, seq: focusSeqRef.current });
    // Commit the tree highlight immediately so the user sees their click
    // take effect, instead of waiting for the scroll handler to derive it
    // from `scrollTop` once the row has finished expanding.
    setActiveFile(filePath);
  }, []);

  // Commit dialog — only available when the adapter exposes the commit
  // endpoint (web/desktop). Hidden behind a guard so embedded contexts can
  // omit the action without breaking the toolbar layout.
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const canCommit = Boolean(adapter.gitCommitWorkspace);

  // Pull / push status — surfaced inline as a small banner above the bottom
  // status bar so the user gets feedback without an interrupting modal.
  const canPull = Boolean(adapter.gitPullWorkspace);
  const canPush = Boolean(adapter.gitPushWorkspace);
  const [gitOpStatus, setGitOpStatus] = useState<
    | { state: "running"; op: "pull" | "push" }
    | { state: "success"; op: "pull" | "push" }
    | { state: "error"; op: "pull" | "push"; message: string }
    | null
  >(null);

  const handleGitPull = useCallback(async () => {
    const pull = adapter.gitPullWorkspace;
    if (!pull) return;
    setGitOpStatus({ state: "running", op: "pull" });
    try {
      await pull.call(adapter, workspaceId);
      setGitOpStatus({ state: "success", op: "pull" });
      // Pull may have advanced HEAD — refresh the diff so the change set
      // reflects the new merge base.
      fetchSummaryRef.current?.(true);
      // Auto-clear the success banner after a couple of seconds; errors
      // stay until dismissed.
      setTimeout(() => {
        setGitOpStatus((prev) =>
          prev && prev.state === "success" && prev.op === "pull" ? null : prev,
        );
      }, 2500);
    } catch (e) {
      setGitOpStatus({
        state: "error",
        op: "pull",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [adapter, workspaceId]);

  const handleGitPush = useCallback(async () => {
    const push = adapter.gitPushWorkspace;
    if (!push) return;
    setGitOpStatus({ state: "running", op: "push" });
    try {
      await push.call(adapter, workspaceId);
      setGitOpStatus({ state: "success", op: "push" });
      // Push doesn't change the local diff, but the branch-status SSE poll
      // will pick up the new ahead/behind state shortly. No forced refresh
      // needed.
      setTimeout(() => {
        setGitOpStatus((prev) =>
          prev && prev.state === "success" && prev.op === "push" ? null : prev,
        );
      }, 2500);
    } catch (e) {
      setGitOpStatus({
        state: "error",
        op: "push",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [adapter, workspaceId]);

  const gitOpBusy = gitOpStatus?.state === "running";
  const isPulling = gitOpBusy && gitOpStatus.op === "pull";
  const isPushing = gitOpBusy && gitOpStatus.op === "push";

  // Track the scroll container's visible height + width:
  // - height sizes the trailing spacer so the last file can be scrolled to
  //   the top of the viewport even when its content is shorter than the
  //   visible area;
  // - width is used to force unified diff mode below SPLIT_VIEW_MIN_WIDTH —
  //   side-by-side splits are unreadable in narrow panels (mobile-style).
  const [scrollContainerHeight, setScrollContainerHeight] = useState<number>(0);
  const [scrollContainerWidth, setScrollContainerWidth] = useState<number>(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when summary changes so the observer is set up after the scroll container mounts (it lives behind a loading/empty-state guard)
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const update = () => {
      setScrollContainerHeight(container.clientHeight);
      setScrollContainerWidth(container.clientWidth);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [summary]);

  // Below this width (in CSS px) the diff renders as unified regardless of the
  // user's selected viewMode — split would just produce two unreadable columns.
  const SPLIT_VIEW_MIN_WIDTH = 640;
  const effectiveViewMode: ViewMode =
    scrollContainerWidth > 0 && scrollContainerWidth < SPLIT_VIEW_MIN_WIDTH ? "unified" : viewMode;

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
            lineCounts: null,
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
              existing.contextLines === contextLines &&
              existing.lineCounts !== null
            ) {
              return prev;
            }
            const next = new Map(prev);
            next.set(filename, {
              diff: result.diff,
              loadingDiff: false,
              diffError: null,
              contextLines,
              // Pre-compute line counts now (off the render path) so the
              // virtualizer's estimateSize stays O(1) when it's called
              // repeatedly during scroll.
              lineCounts: countDiffLines(result.diff),
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
              lineCounts: existing?.lineCounts ?? null,
            });
            return next;
          });
        });
    },
    [adapter, workspaceId],
  );

  const handleToggleFile = useCallback(
    (filename: string) => {
      // React 18 Strict Mode invokes state updaters TWICE in development as
      // an impurity check, so the fetch can't live inside the updater
      // closure — it would fire two `getFileDiff` requests per toggle.
      // Compute the "did we just open it?" signal inside the updater
      // (using `diffCacheRef`, which IS pure), then issue the fetch
      // outside.
      //
      // Race note: rapid open/close/open clicks before the first fetch
      // resolves can both see `diffCacheRef.current.has(filename) === false`
      // and dispatch two `fetchFileDiff` calls. The duplicate is harmless —
      // `fetchFileDiff`'s `.then` overwrites the cache idempotently and
      // skips the state update if the diff string hasn't changed — so we
      // don't try to de-dupe at the call site.
      let shouldFetch = false;
      setExpandedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(filename)) {
          next.delete(filename);
        } else {
          next.add(filename);
          shouldFetch = !diffCacheRef.current.has(filename);
        }
        return next;
      });
      if (shouldFetch) fetchFileDiff(filename);
    },
    [fetchFileDiff],
  );

  // Expand-all callback. Lives here (rather than next to the rest of the
  // boolean toggles up top) because it needs `fetchFileDiff` in scope to
  // pre-warm diffs for newly-expanded files. With expansion lifted into
  // the parent for virtualization safety, this also has to materially
  // update `expandedFiles` instead of relying on a per-row `useEffect`.
  const setExpandAll = useCallback(
    (v: boolean) => {
      setExpandAllState(v);
      storeExpandAll(v);
      if (v) {
        const names = filenamesRef.current;
        setExpandedFiles(new Set(names));
        // Eagerly start fetches so newly-mounted rows have data ready when
        // they scroll into view. Without this, the user would briefly see
        // a blank diff body after each scroll-mount until fetchFileDiff
        // resolved.
        //
        // KNOWN LIMITATION: on a workspace with hundreds of changed
        // files this fires hundreds of concurrent `getFileDiff` requests.
        // Modern browsers cap HTTP/1.1 at 6 sockets per origin and queue
        // the rest, so we never blow past the network — but the adapter
        // (and any backing process / git invocation) will see a burst.
        // Acceptable for typical workspace sizes (≪100 files);
        // throttling would belong in the adapter layer if it becomes a
        // real problem, since per-file deduplication already lives in
        // `fetchFileDiff` via the diffCacheRef check below.
        for (const name of names) {
          if (!diffCacheRef.current.has(name)) {
            fetchFileDiff(name);
          }
        }
      } else {
        setExpandedFiles(new Set());
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
          setExpandedFiles((prev) => {
            if (!prev.has(filename)) return prev;
            const next = new Set(prev);
            next.delete(filename);
            return next;
          });
          // Force refresh to update the file list
          fetchSummaryRef.current?.(true);
        })
        .catch((err) => {
          console.error("Failed to revert file:", err);
        });
    },
    [adapter, workspaceId, diffMode, compareBranch],
  );

  /**
   * Reset every path in the list. Used by ChangesFileTree's right-click
   * "Reset changes" — for a folder right-click the caller collects every
   * leaf file path under that folder and passes them all here so they're
   * reverted together. We revert in parallel and only refresh the
   * summary once at the end so the UI doesn't flicker through N partial
   * states.
   */
  const handleRevertPaths = useCallback(
    async (paths: string[]) => {
      const revertFile = adapter.revertFile;
      if (!revertFile || paths.length === 0) return;

      const results = await Promise.allSettled(
        paths.map((p) =>
          revertFile.call(adapter, workspaceId, p, diffMode, compareBranch ?? undefined),
        ),
      );

      // Drop reverted entries from local cache.
      setDiffCache((prev) => {
        const next = new Map(prev);
        for (const p of paths) next.delete(p);
        return next;
      });
      setExpandedFiles((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const p of paths) {
          if (next.delete(p)) changed = true;
        }
        return changed ? next : prev;
      });

      // Refresh the summary so file rows reflect their new (or absent) state.
      fetchSummaryRef.current?.(true);

      // Surface any partial failures so the user knows something didn't
      // get reset. Individual failures don't roll back the rest — git's
      // own atomicity is per-file anyway.
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("Failed to revert path:", r.reason);
        }
      }
    },
    [adapter, workspaceId, diffMode, compareBranch],
  );

  // -------------------------------------------------------------------------
  // Fetch diff summary
  // -------------------------------------------------------------------------

  useEffect(() => {
    const getWorkspaceDiffSummary = adapter.getWorkspaceDiffSummary;
    if (!getWorkspaceDiffSummary) return;
    // Plain (non-git) projects have no diff to fetch — the dedicated render
    // branch below shows a calm "folder is not a git repo" message instead
    // of bouncing the user off `git diff` errors from the server.
    if (isPlain) {
      setLoading(false);
      setSummary(null);
      summaryRef.current = null;
      setError(null);
      onStatsChange?.(null);
      return;
    }
    // `projectKind` is `undefined` until `useProjects()` resolves. Without
    // this guard the effect fires immediately on mount with `isPlain ===
    // false` and issues a getDiffSummary call before we know whether this
    // workspace's project is plain — the server now returns an empty
    // summary in that case, but it's a wasted round-trip and a brief
    // loading flicker. Skip until projects arrive.
    if (projectKind === undefined) return;

    let cancelled = false;
    setLoading(true);
    setSummary(null);
    summaryRef.current = null;
    // Clear diff cache when this effect re-runs (e.g. diffMode change)
    setDiffCache(new Map());
    setExpandedFiles(new Set());
    // Reset the "previously-seen filenames" record too — otherwise after a
    // ref switch (diffMode / compareBranch), any filename that exists in
    // both the old AND new targets (e.g. src/index.ts modified on both
    // main and dev) would NOT count as "new" and the expand-all
    // auto-expand effect would silently skip it.
    prevFilenamesRef.current = new Set();
    prevFingerprintRef.current = "";

    // INVARIANT: `fetchSummary` MUST NOT call `setLoading(true)`. The
    // re-activation effect (see "Re-activation refresh" below) and the
    // branch-status SSE handler both invoke this closure on an already-
    // mounted DiffView, where the cached summary is showing. Flipping
    // loading to true would wipe the file list and surface "Loading
    // changes…" — the exact regression #484 was about. The only loading
    // mutation here is `setLoading(false)` in `.finally`, which is a
    // no-op when loading was already false.
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

    return () => {
      cancelled = true;
      fetchSummaryRef.current = null;
    };
  }, [
    adapter,
    workspaceId,
    onStatsChange,
    diffMode,
    compareBranch,
    fetchFileDiff,
    // `isPlain` and `projectKind` are both listed even though the
    // former is derived from the latter — required to keep
    // react/exhaustive-deps quiet. The body references both: `isPlain`
    // drives the short-circuit, `projectKind` gates the
    // undefined-during-load early return.
    isPlain,
    projectKind,
  ]);

  // Subscribe to branch-status SSE events to auto-refresh when files change.
  // The branch-status-poller emits events every ~5s with the workspace's git
  // dirty state, so the diff view stays in sync without slow polling.
  //
  // Split from the data-fetch effect above so we can attach/detach the
  // subscription on `active` flips (workspace switches) WITHOUT re-running
  // the initial fetch + state reset. Previously `active` was in the
  // data-fetch effect's dep array, which meant every flip back to a cached
  // workspace wiped the summary/diff cache and triggered "Loading
  // changes…". See issue #484.
  useEffect(() => {
    if (!active) return;
    const unsubscribe = adapter.subscribeStatusEvents((event) => {
      const data = event as SSEEvent;
      if (data.kind === "branch-status" && data.workspaceId === workspaceId) {
        fetchSummaryRef.current?.();
      }
    });
    return unsubscribe;
  }, [adapter, workspaceId, active]);

  // Re-activation refresh: on every `active: false → true` transition,
  // fire one immediate refresh of both summary + branches to close the
  // staleness window the inactive period opened. The SSE subscriptions
  // above only catch events that arrive WHILE active, so anything that
  // changed during the inactive period (agent edits, terminal `git`
  // operations, etc.) would otherwise sit stale until the next
  // branch-status poll (~5 s).
  //
  // The fetch ref bodies are non-destructive: `fetchSummary` only
  // mutates state when the fingerprint changes, so a re-activation that
  // hits unchanged data is visually a no-op (no Loading spinner, no
  // file-list wipe). Tracked separately from the SSE effects above
  // because `prevActiveRef` would otherwise need to be coordinated
  // across the two sibling effects — collapsing the transition logic
  // into a single dedicated effect keeps that bookkeeping local.
  // `workspaceId` is intentionally absent from the deps: each workspace
  // has its own keyed DiffView instance in MultiWorkspacePanelHost, so
  // `workspaceId` never changes within a single instance and threading it
  // through would only invite a well-meaning future reset of
  // `prevActiveRef` on workspace change — which has no defined behavior
  // because workspace change tears down this instance.
  useEffect(() => {
    const wasInactive = prevActiveRef.current === false;
    prevActiveRef.current = active;
    if (active && wasInactive) {
      fetchBranchesRef.current?.();
      fetchSummaryRef.current?.();
    }
  }, [active]);

  // ---------------------------------------------------------------------------
  // Diff target dropdown — combines diff mode + branch selection into one menu.
  // Top section: target branch (current pick), then the project's default
  // branch (if different from target), then Uncommitted. Below the separator
  // we list every other branch alphabetically. Pinning both target + default
  // to the top keeps the two most common compare targets one click away.
  // ---------------------------------------------------------------------------
  const summaryCompareBranch = summary?.compareBranch ?? null;
  const defaultBranch = summary?.defaultBranch ?? availableDefaultBranch ?? null;
  const branchOptions =
    availableBranches.length > 0
      ? availableBranches
      : summaryCompareBranch
        ? [summaryCompareBranch]
        : [];
  const targetBranch = compareBranch ?? branchOptions[0] ?? summaryCompareBranch;

  // Branches pinned above the separator. Order matters in the rendered list.
  const topSectionBranches: string[] = [];
  if (targetBranch) {
    topSectionBranches.push(targetBranch);
  }
  if (defaultBranch && defaultBranch !== targetBranch && branchOptions.includes(defaultBranch)) {
    topSectionBranches.push(defaultBranch);
  }
  const otherBranches = branchOptions
    .filter((b) => !topSectionBranches.includes(b))
    .sort((a, b) => a.localeCompare(b));

  const diffSelectValue =
    diffMode === "uncommitted" ? UNCOMMITTED_VALUE : (targetBranch ?? UNCOMMITTED_VALUE);

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
      <SelectTrigger className="h-6 w-auto max-w-[300px] gap-1 rounded-md border-0 bg-transparent px-1.5 text-xs font-medium text-foreground shadow-none hover:bg-accent [&>[data-slot=select-value]]:truncate [&>[data-slot=select-value]]:block">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {topSectionBranches.map((branch) => (
          <SelectItem key={branch} value={branch}>
            {branch}
          </SelectItem>
        ))}
        <SelectItem value={UNCOMMITTED_VALUE}>Uncommitted</SelectItem>
        {otherBranches.length > 0 && <SelectSeparator />}
        {otherBranches.map((branch) => (
          <SelectItem key={branch} value={branch}>
            {branch}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // The loading / error / "no changes" / populated states all share the
  // outer layout (file tree + toolbar + status banner) so switching the
  // changes selector between refs (including a ref with no diff) doesn't
  // collapse the panel or shift the file-tree column out of the layout.
  //
  // `loading` is intentionally NOT part of `hasChanges`: keeping stale
  // summary data visible during a refetch is preferable to blanking the
  // file list, and the "Loading changes…" message only needs to appear
  // when there's genuinely no data yet (initial mount; ref switch — both
  // paired with `setSummary(null)` in the fetch effect). `!error` does
  // gate it because a failed fetch supersedes whatever the previous
  // summary held.
  const hasChanges = Boolean(!error && summary && summary.stats.filesChanged > 0);
  // `fileStatuses` is the same object reference as `summary.fileStatuses` so
  // long as `summary` is stable — and the fetch effect's fingerprint check
  // keeps `summary` stable across no-op SSE refreshes. That stability is
  // what lets the `filenames` memo below skip re-flattening when nothing
  // actually changed. When there are no changes we fall through to a fresh
  // `{}` on every render, but `filenames` is then a stable [] (empty array
  // produced by flattening an empty tree), so downstream effects keyed on
  // it don't re-fire spuriously.
  const fileStatuses = hasChanges
    ? (summary?.fileStatuses ?? EMPTY_FILE_STATUSES)
    : EMPTY_FILE_STATUSES;
  const filenames = useMemo(
    () => flattenFileTreeOrder(buildFileTree(fileStatuses)),
    [fileStatuses],
  );
  filenamesRef.current = filenames;
  // `hasChanges` already implies `summary !== null`. Assert it with `!` so
  // the JSX downstream doesn't need a redundant `&& summary` guard for
  // type narrowing on every `summary.stats.*` access. (TypeScript can't
  // narrow through the stored boolean.)
  const stats = hasChanges ? summary!.stats : null;

  // Active-file detection: every row is in the DOM (LazyFileRow only
  // lazy-mounts its CodeMirror editor, not the row wrapper itself), so we
  // can pick the file that currently sits at the top of the scroll
  // viewport with a straightforward `getBoundingClientRect()` scan
  // scoped to this DiffView's scroll container. No virtualizer
  // measurements to keep in sync — the DOM IS the source of truth.
  //
  // The lookup is scoped to `scrollContainerRef` (not `document`) so
  // sibling DiffViews kept alive by `MultiWorkspacePanelHost` can't
  // claim each other's rows during a scroll.
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
        const containerTop = container.getBoundingClientRect().top;
        let closest: string | null = null;
        let closestDist = Infinity;
        for (const name of names) {
          const el = container.querySelector<HTMLElement>(
            `[data-band-diff-file="${CSS.escape(name)}"]`,
          );
          if (!el) continue;
          const elRect = el.getBoundingClientRect();
          // The file whose card straddles the top of the viewport is the
          // active one. If the user is scrolled between rows, we fall back
          // to the row whose top is closest to the viewport top.
          if (elRect.top <= containerTop && elRect.bottom > containerTop) {
            closest = name;
            break;
          }
          const dist = Math.abs(elRect.top - containerTop);
          if (dist < closestDist) {
            closestDist = dist;
            closest = name;
          }
        }
        setActiveFile((prev) => (prev === closest ? prev : closest));
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [summary]);

  // When the file set grows (e.g. a fresh edit added a new untracked file
  // while expand-all is on), auto-open the new entries. We compare against
  // the previous filename set so users who manually collapsed a row don't
  // see it pop back open on every summary refresh.
  //
  // This mirrors the pre-virtualization behavior where each LazyFileRow's
  // `useState(expandAll)` initializer caused brand-new rows to mount in
  // the expand-all-driven default state.
  const prevFilenamesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevFilenamesRef.current;
    const next = new Set(filenames);
    prevFilenamesRef.current = next;
    if (!expandAll) return;
    const newOnes: string[] = [];
    for (const name of filenames) {
      if (!prev.has(name)) newOnes.push(name);
    }
    if (newOnes.length === 0) return;
    setExpandedFiles((curr) => {
      const merged = new Set(curr);
      for (const n of newOnes) merged.add(n);
      return merged;
    });
    for (const n of newOnes) {
      if (!diffCacheRef.current.has(n)) fetchFileDiff(n);
    }
  }, [filenames, expandAll, fetchFileDiff]);

  // Jump-to-file from ChangesFileTree.
  //
  // The effect expands the row, kicks off its diff fetch if needed, and
  // then scrolls the row's wrapper to the top of the scroll container.
  // It re-fires whenever the target's line counts change so that an
  // initial scroll issued before the diff arrived gets one corrective
  // pass once the row's placeholder grows to its real size — but at most
  // ONCE per click. Subsequent re-fires (load-more-context bumping line
  // counts, view mode toggle changing placeholder heights) leave the
  // user's current scroll position alone instead of yanking the viewport
  // back to the last sidebar pick.
  const focusedDiffEntry = focusedFile && diffCache.get(focusedFile.path);
  const focusedLineCounts = focusedDiffEntry ? focusedDiffEntry.lineCounts : null;
  // Tracks whether we've already done the "settled" scroll for the
  // current `focusedFile.seq`. A scroll is settled when it ran with
  // non-null line counts (so its target pixel position is final).
  // Initialized with seq:-1 so the first real click (seq:0) always
  // scrolls.
  const lastScrollRef = useRef<{ seq: number; settled: boolean }>({
    seq: -1,
    settled: false,
  });
  useEffect(() => {
    if (!focusedFile) return;
    const target = focusedFile.path;
    const isNewSeq = focusedFile.seq !== lastScrollRef.current.seq;
    const isFirstCorrection =
      !isNewSeq && !lastScrollRef.current.settled && focusedLineCounts !== null;
    if (!isNewSeq && !isFirstCorrection) return;
    lastScrollRef.current = {
      seq: focusedFile.seq,
      settled: focusedLineCounts !== null,
    };
    setExpandedFiles((prev) => {
      if (prev.has(target)) return prev;
      const next = new Set(prev);
      next.add(target);
      return next;
    });
    if (!diffCacheRef.current.has(target)) {
      fetchFileDiff(target);
    }
    // Double rAF: the first lets React commit the expansion state, the
    // second lets the row's placeholder grow to its computed height
    // before we read its position. Without the second frame the scroll
    // lands on the row's pre-expansion location and the user sees the
    // file just below the top edge.
    let frame2: number | null = null;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const el = container.querySelector<HTMLElement>(
          `[data-band-diff-file="${CSS.escape(target)}"]`,
        );
        if (!el) return;
        const elTop = el.getBoundingClientRect().top;
        const containerTop = container.getBoundingClientRect().top;
        container.scrollTo({
          top: container.scrollTop + (elTop - containerTop),
          behavior: "instant",
        });
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      if (frame2 !== null) cancelAnimationFrame(frame2);
    };
  }, [focusedFile, focusedLineCounts, fetchFileDiff]);

  // Plain (non-git) projects: render a calm, normal-text empty state. No
  // toolbar, no error styling — the Changes tab simply isn't meaningful
  // for a folder that isn't a git repo. See #427.
  if (isPlain) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This folder is not a git repository — changes are not tracked.
      </div>
    );
  }

  // For git projects, loading / error / no-changes / populated states all
  // share the unified layout below — see the comment above the `hasChanges`
  // derivation. Don't add separate early returns for loading or error here;
  // they'd reintroduce the layout shift this PR exists to fix.

  // Ghost-style classes shared across every toolbar action button. Variants
  // for the segmented view-mode toggle differ slightly because the active
  // segment uses `bg-accent` on its own, without the hover transition.
  // The auto-shown variant uses a container query against the @container/diff
  // wrapper below — when the DiffView's parent container drops below 40rem,
  // the sidebar auto-hides so the toggle would be a no-op too.
  const ghostBtnClass =
    "hidden size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground @[40rem]/diff:inline-flex";
  const ghostBtnAlwaysClass =
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  /** File-tree toggle — always visible on desktop, hidden on mobile. */
  const renderSidebarToggle = () => (
    <button
      type="button"
      onClick={() => setSidebarOpen(!sidebarOpen)}
      className={ghostBtnClass}
      title={sidebarOpen ? "Hide file tree" : "Show file tree"}
      aria-label={sidebarOpen ? "Hide file tree" : "Show file tree"}
      aria-pressed={sidebarOpen}
    >
      <PanelLeft className="size-3.5" />
    </button>
  );

  /** Inline branch indicator: `<head> → <dropdown>` rendered next to the stats.
   *  When the DiffView container narrows, the head branch label and arrow drop
   *  out so only the compare dropdown remains. */
  const renderBranchIndicator = (headBranchLabel: string | null | undefined) => (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {headBranchLabel && (
        <div className="hidden items-center gap-1.5 @[32rem]/diff:flex">
          <span className="font-medium text-foreground">{headBranchLabel}</span>
          <ArrowRight className="size-3" aria-hidden />
        </div>
      )}
      {renderDiffSelect()}
    </div>
  );

  // Pull / push are useful even when there are no pending changes (the
  // common "just fetch upstream" case). Render them on both the populated
  // and empty branches.
  const renderGitSyncButtons = () => (
    <>
      {canPull && (
        <button
          type="button"
          onClick={handleGitPull}
          className={ghostBtnAlwaysClass}
          title="Git pull"
          aria-label="Git pull"
          disabled={gitOpBusy}
        >
          {isPulling ? <Spinner className="size-3.5" /> : <ArrowDownToLine className="size-3.5" />}
        </button>
      )}
      {canPush && (
        <button
          type="button"
          onClick={handleGitPush}
          className={ghostBtnAlwaysClass}
          title="Git push"
          aria-label="Git push"
          disabled={gitOpBusy}
        >
          {isPushing ? <Spinner className="size-3.5" /> : <ArrowUpFromLine className="size-3.5" />}
        </button>
      )}
    </>
  );

  // Manual "reload changes" button — shared between the populated and empty
  // toolbars so users watching a busy branch can always force a refresh,
  // even when the current ref has no diff.
  const renderReloadButton = () => (
    <button
      type="button"
      onClick={() => fetchSummaryRef.current?.(true)}
      className={ghostBtnAlwaysClass}
      title="Reload changes"
      aria-label="Reload changes"
    >
      <RefreshCw className="size-3.5" />
    </button>
  );

  return (
    <div ref={rootRef} className="@container/diff flex h-full overflow-hidden">
      {/* LEFT: File tree sidebar — auto-hides when this view's container
          becomes too narrow to fit both the tree and useful diff content. */}
      {sidebarOpen && (
        <div
          data-diff-sidebar
          className="hidden shrink-0 flex-col @[40rem]/diff:flex"
          style={{ width: sidebarWidth }}
        >
          <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
            <span className="text-xs font-medium text-muted-foreground">Files</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1 pl-px">
            {/* Key on workspaceId so switching workspaces remounts the tree
                and clears its internal "seen directories" memo. Without
                this, collapsed-directory state from one workspace would
                bleed into the next when the parent route reuses this
                DiffView instance across workspace switches. */}
            <ChangesFileTree
              key={workspaceId}
              fileStatuses={fileStatuses}
              onSelectFile={handleScrollToFile}
              activeFile={activeFile}
              onRevertPaths={adapter.revertFile ? handleRevertPaths : undefined}
            />
          </div>
        </div>
      )}

      {/* Resize handle between sidebar and main content */}
      {sidebarOpen && (
        <div
          onMouseDown={handleResizeStart}
          className="hidden w-[3px] shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-accent-foreground/20 active:bg-accent-foreground/30 @[40rem]/diff:block"
        />
      )}

      {/* RIGHT: Main content (toolbar + file list) */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border pl-2 pr-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {renderSidebarToggle()}
            {renderBranchIndicator(summary?.headBranch)}
          </div>
          {/* When there are no changes the toolbar collapses to the
              pull / push + reload controls. The commit / search / expand /
              view-mode buttons all operate on a non-empty diff and would
              be no-ops, but reload stays so users watching a busy branch
              can still force a refresh. */}
          {!hasChanges && (
            <div className="flex items-center gap-1">
              {renderGitSyncButtons()}
              {renderReloadButton()}
            </div>
          )}
          {/* Inline action icons — collapsed into the kebab menu below 44rem.
              The threshold is wider than the branch-label one (32rem) because
              the right-side cluster now carries up to eight icons (commit,
              pull, push, reload, search, expand, unified, split) — squeezing
              them into a narrower toolbar makes the buttons overlap the
              branch indicator on the left. */}
          {hasChanges && (
            <div className="hidden items-center gap-1 @[44rem]/diff:flex">
              {canCommit && (
                <button
                  type="button"
                  onClick={() => setCommitDialogOpen(true)}
                  className={ghostBtnAlwaysClass}
                  title="Commit changes"
                  aria-label="Commit changes"
                  disabled={gitOpBusy}
                >
                  <GitCommit className="size-3.5" />
                </button>
              )}
              {canPull && (
                <button
                  type="button"
                  onClick={handleGitPull}
                  className={ghostBtnAlwaysClass}
                  title="Git pull"
                  aria-label="Git pull"
                  disabled={gitOpBusy}
                >
                  {isPulling ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <ArrowDownToLine className="size-3.5" />
                  )}
                </button>
              )}
              {canPush && (
                <button
                  type="button"
                  onClick={handleGitPush}
                  className={ghostBtnAlwaysClass}
                  title="Git push"
                  aria-label="Git push"
                  disabled={gitOpBusy}
                >
                  {isPushing ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <ArrowUpFromLine className="size-3.5" />
                  )}
                </button>
              )}
              {renderReloadButton()}
              <button
                type="button"
                onClick={search.handleOpenSearch}
                className={ghostBtnAlwaysClass}
                title="Find in changes (⌘F)"
                aria-label="Find in changes"
              >
                <Search className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setExpandAll(!expandAll)}
                className={`${ghostBtnAlwaysClass} ${expandAll ? "bg-accent text-foreground" : ""}`}
                title={expandAll ? "Collapse all files" : "Expand all files"}
                aria-label={expandAll ? "Collapse all files" : "Expand all files"}
                aria-pressed={expandAll}
              >
                {expandAll ? (
                  <ChevronsDownUp className="size-3.5" />
                ) : (
                  <ChevronsUpDown className="size-3.5" />
                )}
              </button>
              <div className="hidden items-center @[40rem]/diff:flex">
                <button
                  type="button"
                  onClick={() => setViewMode("unified")}
                  className={`${ghostBtnAlwaysClass} ${effectiveViewMode === "unified" ? "bg-accent text-foreground" : ""}`}
                  title="Unified view"
                  aria-label="Unified view"
                  aria-pressed={effectiveViewMode === "unified"}
                >
                  <Rows2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("split")}
                  className={`${ghostBtnAlwaysClass} ${effectiveViewMode === "split" ? "bg-accent text-foreground" : ""}`}
                  title="Split view"
                  aria-label="Split view"
                  aria-pressed={effectiveViewMode === "split"}
                >
                  <Columns2 className="size-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Compact "more actions" kebab menu — visible at narrow widths only.
              Mirrors the 44rem breakpoint above so exactly one of the inline
              cluster / kebab is visible at any width. Hidden when there are
              no changes — the simplified pull / push cluster is shown
              unconditionally at every width instead. */}
          {hasChanges && (
            <div className="flex items-center @[44rem]/diff:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={ghostBtnAlwaysClass}
                    title="More actions"
                    aria-label="More actions"
                  >
                    <MoreVertical className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCommit && (
                    <DropdownMenuItem
                      onSelect={() => setCommitDialogOpen(true)}
                      disabled={gitOpBusy}
                    >
                      <GitCommit className="size-4" />
                      Commit changes
                    </DropdownMenuItem>
                  )}
                  {canPull && (
                    <DropdownMenuItem onSelect={() => handleGitPull()} disabled={gitOpBusy}>
                      {isPulling ? (
                        <Spinner className="size-4" />
                      ) : (
                        <ArrowDownToLine className="size-4" />
                      )}
                      Git pull
                    </DropdownMenuItem>
                  )}
                  {canPush && (
                    <DropdownMenuItem onSelect={() => handleGitPush()} disabled={gitOpBusy}>
                      {isPushing ? (
                        <Spinner className="size-4" />
                      ) : (
                        <ArrowUpFromLine className="size-4" />
                      )}
                      Git push
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => fetchSummaryRef.current?.(true)}>
                    <RefreshCw className="size-4" />
                    Reload changes
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={search.handleOpenSearch}>
                    <Search className="size-4" />
                    Find in changes
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setExpandAll(!expandAll)}>
                    {expandAll ? (
                      <ChevronsDownUp className="size-4" />
                    ) : (
                      <ChevronsUpDown className="size-4" />
                    )}
                    {expandAll ? "Collapse all files" : "Expand all files"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setViewMode("unified")}>
                    <Rows2 className="size-4" />
                    Unified view
                    {effectiveViewMode === "unified" && <Check className="ml-auto size-4" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setViewMode("split")}>
                    <Columns2 className="size-4" />
                    Split view
                    {effectiveViewMode === "split" && <Check className="ml-auto size-4" />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {hasChanges && search.searchOpen && (
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
        {!hasChanges && (
          // role="status" implies aria-live="polite" — spell both out as a
          // defensive pattern. aria-atomic ensures the whole label is
          // re-read on each transition (e.g. "Loading changes…" → "No
          // changes" after a ref switch). `<output>` would be biome's
          // preferred semantic element but it's specifically for the
          // result of a form computation; a generic status region is
          // a better fit here.
          // biome-ignore lint/a11y/useSemanticElements: see comment above.
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex min-h-0 flex-1 items-center justify-center"
          >
            {/* Style follows the same priority as the displayed text:
                `loading` wins over `error`, so a fresh fetch over a
                previously-errored summary reads "Loading changes…" in
                muted text rather than red. */}
            <span
              className={`text-sm ${!loading && error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {loading ? "Loading changes..." : error ? error : "No changes"}
            </span>
          </div>
        )}
        {hasChanges && (
          <div ref={setScrollContainerNode} className="min-h-0 flex-1 overflow-y-auto">
            {/* Every row is rendered as a lightweight wrapper card; the
                expensive CodeMirror editor inside each one is gated by a
                per-row IntersectionObserver (see LazyFileRow). That keeps
                the DOM structure simple — native scroll, sticky headers,
                scrollIntoView all just work — while still capping the
                number of live editors to whatever fits in the viewport
                plus a small overscan zone. See issue #489. */}
            <div className="flex flex-col gap-3 p-3">
              {filenames.map((filename, index) => {
                const isLast = index === filenames.length - 1;
                const row = (
                  <LazyFileRow
                    key={filename}
                    filename={filename}
                    status={fileStatuses[filename]}
                    cacheEntry={diffCache.get(filename)}
                    viewMode={effectiveViewMode}
                    isOpen={expandedFiles.has(filename)}
                    isActive={activeFile === filename}
                    scrollContainerEl={scrollContainerEl}
                    onToggle={handleToggleFile}
                    onLoadMoreContext={handleLoadMoreContext}
                    onShowFullFile={handleShowFullFile}
                    onOpenFile={onOpenFile}
                    onRevertFile={adapter.revertFile ? handleRevertFile : undefined}
                    onEditorViews={handleEditorViews}
                  />
                );
                if (!isLast) return row;
                // Wrap the last row in a flex container with min-height =
                // viewport height. The trailing `flex-1` div soaks up the
                // remaining space so the last file can be scrolled to the
                // top of the viewport even when its content is shorter
                // than the visible area.
                return (
                  <div
                    key={`${filename}-last-wrapper`}
                    className="flex flex-col"
                    style={
                      scrollContainerHeight > 0 ? { minHeight: scrollContainerHeight } : undefined
                    }
                  >
                    {row}
                    <div aria-hidden className="flex-1" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* Inline status banner for one-shot git operations (pull / push).
            Lives above the bottom status bar so it doesn't shift the diff
            viewport. Errors stay until dismissed; success is auto-cleared. */}
        {gitOpStatus && (
          <div
            role={gitOpStatus.state === "error" ? "alert" : "status"}
            className={`flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs ${
              gitOpStatus.state === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border bg-muted/50 text-muted-foreground"
            }`}
          >
            {gitOpStatus.state === "running" && (
              <>
                <Spinner className="size-3.5" />
                <span>{gitOpStatus.op === "pull" ? "Pulling…" : "Pushing…"}</span>
              </>
            )}
            {gitOpStatus.state === "success" && (
              <>
                <Check className="size-3.5 text-green-600 dark:text-green-400" />
                <span>{gitOpStatus.op === "pull" ? "Pulled" : "Pushed"}</span>
              </>
            )}
            {gitOpStatus.state === "error" && (
              <>
                <span className="font-medium">
                  {gitOpStatus.op === "pull" ? "Pull failed" : "Push failed"}:
                </span>
                <span className="min-w-0 flex-1 truncate" title={gitOpStatus.message}>
                  {gitOpStatus.message}
                </span>
                <button
                  type="button"
                  onClick={() => setGitOpStatus(null)}
                  className="shrink-0 rounded px-1 text-destructive hover:bg-destructive/20"
                  aria-label="Dismiss error"
                >
                  ×
                </button>
              </>
            )}
          </div>
        )}
        {/* Bottom status bar — totals for the current diff. Hidden when
            there are no changes; the centered "No changes" message in the
            content area already conveys the empty state. */}
        {stats && (
          <div className="flex h-9 shrink-0 items-center border-t border-border px-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{stats.filesChanged}</span>
            <span className="ml-1">{stats.filesChanged === 1 ? "file" : "files"} changed</span>
            {stats.insertions > 0 && (
              <span className="ml-2 text-green-600 dark:text-green-400">+{stats.insertions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="ml-1 text-red-600 dark:text-red-400">-{stats.deletions}</span>
            )}
          </div>
        )}
      </div>
      {/* Mounted whenever the platform supports commit, not only when
          there are changes. Otherwise a background fetch failure or a
          ref switch would unmount the dialog mid-typing and drop the
          user's commit-message draft. Visibility is controlled by
          `commitDialogOpen` — the commit button only fires from the
          populated toolbar, so the dialog never opens with zero
          changes during normal use. */}
      {canCommit && (
        <CommitDialog
          open={commitDialogOpen}
          onOpenChange={setCommitDialogOpen}
          workspaceId={workspaceId}
          filesChanged={stats?.filesChanged ?? 0}
          onCommitted={() => {
            // Force a fresh diff fetch — after a commit the working-tree
            // diff (uncommitted) is empty, but the branch diff updates too.
            fetchSummaryRef.current?.(true);
          }}
        />
      )}
    </div>
  );
}
