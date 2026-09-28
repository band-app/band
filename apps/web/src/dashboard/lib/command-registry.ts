/**
 * Central command registry for the command palette (Cmd+Shift+P).
 *
 * All palette-visible commands are defined here so they can be referenced by
 * both the CommandPaletteDialog component and the keyboard shortcut handler.
 */

import { isDesktop } from "../../lib/is-desktop";

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
  /**
   * Add a new leaf of the given kind to the active workspace's active group.
   * Mirrors the ⌘T / ⌥⌘T / ⇧⌘B shortcuts in SharedDockviewLayout.
   */
  newLeaf: (kind: "term" | "chat" | "browser") => void;
  /** Open the workspace picker (⌘K). */
  openWorkspacePicker: () => void;
  /** Close the active tab of the active workspace (⌘W). */
  closeActiveTab: () => void;
  /** Split the active tab (⌘D / ⌘⇧D). A terminal splits into nested panes. */
  splitActiveTab: (direction: "right" | "below") => void;
  /** Move to the next / previous tab in the active group (⇧⌘] / ⇧⌘[). */
  cycleTabs: (direction: 1 | -1) => void;
  /** Move to the next / previous pane group (⌘] / ⌘[). */
  cycleGroups: (direction: 1 | -1) => void;
  /** Maximize or restore the active group (⇧⌘M). */
  toggleMaximize: () => void;
  /** Open the active editor's file in the external editor (⌘O). */
  openFileExternal: () => void;
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
// Platform-specific chords
// ---------------------------------------------------------------------------

/**
 * Chords that differ between macOS and Windows / Linux, where the plain
 * `Cmd+` → `Ctrl+` swap in `formatShortcut` would name a binding that
 * doesn't exist. The keyboard handlers apply the same split.
 */
function platformShortcuts() {
  const mac = isMacPlatform();
  return {
    // Ctrl+Alt is AltGr on Windows and "open terminal" on Linux, so there is no
    // ⌥⌘T there; Ctrl+Shift+N opens the same default-agent chat.
    newChat: mac ? "Cmd+Alt+T" : "Cmd+Shift+N",
    // Ctrl+D is the shell's EOF, so Windows / Linux split with Orca's chords.
    splitRight: mac ? "Cmd+D" : "Ctrl+Shift+D",
    splitDown: mac ? "Cmd+Shift+D" : "Alt+Shift+D",
    // ⌃⌘I needs the Cmd key; Windows / Linux use VS Code's chat chord.
    showChat: mac ? "Ctrl+Cmd+I" : "Ctrl+Alt+I",
  };
}

/** Call a `window.__band*` global registered by the app shell, if present. */
function callWindowGlobal(name: string, ...args: unknown[]): void {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === "function") fn(...args);
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

function activatePanel(deps: CommandRegistryDeps, panelId: string): void {
  if (deps.getHiddenPanels().includes(panelId)) return;
  deps.getApi()?.getPanel(panelId)?.api.setActive();
}

