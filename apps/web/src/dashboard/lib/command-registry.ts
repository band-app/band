/**
 * Central command registry for the command palette (Cmd+Shift+P).
 *
 * All palette-visible commands are defined here so they can be referenced by
 * both the CommandPaletteDialog component and the keyboard shortcut handler.
 *
 * The `shortcut` strings are read from `GLOBAL_SHORTCUTS` rather than written
 * out here. They used to be independent copies, so a rebinding could leave the
 * palette advertising a combo that no longer did anything — the display string
 * and the `useHotkeys` binding now come from the same record.
 */

import { GLOBAL_SHORTCUTS } from "@/lib/shortcuts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaletteCommand {
  /** Unique identifier for the command. */
  id: string;
  /** Human-readable label shown in the palette. */
  label: string;
  /**
   * Canonical keyboard shortcut string. Optional — palette-only commands
   * with no keybinding can omit it.
   * Use `Cmd+` for the platform modifier (⌘ on Mac, Ctrl elsewhere).
   * Examples: `"Cmd+P"`, `"Cmd+Shift+F"`, `"Shift+Tab"`.
   */
  shortcut?: string;
  /** Callback executed when the command is selected. */
  action: () => void;
}

export interface CommandRegistryDeps {
  /** Returns the current DockviewApi (reads from a ref at call time). */
  getApi: () => { getPanel(id: string): { api: { setActive(): void } } | undefined } | null;
  /** Returns the current list of hidden panel ids (reads from a ref). */
  getHiddenPanels: () => string[];
  /** Open the Quick Open dialog. */
  openQuickOpen: () => void;
  /** Open the Search Files dialog. */
  openSearchFiles: () => void;
  /** Trigger find-in-file for the active editor. */
  findInFile: () => void;
  /**
   * Format the file in the currently-active editor tab. Implementations
   * read the current `{workspaceId, filePath}` from their own refs at call
   * time and dispatch the `band:format-current-file` event with that detail
   * — the keyboard shortcut handler in DockviewWorkspaceLayout does the
   * same thing, so the palette and shortcut paths stay symmetric.
   */
  formatCurrentFile: () => void;
  /**
   * Open a new untitled (scratch) editor tab. Mirrors the ⌘N shortcut
   * and the "New Untitled File" button in the Files toolbar; backed by
   * the `band:new-untitled-tab` event so the action stays loosely
   * coupled to whichever workspace happens to be active.
   */
  newUntitledTab: () => void;
  /**
   * Open the searchable language-mode picker for the currently-active
   * editor tab. Implementations dispatch `band:open-language-picker`
   * with `{workspaceId, filePath}` so the matching FileViewer listener
   * opens the dialog (same pattern as `formatCurrentFile`).
   */
  changeLanguageMode: () => void;
  /**
   * Step the active editor's navigation history backward/forward.
   * Implementations read the active `workspaceId` from a ref and dispatch
   * `band:editor-go-back` / `band:editor-go-forward` with `{workspaceId}` so
   * only the active workspace's CodeBrowserView acts — hidden sibling
   * workspaces stay mounted and would otherwise step their own history
   * stacks too (same pattern as `formatCurrentFile`, see issue #539).
   */
  editorGoBack: () => void;
  editorGoForward: () => void;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // Prefer the modern User-Agent Client Hints API when available
  const ua = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  if (ua.userAgentData?.platform) {
    return ua.userAgentData.platform === "macOS";
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");
}

// ---------------------------------------------------------------------------
// Shortcut formatting
// ---------------------------------------------------------------------------

/**
 * Convert a canonical shortcut string to a platform-appropriate display string.
 *
 * On macOS: `Cmd+` → `⌘`, `Shift+` → `⇧`, `Alt+` → `⌥`
 * On others: `Cmd+` → `Ctrl+`
 */
export function formatShortcut(shortcut: string): string {
  const mac = isMacPlatform();
  if (mac) {
    return shortcut
      .replace(/Cmd\+/g, "⌘")
      .replace(/Ctrl\+/g, "⌃")
      .replace(/Shift\+/g, "⇧")
      .replace(/Alt\+/g, "⌥");
  }
  // Non-Mac: collapse "Ctrl+Cmd+X" → "Ctrl+X" first so we don't end up
  // with the redundant "Ctrl+Ctrl+X" after the Cmd→Ctrl substitution.
  // (No native Cmd-equivalent on Win/Linux; the binding falls through
  // to plain Ctrl in those environments.)
  return shortcut.replace(/Ctrl\+Cmd\+/g, "Ctrl+").replace(/Cmd\+/g, "Ctrl+");
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

function activatePanel(deps: CommandRegistryDeps, panelId: string): void {
  if (deps.getHiddenPanels().includes(panelId)) return;
  deps.getApi()?.getPanel(panelId)?.api.setActive();
}

export function buildCommands(deps: CommandRegistryDeps): PaletteCommand[] {
  return [
    {
      // ⌘N — open a new untitled (scratch) editor tab. Listed first
      // because it's the closest sibling to Quick Open ("create a new
      // editing surface" vs "find an existing one") and the keybinding
      // is one of the most discoverable in the app.
      id: "new-untitled-tab",
      label: "New Untitled File",
      shortcut: GLOBAL_SHORTCUTS.newUntitledTab.display,
      action: () => deps.newUntitledTab(),
    },
    {
      id: "quick-open",
      label: "Quick Open",
      shortcut: GLOBAL_SHORTCUTS.quickOpen.display,
      action: () => deps.openQuickOpen(),
    },
    {
      // ⇧⌘F → Search in Files (matches VS Code's "Search in Files" /
      // "Find in Files" binding, the same kbd hint advertised by the
      // file-tree tooltip and the file-toolbar dropdown). Format
      // Current File lives at ⇧⌥F (also VS Code parity, see below).
      id: "search-files",
      label: "Search in Files",
      shortcut: GLOBAL_SHORTCUTS.searchFiles.display,
      action: () => deps.openSearchFiles(),
    },
    {
      id: "find-in-file",
      label: "Find in File",
      shortcut: GLOBAL_SHORTCUTS.findInFile.display,
      action: () => deps.findInFile(),
    },
    {
      // Format the file in the currently-active editor tab via Prettier.
      // The deps callback (wired in DockviewWorkspaceLayout) reads the
      // current `{workspaceId, filePath}` from refs and dispatches the
      // event with detail, so the matching FileViewer responds. The
      // keyboard handler dispatches the same event with the same detail
      // shape — both paths funnel through one FileViewer listener.
      //
      // ⇧⌥F mirrors VS Code's default "Format Document" binding. Note
      // it's the only entry in this registry without Cmd/Ctrl in the
      // chord — the keyboard handler special-cases it above its mod
      // gate so the keystroke reaches us in the first place.
      id: "format-current-file",
      label: "Format Current File",
      shortcut: GLOBAL_SHORTCUTS.formatCurrentFile.display,
      action: () => deps.formatCurrentFile(),
    },
    {
      // Searchable language-mode picker for the active editor tab
      // (issue #434). No keyboard shortcut — VS Code's equivalent
      // (Cmd+K M) is a chord we don't yet support; the status-bar
      // language indicator and this palette entry are the two reachable
      // surfaces.
      id: "change-language-mode",
      label: "Change Language Mode…",
      action: () => deps.changeLanguageMode(),
    },
    {
      id: "show-chat",
      label: "Show Chat",
      shortcut: GLOBAL_SHORTCUTS.showChat.display,
      action: () => activatePanel(deps, "chat"),
    },
    {
      id: "show-changes",
      label: "Show Changes",
      shortcut: GLOBAL_SHORTCUTS.showChanges.display,
      action: () => activatePanel(deps, "changes"),
    },
    {
      id: "show-terminal",
      label: "Show Terminal",
      shortcut: GLOBAL_SHORTCUTS.showTerminal.display,
      action: () => activatePanel(deps, "terminal"),
    },
    {
      id: "show-files",
      label: "Show Files",
      shortcut: GLOBAL_SHORTCUTS.showFiles.display,
      action: () => activatePanel(deps, "files"),
    },
    {
      id: "show-browser",
      label: "Show Browser",
      shortcut: GLOBAL_SHORTCUTS.showBrowser.display,
      action: () => activatePanel(deps, "browser"),
    },
    {
      // ⌃0 — reveal the project-list sidebar (which lives outside the
      // dockview) and move keyboard focus into the list. `band:show-sidebar`
      // expands the sidebar if it's collapsed; DashboardShell's
      // `band:focus-projects` listener then focuses the list.
      id: "focus-projects",
      label: "Focus Projects",
      shortcut: GLOBAL_SHORTCUTS.focusProjects.display,
      action: () => {
        window.dispatchEvent(new CustomEvent("band:show-sidebar"));
        queueMicrotask(() => {
          window.dispatchEvent(new CustomEvent("band:focus-projects"));
        });
      },
    },
    {
      // No keyboard shortcut: Cmd+- is reserved by the desktop View menu's
      // Zoom Out accelerator. Reachable via the back/forward arrows in the
      // FileViewer toolbar and via this palette entry.
      id: "editor-go-back",
      label: "Go Back",
      action: () => deps.editorGoBack(),
    },
    {
      id: "editor-go-forward",
      label: "Go Forward",
      action: () => deps.editorGoForward(),
    },
    {
      // No shortcut advertised: Shift+Tab is wired only inside the chat
      // input (PromptInputTextarea), so it isn't a globally-applicable
      // binding. The chat's mode dropdown shows the ⇧Tab hint in-context.
      id: "toggle-mode",
      label: "Toggle Edit/Plan Mode",
      action: () => window.dispatchEvent(new CustomEvent("band:toggle-mode")),
    },
  ];
}
