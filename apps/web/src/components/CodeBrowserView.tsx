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
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Eye,
  File,
  PanelLeft,
  Search,
  TextSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Streamdown } from "streamdown";
import { useFileTabs } from "../hooks/useFileTabs";
import { useIsDesktop } from "../hooks/useIsDesktop";
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
  treeCollapsed: boolean;
  onToggleTree: () => void;
}

function FileTreeToolbar({
  onQuickOpen,
  onSearchFiles,
  treeCollapsed,
  onToggleTree,
}: FileTreeToolbarProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border/50 px-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleTree}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {treeCollapsed ? (
              <PanelLeft className="size-3.5" />
            ) : (
              <PanelLeft className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {treeCollapsed ? "Show" : "Hide"} File Explorer
        </TooltipContent>
      </Tooltip>

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
    if (!file) return "";
    return parseFileLocation(file).filePath;
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

  // Markdown view mode (controlled from here, rendered in tab bar actions)
  const [mdViewMode, setMdViewMode] = useState<"preview" | "source">("preview");
  const isMarkdown = viewFilePath ? getFilePreviewType(viewFilePath) === "markdown" : false;

  // Reset to preview when switching to a different file
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on file change only
  useEffect(() => {
    setMdViewMode("preview");
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
    } else {
      // File prop removed (e.g. route changed via back navigation) — clear
      // view state so the mobile layout switches back to FileBrowser.
      setViewFilePath("");
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
    }
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

  const handleSelectFile = useCallback(
    (filePath: string) => {
      pushDepartureAndArrival({ filePath });
      fileTabs.openTab(filePath);
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [onSelectFile, pushDepartureAndArrival, fileTabs.openTab],
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
      fileTabs.setActiveTab(filePath);
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [fileTabs.setActiveTab, onSelectFile],
  );

  const handleTabClose = useCallback(
    (filePath: string) => {
      // Clear the unsaved edits cache so the file reloads fresh from
      // the server when reopened (same key format as FileViewer).
      try {
        localStorage.removeItem(`band-edits:${workspaceId}\0${filePath}`);
      } catch {
        // storage unavailable
      }
      fileTabs.closeTab(filePath);
    },
    [fileTabs.closeTab, workspaceId],
  );

  // Sync viewFilePath when active tab changes due to a close.
  // Only reacts to tab state changes — onSelectFile and viewFilePath are
  // intentionally read as latest values to avoid re-triggering on every
  // parent render or file navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onSelectFile and viewFilePath are intentionally excluded to prevent feedback loops
  useEffect(() => {
    if (fileTabs.activeTabPath === null && fileTabs.openTabs.length === 0) {
      // All tabs closed — show empty state
      setViewFilePath("");
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(null);
    } else if (fileTabs.activeTabPath && fileTabs.activeTabPath !== viewFilePath) {
      // Active tab changed (e.g. after closing) — sync to new active tab
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
      fileTabs.openTab(entry.filePath);
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
    [viewFilePath, onSelectFile, fileTabs.openTab],
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

  // Mobile: toggle between browse and view
  if (!isDesktop) {
    if (viewFilePath) {
      return (
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
        />
      );
    }
    return (
      <FileBrowser
        workspaceId={workspaceId}
        onOpenFile={handleSelectFile}
        selectedFile={viewFilePath}
      />
    );
  }

  // Desktop: side-by-side layout with resizable file tree
  return (
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
          <FileTreeToolbar
            onQuickOpen={onQuickOpen}
            onSearchFiles={onSearchFiles}
            treeCollapsed={treeCollapsed}
            onToggleTree={toggleTree}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <FileBrowser
              workspaceId={workspaceId}
              onOpenFile={handleSelectFile}
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
          {treeCollapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </Separator>

      {/* Right panel — file tabs + content */}
      <Panel id="file-viewer" minSize="20%">
        <div className="relative flex h-full flex-col overflow-hidden">
          {treeCollapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleTree}
                  className="absolute left-1 top-0 z-10 inline-flex h-9 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <PanelLeft className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Show File Explorer
              </TooltipContent>
            </Tooltip>
          )}

          {/* Tab bar */}
          <div className={treeCollapsed ? "[&>div]:pl-7" : ""}>
            <FileTabBar
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              tabs={fileTabs.openTabs}
              activeTabPath={fileTabs.activeTabPath}
              onSelectTab={handleTabSelect}
              onCloseTab={handleTabClose}
              onGoBack={handleEditorGoBack}
              onGoForward={handleEditorGoForward}
              canGoBack={editorHistory.canGoBack}
              canGoForward={editorHistory.canGoForward}
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
          </div>

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
  );
}
