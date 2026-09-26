import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, WidgetType } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import { baseViewerExtensions, loadLanguage, searchHighlightOnly } from "../lib/codemirror-setup";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import { selectionToChatExtension } from "../lib/selection-to-chat";

export type ViewMode = "unified" | "split";

const VIEW_MODE_KEY = "band:diff-view-mode";

/** Read the persisted split/unified preference for the center `diff` leaf. */
export function getStoredViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === "split" || v === "unified") return v;
  } catch {}
  return "unified";
}

/** Persist the split/unified diff preference. */
export function storeViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {}
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

export function DiffFileContent({
  hunks,
  filename,
  viewMode,
  onEditorViews,
  onLoadMoreContext,
  copyReferenceOnly = false,
  lspNavigation = null,
}: {
  hunks: string;
  filename: string;
  viewMode: ViewMode;
  onEditorViews?: (views: EditorView[]) => void;
  onLoadMoreContext?: () => void;
  /** When true, the selection tooltip shows only "Copy reference" (no Add to
   *  Chat/Terminal) — used by the desktop diff leaf (#643). */
  copyReferenceOnly?: boolean;
  /** Go-to-definition for the working-tree (new) side, from
   *  `createDiffLspNavigation`. Attached only while the diff shows the whole
   *  file, where a line in the view is the same line on disk. The old side
   *  never gets it: its text is the merge-base revision, which the language
   *  server does not have. */
  lspNavigation?: Extension | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);
  const isDark = useIsDark();
  // The navigation arrives after the editor is built (the LSP client connects
  // asynchronously), so it goes in a compartment instead of rebuilding.
  const lspCompartment = useRef(new Compartment()).current;
  const lspNavigationRef = useRef(lspNavigation);
  lspNavigationRef.current = lspNavigation;
  /** The working-tree view, set only when its document is the whole file. */
  const lspTargetRef = useRef<EditorView | null>(null);

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
      const wholeFile = newLineNumbers.every((n, i) => n === i + 1);
      const lspExtension = lspCompartment.of(
        wholeFile && lspNavigationRef.current ? lspNavigationRef.current : [],
      );

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
              ...baseViewerExtensions(isDark, { skipLineNumbers: true, naturalHeight: true }),
              makeLineNumbers(oldLineNumbers),
              hunkSeparatorExtension(oldHunkBoundaryLines, loadMore),
              selectionToChatExtension(filename, oldLineNumbers, { copyReferenceOnly }),
              EditorView.editorAttributes.of({ "data-testid": "diff-file__editor--old" }),
              ...sharedExtensions,
            ],
          },
          b: {
            doc: newText,
            extensions: [
              ...baseViewerExtensions(isDark, { skipLineNumbers: true, naturalHeight: true }),
              makeLineNumbers(newLineNumbers),
              hunkSeparatorExtension(newHunkBoundaryLines, loadMore),
              selectionToChatExtension(filename, newLineNumbers, { copyReferenceOnly }),
              lspExtension,
              EditorView.editorAttributes.of({ "data-testid": "diff-file__editor--new" }),
              ...sharedExtensions,
            ],
          },
          parent: container,
          highlightChanges: false,
          gutter: true,
        });

        lspTargetRef.current = wholeFile ? viewRef.current.b : null;
        onEditorViewsRef.current?.([viewRef.current.a, viewRef.current.b]);
      } else {
        const extensions = [
          ...baseViewerExtensions(isDark, { skipLineNumbers: true, naturalHeight: true }),
          makeLineNumbers(newLineNumbers),
          hunkSeparatorExtension(newHunkBoundaryLines, loadMore),
          searchHighlightOnly(),
          selectionToChatExtension(filename, newLineNumbers, { copyReferenceOnly }),
          lspExtension,
          EditorView.editorAttributes.of({ "data-testid": "diff-file__editor--new" }),
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

        lspTargetRef.current = wholeFile ? viewRef.current : null;
        onEditorViewsRef.current?.([viewRef.current]);
      }
    };

    // If `setup()` rejects after `await loadLanguage()` (e.g. `new
    // MergeView()` throws on a malformed diff or a CodeMirror extension
    // conflict), the success path that fires `onEditorViewsRef.current?.([
    // ...views])` is never reached. Routing the failure through the same
    // empty-views callback the cleanup path uses lets the parent drop any
    // stale views it still holds (e.g. the diff leaf's find wiring).
    //
    // The `cancelled` gate is critical: when props change (isDark,
    // viewMode, hunks) React runs the cleanup synchronously and then
    // re-runs the effect, wiring a *new* callback into
    // `onEditorViewsRef.current`. A late rejection from the previous
    // setup would otherwise fire `[]` into the new mount mid-setup.
    setup().catch((err) => {
      // Intentional teardown (effect cleanup → cancelled = true) is not
      // an error, so skip both the log and the parent reset to avoid
      // devtools noise on every legitimate re-mount.
      if (cancelled) return;
      // Surface the failure to the console so a broken editor isn't
      // completely invisible to the developer. There's no user-facing
      // affordance for retry, but at least the error is debuggable from
      // the devtools.
      console.error("[DiffFileContent] editor setup failed", err);
      onEditorViewsRef.current?.([]);
    });

    return () => {
      cancelled = true;
      lspTargetRef.current = null;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      onEditorViewsRef.current?.([]);
    };
  }, [hunks, filename, viewMode, isDark, copyReferenceOnly, lspCompartment]);

  useEffect(() => {
    lspTargetRef.current?.dispatch({ effects: lspCompartment.reconfigure(lspNavigation ?? []) });
  }, [lspNavigation, lspCompartment]);

  return <div ref={containerRef} />;
}
