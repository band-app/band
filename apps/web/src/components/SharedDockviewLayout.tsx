import { useRouterState } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AddToTerminalDetail,
  buildCommands,
  type ChatInsertDetail,
  CommandPaletteDialog,
  parseFileLocation,
  QuickOpenDialog,
  recordWorkspaceAccess,
  SearchFilesDialog,
  type SelectionToChatDetail,
  WorkspacePickerDialog,
} from "@/dashboard";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import {
  findFocusedInnerDockview,
  prepareMaximizeRestoreAnimation,
  toggleEdgeGroup,
} from "../lib/dockview-edge-groups";
import { isDesktop } from "../lib/is-desktop";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { enqueueExternalOpen } from "../lib/pending-external-open";
import { trpc } from "../lib/trpc-client";
import { MultiWorkspacePanelHost } from "./MultiWorkspacePanelHost";
import {
  getPerWorkspaceState,
  setPerWorkspaceState,
  subscribePerWorkspaceState,
} from "./per-workspace-state-store";
import { useAnyToolbarDialogOpen } from "./ToolbarButtons";
import {
  firstLeafOfKind,
  getWorkspaceDockviewApi,
  getWorkspaceLeafActions,
  type LeafKind,
  WorkspaceCenterDockview,
} from "./WorkspaceCenterDockview";

// ---------------------------------------------------------------------------
// Per-workspace cross-panel context
// ---------------------------------------------------------------------------
//
// Cross-panel state (currentFile, openFilePath, find-in-file registration) is
// per-workspace but read/written by leaves that live inside the per-workspace
// dockviews cached by `MultiWorkspacePanelHost`. We use module-level handlers
// wired by `SharedDockviewLayout`'s render so per-workspace callbacks always
// reference the latest closure without re-rendering every cached child.
// ---------------------------------------------------------------------------

interface CrossPanelHandlers {
  /** Called when the Changes leaf asks us to open a file in the Files leaf. */
  onOpenFile: (workspaceId: string, filename: string) => void;
  /** Called when the Files leaf reports the active file changed. */
  onSelectFile: (workspaceId: string, filePath: string | null) => void;
  /** Called when the Files leaf finishes opening the requested file. */
  onFileOpened: (workspaceId: string) => void;
  /** Called by a leaf to register/unregister its find-in-file callback. */
  onFindInFile: (workspaceId: string, fn: (() => void) | null) => void;
  /** Bring the Files leaf to the foreground (external-open flow). */
  onActivateFilesPanel: (workspaceId: string) => void;
  /** Bring a Terminal leaf to the foreground ("Continue in terminal"). */
  onActivateTerminalPanel: (workspaceId: string) => void;
}

// Mutable module-level handlers — `SharedDockviewLayout` writes them on every
// render. Exported so non-dockview call sites (the SSE listener in
// `__root.tsx`, the legacy chat container) can drive the layout.
export const crossPanelHandlers: CrossPanelHandlers = {
  onOpenFile: () => {},
  onSelectFile: () => {},
  onFileOpened: () => {},
  onFindInFile: () => {},
  onActivateFilesPanel: () => {},
  onActivateTerminalPanel: () => {},
};

// ---------------------------------------------------------------------------
// Helpers: resolve + drive the ACTIVE workspace's dockview
// ---------------------------------------------------------------------------

/** Activate the first leaf of `kind` in a workspace's dockview; returns
 *  whether a matching leaf was found. */
function activateLeafOfKind(workspaceId: string | null, kind: LeafKind): boolean {
  const api = getWorkspaceDockviewApi(workspaceId);
  const panel = api ? firstLeafOfKind(api, kind) : undefined;
  if (panel) {
    panel.api.setActive();
    return true;
  }
  return false;
}

// Empty state shown by the panel host when no workspace is selected.
function NoWorkspaceMessage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center px-8">
        <FolderOpen className="size-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Select a workspace to get started</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SharedDockviewLayout — a thin host around one per-workspace dockview
// ---------------------------------------------------------------------------

