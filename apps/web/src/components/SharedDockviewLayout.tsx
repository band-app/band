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
  recordWorktreeAccess,
  SearchFilesDialog,
  useCapabilities,
  WorktreePickerDialog,
} from "@/dashboard";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { cycleGridGroups, cycleTabsInActiveGroup } from "../lib/dockview-section-actions";
import { parseWorktreeFromPath } from "../lib/parse-worktree";
import { trpc } from "../lib/trpc-client";
import { WindowDragContext } from "./DesktopTitleBar";
import { MultiWorktreePanelHost } from "./MultiWorktreePanelHost";
import { getPerWorktreeState, subscribePerWorktreeState } from "./per-worktree-state-store";
import {
  firstLeafOfKind,
  getWorktreeDockviewApi,
  getWorktreeLeafActions,
  type LeafKind,
  nextUntitledPath,
  WorktreeCenterDockview,
} from "./WorktreeCenterDockview";

// ---------------------------------------------------------------------------
// Per-worktree cross-panel context
// ---------------------------------------------------------------------------
//
// Cross-panel state (currentFile, openFilePath, find-in-file registration) is
// per-worktree but read/written by leaves that live inside the per-worktree
// dockviews cached by `MultiWorktreePanelHost`. We use module-level handlers
// wired by `SharedDockviewLayout`'s render so per-worktree callbacks always
// reference the latest closure without re-rendering every cached child.
// ---------------------------------------------------------------------------

