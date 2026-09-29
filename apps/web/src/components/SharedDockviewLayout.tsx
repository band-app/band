import { useRouterState } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AddToChatDetail,
  type AddToTerminalDetail,
  buildCommands,
  type ChatInsertDetail,
  CommandPaletteDialog,
  isMacPlatform,
  parseFileLocation,
  QuickOpenDialog,
  recordWorkspaceAccess,
  SearchFilesDialog,
  useCapabilities,
  WorkspacePickerDialog,
} from "@/dashboard";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { cycleGridGroups, cycleTabsInActiveGroup } from "../lib/dockview-section-actions";
import { parseWorkspaceFromPath } from "../lib/parse-workspace";
import { trpc } from "../lib/trpc-client";
import { MultiWorkspacePanelHost } from "./MultiWorkspacePanelHost";
import { getPerWorkspaceState, subscribePerWorkspaceState } from "./per-workspace-state-store";
import {
  firstLeafOfKind,
  getWorkspaceDockviewApi,
  getWorkspaceLeafActions,
  type LeafKind,
  nextUntitledPath,
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

/** Add a new leaf of `kind` to the active group of a workspace's dockview.
 *  An edge group collapses to zero size when empty, so when one is active the
 *  leaf goes to the first grid group instead (same rule as the "+" menu). */
function addLeafToActiveGroup(workspaceId: string | null, kind: LeafKind): void {
  const api = getWorkspaceDockviewApi(workspaceId);
  const active = api?.activeGroup;
  const group =
    active?.api.location.type === "grid"
      ? active
      : api?.groups.find((g) => g.api.location.type === "grid");
  getWorkspaceLeafActions(workspaceId)?.onAdd(kind, group?.id);
}

/** Maximize the active group of a workspace's dockview, or restore it. */
function toggleMaximizeActiveGroup(workspaceId: string | null): void {
  const active = getWorkspaceDockviewApi(workspaceId)?.activeGroup;
  if (!active) return;
  if (active.api.isMaximized()) {
    active.api.exitMaximized();
  } else {
    active.api.maximize();
  }
}

/** Move focus into the active leaf of a workspace's dockview, after a palette
 *  command activated it. `WorkspaceCenterDockview` listens for
 *  `band:focus-active-leaf`. */
function focusActiveLeaf(workspaceId: string | null): void {
  if (!workspaceId) return;
  window.dispatchEvent(new CustomEvent("band:focus-active-leaf", { detail: { workspaceId } }));
}

/** Reveal the right sidepanel and (optionally) select its Explorer/Changes tab.
 *  `__root` listens for `band:show-right-panel`; `RightSidepanel` listens for
 *  `band:right-sidepanel-set-tab`. */
function revealRightPanel(tab?: "explorer" | "changes"): void {
  window.dispatchEvent(new CustomEvent("band:show-right-panel"));
  if (tab) {
    window.dispatchEvent(new CustomEvent("band:right-sidepanel-set-tab", { detail: { tab } }));
  }
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
 * visited workspace (all stay mounted for instant switching). This
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

  // Desktop shell capabilities: `pickFile` (OS "Open File…" dialog) gates ⌘O.
  const capabilities = useCapabilities();
  const pickFile = capabilities.pickFile;

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
      const loc = parseFileLocation(filename);
      trackFile(loc.filePath);
      getWorkspaceLeafActions(workspaceId)?.openFile(loc.filePath, {
        line: loc.line,
        column: loc.column,
      });
    },
    [trackFile],
  );

  const handleFileOpened = useCallback((_workspaceId: string) => {
    // No-op now that files open as dedicated `file` leaves; kept so the
    // cross-panel handler surface stays stable for any legacy callers.
  }, []);

  const handleOpenExternalFile = useCallback((workspaceId: string, location: string) => {
    const loc = parseFileLocation(location);
    getWorkspaceLeafActions(workspaceId)?.openFile(loc.filePath, {
      line: loc.line,
      column: loc.column,
      external: true,
    });
  }, []);

  const handleSelectFile = useCallback(
    (_workspaceId: string, filePath: string | null) => {
      if (filePath) trackFile(filePath);
    },
    [trackFile],
  );

  const handleSetFindInFile = useCallback((workspaceId: string, fn: (() => void) | null) => {
    if (fn) findInFileRegistry.current.set(workspaceId, fn);
    else findInFileRegistry.current.delete(workspaceId);
  }, []);

  const handleActivateFilesPanel = useCallback((_workspaceId: string) => {
    // "Reveal files" now means reveal the right sidepanel's Explorer tab.
    revealRightPanel("explorer");
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
        // Adapt the command registry's `getPanel(id)` (id = "chat" /
        // "terminal" / "browser") to the active workspace's dockview by
        // resolving the first leaf of that kind. "files" / "changes" moved to
        // the right sidepanel and no longer map to a center leaf — return
        // undefined so the command falls through to its reveal path.
        getApi: () => {
          const api = getWorkspaceDockviewApi(activeWorkspaceIdRef.current);
          if (!api) return null;
          return {
            getPanel: (id: string) => {
              if (id === "files" || id === "changes") return undefined;
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
        newLeaf: (kind) => addLeafToActiveGroup(activeWorkspaceIdRef.current, kind),
        openWorkspacePicker: () => setWorkspacePickerOpen(true),
        closeActiveTab: () => {
          const ws = activeWorkspaceIdRef.current;
          const active = getWorkspaceDockviewApi(ws)?.activePanel;
          if (!active) return;
          getWorkspaceLeafActions(ws)?.onClose(active.id, active.api.component as LeafKind);
        },
        splitActiveTab: (direction) => {
          const ws = activeWorkspaceIdRef.current;
          const api = getWorkspaceDockviewApi(ws);
          const active = api?.activePanel;
          const groupId = api?.activeGroup?.id;
          if (!active || !groupId) return;
          const kind = active.api.component as LeafKind;
          if (kind === "term") {
            // Terminals split into nested panes, owned by the leaf's own dockview.
            window.dispatchEvent(
              new CustomEvent("band:split-terminal-pane", {
                detail: { leafId: active.id, direction },
              }),
            );
          } else if (kind === "chat" || kind === "browser") {
            getWorkspaceLeafActions(ws)?.onSplit(kind, groupId, direction);
          }
        },
        cycleTabs: (direction) => {
          const ws = activeWorkspaceIdRef.current;
          cycleTabsInActiveGroup(getWorkspaceDockviewApi(ws) ?? null, direction, () =>
            focusActiveLeaf(ws),
          );
        },
        cycleGroups: (direction) => {
          const ws = activeWorkspaceIdRef.current;
          cycleGridGroups(getWorkspaceDockviewApi(ws) ?? null, direction, () =>
            focusActiveLeaf(ws),
          );
        },

        toggleMaximize: () => toggleMaximizeActiveGroup(activeWorkspaceIdRef.current),
        openFileExternal: () => {
          const ws = activeWorkspaceIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:open-file-external", { detail: { workspaceId: ws } }),
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

      const key = e.key.toLowerCase();

      // Off macOS the modifier is Ctrl, and a focused terminal keeps Ctrl chords
      // for the shell (Ctrl+T transposes, Ctrl+B moves back). The shell has no
      // use for Ctrl+Shift+N / B / P or Ctrl+Alt+I, so new chat, new browser,
      // the command palette and show chat still work there.
      const shellFreeChord =
        !isMacPlatform() &&
        ((e.shiftKey && !e.altKey && (key === "n" || key === "b" || key === "p")) ||
          (e.altKey && !e.shiftKey && e.code === "KeyI"));
      if (terminalFocused && !e.metaKey && !shellFreeChord) return;

      // New-tab chords copied from Orca: ⌘T terminal, ⌥⌘T chat with the
      // default agent, ⇧⌘B browser. Each opens in the active group. ⌥⌘T is
      // macOS only (Ctrl+Alt is AltGr on Windows and the desktop's "open
      // terminal" on Linux), so Windows / Linux open a chat with Ctrl+Shift+N
      // (below). It matches on `code` because ⌥ rewrites `key`.
      if (key === "t" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        addLeafToActiveGroup(ws, "term");
        return;
      }
      if (e.code === "KeyT" && e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        addLeafToActiveGroup(ws, "chat");
        return;
      }

      if (key === "n" && e.shiftKey) {
        // ⇧⌘N → the default agent, in this device's mode (issue #682).
        e.preventDefault();
        e.stopPropagation();
        addLeafToActiveGroup(ws, "chat");
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
        // ⌘F is find-in-file, but ONLY when the editor/preview is the focused
        // surface. With a focused terminal, ⌘F belongs to the terminal's own
        // find — don't also open the (visible-but-unfocused) file/diff leaf's
        // bar. The find-in-file registry is keyed by visibility, not focus, so
        // without this guard a split layout (file + terminal both visible)
        // would open the file's find whenever ⌘F was pressed in the terminal.
        // A focused chat pane has its own find bar (ChatView).
        if (terminalFocused || document.activeElement?.closest("[data-chat-pane]")) return;
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
      } else if (
        e.code === "KeyI" &&
        (isMacPlatform()
          ? e.ctrlKey && e.metaKey
          : e.ctrlKey && e.altKey && !e.metaKey && key === "i")
      ) {
        // ⌃⌘I (Ctrl+Alt+I off macOS, VS Code's chat key there) → show chat.
        // Windows AltGr arrives as Ctrl+Alt; checking `key` leaves an
        // AltGr-typed character (Hungarian Í) to the input.
        e.preventDefault();
        activateLeafOfKind(ws, "chat");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-chat")));
      } else if (key === "g" && e.shiftKey) {
        // ⇧⌘G → reveal the right sidepanel's Changes tab.
        e.preventDefault();
        revealRightPanel("changes");
      } else if (key === "e" && e.shiftKey) {
        // ⇧⌘E → reveal the right sidepanel's Explorer tab.
        e.preventDefault();
        revealRightPanel("explorer");
      } else if (key === "b" && e.shiftKey) {
        // ⇧⌘B → New Browser leaf.
        e.preventDefault();
        addLeafToActiveGroup(ws, "browser");
      } else if (key === "b" && !e.shiftKey && !e.altKey) {
        // ⌘B → toggle the project sidebar.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:toggle-sidebar"));
      } else if (e.code === "KeyB" && e.altKey && !e.shiftKey) {
        // ⌥⌘B → toggle the right sidepanel (Explorer / Changes).
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("band:toggle-right-panel"));
      } else if (key === "m" && e.shiftKey) {
        // ⇧⌘M → maximize / restore the active group.
        e.preventDefault();
        toggleMaximizeActiveGroup(ws);
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

  // LSP cross-file go-to-definition → open the resolved file directly. The LSP
  // client resolves an exact workspace-relative path (no Quick Open picker) and
  // waits for the new editor view to mount before scrolling to the definition.
  // The old listener lived in CodeBrowserView (removed in #643); without this,
  // clicking "Go to definition" across files did nothing.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          filePath?: string;
          workspaceId?: string;
          line?: number;
          column?: number;
        }>
      ).detail;
      if (!detail?.filePath) return;
      // Open in the ADDRESSED workspace (falling through to the active one when
      // the event carries no id, for backwards-compat). Targeting the owning
      // workspace directly is what prevents an A-relative path from leaking
      // into a cached hidden workspace B/C — the nav opens in A even when A is
      // not the active workspace.
      // A diff view's jump carries the definition's 1-based position; the
      // editor's own jump positions the cursor itself and sends none.
      getWorkspaceLeafActions(detail.workspaceId ?? activeWorkspaceId)?.openFile(detail.filePath, {
        preview: false,
        line: detail.line,
        column: detail.column,
      });
    };
    window.addEventListener("band:lsp-navigate", handler);
    return () => window.removeEventListener("band:lsp-navigate", handler);
  }, [activeWorkspaceId]);

  // Toolbar window-event triggers for the dialogs.
  useEffect(() => {
    const openQO = () => setQuickOpenOpen(true);
    const openSF = () => setSearchFilesOpen(true);
    window.addEventListener("band:open-quick-open", openQO);
    window.addEventListener("band:open-search-files", openSF);
    return () => {
      window.removeEventListener("band:open-quick-open", openQO);
      window.removeEventListener("band:open-search-files", openSF);
    };
  }, []);

  // Panel activation events from the title-bar panel switcher.
  useEffect(() => {
    const handler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId: string }>).detail?.panelId;
      if (!panelId) return;
      // "files" / "changes" moved to the right sidepanel — reveal it (and select
      // the matching tab) instead of activating a (now non-existent) center leaf.
      if (panelId === "files") {
        revealRightPanel("explorer");
        return;
      }
      if (panelId === "changes") {
        revealRightPanel("changes");
        return;
      }
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
      const detail = (e as CustomEvent<AddToChatDetail>).detail;
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
        const insert: ChatInsertDetail =
          "text" in detail
            ? { text: detail.text, workspaceId, chatId }
            : {
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

  // ⌘N → New Untitled File. The shell already dispatches
  // `band:new-untitled-tab` on ⌘N (and from the command palette); open a fresh
  // untitled `file` leaf in the active workspace's dockview. The desktop
  // Save-As flow lives in `FileLeaf` (`onSaveAs` → `capabilities.pickSaveFile`).
  // Web builds without `pickSaveFile` still get a scratch buffer they can edit;
  // only persistence is desktop-only (same as CodeBrowserView).
  useEffect(() => {
    const handler = () => {
      const ws = activeWorkspaceIdRef.current;
      if (!ws) return;
      const filePath = nextUntitledPath(ws);
      getWorkspaceLeafActions(ws)?.openFile(filePath, { untitled: true, preview: false });
    };
    window.addEventListener("band:new-untitled-tab", handler);
    return () => window.removeEventListener("band:new-untitled-tab", handler);
  }, []);

  // ⌘O → Open File… — desktop-only (gated on `capabilities.pickFile`). Runs the
  // OS file picker, then opens the chosen absolute path as an external `file`
  // leaf (reads/writes hit the host's external-file capability). Mirrors
  // CodeBrowserView's `handleOpenExternalFile`, but routed to the active
  // workspace's leaf actions so multi-workspace setups open in the right one.
  useEffect(() => {
    if (!pickFile) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceId?: string } | undefined>).detail;
      const ws = detail?.workspaceId ?? activeWorkspaceIdRef.current;
      if (!ws || (detail?.workspaceId && detail.workspaceId !== activeWorkspaceIdRef.current)) {
        return;
      }
      void (async () => {
        const absolutePath = await pickFile();
        if (!absolutePath) return;
        const loc = parseFileLocation(absolutePath);
        getWorkspaceLeafActions(ws)?.openFile(loc.filePath, {
          line: loc.line,
          column: loc.column,
          external: true,
          preview: false,
        });
      })();
    };
    window.addEventListener("band:open-file-external", handler);
    return () => window.removeEventListener("band:open-file-external", handler);
  }, [pickFile]);

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