/**
 * The app-shell layout. No longer owns a dockview: it renders a single
 * `MultiWorkspacePanelHost` whose child is a `WorkspaceCenterDockview` per
 * cached workspace (the LRU keeps ~3 alive for instant switching). This
 * component keeps the shell-level concerns: the command dialogs, the global
 * keyboard shortcuts, and the cross-panel handler registry. Panel-activation
 * shortcuts resolve the active workspace's dockview from
 * `getWorkspaceDockviewApi`.
 */
export function SharedDockviewLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeWorkspaceId = parseWorkspaceFromPath(pathname);

  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  // Notify the "recent workspaces" picker on every workspace switch.
  useEffect(() => {
    if (activeWorkspaceId) recordWorkspaceAccess(activeWorkspaceId);
  }, [activeWorkspaceId]);

  const { recentFiles, trackFile } = useRecentFiles(activeWorkspaceId ?? "");

  // Shadow of the active workspace's currentFile for the format/quick-open flows.
  const currentFileRef = useRef<string | undefined>(undefined);
  const findInFileRegistry = useRef(new Map<string, () => void>());

  // Dialog state — exactly one dialog open at a time across the whole app.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [lastQuickOpenQuery, setLastQuickOpenQuery] = useState("");
  const [activeCurrentFile, setActiveCurrentFile] = useState<string | undefined>(undefined);

  // Refresh the active workspace's currentFile shadow on navigation.
  useEffect(() => {
    if (!activeWorkspaceId) {
      setActiveCurrentFile(undefined);
      currentFileRef.current = undefined;
      return;
    }
    const state = getPerWorkspaceState(activeWorkspaceId);
    setActiveCurrentFile(state.currentFile);
    currentFileRef.current = state.currentFile;
    const unsub = subscribePerWorkspaceState(activeWorkspaceId, () => {
      const next = getPerWorkspaceState(activeWorkspaceId).currentFile;
      setActiveCurrentFile(next);
      currentFileRef.current = next;
    });
    return unsub;
  }, [activeWorkspaceId]);

  // ---------------------------------------------------------------------
  // Cross-panel handler wiring
  // ---------------------------------------------------------------------

  const handleOpenFile = useCallback(
    (workspaceId: string, filename: string) => {
      const cleanPath = parseFileLocation(filename).filePath;
      setPerWorkspaceState(workspaceId, { currentFile: cleanPath, openFilePath: filename });
      trackFile(cleanPath);
      if (workspaceId === activeWorkspaceIdRef.current) {
        activateLeafOfKind(workspaceId, "files");
      }
    },
    [trackFile],
  );

  const handleFileOpened = useCallback((workspaceId: string) => {
    setPerWorkspaceState(workspaceId, { openFilePath: null });
  }, []);

  const handleOpenExternalFile = useCallback((workspaceId: string, location: string) => {
    enqueueExternalOpen(workspaceId, location);
    if (workspaceId === activeWorkspaceIdRef.current) {
      activateLeafOfKind(workspaceId, "files");
    }
  }, []);

  const handleSelectFile = useCallback(
    (workspaceId: string, filePath: string | null) => {
      setPerWorkspaceState(workspaceId, { currentFile: filePath ?? undefined });
      if (filePath) trackFile(filePath);
    },
    [trackFile],
  );

  const handleSetFindInFile = useCallback((workspaceId: string, fn: (() => void) | null) => {
    if (fn) findInFileRegistry.current.set(workspaceId, fn);
    else findInFileRegistry.current.delete(workspaceId);
  }, []);

  const handleActivateFilesPanel = useCallback((workspaceId: string) => {
    if (workspaceId === activeWorkspaceIdRef.current) {
      activateLeafOfKind(workspaceId, "files");
    }
  }, []);

  const handleActivateTerminalPanel = useCallback((workspaceId: string) => {
    if (workspaceId !== activeWorkspaceIdRef.current) return;
    activateLeafOfKind(workspaceId, "term");
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-terminal")));
  }, []);

  crossPanelHandlers.onOpenFile = handleOpenFile;
  crossPanelHandlers.onFileOpened = handleFileOpened;
  crossPanelHandlers.onSelectFile = handleSelectFile;
  crossPanelHandlers.onFindInFile = handleSetFindInFile;
  crossPanelHandlers.onActivateFilesPanel = handleActivateFilesPanel;
  crossPanelHandlers.onActivateTerminalPanel = handleActivateTerminalPanel;

  // ---------------------------------------------------------------------
  // Command palette
  // ---------------------------------------------------------------------

  const paletteCommands = useMemo(
    () =>
      buildCommands({
        // Adapt the command registry's `getPanel(id)` (id = "chat" / "changes"
        // / "files" / "terminal" / "browser") to the active workspace's
        // dockview by resolving the first leaf of that kind.
        getApi: () => {
          const api = getWorkspaceDockviewApi(activeWorkspaceIdRef.current);
          if (!api) return null;
          return {
            getPanel: (id: string) => {
              const kind = (id === "terminal" ? "term" : id) as LeafKind;
              const panel = firstLeafOfKind(api, kind);
              return panel ? { api: { setActive: () => panel.api.setActive() } } : undefined;
            },
          };
        },
        getHiddenPanels: () => [],
        openQuickOpen: () => setQuickOpenOpen(true),
        openSearchFiles: () => setSearchFilesOpen(true),
        findInFile: () => {
          const ws = activeWorkspaceIdRef.current;
          const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
          if (fn) fn();
          else window.dispatchEvent(new CustomEvent("band:find-in-file"));
        },
        formatCurrentFile: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:format-current-file", {
              detail: { workspaceId: ws, filePath: currentFileRef.current },
            }),
          );
        },
        newUntitledTab: () => window.dispatchEvent(new CustomEvent("band:new-untitled-tab")),
        changeLanguageMode: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:open-language-picker", {
              detail: { workspaceId: ws, filePath: currentFileRef.current },
            }),
          );
        },
        editorGoBack: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-back", { detail: { workspaceId: ws } }),
          );
        },
        editorGoForward: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-forward", { detail: { workspaceId: ws } }),
          );
        },
      }),
    [],
  );

  // ---------------------------------------------------------------------
  // Global keyboard shortcuts
  // ---------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ws = activeWorkspaceIdRef.current;
      const terminalFocused = document.activeElement?.closest(".xterm") != null;

      // ⌘K → workspace picker (fires even with a terminal focused).
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setWorkspacePickerOpen(true);
        return;
      }

      // Ctrl+K → workspace picker on non-macOS (bail on focused terminal).
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (terminalFocused) return;
        e.preventDefault();
        e.stopPropagation();
        setWorkspacePickerOpen(true);
        return;
      }

      // Ctrl+` → activate (or create) a Terminal leaf.
      if (e.ctrlKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        e.stopPropagation();
        if (!activateLeafOfKind(ws, "term")) {
          getWorkspaceLeafActions(ws)?.onAdd("term");
        }
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-terminal")));
        return;
      }

      // Ctrl+0 → reveal + focus the project sidebar.
      if (e.ctrlKey && !e.metaKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:show-sidebar"));
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-projects")));
        return;
      }

      // ⇧⌥F → Format Current File.
      if (e.code === "KeyF" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (terminalFocused) return;
        e.preventDefault();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:format-current-file", {
            detail: { workspaceId: ws, filePath: currentFileRef.current },
          }),
        );
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (terminalFocused && !e.metaKey) return;

      const key = e.key.toLowerCase();

      if (key === "n" && e.shiftKey) {
        // ⇧⌘N → New Chat leaf.
        e.preventDefault();
        getWorkspaceLeafActions(ws)?.onAdd("chat");
      } else if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:new-untitled-tab"));
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (key === "f" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchFilesOpen(true);
      } else if (key === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
        if (fn) fn();
        else window.dispatchEvent(new CustomEvent("band:find-in-file"));
      } else if (key === "o" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:open-file-external", { detail: { workspaceId: ws } }),
        );
      } else if (key === "i" && e.ctrlKey && e.metaKey) {
        e.preventDefault();
        activateLeafOfKind(ws, "chat");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-chat")));
      } else if (key === "g" && e.shiftKey) {
        e.preventDefault();
        activateLeafOfKind(ws, "changes");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-changes")));
      } else if (key === "e" && e.shiftKey) {
        e.preventDefault();
        activateLeafOfKind(ws, "files");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-files")));
      } else if (key === "b" && e.shiftKey) {
        e.preventDefault();
        activateLeafOfKind(ws, "browser");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-browser")));
      } else if (key === "b" && !e.shiftKey && !e.altKey) {
        // ⌘B → toggle inner-dockview left edge, else the project sidebar.
        e.preventDefault();
        const inner = findFocusedInnerDockview();
        if (inner && toggleEdgeGroup(inner, "left")) return;
        window.dispatchEvent(new CustomEvent("band:toggle-sidebar"));
      } else if (e.code === "KeyB" && e.altKey && !e.shiftKey) {
        // ⌥⌘B → toggle right edge of the focused / active dockview.
        e.preventDefault();
        const inner = findFocusedInnerDockview();
        if (inner && toggleEdgeGroup(inner, "right")) return;
        const api = getWorkspaceDockviewApi(ws);
        if (api) toggleEdgeGroup(api, "right");
      } else if (key === "j" && !e.shiftKey && !e.altKey) {
        // ⌘J → toggle bottom edge.
        e.preventDefault();
        const inner = findFocusedInnerDockview();
        if (inner && toggleEdgeGroup(inner, "bottom")) return;
        const api = getWorkspaceDockviewApi(ws);
        if (api) toggleEdgeGroup(api, "bottom");
      } else if (key === "m" && e.shiftKey) {
        // ⇧⌘M → maximize / restore the active group.
        e.preventDefault();
        const api = getWorkspaceDockviewApi(ws);
        const active = api?.activeGroup;
        if (!api || !active) return;
        if (active.api.isMaximized()) {
          prepareMaximizeRestoreAnimation(document.querySelector<HTMLElement>(".dv-shell"));
          active.api.exitMaximized();
        } else {
          active.api.maximize();
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // File link clicks from chat → open Quick Open with query (scoped to active ws).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename?: string; workspaceId?: string }>).detail;
      if (!detail?.filename) return;
      if (detail.workspaceId && detail.workspaceId !== activeWorkspaceId) return;
      setQuickOpenQuery(detail.filename);
      setQuickOpenOpen(true);
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [activeWorkspaceId]);

  // Toolbar / title-bar window-event triggers for the dialogs.
  useEffect(() => {
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    const openPicker = () => setWorkspacePickerOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    window.addEventListener("band:open-workspace-picker", openPicker);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
      window.removeEventListener("band:open-workspace-picker", openPicker);
    };
  }, []);

  // Panel activation events from the title-bar panel switcher.
  useEffect(() => {
    const handler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId: string }>).detail?.panelId;
      if (!panelId) return;
      const kind = (panelId === "terminal" ? "term" : panelId) as LeafKind;
      activateLeafOfKind(activeWorkspaceIdRef.current, kind);
    };
    window.addEventListener("band:activate-panel", handler);
    return () => window.removeEventListener("band:activate-panel", handler);
  }, []);

  // "Add to Terminal" — surface a terminal leaf then dispatch the scoped insert.
  useEffect(() => {
    const handler = (e: Event) => {
      const reference = (e as CustomEvent<AddToTerminalDetail>).detail?.reference;
      const workspaceId = activeWorkspaceIdRef.current;
      if (!reference || !workspaceId) return;
      activateLeafOfKind(workspaceId, "term");
      void (async () => {
        let terminalId: string | undefined;
        try {
          terminalId = (await trpc.panelFocus.get.query({ workspaceId })).terminal;
        } catch {
          // best-effort — fall back to visible-terminal delivery
        }
        window.dispatchEvent(
          new CustomEvent("band:terminal-insert", {
            detail: { reference, workspaceId, terminalId },
          }),
        );
      })();
    };
    window.addEventListener("band:add-to-terminal", handler);
    return () => window.removeEventListener("band:add-to-terminal", handler);
  }, []);

  // "Add to Chat" — surface a chat leaf then dispatch the scoped insert.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SelectionToChatDetail>).detail;
      const workspaceId = activeWorkspaceIdRef.current;
      if (!detail || !workspaceId) return;
      activateLeafOfKind(workspaceId, "chat");
      void (async () => {
        let chatId: string | undefined;
        try {
          chatId = (await trpc.panelFocus.get.query({ workspaceId })).chat;
        } catch {
          // best-effort — fall back to visible-chat delivery
        }
        const insert: ChatInsertDetail = {
          filePath: detail.filePath,
          startLine: detail.startLine,
          endLine: detail.endLine,
          workspaceId,
          chatId,
        };
        window.dispatchEvent(new CustomEvent("band:chat-insert", { detail: insert }));
      })();
    };
    window.addEventListener("band:add-to-chat", handler);
    return () => window.removeEventListener("band:add-to-chat", handler);
  }, []);

  // Hide all browser webviews (desktop) while a dialog is open (active ws only).
  const toolbarDialogOpen = useAnyToolbarDialogOpen();
  useEffect(() => {
    if (!isDesktop || !activeWorkspaceId) return;
    const isDialogOpen =
      quickOpenOpen ||
      searchFilesOpen ||
      workspacePickerOpen ||
      commandPaletteOpen ||
      toolbarDialogOpen;

    if (isDialogOpen) {
      desktopInvoke("browser_hide_all_for_workspace", { workspaceId: activeWorkspaceId }).catch(
        () => {},
      );
    } else {
      const api = getWorkspaceDockviewApi(activeWorkspaceId);
      const anyBrowserActive = api?.panels.some(
        (p) => p.api.component === "browser" && p.api.isActive,
      );
      if (anyBrowserActive) {
        desktopInvoke("browser_show_all_for_workspace", {
          workspaceId: activeWorkspaceId,
        }).catch(() => {});
      }
    }
  }, [
    quickOpenOpen,
    searchFilesOpen,
    workspacePickerOpen,
    commandPaletteOpen,
    toolbarDialogOpen,
    activeWorkspaceId,
  ]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <>
      {/* `absolute inset-0` so we OVERLAY the AppShell's relative div instead of
        stacking in normal flow next to the <Outlet /> sibling. */}
      <div className="absolute inset-0">
        <MultiWorkspacePanelHost emptyState={<NoWorkspaceMessage />}>
          {(workspaceId, wsActive) => (
            <WorkspaceCenterDockview
              workspaceId={workspaceId}
              visible={wsActive}
              wsActive={wsActive}
            />
          )}
        </MultiWorkspacePanelHost>
      </div>

      <QuickOpenDialog
        workspaceId={activeWorkspaceId ?? ""}
        open={quickOpenOpen}
        onOpenChange={(open) => {
          setQuickOpenOpen(open);
          if (!open) setQuickOpenQuery(undefined);
        }}
        onOpenFile={(filename) => {
          if (activeWorkspaceId) handleOpenFile(activeWorkspaceId, filename);
        }}
        onOpenExternalFile={(location) => {
          if (activeWorkspaceId) handleOpenExternalFile(activeWorkspaceId, location);
        }}
        currentFile={activeCurrentFile}
        initialQuery={quickOpenQuery}
        autoOpen={quickOpenQuery != null}
        recentFiles={recentFiles}
        lastQuery={lastQuickOpenQuery}
        onQueryChange={setLastQuickOpenQuery}
      />
      <SearchFilesDialog
        workspaceId={activeWorkspaceId ?? ""}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={(filename) => {
          if (activeWorkspaceId) handleOpenFile(activeWorkspaceId, filename);
        }}
      />
      <WorkspacePickerDialog open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen} />
      <CommandPaletteDialog
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={paletteCommands}
      />
    </>
  );
}