interface CrossPanelHandlers {
  /** Called when the Changes leaf asks us to open a file in the Files leaf. */
  onOpenFile: (worktreeId: string, filename: string) => void;
  /** Called when the Files leaf reports the active file changed. */
  onSelectFile: (worktreeId: string, filePath: string | null) => void;
  /** Called when the Files leaf finishes opening the requested file. */
  onFileOpened: (worktreeId: string) => void;
  /** Called by a leaf to register/unregister its find-in-file callback. */
  onFindInFile: (worktreeId: string, fn: (() => void) | null) => void;
  /** Bring the Files leaf to the foreground (external-open flow). */
  onActivateFilesPanel: (worktreeId: string) => void;
  /** Bring a Terminal leaf to the foreground ("Continue in terminal"). */
  onActivateTerminalPanel: (worktreeId: string) => void;
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
// Helpers: resolve + drive the ACTIVE worktree's dockview
// ---------------------------------------------------------------------------

/** Activate the first leaf of `kind` in a worktree's dockview; returns
 *  whether a matching leaf was found. */
function activateLeafOfKind(worktreeId: string | null, kind: LeafKind): boolean {
  const api = getWorktreeDockviewApi(worktreeId);
  const panel = api ? firstLeafOfKind(api, kind) : undefined;
  if (panel) {
    panel.api.setActive();
    return true;
  }
  return false;
}

/** Add a new leaf of `kind` to the active group of a worktree's dockview.
 *  An edge group collapses to zero size when empty, so when one is active the
 *  leaf goes to the first grid group instead (same rule as the "+" menu). */
function addLeafToActiveGroup(worktreeId: string | null, kind: LeafKind): void {
  const api = getWorktreeDockviewApi(worktreeId);
  const active = api?.activeGroup;
  const group =
    active?.api.location.type === "grid"
      ? active
      : api?.groups.find((g) => g.api.location.type === "grid");
  getWorktreeLeafActions(worktreeId)?.onAdd(kind, group?.id);
}

/** Maximize the active group of a worktree's dockview, or restore it. */
function toggleMaximizeActiveGroup(worktreeId: string | null): void {
  const active = getWorktreeDockviewApi(worktreeId)?.activeGroup;
  if (!active) return;
  if (active.api.isMaximized()) {
    active.api.exitMaximized();
  } else {
    active.api.maximize();
  }
}

/** Move focus into the active leaf of a worktree's dockview, after a palette
 *  command activated it. `WorktreeCenterDockview` listens for
 *  `band:focus-active-leaf`. */
function focusActiveLeaf(worktreeId: string | null): void {
  if (!worktreeId) return;
  window.dispatchEvent(new CustomEvent("band:focus-active-leaf", { detail: { worktreeId } }));
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

// Empty state shown by the panel host when no worktree is selected.
function NoWorktreeMessage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center px-8">
        <FolderOpen className="size-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Select a worktree to get started</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SharedDockviewLayout — a thin host around one per-worktree dockview
// ---------------------------------------------------------------------------

/**
 * The app-shell layout. No longer owns a dockview: it renders a single
 * `MultiWorktreePanelHost` whose child is a `WorktreeCenterDockview` per
 * visited worktree (all stay mounted for instant switching). This
 * component keeps the shell-level concerns: the command dialogs, the global
 * keyboard shortcuts, and the cross-panel handler registry. Panel-activation
 * shortcuts resolve the active worktree's dockview from
 * `getWorktreeDockviewApi`.
 */
export function SharedDockviewLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeWorktreeId = parseWorktreeFromPath(pathname);

  const activeWorktreeIdRef = useRef<string | null>(activeWorktreeId);
  activeWorktreeIdRef.current = activeWorktreeId;

  // Notify the "recent worktrees" picker on every worktree switch.
  useEffect(() => {
    if (activeWorktreeId) recordWorktreeAccess(activeWorktreeId);
  }, [activeWorktreeId]);

  const { recentFiles, trackFile } = useRecentFiles(activeWorktreeId ?? "");

  // Desktop shell capabilities: `pickFile` (OS "Open File…" dialog) gates ⌘O.
  const capabilities = useCapabilities();
  const pickFile = capabilities.pickFile;

  // Shadow of the active worktree's currentFile for the format/quick-open flows.
  const currentFileRef = useRef<string | undefined>(undefined);
  const findInFileRegistry = useRef(new Map<string, () => void>());

  // Dialog state — exactly one dialog open at a time across the whole app.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState<string | undefined>(undefined);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [lastQuickOpenQuery, setLastQuickOpenQuery] = useState("");
  const [activeCurrentFile, setActiveCurrentFile] = useState<string | undefined>(undefined);

  // Refresh the active worktree's currentFile shadow on navigation.
  useEffect(() => {
    if (!activeWorktreeId) {
      setActiveCurrentFile(undefined);
      currentFileRef.current = undefined;
      return;
    }
    const state = getPerWorktreeState(activeWorktreeId);
    setActiveCurrentFile(state.currentFile);
    currentFileRef.current = state.currentFile;
    const unsub = subscribePerWorktreeState(activeWorktreeId, () => {
      const next = getPerWorktreeState(activeWorktreeId).currentFile;
      setActiveCurrentFile(next);
      currentFileRef.current = next;
    });
    return unsub;
  }, [activeWorktreeId]);

  // ---------------------------------------------------------------------
  // Cross-panel handler wiring
  // ---------------------------------------------------------------------

  const handleOpenFile = useCallback(
    (worktreeId: string, filename: string) => {
      const loc = parseFileLocation(filename);
      trackFile(loc.filePath);
      getWorktreeLeafActions(worktreeId)?.openFile(loc.filePath, {
        line: loc.line,
        column: loc.column,
      });
    },
    [trackFile],
  );

  const handleFileOpened = useCallback((_worktreeId: string) => {
    // No-op now that files open as dedicated `file` leaves; kept so the
    // cross-panel handler surface stays stable for any legacy callers.
  }, []);

  const handleOpenExternalFile = useCallback((worktreeId: string, location: string) => {
    const loc = parseFileLocation(location);
    getWorktreeLeafActions(worktreeId)?.openFile(loc.filePath, {
      line: loc.line,
      column: loc.column,
      external: true,
    });
  }, []);

  const handleSelectFile = useCallback(
    (_worktreeId: string, filePath: string | null) => {
      if (filePath) trackFile(filePath);
    },
    [trackFile],
  );

  const handleSetFindInFile = useCallback((worktreeId: string, fn: (() => void) | null) => {
    if (fn) findInFileRegistry.current.set(worktreeId, fn);
    else findInFileRegistry.current.delete(worktreeId);
  }, []);

  const handleActivateFilesPanel = useCallback((_worktreeId: string) => {
    // "Reveal files" now means reveal the right sidepanel's Explorer tab.
    revealRightPanel("explorer");
  }, []);

  const handleActivateTerminalPanel = useCallback((worktreeId: string) => {
    if (worktreeId !== activeWorktreeIdRef.current) return;
    activateLeafOfKind(worktreeId, "term");
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
        // "terminal" / "browser") to the active worktree's dockview by
        // resolving the first leaf of that kind. "files" / "changes" moved to
        // the right sidepanel and no longer map to a center leaf — return
        // undefined so the command falls through to its reveal path.
        getApi: () => {
          const api = getWorktreeDockviewApi(activeWorktreeIdRef.current);
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
          const ws = activeWorktreeIdRef.current;
          const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
          if (fn) fn();
          else window.dispatchEvent(new CustomEvent("band:find-in-file"));
        },
        formatCurrentFile: () => {
          const ws = activeWorktreeIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:format-current-file", {
              detail: { worktreeId: ws, filePath: currentFileRef.current },
            }),
          );
        },
        newUntitledTab: () => window.dispatchEvent(new CustomEvent("band:new-untitled-tab")),
        changeLanguageMode: () => {
          const ws = activeWorktreeIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:open-language-picker", {
              detail: { worktreeId: ws, filePath: currentFileRef.current },
            }),
          );
        },
        editorGoBack: () => {
          const ws = activeWorktreeIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-back", { detail: { worktreeId: ws } }),
          );
        },
        editorGoForward: () => {
          const ws = activeWorktreeIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:editor-go-forward", { detail: { worktreeId: ws } }),
          );
        },
        newLeaf: (kind) => addLeafToActiveGroup(activeWorktreeIdRef.current, kind),
        openWorktreePicker: () => setWorktreePickerOpen(true),
        closeActiveTab: () => {
          const ws = activeWorktreeIdRef.current;
          const active = getWorktreeDockviewApi(ws)?.activePanel;
          if (!active) return;
          getWorktreeLeafActions(ws)?.onClose(active.id, active.api.component as LeafKind);
        },
        splitActiveTab: (direction) => {
          const ws = activeWorktreeIdRef.current;
          const api = getWorktreeDockviewApi(ws);
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
            getWorktreeLeafActions(ws)?.onSplit(kind, groupId, direction);
          }
        },
        cycleTabs: (direction) => {
          const ws = activeWorktreeIdRef.current;
          cycleTabsInActiveGroup(getWorktreeDockviewApi(ws) ?? null, direction, () =>
            focusActiveLeaf(ws),
          );
        },
        cycleGroups: (direction) => {
          const ws = activeWorktreeIdRef.current;
          cycleGridGroups(getWorktreeDockviewApi(ws) ?? null, direction, () => focusActiveLeaf(ws));
        },

        toggleMaximize: () => toggleMaximizeActiveGroup(activeWorktreeIdRef.current),
        openFileExternal: () => {
          const ws = activeWorktreeIdRef.current;
          if (!ws) return;
          window.dispatchEvent(
            new CustomEvent("band:open-file-external", { detail: { worktreeId: ws } }),
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
      const ws = activeWorktreeIdRef.current;
      const terminalFocused = document.activeElement?.closest(".xterm") != null;

      // ⌘K → worktree picker (fires even with a terminal focused).
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setWorktreePickerOpen(true);
        return;
      }

      // Ctrl+K → worktree picker on non-macOS (bail on focused terminal).
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (terminalFocused) return;
        e.preventDefault();
        e.stopPropagation();
        setWorktreePickerOpen(true);
        return;
      }

      // Ctrl+` → activate (or create) a Terminal leaf.
      if (e.ctrlKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        e.stopPropagation();
        if (!activateLeafOfKind(ws, "term")) {
          getWorktreeLeafActions(ws)?.onAdd("term");
        }
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-terminal")));
        return;
      }

      // Ctrl+0 → reveal + focus the repo sidebar.
      if (e.ctrlKey && !e.metaKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("band:show-sidebar"));
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-repos")));
        return;
      }

      // ⇧⌥F → Format Current File.
      if (e.code === "KeyF" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (terminalFocused) return;
        e.preventDefault();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:format-current-file", {
            detail: { worktreeId: ws, filePath: currentFileRef.current },
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
          new CustomEvent("band:open-file-external", { detail: { worktreeId: ws } }),
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
        // ⌘B → toggle the repo sidebar.
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
      const detail = (e as CustomEvent<{ filename?: string; worktreeId?: string }>).detail;
      if (!detail?.filename) return;
      if (detail.worktreeId && detail.worktreeId !== activeWorktreeId) return;
      setQuickOpenQuery(detail.filename);
      setQuickOpenOpen(true);
    };
    window.addEventListener("band:open-file", handler);
    return () => window.removeEventListener("band:open-file", handler);
  }, [activeWorktreeId]);

  // LSP cross-file go-to-definition → open the resolved file directly. The LSP
  // client resolves an exact worktree-relative path (no Quick Open picker) and
  // waits for the new editor view to mount before scrolling to the definition.
  // The old listener lived in CodeBrowserView (removed in #643); without this,
  // clicking "Go to definition" across files did nothing.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          filePath?: string;
          worktreeId?: string;
          line?: number;
          column?: number;
        }>
      ).detail;
      if (!detail?.filePath) return;
      // Open in the ADDRESSED worktree (falling through to the active one when
      // the event carries no id, for backwards-compat). Targeting the owning
      // worktree directly is what prevents an A-relative path from leaking
      // into a cached hidden worktree B/C — the nav opens in A even when A is
      // not the active worktree.
      // A diff view's jump carries the definition's 1-based position; the
      // editor's own jump positions the cursor itself and sends none.
      getWorktreeLeafActions(detail.worktreeId ?? activeWorktreeId)?.openFile(detail.filePath, {
        preview: false,
        line: detail.line,
        column: detail.column,
      });
    };
    window.addEventListener("band:lsp-navigate", handler);
    return () => window.removeEventListener("band:lsp-navigate", handler);
  }, [activeWorktreeId]);

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
      activateLeafOfKind(activeWorktreeIdRef.current, kind);
    };
    window.addEventListener("band:activate-panel", handler);
    return () => window.removeEventListener("band:activate-panel", handler);
  }, []);

  // "Add to Terminal" — surface a terminal leaf then dispatch the scoped insert.
  useEffect(() => {
    const handler = (e: Event) => {
      const reference = (e as CustomEvent<AddToTerminalDetail>).detail?.reference;
      const worktreeId = activeWorktreeIdRef.current;
      if (!reference || !worktreeId) return;
      activateLeafOfKind(worktreeId, "term");
      void (async () => {
        let terminalId: string | undefined;
        try {
          terminalId = (await trpc.panelFocus.get.query({ worktreeId })).terminal;
        } catch {
          // best-effort — fall back to visible-terminal delivery
        }
        window.dispatchEvent(
          new CustomEvent("band:terminal-insert", {
            detail: { reference, worktreeId, terminalId },
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
      const worktreeId = activeWorktreeIdRef.current;
      if (!detail || !worktreeId) return;
      activateLeafOfKind(worktreeId, "chat");
      void (async () => {
        let chatId: string | undefined;
        try {
          chatId = (await trpc.panelFocus.get.query({ worktreeId })).chat;
        } catch {
          // best-effort — fall back to visible-chat delivery
        }
        const insert: ChatInsertDetail =
          "text" in detail
            ? { text: detail.text, worktreeId, chatId }
            : {
                filePath: detail.filePath,
                startLine: detail.startLine,
                endLine: detail.endLine,
                worktreeId,
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
  // untitled `file` leaf in the active worktree's dockview. The desktop
  // Save-As flow lives in `FileLeaf` (`onSaveAs` → `capabilities.pickSaveFile`).
  // Web builds without `pickSaveFile` still get a scratch buffer they can edit;
  // only persistence is desktop-only (same as CodeBrowserView).
  useEffect(() => {
    const handler = () => {
      const ws = activeWorktreeIdRef.current;
      if (!ws) return;
      const filePath = nextUntitledPath(ws);
      getWorktreeLeafActions(ws)?.openFile(filePath, { untitled: true, preview: false });
    };
    window.addEventListener("band:new-untitled-tab", handler);
    return () => window.removeEventListener("band:new-untitled-tab", handler);
  }, []);

  // ⌘O → Open File… — desktop-only (gated on `capabilities.pickFile`). Runs the
  // OS file picker, then opens the chosen absolute path as an external `file`
  // leaf (reads/writes hit the host's external-file capability). Mirrors
  // CodeBrowserView's `handleOpenExternalFile`, but routed to the active
  // worktree's leaf actions so multi-worktree setups open in the right one.
  useEffect(() => {
    if (!pickFile) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ worktreeId?: string } | undefined>).detail;
      const ws = detail?.worktreeId ?? activeWorktreeIdRef.current;
      if (!ws || (detail?.worktreeId && detail.worktreeId !== activeWorktreeIdRef.current)) {
        return;
      }
      void (async () => {
        const absolutePath = await pickFile();
        if (!absolutePath) return;
        const loc = parseFileLocation(absolutePath);
        getWorktreeLeafActions(ws)?.openFile(loc.filePath, {
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
        <MultiWorktreePanelHost emptyState={<NoWorktreeMessage />}>
          {(worktreeId, wsActive) => (
            // Only the shown worktree puts app-regions on the page.
            <WindowDragContext.Provider value={wsActive}>
              <WorktreeCenterDockview
                worktreeId={worktreeId}
                visible={wsActive}
                wsActive={wsActive}
              />
            </WindowDragContext.Provider>
          )}
        </MultiWorktreePanelHost>
      </div>

      <QuickOpenDialog
        worktreeId={activeWorktreeId ?? ""}
        open={quickOpenOpen}
        onOpenChange={(open) => {
          setQuickOpenOpen(open);
          if (!open) setQuickOpenQuery(undefined);
        }}
        onOpenFile={(filename) => {
          if (activeWorktreeId) handleOpenFile(activeWorktreeId, filename);
        }}
        onOpenExternalFile={(location) => {
          if (activeWorktreeId) handleOpenExternalFile(activeWorktreeId, location);
        }}
        currentFile={activeCurrentFile}
        initialQuery={quickOpenQuery}
        autoOpen={quickOpenQuery != null}
        recentFiles={recentFiles}
        lastQuery={lastQuickOpenQuery}
        onQueryChange={setLastQuickOpenQuery}
      />
      <SearchFilesDialog
        worktreeId={activeWorktreeId ?? ""}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={(filename) => {
          if (activeWorktreeId) handleOpenFile(activeWorktreeId, filename);
        }}
      />
      <WorktreePickerDialog open={worktreePickerOpen} onOpenChange={setWorktreePickerOpen} />
      <CommandPaletteDialog
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={paletteCommands}
      />
    </>
  );
}