export function buildCommands(deps: CommandRegistryDeps): PaletteCommand[] {
  const keys = platformShortcuts();
  return [
    {
      // ⌘N — open a new untitled (scratch) editor tab. Listed first
      // because it's the closest sibling to Quick Open ("create a new
      // editing surface" vs "find an existing one") and the keybinding
      // is one of the most discoverable in the app.
      id: "new-untitled-tab",
      label: "New Untitled File",
      shortcut: "Cmd+N",
      action: () => deps.newUntitledTab(),
    },
    {
      // New-tab chords copied from Orca (see SharedDockviewLayout).
      id: "new-terminal",
      label: "New Terminal",
      shortcut: "Cmd+T",
      action: () => deps.newLeaf("term"),
    },
    {
      id: "new-chat",
      label: "New Chat (Default Agent)",
      shortcut: keys.newChat,
      action: () => deps.newLeaf("chat"),
    },
    // Browser tabs are <webview> guests, which exist only in the desktop app.
    ...(isDesktop
      ? [
          {
            id: "new-browser",
            label: "New Browser",
            shortcut: "Cmd+Shift+B",
            action: () => deps.newLeaf("browser"),
          },
        ]
      : []),
    {
      id: "quick-open",
      label: "Quick Open",
      shortcut: "Cmd+P",
      action: () => deps.openQuickOpen(),
    },
    {
      // ⇧⌘F → Search in Files (matches VS Code's "Search in Files" /
      // "Find in Files" binding, the same kbd hint advertised by the
      // file-tree tooltip and the file-toolbar dropdown). Format
      // Current File lives at ⇧⌥F (also VS Code parity, see below).
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
      shortcut: "Shift+Alt+F",
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
      shortcut: keys.showChat,
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
      action: () => activatePanel(deps, "browser"),
    },
    {
      id: "close-tab",
      label: "Close Tab",
      shortcut: "Cmd+W",
      action: () => deps.closeActiveTab(),
    },
    {
      id: "split-right",
      label: "Split Right",
      shortcut: keys.splitRight,
      action: () => deps.splitActiveTab("right"),
    },
    {
      id: "split-down",
      label: "Split Down",
      shortcut: keys.splitDown,
      action: () => deps.splitActiveTab("below"),
    },
    {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs too, in the desktop app and in the
      // web build opened as an installed app window. A regular Chrome tab keeps
      // Ctrl+Tab for its own tab switching and never passes it to the page.
      id: "next-tab",
      label: "Next Tab",
      shortcut: "Cmd+Shift+]",
      action: () => deps.cycleTabs(1),
    },
    {
      id: "previous-tab",
      label: "Previous Tab",
      shortcut: "Cmd+Shift+[",
      action: () => deps.cycleTabs(-1),
    },
    {
      id: "next-pane",
      label: "Next Pane",
      shortcut: "Cmd+]",
      action: () => deps.cycleGroups(1),
    },
    {
      id: "previous-pane",
      label: "Previous Pane",
      shortcut: "Cmd+[",
      action: () => deps.cycleGroups(-1),
    },
    {
      id: "toggle-maximize",
      label: "Maximize / Restore Pane",
      shortcut: "Cmd+Shift+M",
      action: () => deps.toggleMaximize(),
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      shortcut: "Cmd+B",
      action: () => window.dispatchEvent(new CustomEvent("band:toggle-sidebar")),
    },
    {
      id: "toggle-right-panel",
      label: "Toggle Explorer / Changes Panel",
      shortcut: "Cmd+Alt+B",
      action: () => window.dispatchEvent(new CustomEvent("band:toggle-right-panel")),
    },
    {
      // Developer aid: draws the desktop window's drag region over the app
      // (`WindowDragRegionOverlay`). Offered in the web build too, where the
      // same app-region styles compute but nothing hit-tests them.
      id: "toggle-drag-region-overlay",
      label: "Toggle Window Drag Region Overlay",
      action: () => window.dispatchEvent(new CustomEvent("band:toggle-drag-region-overlay")),
    },
    {
      id: "switch-workspace",
      label: "Switch Workspace…",
      shortcut: "Cmd+K",
      action: () => deps.openWorkspacePicker(),
    },
    {
      // ⌥⌘← / ⌥⌘→, copied from Orca's worktree history. AppShell owns the
      // history stack and listens for these events and the keys.
      id: "workspace-go-back",
      label: "Previous Workspace",
      shortcut: "Cmd+Alt+←",
      action: () => window.dispatchEvent(new CustomEvent("band:workspace-go-back")),
    },
    {
      id: "workspace-go-forward",
      label: "Next Workspace",
      shortcut: "Cmd+Alt+→",
      action: () => window.dispatchEvent(new CustomEvent("band:workspace-go-forward")),
    },
    {
      // ⌘1..9 pick the Nth label; they depend on the user's labels, so only
      // "All projects" is listed here.
      id: "show-all-projects",
      label: "Show All Projects",
      shortcut: "Cmd+0",
      action: () => window.dispatchEvent(new CustomEvent("band:show-all-projects")),
    },
    {
      id: "open-file-external",
      label: "Open File in External Editor",
      shortcut: "Cmd+O",
      action: () => deps.openFileExternal(),
    },
    {
      id: "zoom-in",
      label: "Zoom In",
      shortcut: "Cmd+=",
      action: () => callWindowGlobal("__bandZoom", "in"),
    },
    {
      id: "zoom-out",
      label: "Zoom Out",
      shortcut: "Cmd+-",
      action: () => callWindowGlobal("__bandZoom", "out"),
    },
    {
      id: "zoom-reset",
      label: "Actual Size",
      shortcut: "Cmd+Shift+0",
      action: () => callWindowGlobal("__bandZoom", "reset"),
    },
    {
      // ⌘, is a desktop View-menu accelerator; the browser keeps it.
      id: "open-settings",
      label: "Open Settings",
      shortcut: isDesktop ? "Cmd+," : undefined,
      action: () => callWindowGlobal("__bandOpenSettings"),
    },
    // ⌘R is a desktop View-menu accelerator. From the palette nothing inside
    // a browser tab has focus, so it reloads the app.
    ...(isDesktop
      ? [
          {
            id: "reload",
            label: "Reload",
            shortcut: "Cmd+R",
            action: () => callWindowGlobal("__bandReload"),
          },
        ]
      : []),
    {
      // ⌃0 — reveal the project-list sidebar (which lives outside the
      // dockview) and move keyboard focus into the list. `band:show-sidebar`
      // expands the sidebar if it's collapsed; DashboardShell's
      // `band:focus-projects` listener then focuses the list.
      id: "focus-projects",
      label: "Focus Projects",
      shortcut: "Ctrl+0",
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
