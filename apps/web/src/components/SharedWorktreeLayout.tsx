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
  type SendToChatDetail,
  useCapabilities,
  useWorktreeCommands,
  WorktreePickerDialog,
} from "@/dashboard";
import { markdownPreviewOwnsFormatKey } from "../dashboard/lib/markdown-live-preview";
import { useRecentFiles } from "../hooks/useRecentFiles";
import { chatFetch } from "../lib/direct-chat";
import { cycleGridGroups, cycleTabsInActiveGroup } from "../lib/layout-section-actions";
import { requestOpenLocalFiles } from "../lib/open-local-files";
import { parseWorktreeFromPath } from "../lib/parse-worktree";
import {
  findConflicts,
  handlerCommandFor,
  isOverridden,
  matchesCommand,
  runCommand,
} from "../lib/shortcuts";
import { trpc } from "../lib/trpc-client";
import { WindowDragContext } from "./DesktopTitleBar";
import { MultiWorktreePanelHost } from "./MultiWorktreePanelHost";
import { OfflineWorktreeNotice } from "./OfflineCheckpoint";
import { getPerWorktreeState, subscribePerWorktreeState } from "./per-worktree-state-store";
import {
  firstLeafOfKind,
  getWorktreeLayoutApi,
  getWorktreeLeafActions,
  type LeafKind,
  nextUntitledPath,
  WorktreeCenter,
} from "./WorktreeCenter";

/** Commands whose chord a focused terminal does not keep for the shell off macOS. */
const SHELL_FREE_COMMANDS = new Set([
  "new-chat",
  "new-browser",
  "command-palette",
  "toggle-maximize",
  "show-chat",
]);

// ---------------------------------------------------------------------------
// Per-worktree cross-panel context
// ---------------------------------------------------------------------------
//
// Cross-panel state (currentFile, openFilePath, find-in-file registration) is
// per-worktree but read/written by leaves that live inside the per-worktree
// layouts cached by `MultiWorktreePanelHost`. We use module-level handlers
// wired by `SharedWorktreeLayout`'s render so per-worktree callbacks always
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
  /** Open a file outside the worktree as a focused external tab. */
  onOpenExternalFile: (worktreeId: string, location: string) => void;
  /** Bring a Terminal leaf to the foreground ("Continue in terminal"). */
  onActivateTerminalPanel: (worktreeId: string) => void;
}

// Mutable module-level handlers — `SharedWorktreeLayout` writes them on every
// render. Exported so non-layout call sites (the SSE listener in
// `__root.tsx`, the legacy chat container) can drive the layout.
export const crossPanelHandlers: CrossPanelHandlers = {
  onOpenFile: () => {},
  onSelectFile: () => {},
  onFileOpened: () => {},
  onFindInFile: () => {},
  onOpenExternalFile: () => {},
  onActivateTerminalPanel: () => {},
};

// ---------------------------------------------------------------------------
// Helpers: resolve + drive the ACTIVE worktree's layout
// ---------------------------------------------------------------------------

/** Activate the first leaf of `kind` in a worktree's layout; returns
 *  whether a matching leaf was found. */
function activateLeafOfKind(worktreeId: string | null, kind: LeafKind): boolean {
  const api = getWorktreeLayoutApi(worktreeId);
  const panel = api ? firstLeafOfKind(api, kind) : undefined;
  if (panel) {
    panel.api.setActive();
    return true;
  }
  return false;
}

/** Add a new leaf of `kind` to the active group of a worktree's layout, or to
 *  the first group when none is active (same rule as the "+" menu). */
function addLeafToActiveGroup(worktreeId: string | null, kind: LeafKind): void {
  const api = getWorktreeLayoutApi(worktreeId);
  const group = api?.activeGroup ?? api?.groups[0];
  getWorktreeLeafActions(worktreeId)?.onAdd(kind, group?.id);
}

/** Maximize the active group of a worktree's layout, or restore it. */
function toggleMaximizeActiveGroup(worktreeId: string | null): void {
  const active = getWorktreeLayoutApi(worktreeId)?.activeGroup;
  if (!active) return;
  if (active.api.isMaximized()) {
    active.api.exitMaximized();
  } else {
    active.api.maximize();
  }
}

/** Move focus into the active leaf of a worktree's layout, after a palette
 *  command activated it. `WorktreeCenter` listens for
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
// Main SharedWorktreeLayout — a thin host around one per-worktree layout
// ---------------------------------------------------------------------------

/**
 * The app-shell layout. No longer owns a layout: it renders a single
 * `MultiWorktreePanelHost` whose child is a `WorktreeCenter` per
 * visited worktree (all stay mounted for instant switching). This
 * component keeps the shell-level concerns: the command dialogs, the global
 * keyboard shortcuts, and the cross-panel handler registry. Panel-activation
 * shortcuts resolve the active worktree's layout from
 * `getWorktreeLayoutApi`.
 */
