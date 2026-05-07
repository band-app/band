import {
  buildLspWsUrl,
  createLspExtension,
  FileBrowser,
  FileViewer,
  getFilePreviewType,
  getLspLanguageId,
  hasPendingNavigation,
  parseFileLocation,
  releaseLspClient,
  resolveNavigation,
  SearchBar,
  scrollToLine,
  serializeEditorState,
  toFileUri,
  toLspServerLang,
  toWorkspaceId,
  useEditorHistory,
  useProjects,
  useSearch,
  useSettingsQuery,
} from "@band-app/dashboard-core";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import type { Extension } from "@codemirror/state";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { ChevronLeft, ChevronRight, Code, Eye, File, Search, TextSearch } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Streamdown } from "streamdown";
import { useFileTabs } from "../hooks/useFileTabs";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useTabState } from "../hooks/useTabState";
import { FileTabBar } from "./FileTabBar";
import { streamdownComponents } from "./streamdown-components";

const streamdownPlugins = { cjk, code, math, mermaid };

// ---------------------------------------------------------------------------
// File tree width persistence
// ---------------------------------------------------------------------------
function fileTreeWidthKey(wsId: string): string {
  return `band-file-tree-width:${wsId}`;
}

function fileTreeCollapsedKey(wsId: string): string {
  return `band-file-tree-collapsed:${wsId}`;
}

