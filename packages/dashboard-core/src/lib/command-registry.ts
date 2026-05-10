/**
 * Central command registry for the command palette (Cmd+Shift+P).
 *
 * All palette-visible commands are defined here so they can be referenced by
 * both the CommandPaletteDialog component and the keyboard shortcut handler.
 */

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
      id: "quick-open",
      label: "Quick Open",
      shortcut: "Cmd+P",
      action: () => deps.openQuickOpen(),
    },
    {
      id: "search-files",
      label: "Search in Files",
      shortcut: "Cmd+Shift+F",
      action: () => deps.openSearchFiles(),
    },
    {
      id: "find-in-file",
      label: "Find in File",
      shortcut: "Cmd+F",
      action: () => deps.findInFile(),
    },
    {
      id: "show-chat",
      label: "Show Chat",
      shortcut: "Ctrl+Cmd+I",
      action: () => activatePanel(deps, "chat"),
    },
    {
      id: "show-changes",
      label: "Show Changes",
      shortcut: "Cmd+Shift+G",
      action: () => activatePanel(deps, "changes"),
    },
    {
      id: "show-terminal",
      label: "Show Terminal",
      shortcut: "Ctrl+`",
      action: () => activatePanel(deps, "terminal"),
    },
    {
      id: "show-files",
      label: "Show Files",
      shortcut: "Cmd+Shift+E",
      action: () => activatePanel(deps, "files"),
    },
    {
      id: "show-browser",
      label: "Show Browser",
      shortcut: "Cmd+Shift+B",
      action: () => activatePanel(deps, "browser"),
    },
    {
      // ⌃0 — focuses keyboard into the Projects list. The direct
      // keyboard handler in DockviewWorkspaceLayout also expands the
      // left edge group if it's collapsed; this palette path just
      // activates the panel and dispatches the focus event. If the
      // sidebar happens to be collapsed when invoked from the palette,
      // press ⌘B first.
      id: "focus-projects",
      label: "Focus Projects",
      shortcut: "Ctrl+0",
      action: () => {
        activatePanel(deps, "projects");
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
      action: () => window.dispatchEvent(new CustomEvent("band:editor-go-back")),
    },
    {
      id: "editor-go-forward",
      label: "Go Forward",
      action: () => window.dispatchEvent(new CustomEvent("band:editor-go-forward")),
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
