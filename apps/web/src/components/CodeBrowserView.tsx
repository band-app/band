import {
  buildLspWsUrl,
  createLspExtension,
  FileBrowser,
  type FileBrowserHandle,
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
  useCapabilities,
  useEditorHistory,
  useProjects,
  useSearch,
  useSettingsQuery,
} from "@band-app/dashboard-core";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import type { Extension } from "@codemirror/state";
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Eye,
  File,
  FileInput,
  FilePlus,
  FolderPlus,
  MoreVertical,
  Search,
  TextSearch,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Streamdown } from "streamdown";
import { useFileTabs } from "../hooks/useFileTabs";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useTabState } from "../hooks/useTabState";
import { applyFrontmatterTable } from "../lib/frontmatter";
import { FileTabBar } from "./FileTabBar";
import { streamdownComponents, streamdownPlugins } from "./streamdown-components";

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
  // Frontmatter (YAML between `---` delimiters at the top of the file) is
  // rewritten into a markdown table by `applyFrontmatterTable` so SKILL.md
  // / plan-file metadata renders as a scannable table instead of leaking
  // raw `---` delimiters into the preview. When there is no frontmatter,
  // the helper returns the original string unchanged.
  return (
    <Streamdown
      className={cn(
        "size-full break-words leading-relaxed [overflow-wrap:anywhere]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
      plugins={streamdownPlugins}
      components={streamdownComponents}
    >
      {applyFrontmatterTable(content)}
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
}

// ---------------------------------------------------------------------------
// File tree toolbar
// ---------------------------------------------------------------------------

interface FileTreeToolbarProps {
  onNewFile?: () => void;
  onNewFolder?: () => void;
  /**
   * Trigger the OS file picker and open the chosen file in a new
   * editor tab. Only defined inside the desktop shell (where the
   * native dialog is available — see `capabilities.pickFile`), so the
   * toolbar simply omits the action on the web. Backs the "Open File…"
   * flow.
   */
  onOpenFile?: () => void;
}

// Below this width (px), the toolbar collapses its action buttons into a
// vertical 3-dots dropdown so the panel stays usable even when narrow.
const TOOLBAR_COMPACT_BREAKPOINT = 200;

/**
 * Build a pointerup handler that mirrors a click for touch / pen pointers.
 *
 * iOS Safari swallows the synthetic click on a Tooltip-wrapped button's
 * first tap — the OS treats the tap as a "show hover state" gesture for
 * the tooltip, the tooltip flashes, and `onClick` never fires. Lifting on
 * pointerup is reliable across pointer types: we run the action there for
 * touch and pen, and `preventDefault()` stops the synthetic click from
 * firing afterward so mouse-pointer clicks (which take the `onClick` path)
 * don't double-trigger.
 */
const touchPointerUp = (fn?: () => void) => (e: React.PointerEvent<HTMLButtonElement>) => {
  if (!fn || e.pointerType === "mouse") return;
  e.preventDefault();
  fn();
};

/**
 * Open Quick Open via a window event. The active workspace layout
 * (MobileWorkspaceLayout in `workspace.$workspaceId.tsx` or
 * DockviewWorkspaceLayout when desktop) listens for this event and
 * opens its locally-owned dialog. Using an event avoids threading the
 * setter through a React context across multiple route levels, which
 * proved unreliable in practice on the iOS Simulator.
 */
const fireOpenQuickOpen = () => window.dispatchEvent(new CustomEvent("band:open-quick-open"));
const fireOpenSearchFiles = () => window.dispatchEvent(new CustomEvent("band:open-search-files"));

function FileTreeToolbar({ onNewFile, onNewFolder, onOpenFile }: FileTreeToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setCompact(el.clientWidth < TOOLBAR_COMPACT_BREAKPOINT);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < TOOLBAR_COMPACT_BREAKPOINT);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Defer the dropdown's menu actions until after the menu has fully
  // closed — same trick the file-tree context menus use. Without this,
  // selecting "New File" mounts the inline rename / new-entry input
  // inside dashboard-core while Radix's FocusScope (still alive for
  // the DropdownMenu's close transition) yanks focus back, and the
  // input's own onBlur tears it down before it can take focus.
  const pendingMenuAction = useRef<(() => void) | null>(null);
  const queueMenuAction = useCallback((fn: () => void) => {
    pendingMenuAction.current = fn;
  }, []);
  const flushMenuAction = useCallback((e: { preventDefault: () => void }) => {
    e.preventDefault();
    const fn = pendingMenuAction.current;
    pendingMenuAction.current = null;
    fn?.();
  }, []);

  return (
    <div
      ref={rootRef}
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/50 pl-3 pr-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">Files</span>
      <div className="flex-1" />
      {compact ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="File tree actions"
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground"
                >
                  <MoreVertical className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              More
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className="min-w-[10rem]"
            onCloseAutoFocus={flushMenuAction}
          >
            {onNewFile && (
              <DropdownMenuItem onSelect={() => queueMenuAction(onNewFile)}>
                <FilePlus className="size-4" />
                New File
              </DropdownMenuItem>
            )}
            {onNewFolder && (
              <DropdownMenuItem onSelect={() => queueMenuAction(onNewFolder)}>
                <FolderPlus className="size-4" />
                New Folder
              </DropdownMenuItem>
            )}
            {(onNewFile || onNewFolder) && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => queueMenuAction(fireOpenQuickOpen)}>
              <Search className="size-4" />
              Quick Open
              <kbd className="ml-auto rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[10px]">
                ⌘P
              </kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => queueMenuAction(fireOpenSearchFiles)}>
              <TextSearch className="size-4" />
              Search in Files
              <kbd className="ml-auto rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[10px]">
                ⌘⇧F
              </kbd>
            </DropdownMenuItem>
            {onOpenFile && (
              <DropdownMenuItem onSelect={() => queueMenuAction(onOpenFile)}>
                <FileInput className="size-4" />
                Open File…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          {onNewFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onNewFile}
                  onPointerUp={touchPointerUp(onNewFile)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <FilePlus className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                New File
              </TooltipContent>
            </Tooltip>
          )}

          {onNewFolder && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onNewFolder}
                  onPointerUp={touchPointerUp(onNewFolder)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <FolderPlus className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                New Folder
              </TooltipContent>
            </Tooltip>
          )}

          {onOpenFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenFile}
                  onPointerUp={touchPointerUp(onOpenFile)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <FileInput className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Open File…
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={fireOpenQuickOpen}
                onPointerUp={touchPointerUp(fireOpenQuickOpen)}
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
                onClick={fireOpenSearchFiles}
                onPointerUp={touchPointerUp(fireOpenSearchFiles)}
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
        </>
      )}
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
}: CodeBrowserViewProps) {
  const isDesktop = useIsDesktop();
  const fileTabs = useFileTabs(workspaceId);
  const tabState = useTabState(workspaceId);

  // Mirror tab-state callbacks behind refs. `openPreviewWithGuard` is
  // memoised on `fileTabs.openTabPreview` alone — these refs let it read
  // the latest isDirty / removeFile without churning its dep array (which
  // would re-trigger downstream LSP / keyboard effects every render).
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

  // Listen for the workspace-level ⇧⌘E "focus Files" event. Scope the
  // focus to this CodeBrowserView's subtree (containerRef), so multi-
  // workspace setups don't fight — only the visible instance's focus
  // actually applies (offsetParent === null on hidden ones is a no-op).
  // Prefer the currently-active file row (data-band-active); fall back
  // to the first focusable button in the tree if nothing is selected.
  useEffect(() => {
    const handler = () => {
      const root = containerRef.current;
      if (!root || root.offsetParent === null) return;
      const target =
        root.querySelector<HTMLElement>("[data-band-active]") ??
        root.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
    };
    window.addEventListener("band:focus-files", handler);
    return () => window.removeEventListener("band:focus-files", handler);
  }, []);

  // Use the mobile toggle layout when EITHER the viewport is narrow (real
  // mobile) OR the container is narrower than 600px (narrow dockview panel).
  const useMobileLayout = !isDesktop || (containerWidth !== null && containerWidth < 600);

  // Look up whether a given path is an external (out-of-workspace) tab.
  // Returns `false` for null / unknown paths so the workspace-relative
  // path through `onSelectFile` keeps firing for anything that hasn't
  // explicitly been opened as external.
  const isExternalPath = useCallback(
    (filePath: string | null): boolean => {
      if (filePath === null) return false;
      const tab = fileTabs.openTabs.find((t) => t.filePath === filePath);
      return tab?.isExternal === true;
    },
    [fileTabs.openTabs],
  );

  // Whether the currently-viewed file lives outside the workspace root.
  // Derived from the tab list so we don't have to thread a second flag
  // everywhere a path does.
  const viewIsExternal = useMemo(
    () => isExternalPath(viewFilePath || null),
    [isExternalPath, viewFilePath],
  );

  // The parent route's onSelectFile pushes the path into the URL
  // (`/workspace/$workspaceId/code/$filePath`). External files use
  // absolute filesystem paths, which would produce a nonsensical URL
  // (`/workspace/foo/code//Users/alice/foo.md`) — so we silently drop
  // those notifications. The tab list (persisted to localStorage) is
  // the source of truth for "what's currently being viewed" instead.
  //
  // The guard checks `isExternalPath` against the current tab list so
  // the invariant ("external tabs don't round-trip through the route")
  // is explicit, rather than relying on the implicit "external paths
  // happen to be absolute, workspace-relative paths happen not to be."
  const notifySelectFile = useCallback(
    (filePath: string | null) => {
      if (isExternalPath(filePath)) return;
      onSelectFile?.(filePath);
    },
    [isExternalPath, onSelectFile],
  );

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

  // Detect the language of the current file and build the LSP WebSocket URL.
  // External files are outside the workspace's project root, so the
  // workspace's tsserver wouldn't have any useful context for them — skip
  // LSP entirely.
  const lspServerLang = useMemo(() => {
    if (!settings.enableLSP) return null;
    if (!viewFilePath) return null;
    if (viewIsExternal) return null;
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
  }, [viewFilePath, viewIsExternal, settings.enableLSP]);

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

  // Handle externally triggered file open (Quick Open, Search, chat links).
  // These are explicit user intentions to open a file — pin the destination
  // so it isn't silently replaced by the next single-click in the tree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorHistory.push is stable (ref-based)
  useEffect(() => {
    if (openFilePath) {
      const loc = parseFileLocation(openFilePath);
      editorHistory.push({
        filePath: loc.filePath,
        line: loc.line ?? 1,
        column: loc.column,
      });
      fileTabs.openTabPinned(loc.filePath);
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

  // Open a file in the preview slot. `openTabPreview` pins a dirty preview
  // in place before evicting (single atomic setState updater) so unsaved
  // edits are never silently dropped. We release editor state for the
  // evicted (clean) preview to keep memory bounded.
  const openPreviewWithGuard = useCallback(
    (filePath: string) => {
      const evicted = fileTabs.openTabPreview(filePath, isDirtyRef.current);
      if (evicted && evicted !== filePath) {
        delete savedEditorStatesRef.current[evicted];
        removeFileRef.current(evicted);
      }
    },
    [fileTabs.openTabPreview],
  );

  // Preview-tab behavior is opt-out via the `enableFilePreviewTabs` setting.
  // The setting defaults to true, matching the PR's new default; when the
  // user disables it, single-click reverts to the pre-PR pinned-open
  // behavior. Double-click and edit-auto-pin paths remain functional in
  // either mode — they're no-ops when there's no preview slot to operate on.
  const previewTabsEnabled = settings.enableFilePreviewTabs ?? true;
  const handleSelectFile = useCallback(
    (filePath: string) => {
      // History push is deduped by useEditorHistory's proximity check
      // (same file + close line), so skipping here when the target equals
      // the current view file just keeps the call site simple — but the
      // pin/preview branch still needs to run.
      const isSameFile = filePath === viewFilePath;
      if (!isSameFile) pushDepartureAndArrival({ filePath });
      if (previewTabsEnabled) {
        openPreviewWithGuard(filePath);
      } else {
        fileTabs.openTabPinned(filePath);
      }
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      notifySelectFile(filePath);
    },
    [
      notifySelectFile,
      pushDepartureAndArrival,
      openPreviewWithGuard,
      fileTabs.openTabPinned,
      previewTabsEnabled,
      viewFilePath,
    ],
  );

  const handleSelectFilePinned = useCallback(
    (filePath: string) => {
      // A double-click on a file in the tree fires `onClick` twice plus
      // `onDoubleClick` once — so handleSelectFile has already pushed the
      // navigation and the file is now the current view. Skipping the
      // push when the target is unchanged keeps history sane on
      // double-click (and on rapid same-file re-clicks generally).
      if (filePath !== viewFilePath) pushDepartureAndArrival({ filePath });
      fileTabs.openTabPinned(filePath);
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      notifySelectFile(filePath);
    },
    [notifySelectFile, pushDepartureAndArrival, fileTabs.openTabPinned, viewFilePath],
  );

  const handleBack = useCallback(() => {
    setViewFilePath("");
    setViewLine(undefined);
    setViewLineEnd(undefined);
    setViewColumn(undefined);
    notifySelectFile(null);
  }, [notifySelectFile]);

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
      notifySelectFile(filePath);
    },
    [fileTabs.setActiveTab, notifySelectFile, viewFilePath, tabState.update],
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
      notifySelectFile(null);
    } else if (fileTabs.activeTabPath && fileTabs.activeTabPath !== viewFilePath) {
      // Active tab changed (e.g. after closing) — sync to new active tab
      // Cursor/scroll position is restored from savedEditorStatesRef via props
      skipFileEffectRef.current = true;
      setViewFilePath(fileTabs.activeTabPath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      notifySelectFile(fileTabs.activeTabPath);
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
      notifySelectFile(entry.filePath);

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
    [viewFilePath, notifySelectFile, openPreviewWithGuard],
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

  // Listen for LSP cross-file navigation events (e.g., go-to-definition).
  // Go-to-definition is an explicit user intent to land on the target — pin
  // the destination so the next single-click in the tree doesn't silently
  // replace the file the user just navigated to.
  useEffect(() => {
    const handleLspNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filePath) {
        pushDepartureAndArrival({ filePath: detail.filePath });
        // Use skipFileEffectRef to prevent the route change from clobbering nav
        skipFileEffectRef.current = true;
        fileTabs.openTabPinned(detail.filePath);
        setViewFilePath(detail.filePath);
        setViewLine(undefined);
        setViewLineEnd(undefined);
        setViewColumn(undefined);
        notifySelectFile(detail.filePath);
        // The LSP library will position the cursor once resolveNavigation provides the view
        focusOnViewReadyRef.current = true;
      }
    };

    window.addEventListener("band:lsp-navigate", handleLspNavigate);
    return () => window.removeEventListener("band:lsp-navigate", handleLspNavigate);
  }, [pushDepartureAndArrival, fileTabs.openTabPinned, notifySelectFile]);

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
  // File tree imperative handle (drives "new file" / "new folder" from toolbar)
  // -------------------------------------------------------------------------
  const fileBrowserRef = useRef<FileBrowserHandle | null>(null);

  const handleNewFile = useCallback(() => {
    fileBrowserRef.current?.startNewFile();
  }, []);
  const handleNewFolder = useCallback(() => {
    fileBrowserRef.current?.startNewFolder();
  }, []);

  // -------------------------------------------------------------------------
  // Open File… — desktop-only "open a file from anywhere on the local
  // filesystem" action. The OS file picker lives in the Electron main
  // process; once we have the path back, the file flows through the same
  // FileViewer used for workspace files, just with the `external` flag set
  // so reads/writes hit `host.readFile` / `host.saveFile`.
  // -------------------------------------------------------------------------
  const capabilities = useCapabilities();
  const pickFile = capabilities.pickFile;
  const handleOpenExternalFile = useCallback(async () => {
    if (!pickFile) return;
    const absolutePath = await pickFile();
    if (!absolutePath) return;
    fileTabs.openTabExternal(absolutePath);
    setViewFilePath(absolutePath);
    setViewLine(undefined);
    setViewLineEnd(undefined);
    setViewColumn(undefined);
    // We deliberately do NOT call onSelectFile / push to editor history —
    // the route only carries workspace-relative paths, and pushing an
    // absolute path would corrupt the back/forward stack. External tabs
    // remain reachable via the tab bar and Cmd+W close.
  }, [pickFile, fileTabs.openTabExternal]);

  // Surface the action via the same command-palette event pattern as
  // Quick Open / Search in Files. Listened to here so the desktop-shell
  // capability check stays local.
  useEffect(() => {
    if (!pickFile) return;
    const handler = () => {
      void handleOpenExternalFile();
    };
    window.addEventListener("band:open-file-external", handler);
    return () => window.removeEventListener("band:open-file-external", handler);
  }, [pickFile, handleOpenExternalFile]);

  // -------------------------------------------------------------------------
  // Keep tabs + editor state in sync with rename / delete in the file tree.
  // -------------------------------------------------------------------------

  // Save the editor view's current state for the currently active tab.
  // This needs to happen synchronously BEFORE the file path changes so
  // we don't lose pending edits when the editor remounts on the new
  // path. Returns a function that flushes the saved state to either
  // the rewritten path (rename) or drops it (delete).
  const flushActiveEditorState = useCallback(() => {
    const view = editorViewRef.current;
    const fp = viewFilePathRef.current;
    if (!view || !fp) return null;
    try {
      const state = serializeEditorState(view);
      return { path: fp, state };
    } catch {
      return null;
    }
  }, []);

  const handlePathRenamed = useCallback(
    (oldPath: string, newPath: string, _kind: "file" | "directory") => {
      // Capture the live editor state for the active tab before any
      // path rewriting so it survives the rename.
      const flushed = flushActiveEditorState();

      // Rewrite tab list and persisted per-tab state (editor state,
      // view mode, edited content). Both handle exact and prefix-match
      // semantics so directory renames cascade to descendant tabs.
      fileTabs.renameFile(oldPath, newPath);
      tabState.renameFile(oldPath, newPath);

      // In-memory editor states keyed by path also need rewriting.
      const oldPrefix = `${oldPath}/`;
      const newStates: typeof savedEditorStatesRef.current = {};
      for (const [key, value] of Object.entries(savedEditorStatesRef.current)) {
        if (key === oldPath) {
          newStates[newPath] = value;
        } else if (key.startsWith(oldPrefix)) {
          newStates[newPath + key.slice(oldPath.length)] = value;
        } else {
          newStates[key] = value;
        }
      }
      // If we just captured the active editor's state, persist it
      // under the renamed key so the editor restores cleanly when it
      // remounts on the new path.
      if (flushed) {
        const rewritten =
          flushed.path === oldPath
            ? newPath
            : flushed.path.startsWith(oldPrefix)
              ? newPath + flushed.path.slice(oldPath.length)
              : flushed.path;
        newStates[rewritten] = flushed.state;
        tabState.update(rewritten, {
          editorState: flushed.state.editorState,
          scrollTop: flushed.state.scrollTop,
        });
      }
      savedEditorStatesRef.current = newStates;

      // Sync the currently-viewed file path so the editor remounts on
      // the new name (or the new descendant path).
      if (viewFilePath === oldPath) {
        skipFileEffectRef.current = true;
        setViewFilePath(newPath);
        notifySelectFile(newPath);
      } else if (viewFilePath.startsWith(oldPrefix)) {
        const rewritten = newPath + viewFilePath.slice(oldPath.length);
        skipFileEffectRef.current = true;
        setViewFilePath(rewritten);
        notifySelectFile(rewritten);
      }
    },
    [
      fileTabs.renameFile,
      tabState.renameFile,
      tabState.update,
      flushActiveEditorState,
      viewFilePath,
      notifySelectFile,
    ],
  );

  const handlePathDeleted = useCallback(
    (path: string, _kind: "file" | "directory") => {
      const prefix = `${path}/`;
      // Drop in-memory editor state for any descendant.
      for (const key of Object.keys(savedEditorStatesRef.current)) {
        if (key === path || key.startsWith(prefix)) {
          delete savedEditorStatesRef.current[key];
        }
      }
      // Drop persisted per-tab state.
      tabState.removePath(path);
      // Drop tabs (this also adjusts activeTabPath if needed).
      fileTabs.removePath(path);

      // Clear the currently-viewed file if it sat inside the deleted tree.
      if (viewFilePath === path || viewFilePath.startsWith(prefix)) {
        setViewFilePath("");
        setViewLine(undefined);
        setViewLineEnd(undefined);
        setViewColumn(undefined);
        notifySelectFile(null);
      }
    },
    [fileTabs.removePath, tabState.removePath, viewFilePath, notifySelectFile],
  );

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

  // Auto-expand tree when the last tab is closed. Otherwise the user is
  // stranded: FileTabBar (which owns the tree-toggle button) renders null
  // when there are no tabs, so a collapsed tree leaves no visible UI to
  // open another file. (Issue #424)
  //
  // `treeCollapsed` is intentionally in the dep array — beyond the
  // close-last-tab and mount-with-empty-tabs cases, it also re-expands
  // the tree if the user drags the separator gripper to collapse it
  // while no tabs are open. That's the desired behaviour: you can't
  // strand yourself by collapsing the only remaining navigation UI.
  useEffect(() => {
    if (fileTabs.openTabs.length === 0 && treeCollapsed) {
      treePanelRef.current?.expand();
    }
  }, [fileTabs.openTabs.length, treeCollapsed, treePanelRef]);

  // -------------------------------------------------------------------------
  // Render — mobile toggle layout or desktop side-by-side layout
  // -------------------------------------------------------------------------
  // Wrapped in a measured container so the ResizeObserver can track width.
  return (
    // h-full + w-full + overflow-hidden + min-w-0 is required so that
    // CodeMirror's wide intrinsic content (long unwrapped lines, scrollable
    // horizontally) doesn't propagate up through the flex chain into
    // dockview's content container, which has min-height:0 but not
    // min-width:0 and would otherwise be pushed wider than its allocated
    // group slot — visibly shoving the right-edge tab strip off-screen.
    <div ref={containerRef} className="h-full w-full min-w-0 overflow-hidden">
      {useMobileLayout ? (
        // Mobile / narrow container: toggle between file browser and viewer
        viewFilePath ? (
          <FileViewer
            workspaceId={workspaceId}
            filePath={viewFilePath}
            external={viewIsExternal}
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
            // LSP is workspace-scoped — external files have no project root,
            // so we deliberately skip the extension for them.
            lspExtension={viewIsExternal ? null : lspExtension}
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
          // Same toolbar-above-tree layout the desktop side-by-side uses,
          // so New File / New Folder / Quick Open / Search in Files are
          // reachable on touch without relying on the (undiscoverable)
          // long-press → context menu. The toolbar already handles its
          // own narrow-width collapse into a kebab, so this works at any
          // mobile viewport.
          <div className="flex h-full flex-col overflow-hidden">
            <FileTreeToolbar
              onNewFile={handleNewFile}
              onNewFolder={handleNewFolder}
              onOpenFile={pickFile ? handleOpenExternalFile : undefined}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <FileBrowser
                ref={fileBrowserRef}
                workspaceId={workspaceId}
                onOpenFile={handleSelectFile}
                onOpenFilePinned={handleSelectFilePinned}
                selectedFile={viewFilePath}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
              />
            </div>
          </div>
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
              <FileTreeToolbar
                onNewFile={handleNewFile}
                onNewFolder={handleNewFolder}
                onOpenFile={pickFile ? handleOpenExternalFile : undefined}
              />
              <div className="min-h-0 flex-1 overflow-hidden">
                <FileBrowser
                  ref={fileBrowserRef}
                  workspaceId={workspaceId}
                  onOpenFile={handleSelectFile}
                  onOpenFilePinned={handleSelectFilePinned}
                  compact
                  selectedFile={viewFilePath}
                  onPathRenamed={handlePathRenamed}
                  onPathDeleted={handlePathDeleted}
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
            <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
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
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {viewFilePath ? (
                  <FileViewer
                    workspaceId={workspaceId}
                    filePath={viewFilePath}
                    external={viewIsExternal}
                    line={viewLine}
                    lineEnd={viewLineEnd}
                    column={viewColumn}
                    onEditorView={handleEditorView}
                    onCursorLineChange={handleCursorLineChange}
                    renderMarkdown={renderMarkdown}
                    editable
                    hideTitleBar
                    // LSP is workspace-scoped — external files have no project
                    // root, so we deliberately skip the extension for them.
                    lspExtension={viewIsExternal ? null : lspExtension}
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