function loadFileTreeWidth(wsId: string): number | null {
  try {
    const raw = localStorage.getItem(fileTreeWidthKey(wsId));
    if (raw == null) return null;
    const val = Number(raw);
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}

function saveFileTreeWidth(wsId: string, width: number): void {
  try {
    localStorage.setItem(fileTreeWidthKey(wsId), String(width));
  } catch {
    // storage unavailable
  }
}

function loadFileTreeCollapsed(wsId: string): boolean {
  try {
    return localStorage.getItem(fileTreeCollapsedKey(wsId)) === "true";
  } catch {
    return false;
  }
}

function saveFileTreeCollapsed(wsId: string, collapsed: boolean): void {
  try {
    localStorage.setItem(fileTreeCollapsedKey(wsId), String(collapsed));
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(content: string) {
  return (
    <Streamdown
      className={cn(
        "size-full break-words leading-relaxed [overflow-wrap:anywhere]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
      plugins={streamdownPlugins}
      components={streamdownComponents}
    >
      {content}
    </Streamdown>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CodeBrowserViewProps {
  workspaceId: string;
  /** When set, navigates the browser to this file path. */
  file?: string;
  /** Called when the user selects a file or navigates back (null = no file). */
  onSelectFile?: (filePath: string | null) => void;
  /** Externally triggered file to open (e.g. from Quick Open or Search) */
  openFilePath?: string | null;
  /** Called after the external file path has been consumed */
  onFileOpened?: () => void;
  /** Reports a callback that triggers find-in-file search (null when unavailable) */
  onFindInFile?: (fn: (() => void) | null) => void;
  /** Called to open the Quick Open dialog */
  onQuickOpen?: () => void;
  /** Called to open the Search in Files dialog */
  onSearchFiles?: () => void;
}

// ---------------------------------------------------------------------------
// File tree toolbar
// ---------------------------------------------------------------------------

interface FileTreeToolbarProps {
  onQuickOpen?: () => void;
  onSearchFiles?: () => void;
}

function FileTreeToolbar({ onQuickOpen, onSearchFiles }: FileTreeToolbarProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/50 pl-3 pr-1.5">
      <span className="text-xs font-medium text-muted-foreground">Files</span>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onQuickOpen}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <Search className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Quick Open{" "}
          <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
            ⌘P
          </kbd>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSearchFiles}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <TextSearch className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Search in Files{" "}
          <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
            ⌘⇧F
          </kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CodeBrowserView
// ---------------------------------------------------------------------------

export function CodeBrowserView({
  workspaceId,
  file,
  onSelectFile,
  openFilePath,
  onFileOpened,
  onFindInFile,
  onQuickOpen,
  onSearchFiles,
}: CodeBrowserViewProps) {
  const isDesktop = useIsDesktop();
  const fileTabs = useFileTabs(workspaceId);
  const tabState = useTabState(workspaceId);

  // Mirror tab state for synchronous reads inside callbacks. Lets the
  // preview-open helper stay stable across tab changes, so callbacks
  // built on top (handleSelectFile, navigateToEntry) don't churn deps
  // and re-trigger downstream LSP/keyboard effects.
  const openTabsRef = useRef(fileTabs.openTabs);
  openTabsRef.current = fileTabs.openTabs;
  const isDirtyRef = useRef(tabState.isDirty);
  isDirtyRef.current = tabState.isDirty;
  const removeFileRef = useRef(tabState.removeFile);
  removeFileRef.current = tabState.removeFile;
  const { settings } = useSettingsQuery();
  const { projects } = useProjects();
  const workspacePath = (() => {
    for (const proj of projects) {
      for (const wt of proj.worktrees) {
        if (toWorkspaceId(proj.name, wt.branch) === workspaceId) {
          return wt.path;
        }
      }
    }
    return undefined;
  })();
  const [viewFilePath, setViewFilePath] = useState(() => {
    if (file) return parseFileLocation(file).filePath;
    // No file in route — restore the active tab from localStorage so the
    // editor renders immediately when returning to a workspace.
    return fileTabs.activeTabPath ?? "";
  });
  const [viewLine, setViewLine] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).line;
  });
  const [viewLineEnd, setViewLineEnd] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).lineEnd;
  });
  const [viewColumn, setViewColumn] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).column;
  });

  // -------------------------------------------------------------------------
  // Container-based layout detection
  // -------------------------------------------------------------------------
  // useIsDesktop() checks the viewport width, but CodeBrowserView may live
  // inside a narrow dockview panel even when the viewport is wide.  We
  // measure the actual container width so we can switch to the mobile toggle
  // layout (with back button) when the container is too narrow for the
  // side-by-side desktop layout.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Synchronous initial measurement to avoid a layout flash
    setContainerWidth(el.clientWidth);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Use the mobile toggle layout when EITHER the viewport is narrow (real
  // mobile) OR the container is narrower than 600px (narrow dockview panel).
  const useMobileLayout = !isDesktop || (containerWidth !== null && containerWidth < 600);

  // Markdown view mode (controlled from here, rendered in tab bar actions)
  const [mdViewMode, setMdViewModeState] = useState<"preview" | "source">("preview");
  const isMarkdown = viewFilePath ? getFilePreviewType(viewFilePath) === "markdown" : false;

  // Wrap the setter to also persist to tab state
  const setMdViewMode = useCallback(
    (mode: "preview" | "source") => {
      setMdViewModeState(mode);
      if (viewFilePath) tabState.setViewMode(viewFilePath, mode);
    },
    [viewFilePath, tabState.setViewMode],
  );

  // Restore markdown view mode from tab state (default to preview)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on file change only
  useEffect(() => {
    setMdViewModeState(tabState.getViewMode(viewFilePath) ?? "preview");
  }, [viewFilePath]);

  // Open initial file as a tab (desktop only)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    if (file) {
      const loc = parseFileLocation(file);
      fileTabs.openTab(loc.filePath);
    }
  }, []);

  // -------------------------------------------------------------------------
  // LSP extension for code intelligence (hover, go-to-definition, etc.)
  // -------------------------------------------------------------------------
  const [lspExtension, setLspExtension] = useState<Extension | null>(null);

  // Detect the language of the current file and build the LSP WebSocket URL
  const lspServerLang = useMemo(() => {
    if (!settings.enableLSP) return null;
    if (!viewFilePath) return null;
    const ext = viewFilePath.split(".").pop()?.toLowerCase();
    if (!ext) return null;
    // Map file extension to CodeMirror language name, then to LSP server lang
    const langMap: Record<string, string> = {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      mts: "typescript",
      cts: "typescript",
      mjs: "javascript",
      cjs: "javascript",
    };
    const cmLang = langMap[ext];
    return cmLang ? toLspServerLang(cmLang) : null;
  }, [viewFilePath, settings.enableLSP]);

  const lspWsUrl = useMemo(
    () => (lspServerLang ? buildLspWsUrl(workspaceId, lspServerLang) : null),
    [workspaceId, lspServerLang],
  );

  // Create/release LSP extension when the file changes
  useEffect(() => {
    if (!lspWsUrl || !workspacePath || !viewFilePath) {
      setLspExtension(null);
      return;
    }

    let cancelled = false;
    const rootUri = toFileUri(workspacePath);
    const documentUri = toFileUri(workspacePath, viewFilePath);

    // Detect the LSP language ID for this file
    const ext = viewFilePath.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      mts: "typescript",
      cts: "typescript",
      mjs: "javascript",
      cjs: "javascript",
    };
    const cmLang = langMap[ext ?? ""];
    const languageId = cmLang ? getLspLanguageId(cmLang) : undefined;

    createLspExtension(lspWsUrl, rootUri, documentUri, languageId)
      .then((ext) => {
        if (!cancelled) setLspExtension(ext);
      })
      .catch((err) => {
        console.warn("LSP extension creation failed:", err);
        if (!cancelled) setLspExtension(null);
      });

    return () => {
      cancelled = true;
    };
  }, [lspWsUrl, workspacePath, viewFilePath]);

  // Clean up LSP client when the WebSocket URL changes or on unmount.
  // Runs the cleanup for the *previous* lspWsUrl on each change.
  useEffect(() => {
    return () => {
      if (lspWsUrl) releaseLspClient(lspWsUrl);
    };
  }, [lspWsUrl]);

  // -------------------------------------------------------------------------
  // CodeMirror editor view ref (shared by find-in-file and navigation history)
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: EditorView type from @codemirror/view — kept untyped to avoid cross-package dependency
  const editorViewRef = useRef<any>(null);

  // In-memory store for serialized CodeMirror editor state per file.
  // Primary store for tab switches (faster than localStorage).
  // Also persisted to localStorage via tabState so undo history survives
  // workspace switches and page reloads.
  const savedEditorStatesRef = useRef<Record<string, { editorState: unknown; scrollTop: number }>>(
    {},
  );

  // Track viewFilePath in a ref so stable callbacks can read the latest value
  const viewFilePathRef = useRef(viewFilePath);
  viewFilePathRef.current = viewFilePath;

  // Save active editor state to localStorage when leaving the workspace.
  // Uses useLayoutEffect so the cleanup runs synchronously BEFORE
  // CodeMirrorEditor's useEffect cleanup destroys the editor view.
  const tabStateUpdateRef = useRef(tabState.update);
  tabStateUpdateRef.current = tabState.update;
  useLayoutEffect(() => {
    return () => {
      // Save the currently active editor's state
      const view = editorViewRef.current;
      const fp = viewFilePathRef.current;
      if (view && fp) {
        try {
          const state = serializeEditorState(view);
          tabStateUpdateRef.current(fp, {
            editorState: state.editorState,
            scrollTop: state.scrollTop,
          });
        } catch {
          // editor not ready
        }
      }
      // Flush all other tabs' in-memory states to localStorage
      for (const [filePath, state] of Object.entries(savedEditorStatesRef.current)) {
        tabStateUpdateRef.current(filePath, {
          editorState: state.editorState,
          scrollTop: state.scrollTop,
        });
      }
    };
  }, []);

  // Callback for FileViewer to persist edited content to tab state
  const handleEditedContentChange = useCallback(
    (content: string | null) => {
      const fp = viewFilePathRef.current;
      if (fp) {
        tabState.update(fp, { editedContent: content ?? undefined });
        // Editing auto-pins a preview tab — VS Code-style.
        if (content !== null) fileTabs.pinTab(fp);
      }
    },
    [tabState.update, fileTabs.pinTab],
  );

  // -------------------------------------------------------------------------
  // Editor navigation history (back/forward)
  // -------------------------------------------------------------------------
  const editorHistory = useEditorHistory();
  // When true, the `file` prop effect skips overwriting viewLine/viewColumn.
  // Set by navigateToEntry to prevent the route round-trip from clobbering
  // the line the user is navigating to (the route only carries the file path).
  const skipFileEffectRef = useRef(false);

  // Read the current cursor position from CodeMirror so we can record where
  // the user is *departing from* before a synchronous navigation handler runs.
  // Only meaningful when called synchronously (e.g. from handleSelectFile) —
  // in effects the CM view may already have scrolled.
  const pushDepartureAndArrival = useCallback(
    (target: { filePath: string; line?: number; column?: number }) => {
      const view = editorViewRef.current;
      if (view && viewFilePath) {
        try {
          const pos = view.state.selection.main.head;
          const lineInfo = view.state.doc.lineAt(pos);
          editorHistory.push({
            filePath: viewFilePath,
            line: lineInfo.number,
            column: pos - lineInfo.from + 1,
          });
        } catch {
          // CM view not ready — skip departure
        }
      }
      editorHistory.push({ ...target, line: target.line ?? 1 });
    },
    [viewFilePath, editorHistory.push],
  );

  // Sync when the file prop changes (e.g. navigating from diff view).
  // The file prop also changes after handleSelectFile navigates the route,
  // but that navigation is already recorded synchronously, so the sentinel
  // inside the hook deduplicates it.
  //
  // prevFileRef tracks the previous value so we only clear viewFilePath
  // when file is *removed* (e.g. mobile back nav), not on the initial
  // mount where file is absent but fileTabs.activeTabPath was restored.
  const prevFileRef = useRef(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorHistory.push is stable (ref-based)
  useEffect(() => {
    if (skipFileEffectRef.current) {
      skipFileEffectRef.current = false;
      return;
    }
    if (file) {
      const loc = parseFileLocation(file);
      editorHistory.push({
        filePath: loc.filePath,
        line: loc.line ?? 1,
        column: loc.column,
      });
      fileTabs.openTab(loc.filePath);
      setViewFilePath(loc.filePath);
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
    } else if (prevFileRef.current) {
      // File prop removed (e.g. route changed via back navigation) — clear
      // view state so the mobile layout switches back to FileBrowser.
      // Only when transitioning from a file to no file, not on initial mount.
      setViewFilePath("");
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
    }
    prevFileRef.current = file;
  }, [file]);

  // Handle externally triggered file open (Quick Open, Search, chat links)
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorHistory.push is stable (ref-based)
  useEffect(() => {
    if (openFilePath) {
      const loc = parseFileLocation(openFilePath);
      editorHistory.push({
        filePath: loc.filePath,
        line: loc.line ?? 1,
        column: loc.column,
      });
      fileTabs.openTab(loc.filePath);
      setViewFilePath(loc.filePath);
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
      onFileOpened?.();
    }
  }, [openFilePath, onFileOpened]);

  // Called by the cursorLineTracker CM extension when the user jumps ≥10 lines
  // (clicking a distant line, Page Up/Down, etc.). Records both the departure
  // and arrival lines so the user can navigate back and forward between them.
  const handleCursorLineChange = useCallback(
    (departureLine: number, arrivalLine: number) => {
      if (viewFilePath) {
        editorHistory.push({ filePath: viewFilePath, line: departureLine });
        editorHistory.push({ filePath: viewFilePath, line: arrivalLine });
      }
    },
    [viewFilePath, editorHistory.push],
  );

  // -------------------------------------------------------------------------
  // Find-in-file state
  // -------------------------------------------------------------------------
  const getViews = useCallback(() => (editorViewRef.current ? [editorViewRef.current] : []), []);

  const search = useSearch({ getViews, onFindInFile });

  // Flag: focus the editor once the next view is ready (after cross-file nav)
  const focusOnViewReadyRef = useRef(false);

  const handleEditorView = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped to avoid cross-package dependency
    (view: any) => {
      editorViewRef.current = view;
      if (view) {
        search.dispatchToViews([view]);
        if (focusOnViewReadyRef.current) {
          focusOnViewReadyRef.current = false;
          view.focus();
        }
        // Resolve pending LSP cross-file navigation (e.g., go-to-definition)
        if (hasPendingNavigation()) {
          resolveNavigation(view);
        }
      }
    },
    [search.dispatchToViews],
  );

  // Close search when file changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewFilePath intentionally triggers reset when user navigates to a different file
  useEffect(() => {
    search.handleCloseSearch();
  }, [viewFilePath]);

  // Open a file in the preview slot, pinning any dirty preview tab first
  // (so unsaved edits are never silently dropped) and releasing editor
  // state for the evicted preview to keep memory bounded. Reads tab state
  // through refs so the callback identity stays stable across tab changes.
  const openPreviewWithGuard = useCallback(
    (filePath: string) => {
      const previewTab = openTabsRef.current.find((t) => t.isPreview);
      if (
        previewTab &&
        previewTab.filePath !== filePath &&
        isDirtyRef.current(previewTab.filePath)
      ) {
        fileTabs.pinTab(previewTab.filePath);
      }
      const evicted = fileTabs.openTabPreview(filePath);
      if (evicted && evicted !== filePath) {
        delete savedEditorStatesRef.current[evicted];
        removeFileRef.current(evicted);
      }
    },
    [fileTabs.pinTab, fileTabs.openTabPreview],
  );

  const handleSelectFile = useCallback(
    (filePath: string) => {
      pushDepartureAndArrival({ filePath });
      openPreviewWithGuard(filePath);
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [onSelectFile, pushDepartureAndArrival, openPreviewWithGuard],
  );

  const handleSelectFilePinned = useCallback(
    (filePath: string) => {
      pushDepartureAndArrival({ filePath });
      fileTabs.openTabPinned(filePath);
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [onSelectFile, pushDepartureAndArrival, fileTabs.openTabPinned],
  );

  const handleBack = useCallback(() => {
    setViewFilePath("");
    setViewLine(undefined);
    setViewLineEnd(undefined);
    setViewColumn(undefined);
    onSelectFile?.(null);
  }, [onSelectFile]);

  // -------------------------------------------------------------------------
  // Tab handlers
  // -------------------------------------------------------------------------
  const handleTabSelect = useCallback(
    (filePath: string) => {
      // Save full editor state for the departing file (doc, selection, undo history, scroll)
      const view = editorViewRef.current;
      if (view && viewFilePath) {
        try {
          const state = serializeEditorState(view);
          savedEditorStatesRef.current[viewFilePath] = state;
          // Persist to localStorage so undo history survives workspace switches
          tabState.update(viewFilePath, {
            editorState: state.editorState,
            scrollTop: state.scrollTop,
          });
        } catch {
          // CM view not ready
        }
      }

      // Prevent the file prop effect from overwriting state.
      // The route round-trip (via onSelectFile) only carries the file path.
      if (filePath !== viewFilePath) skipFileEffectRef.current = true;

      fileTabs.setActiveTab(filePath);
      setViewFilePath(filePath);
      // Don't set viewLine — cursor position is restored from savedEditorState
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [fileTabs.setActiveTab, onSelectFile, viewFilePath, tabState.update],
  );

  const handleTabClose = useCallback(
    (filePath: string) => {
      // Remove all stored state for this tab (view mode, edited content)
      tabState.removeFile(filePath);
      // Remove in-memory editor state (cursor, selection, undo history, scroll)
      delete savedEditorStatesRef.current[filePath];
      // Notify listeners (FileTabBar) that dirty state changed
      window.dispatchEvent(new CustomEvent("band:dirty-change"));
      fileTabs.closeTab(filePath);
    },
    [fileTabs.closeTab, tabState.removeFile],
  );

  // Sync viewFilePath when active tab changes due to a close.
  // Only reacts to tab state changes — onSelectFile and viewFilePath are
  // intentionally read as latest values to avoid re-triggering on every
  // parent render or file navigation.
  //
  // IMPORTANT: skip the initial mount run.  On mount, fileTabs loads the
  // persisted active tab from localStorage.  If we didn't skip, the
  // effect would see activeTabPath !== viewFilePath ("" on mount) and
  // re-open the previously viewed file — defeating mobile back navigation
  // which clears viewFilePath and then navigates to the code-index route
  // (causing a remount with an empty viewFilePath).
  const skipInitialTabSync = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: onSelectFile and viewFilePath are intentionally excluded to prevent feedback loops
  useEffect(() => {
    if (skipInitialTabSync.current) {
      skipInitialTabSync.current = false;
      return;
    }
    if (fileTabs.activeTabPath === null && fileTabs.openTabs.length === 0) {
      // All tabs closed — show empty state
      setViewFilePath("");
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(null);
    } else if (fileTabs.activeTabPath && fileTabs.activeTabPath !== viewFilePath) {
      // Active tab changed (e.g. after closing) — sync to new active tab
      // Cursor/scroll position is restored from savedEditorStatesRef via props
      skipFileEffectRef.current = true;
      setViewFilePath(fileTabs.activeTabPath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(fileTabs.activeTabPath);
    }
  }, [fileTabs.activeTabPath, fileTabs.openTabs.length]);

  const navigateToEntry = useCallback(
    (entry: { filePath: string; line?: number; column?: number }) => {
      const sameFile = entry.filePath === viewFilePath;
      // Prevent the file prop effect from overwriting the line we're about to set.
      // The route round-trip only carries the file path, not the line.
      if (!sameFile) skipFileEffectRef.current = true;
      // Clear saved editor state so the explicit line takes precedence
      delete savedEditorStatesRef.current[entry.filePath];
      // History navigation reuses the preview slot — same as single-click in tree.
      openPreviewWithGuard(entry.filePath);
      setViewFilePath(entry.filePath);
      setViewLine(entry.line);
      setViewLineEnd(undefined);
      setViewColumn(entry.column);
      onSelectFile?.(entry.filePath);

      if (sameFile && editorViewRef.current) {
        // Same file: directly scroll + focus the editor view.
        // React state dedup would skip the effect if the line value is unchanged.
        if (entry.line) {
          scrollToLine(editorViewRef.current, entry.line, undefined, entry.column);
        }
        editorViewRef.current.focus();
      } else {
        // Cross-file: the editor view will be recreated — focus it once ready.
        focusOnViewReadyRef.current = true;
      }
    },
    [viewFilePath, onSelectFile, openPreviewWithGuard],
  );

  const handleEditorGoBack = useCallback(() => {
    const entry = editorHistory.goBack();
    if (entry) navigateToEntry(entry);
  }, [editorHistory.goBack, navigateToEntry]);

  const handleEditorGoForward = useCallback(() => {
    const entry = editorHistory.goForward();
    if (entry) navigateToEntry(entry);
  }, [editorHistory.goForward, navigateToEntry]);

  // Listen for keyboard shortcut events dispatched from DockviewWorkspaceLayout
  useEffect(() => {
    const handleGoBack = () => handleEditorGoBack();
    const handleGoForward = () => handleEditorGoForward();

    window.addEventListener("band:editor-go-back", handleGoBack);
    window.addEventListener("band:editor-go-forward", handleGoForward);
    return () => {
      window.removeEventListener("band:editor-go-back", handleGoBack);
      window.removeEventListener("band:editor-go-forward", handleGoForward);
    };
  }, [handleEditorGoBack, handleEditorGoForward]);

  // Listen for LSP cross-file navigation events (e.g., go-to-definition)
  useEffect(() => {
    const handleLspNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filePath) {
        pushDepartureAndArrival({ filePath: detail.filePath });
        // Use skipFileEffectRef to prevent the route change from clobbering nav
        skipFileEffectRef.current = true;
        fileTabs.openTab(detail.filePath);
        setViewFilePath(detail.filePath);
        setViewLine(undefined);
        setViewLineEnd(undefined);
        setViewColumn(undefined);
        onSelectFile?.(detail.filePath);
        // The LSP library will position the cursor once resolveNavigation provides the view
        focusOnViewReadyRef.current = true;
      }
    };

    window.addEventListener("band:lsp-navigate", handleLspNavigate);
    return () => window.removeEventListener("band:lsp-navigate", handleLspNavigate);
  }, [pushDepartureAndArrival, fileTabs.openTab, onSelectFile]);

  // Ctrl+Tab / Ctrl+Shift+Tab to switch between file tabs
  useEffect(() => {
    const handleNextTab = () => {
      const tabs = fileTabs.openTabs;
      if (tabs.length <= 1) return;
      const currentIndex = tabs.findIndex((t) => t.filePath === fileTabs.activeTabPath);
      const nextIndex = (currentIndex + 1) % tabs.length;
      handleTabSelect(tabs[nextIndex].filePath);
    };
    const handlePrevTab = () => {
      const tabs = fileTabs.openTabs;
      if (tabs.length <= 1) return;
      const currentIndex = tabs.findIndex((t) => t.filePath === fileTabs.activeTabPath);
      const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      handleTabSelect(tabs[prevIndex].filePath);
    };

    window.addEventListener("band:next-file-tab", handleNextTab);
    window.addEventListener("band:prev-file-tab", handlePrevTab);
    return () => {
      window.removeEventListener("band:next-file-tab", handleNextTab);
      window.removeEventListener("band:prev-file-tab", handlePrevTab);
    };
  }, [fileTabs.openTabs, fileTabs.activeTabPath, handleTabSelect]);

  // Cmd+W / Ctrl+W to close active tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        if (fileTabs.activeTabPath) {
          e.preventDefault();
          e.stopPropagation();
          handleTabClose(fileTabs.activeTabPath);
        }
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [fileTabs.activeTabPath, handleTabClose]);

  // -------------------------------------------------------------------------
  // Resizable file tree panel
  // -------------------------------------------------------------------------
  const treePanelRef = usePanelRef();
  const [treeCollapsed, setTreeCollapsed] = useState(() => loadFileTreeCollapsed(workspaceId));
  const skipFirstLayoutCallback = useRef(true);

  const savedCollapsed = loadFileTreeCollapsed(workspaceId);
  const savedWidth = loadFileTreeWidth(workspaceId);
  const defaultLayout = savedCollapsed
    ? { "file-tree": 0, "file-viewer": 100 }
    : savedWidth
      ? { "file-tree": savedWidth, "file-viewer": 100 - savedWidth }
      : undefined;

  const handleLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      if (skipFirstLayoutCallback.current) {
        skipFirstLayoutCallback.current = false;
        return;
      }
      if (layout["file-tree"] != null) {
        saveFileTreeWidth(workspaceId, layout["file-tree"]);
      }
    },
    [workspaceId],
  );

  const toggleTree = useCallback(() => {
    const panel = treePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [treePanelRef]);

  // Auto-expand tree when a file is opened externally (Quick Open / Search)
  useEffect(() => {
    if (openFilePath && treeCollapsed) {
      treePanelRef.current?.expand();
    }
  }, [openFilePath, treeCollapsed, treePanelRef]);

  // -------------------------------------------------------------------------
  // Render — mobile toggle layout or desktop side-by-side layout
  // -------------------------------------------------------------------------
  // Wrapped in a measured container so the ResizeObserver can track width.
  return (
    <div ref={containerRef} className="h-full">
      {useMobileLayout ? (
        // Mobile / narrow container: toggle between file browser and viewer
        viewFilePath ? (
          <FileViewer
            workspaceId={workspaceId}
            filePath={viewFilePath}
            line={viewLine}
            lineEnd={viewLineEnd}
            column={viewColumn}
            onBack={handleBack}
            onGoBack={handleEditorGoBack}
            onGoForward={handleEditorGoForward}
            canGoBack={editorHistory.canGoBack}
            canGoForward={editorHistory.canGoForward}
            onCursorLineChange={handleCursorLineChange}
            renderMarkdown={renderMarkdown}
            editable
            lspExtension={lspExtension}
            initialEditedContent={tabState.get(viewFilePath)?.editedContent ?? null}
            savedEditorState={
              savedEditorStatesRef.current[viewFilePath]?.editorState ??
              tabState.get(viewFilePath)?.editorState
            }
            savedScrollTop={
              savedEditorStatesRef.current[viewFilePath]?.scrollTop ??
              tabState.get(viewFilePath)?.scrollTop
            }
            onEditedContentChange={handleEditedContentChange}
          />
        ) : (
          <FileBrowser
            workspaceId={workspaceId}
            onOpenFile={handleSelectFile}
            onOpenFilePinned={handleSelectFilePinned}
            selectedFile={viewFilePath}
          />
        )
      ) : (
        // Desktop: side-by-side layout with resizable file tree
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={handleLayoutChanged}
        >
          {/* Left panel — file tree */}
          <Panel
            id="file-tree"
            defaultSize="15rem"
            minSize="10rem"
            maxSize="50%"
            collapsible
            collapsedSize="0%"
            panelRef={treePanelRef}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0;
              setTreeCollapsed(collapsed);
              saveFileTreeCollapsed(workspaceId, collapsed);
            }}
          >
            <div className="flex h-full flex-col overflow-hidden border-r border-border">
              <FileTreeToolbar onQuickOpen={onQuickOpen} onSearchFiles={onSearchFiles} />
              <div className="min-h-0 flex-1 overflow-hidden">
                <FileBrowser
                  workspaceId={workspaceId}
                  onOpenFile={handleSelectFile}
                  onOpenFilePinned={handleSelectFilePinned}
                  compact
                  selectedFile={viewFilePath}
                />
              </div>
            </div>
          </Panel>

          <Separator className="group relative w-[3px] bg-transparent hover:bg-accent-foreground/20 active:bg-accent-foreground/30 transition-colors cursor-col-resize">
            <button
              type="button"
              onClick={toggleTree}
              className="absolute top-1/2 left-1/2 z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent-foreground/30 bg-background text-muted-foreground opacity-0 shadow-md transition-opacity hover:border-accent-foreground/50 hover:text-foreground group-hover:opacity-100"
            >
              {treeCollapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronLeft className="size-4" />
              )}
            </button>
          </Separator>

          {/* Right panel — file tabs + content */}
          <Panel id="file-viewer" minSize="20%">
            <div className="relative flex h-full flex-col overflow-hidden">
              {/* Tab bar — owns the file-tree toggle now (auto-hides when narrow) */}
              <FileTabBar
                workspacePath={workspacePath}
                tabs={fileTabs.openTabs}
                activeTabPath={fileTabs.activeTabPath}
                onSelectTab={handleTabSelect}
                onCloseTab={handleTabClose}
                onPinTab={fileTabs.pinTab}
                onGoBack={handleEditorGoBack}
                onGoForward={handleEditorGoForward}
                canGoBack={editorHistory.canGoBack}
                canGoForward={editorHistory.canGoForward}
                isDirty={tabState.isDirty}
                treeCollapsed={treeCollapsed}
                onToggleTree={toggleTree}
                actions={
                  isMarkdown ? (
                    <div className="flex items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setMdViewMode("preview")}
                            className={`inline-flex size-6 items-center justify-center rounded-md transition-colors ${
                              mdViewMode === "preview"
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            }`}
                          >
                            <Eye className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">
                          Preview
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setMdViewMode("source")}
                            className={`inline-flex size-6 items-center justify-center rounded-md transition-colors ${
                              mdViewMode === "source"
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            }`}
                          >
                            <Code className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">
                          Source
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  ) : undefined
                }
              />

              {/* File content */}
              <div className="min-h-0 flex-1">
                {viewFilePath ? (
                  <FileViewer
                    workspaceId={workspaceId}
                    filePath={viewFilePath}
                    line={viewLine}
                    lineEnd={viewLineEnd}
                    column={viewColumn}
                    onEditorView={handleEditorView}
                    onCursorLineChange={handleCursorLineChange}
                    renderMarkdown={renderMarkdown}
                    editable
                    hideTitleBar
                    lspExtension={lspExtension}
                    viewMode={isMarkdown ? mdViewMode : undefined}
                    onViewModeChange={isMarkdown ? setMdViewMode : undefined}
                    initialEditedContent={tabState.get(viewFilePath)?.editedContent ?? null}
                    savedEditorState={
                      savedEditorStatesRef.current[viewFilePath]?.editorState ??
                      tabState.get(viewFilePath)?.editorState
                    }
                    savedScrollTop={
                      savedEditorStatesRef.current[viewFilePath]?.scrollTop ??
                      tabState.get(viewFilePath)?.scrollTop
                    }
                    onEditedContentChange={handleEditedContentChange}
                    toolbar={
                      search.searchOpen ? (
                        <SearchBar
                          ref={search.searchBarRef}
                          query={search.searchQuery}
                          onQueryChange={search.setSearchQuery}
                          options={search.searchOptions}
                          onOptionsChange={search.setSearchOptions}
                          placeholder="Find in file..."
                          matchInfo={search.matchInfo}
                          onNext={search.handleNext}
                          onPrevious={search.handlePrevious}
                          onClose={search.handleCloseSearch}
                        />
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex flex-col items-center gap-3 px-8 text-center">
                      <File className="size-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">Select a file to view</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </Group>
      )}
    </div>
  );
}