export function SharedWorktreeLayout() {
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

  const handleActivateTerminalPanel = useCallback((worktreeId: string) => {
    if (worktreeId !== activeWorktreeIdRef.current) return;
    activateLeafOfKind(worktreeId, "term");
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-terminal")));
  }, []);

  crossPanelHandlers.onOpenFile = handleOpenFile;
  crossPanelHandlers.onFileOpened = handleFileOpened;
  crossPanelHandlers.onSelectFile = handleSelectFile;
  crossPanelHandlers.onFindInFile = handleSetFindInFile;
  crossPanelHandlers.onOpenExternalFile = handleOpenExternalFile;
  crossPanelHandlers.onActivateTerminalPanel = handleActivateTerminalPanel;

  // ---------------------------------------------------------------------
  // Command palette
  // ---------------------------------------------------------------------

  const paletteCommands = useMemo(
    () =>
      buildCommands({
        // Adapt the command registry's `getPanel(id)` (id = "chat" /
        // "terminal" / "browser") to the active worktree's layout by
        // resolving the first leaf of that kind. "files" / "changes" moved to
        // the right sidepanel and no longer map to a center leaf — return
        // undefined so the command falls through to its reveal path.
        getApi: () => {
          const api = getWorktreeLayoutApi(activeWorktreeIdRef.current);
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
          const active = getWorktreeLayoutApi(ws)?.activePanel;
          if (!active) return;
          getWorktreeLeafActions(ws)?.onClose(active.id, active.api.component as LeafKind);
        },
        splitActiveTab: (direction) => {
          const ws = activeWorktreeIdRef.current;
          const api = getWorktreeLayoutApi(ws);
          const active = api?.activePanel;
          const groupId = api?.activeGroup?.id;
          if (!active || !groupId) return;
          const kind = active.api.component as LeafKind;
          if (kind === "term") {
            // Terminals split into nested panes, owned by the leaf's own layout.
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
          cycleTabsInActiveGroup(getWorktreeLayoutApi(ws) ?? null, direction, () =>
            focusActiveLeaf(ws),
          );
        },
        cycleGroups: (direction) => {
          const ws = activeWorktreeIdRef.current;
          cycleGridGroups(getWorktreeLayoutApi(ws) ?? null, direction, () => focusActiveLeaf(ws));
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

  // The worktree right-click actions (git pull, git push, pin...) on the worktree on screen.
  const worktreeCommands = useWorktreeCommands(activeWorktreeId);
  const allPaletteCommands = useMemo(
    () => [...paletteCommands, ...worktreeCommands],
    [paletteCommands, worktreeCommands],
  );

  // ---------------------------------------------------------------------
  // Global keyboard shortcuts
  // ---------------------------------------------------------------------

  useEffect(() => {
    // Every chord comes from the shortcut registry (`lib/shortcuts.ts`), so a
    // chord the user rebinds replaces the default here and in the palette.
    const handler = (e: KeyboardEvent) => {
      const ws = activeWorktreeIdRef.current;
      const terminalFocused = document.activeElement?.closest(".xterm") != null;
      const mac = isMacPlatform();

      // A focused terminal keeps the chords it needs for the shell. ⌘ chords
      // (macOS) always pass. Off macOS Ctrl chords go to the shell (Ctrl+T
      // transposes, Ctrl+B moves back); chords with Shift or Alt still work for
      // the commands the shell has no use for (new chat, new browser, the
      // palette, maximize, show chat), and so do a few that always apply.
      const terminalAllows = (id: string): boolean => {
        if (!terminalFocused || e.metaKey) return true;
        if (id === "show-terminal" || id === "focus-repos") return true;
        const shellFree =
          !mac && (e.shiftKey || e.altKey) && (SHELL_FREE_COMMANDS.has(id) || isOverridden(id));
        return shellFree;
      };
      const hit = (id: string) => matchesCommand(e, id) && terminalAllows(id);
      const claim = (stop = false) => {
        e.preventDefault();
        if (stop) e.stopPropagation();
      };

      if (hit("switch-worktree")) {
        claim(true);
        setWorktreePickerOpen(true);
        return;
      }
      if (hit("show-terminal")) {
        claim(true);
        if (!activateLeafOfKind(ws, "term")) {
          getWorktreeLeafActions(ws)?.onAdd("term");
        }
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-terminal")));
        return;
      }
      if (hit("focus-repos")) {
        claim(true);
        window.dispatchEvent(new CustomEvent("band:show-sidebar"));
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-repos")));
        return;
      }
      if (hit("format-current-file")) {
        claim();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:format-current-file", {
            detail: { worktreeId: ws, filePath: currentFileRef.current },
          }),
        );
        return;
      }

      // ⌘B / ⌘I with text selected in the markdown preview format it. The
      // editor handles the key, so leave it alone here.
      if (e.metaKey || e.ctrlKey) {
        if (markdownPreviewOwnsFormatKey(e)) return;
      }

      if (hit("new-terminal")) {
        claim(true);
        addLeafToActiveGroup(ws, "term");
      } else if (
        hit("new-chat") ||
        // ⇧⌘N stays a second chord for the default agent on macOS (issue #682).
        (mac &&
          !isOverridden("new-chat") &&
          findConflicts("Cmd+Shift+N", "new-chat").length === 0 &&
          e.metaKey &&
          e.shiftKey &&
          e.code === "KeyN" &&
          !e.altKey)
      ) {
        claim(true);
        addLeafToActiveGroup(ws, "chat");
      } else if (hit("new-untitled-tab")) {
        claim();
        window.dispatchEvent(new CustomEvent("band:new-untitled-tab"));
      } else if (hit("command-palette")) {
        claim();
        setCommandPaletteOpen(true);
      } else if (hit("quick-open")) {
        claim();
        setQuickOpenOpen(true);
      } else if (hit("search-files")) {
        claim();
        setSearchFilesOpen(true);
      } else if (hit("find-in-file")) {
        // ⌘F is find-in-file, but ONLY when the editor/preview is the focused
        // surface. With a focused terminal, ⌘F belongs to the terminal's own
        // find — don't also open the (visible-but-unfocused) file/diff leaf's
        // bar. The find-in-file registry is keyed by visibility, not focus, so
        // without this guard a split layout (file + terminal both visible)
        // would open the file's find whenever ⌘F was pressed in the terminal.
        // A focused chat pane has its own find bar (ChatView).
        if (terminalFocused || document.activeElement?.closest("[data-chat-pane]")) return;
        claim();
        const fn = ws ? findInFileRegistry.current.get(ws) : undefined;
        if (fn) fn();
        else window.dispatchEvent(new CustomEvent("band:find-in-file"));
      } else if (hit("open-file-external")) {
        claim();
        if (!ws) return;
        window.dispatchEvent(
          new CustomEvent("band:open-file-external", { detail: { worktreeId: ws } }),
        );
      } else if (hit("show-chat")) {
        // ⌃⌘I (Ctrl+Alt+I off macOS, VS Code's chat key there) → show chat.
        claim();
        activateLeafOfKind(ws, "chat");
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("band:focus-chat")));
      } else if (hit("show-changes")) {
        claim();
        revealRightPanel("changes");
      } else if (hit("show-files")) {
        claim();
        revealRightPanel("explorer");
      } else if (hit("new-browser")) {
        claim();
        addLeafToActiveGroup(ws, "browser");
      } else if (hit("toggle-sidebar")) {
        claim();
        window.dispatchEvent(new CustomEvent("band:toggle-sidebar"));
      } else if (hit("toggle-right-panel")) {
        claim();
        window.dispatchEvent(new CustomEvent("band:toggle-right-panel"));
      } else if (hit("toggle-maximize")) {
        claim();
        toggleMaximizeActiveGroup(ws);
      } else {
        // Commands with a registered handler and no listener of their own
        // (the worktree right-click actions).
        const id = handlerCommandFor(e);
        if (id && terminalAllows(id)) {
          claim();
          runCommand(id);
        }
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

  // "Send to chat" — post a message to the worktree's last-focused chat (the
  // first chat, or a new one) and bring that chat forward.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SendToChatDetail>).detail;
      if (!detail?.worktreeId || !detail.text) return;
      const { worktreeId, text, done } = detail;
      void (async () => {
        try {
          let chatId: string | undefined;
          try {
            chatId = (await trpc.panelFocus.get.query({ worktreeId })).chat;
          } catch {
            // fall through to the chat list
          }
          if (!chatId) {
            const { chats } = await trpc.chats.list.query({ worktreeId });
            chatId = chats[0]?.id;
          }
          if (!chatId) {
            chatId = (await trpc.chats.create.mutate({ worktreeId })).chat.id;
          }
          activateLeafOfKind(worktreeId, "chat");
          const res = await chatFetch(() => worktreeId, chatId)(
            `/api/chats/${encodeURIComponent(chatId)}/messages`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ worktreeId, text }),
            },
          );
          done(res.ok);
        } catch {
          done(false);
        }
      })();
    };
    window.addEventListener("band:send-to-chat", handler);
    return () => window.removeEventListener("band:send-to-chat", handler);
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
  // untitled `file` leaf in the active worktree's layout. The desktop
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
        // The picked file is on this Mac: a file inside a worktree on this Mac opens there as a
        // normal tab, any other opens as an external tab read by the desktop app.
        requestOpenLocalFiles([absolutePath]);
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
              <div className="flex h-full w-full flex-col">
                <OfflineWorktreeNotice worktreeId={worktreeId} active={wsActive} />
                <div className="relative min-h-0 flex-1">
                  <WorktreeCenter worktreeId={worktreeId} visible={wsActive} wsActive={wsActive} />
                </div>
              </div>
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
        commands={allPaletteCommands}
      />
    </>
  );
}
