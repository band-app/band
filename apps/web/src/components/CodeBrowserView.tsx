import {
  FileBrowser,
  FileViewer,
  parseFileLocation,
  SearchBar,
  useSearch,
} from "@band-app/dashboard-core";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  ChevronLeft,
  ChevronRight,
  File,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  TextSearch,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Streamdown } from "streamdown";
import { useIsDesktop } from "../hooks/useIsDesktop";
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
              <PanelLeftOpen className="size-3.5" />
            ) : (
              <PanelLeftClose className="size-3.5" />
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

  // Sync when the file prop changes (e.g. navigating from diff view)
  useEffect(() => {
    if (file) {
      const loc = parseFileLocation(file);
      setViewFilePath(loc.filePath);
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
    }
  }, [file]);

  // Handle externally triggered file open
  useEffect(() => {
    if (openFilePath) {
      const loc = parseFileLocation(openFilePath);
      setViewFilePath(loc.filePath);
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
      onFileOpened?.();
    }
  }, [openFilePath, onFileOpened]);

  // -------------------------------------------------------------------------
  // Find-in-file state
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: EditorView type from @codemirror/view — kept untyped to avoid cross-package dependency
  const editorViewRef = useRef<any>(null);

  const getViews = useCallback(() => (editorViewRef.current ? [editorViewRef.current] : []), []);

  const search = useSearch({ getViews, onFindInFile });

  const handleEditorView = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped to avoid cross-package dependency
    (view: any) => {
      editorViewRef.current = view;
      if (view) {
        search.dispatchToViews([view]);
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
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [onSelectFile],
  );

  const handleBack = useCallback(() => {
    setViewFilePath("");
    setViewLine(undefined);
    setViewLineEnd(undefined);
    setViewColumn(undefined);
    onSelectFile?.(null);
  }, [onSelectFile]);

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
          renderMarkdown={renderMarkdown}
          editable
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

      {/* Right panel — file content */}
      <Panel id="file-viewer" minSize="20%">
        <div className="relative h-full overflow-hidden">
          {treeCollapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleTree}
                  className="absolute left-1 top-0 z-10 inline-flex h-9 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <PanelLeftOpen className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Show File Explorer
              </TooltipContent>
            </Tooltip>
          )}
          <div className={treeCollapsed ? "h-full [&>div>div:first-child]:pl-8" : "h-full"}>
            {viewFilePath ? (
              <FileViewer
                workspaceId={workspaceId}
                filePath={viewFilePath}
                line={viewLine}
                lineEnd={viewLineEnd}
                column={viewColumn}
                onEditorView={handleEditorView}
                renderMarkdown={renderMarkdown}
                editable
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
