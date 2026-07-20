/**
 * The single source of truth for Band's keyboard shortcut combos.
 *
 * Every DOM-delivered shortcut is declared here once, as a pair:
 *
 *   - `binding` — the combo in `react-hotkeys-hook` syntax, passed straight
 *     to `useHotkeys`. `mod` resolves to ⌘ on macOS and Ctrl elsewhere.
 *   - `display` — the same combo in the canonical `Cmd+X` notation that
 *     `formatShortcut` (command-registry.ts) turns into platform symbols for
 *     the command palette and the UI hints.
 *
 * Keeping both on one record is the point: the palette used to carry its own
 * copy of every combo string, so a rebinding could silently leave the
 * advertised shortcut pointing at nothing.
 *
 * NOT declared here — these reach the app through their own delivery
 * mechanisms and never touch the DOM keydown path:
 *
 *   - CodeMirror editing keys (⌘S, Tab, undo/redo) — `codemirror-setup.ts`
 *     registers them as a `keymap` extension on the editor state.
 *   - The Electron menu accelerators (⌘R, ⌘=, ⌘,, ⌥⌘I) — `apps/desktop/
 *     src/main/menu.ts`. The native menu consumes the keystroke before the
 *     renderer sees it.
 *   - Browser find-in-page (⌘F inside a WebContentsView) — the embedded view
 *     swallows keydown, so the main process forwards a `browser-find-shortcut`
 *     IPC event instead (`useBrowserFindInPage.ts`).
 */

/** A shortcut's binding (react-hotkeys-hook syntax) plus its display form. */
export interface ShortcutSpec {
  /** Passed to `useHotkeys`. `mod` = ⌘ on macOS, Ctrl elsewhere. */
  binding: string;
  /** Canonical `Cmd+X` notation for `formatShortcut`. */
  display: string;
  /**
   * Match the produced CHARACTER rather than the physical key.
   *
   * react-hotkeys-hook v5 defaults to `useKey: false`, which matches on
   * `KeyboardEvent.code` — so a punctuation binding written as the literal
   * character (`` ` ``, `[`, `=`) silently never fires; it would have to be
   * spelled `Backquote` / `BracketLeft` / `Equal` instead. Every punctuation
   * binding below therefore sets this, which also preserves the `e.key`
   * (character-based) matching the hand-rolled handlers used.
   *
   * The inverse case — deliberately matching the physical key — is why ⇧⌥F and
   * ⌥⌘B leave this unset: macOS substitutes Alt-layer characters into `e.key`
   * (⌥B → "∫", ⌥F → "ƒ"), so those must match on `code`.
   */
  useKey?: boolean;
}

/**
 * Expand a mod-key combo into BOTH the ⌘ and the Ctrl spelling.
 *
 * `react-hotkeys-hook`'s `mod` alias resolves to ONE modifier per platform (⌘
 * on macOS, Ctrl elsewhere). The handler this replaces gated on
 * `e.metaKey || e.ctrlKey`, so every one of these chords fired from EITHER
 * modifier on EVERY platform — ⌘N and Ctrl+N both opened a new file on a Mac.
 * Using `mod` would silently drop half of each binding, so the combos are
 * spelled out instead.
 *
 * Narrowing these to one modifier per platform may well be an improvement
 * (Ctrl+N is "next line" in readline), but it's a user-visible change and
 * belongs in its own decision, not smuggled in by a refactor.
 */
function eitherMod(suffix: string): string {
  return `meta+${suffix}, ctrl+${suffix}`;
}

/**
 * Shortcuts that fire from anywhere in the workspace.
 *
 * Terminal caveat: xterm owns most Ctrl chords (Ctrl+K is kill-to-end-of-line,
 * Ctrl+D is EOF), so the handlers for the `mod`-based entries below bail while
 * a terminal is focused *unless* the user actually pressed ⌘. On Windows and
 * Linux, where `mod` IS Ctrl, that means these shortcuts deliberately yield to
 * the shell. The two entries called out individually below are the exceptions.
 */
export const GLOBAL_SHORTCUTS = {
  /**
   * Workspace picker. BOTH spellings are bound on every platform, not `mod+k`:
   * the Ctrl+K spelling has to keep working on a Mac too (it predates the ⌘
   * binding and users have it in muscle memory), and `mod` would collapse to ⌘
   * alone there. Collapsing these two was a real regression caught by
   * `workspace-picker.spec.ts`'s "non-macOS path" test.
   *
   * The two spellings differ in one respect, handled by the shared terminal
   * bail rather than here: ⌘K fires even from a focused terminal (⌘ isn't a
   * shell modifier, and opening the picker from a terminal was a long-standing
   * request), while Ctrl+K yields to xterm since it's kill-to-end-of-line.
   */
  workspacePicker: { binding: "meta+k, ctrl+k", display: "Cmd+K" },
  /** Reveal the project-list sidebar and focus the list. */
  focusProjects: { binding: "ctrl+0", display: "Ctrl+0" },

  // Dialogs and editor actions.
  newUntitledTab: { binding: eitherMod("n"), display: "Cmd+N" },
  newChatSession: { binding: eitherMod("shift+n"), display: "Cmd+Shift+N" },
  quickOpen: { binding: eitherMod("p"), display: "Cmd+P" },
  commandPalette: { binding: eitherMod("shift+p"), display: "Cmd+Shift+P" },
  searchFiles: { binding: eitherMod("shift+f"), display: "Cmd+Shift+F" },
  findInFile: { binding: eitherMod("f"), display: "Cmd+F" },
  /** Desktop only — the plain web build has no file picker to invoke. */
  openFile: { binding: eitherMod("o"), display: "Cmd+O" },
  /** The one binding with no mod key in the chord, so it needs its own
   *  handler rather than riding the shared mod gate. */
  formatCurrentFile: { binding: "shift+alt+f", display: "Shift+Alt+F" },

  // Panel activation.
  showChat: { binding: "ctrl+meta+i", display: "Ctrl+Cmd+I" },
  showChanges: { binding: eitherMod("shift+g"), display: "Cmd+Shift+G" },
  showFiles: { binding: eitherMod("shift+e"), display: "Cmd+Shift+E" },
  showBrowser: { binding: eitherMod("shift+b"), display: "Cmd+Shift+B" },
  /** Ctrl+` on every platform (VS Code parity) — not a `mod` binding. */
  showTerminal: { binding: "ctrl+`", display: "Ctrl+`", useKey: true },

  // Layout.
  /** Toggles the project-list sidebar, always — it does not resolve its target
   *  by focus. A shortcut that means different things depending on invisible
   *  focus state is hard to trust, and the sidebar is overwhelmingly the
   *  intended target. The cost is that an inner dockview's LEFT edge has no
   *  keyboard toggle; if that turns out to matter it gets its own combo rather
   *  than focus-dependence here. */
  toggleSidebar: { binding: eitherMod("b"), display: "Cmd+B" },
  /** Focus-aware: toggles the focused inner dockview's right edge when it has
   *  panels, else the main layout's. The last of the three edge chords to
   *  resolve its target by focus. */
  toggleRightEdge: { binding: eitherMod("alt+b"), display: "Cmd+Alt+B" },
  /** Toggles the OUTERMOST layout's bottom edge, always — same rule as
   *  `toggleSidebar`, not `toggleRightEdge`. The bottom panel reads as one
   *  shared surface, so the chord that shows and hides it means one thing
   *  everywhere instead of retargeting to the focused inner dock. No-ops when
   *  that edge is absent or empty. */
  toggleBottomEdge: { binding: eitherMod("j"), display: "Cmd+J" },
  maximizePanel: { binding: eitherMod("shift+m"), display: "Cmd+Shift+M" },
} as const satisfies Record<string, ShortcutSpec>;

/**
 * Shortcuts scoped to a dock — the chat, terminal, browser, and file-tab
 * containers. Each dock binds these against its own element, so the same
 * combo performs the dock's own version of the action and only while that
 * dock (or a descendant) holds focus. Innermost focused dock wins.
 */
export const DOCK_SHORTCUTS = {
  newTab: { binding: eitherMod("t"), display: "Cmd+T" },
  closeTab: { binding: eitherMod("w"), display: "Cmd+W" },
  /** The terminal dock additionally requires ⌘ (Ctrl+D is EOF there) and
   *  enforces that with its own `ignoreEventWhen`; chat and browser accept
   *  either modifier, as they did before. */
  splitRight: { binding: eitherMod("d"), display: "Cmd+D" },
  splitDown: { binding: eitherMod("shift+d"), display: "Cmd+Shift+D" },
  /**
   * Matched on the PHYSICAL key (no `useKey`), unlike their unshifted
   * `nextGroup` / `previousGroup` siblings. Holding Shift changes the produced
   * character — `]` becomes `}` on a US layout — so a character match against
   * `]` can never fire. The hand-rolled handlers had exactly that bug
   * (`e.key.toLowerCase() === "]"` behind a `e.shiftKey` test), which made both
   * of these dead bindings despite being advertised in the palette. Physical
   * matching fixes them and is layout-independent besides.
   */
  nextTab: { binding: eitherMod("shift+BracketRight"), display: "Cmd+Shift+]" },
  previousTab: { binding: eitherMod("shift+BracketLeft"), display: "Cmd+Shift+[" },
  /** Ctrl-only by design, and must NOT fire with ⌘ held — matches the
   *  `e.ctrlKey && !e.metaKey` test in the handlers this replaces. */
  cycleTabForward: { binding: "ctrl+tab", display: "Ctrl+Tab" },
  cycleTabBackward: { binding: "ctrl+shift+tab", display: "Ctrl+Shift+Tab" },
  nextGroup: { binding: eitherMod("]"), display: "Cmd+]", useKey: true },
  previousGroup: { binding: eitherMod("["), display: "Cmd+[", useKey: true },
} as const satisfies Record<string, ShortcutSpec>;

/**
 * Label filter in the dashboard sidebar: ⌘0 = All, ⌘1..9 / Ctrl+1..9 = Nth
 * label. One binding covering all ten digits, since the handler has to resolve
 * the digit against the label list at call time anyway.
 *
 * ⌘0 is ⌘-only on purpose: Ctrl+0 is the global "Focus Projects" shortcut, so
 * the two must not both claim that chord. Digits 1..9 have no such conflict and
 * accept either modifier, matching the `e.metaKey || e.ctrlKey` gate this
 * replaces. See the call site in `DashboardShell.tsx`.
 */
export const LABEL_FILTER_SHORTCUT: ShortcutSpec = {
  binding: ["meta+0", ...Array.from({ length: 9 }, (_, i) => eitherMod(String(i + 1)))].join(", "),
  display: "Cmd+0",
  // Character-based so the match and the handler agree: the callback resolves
  // which label to select with `Number(event.key)`. Matching on the physical key
  // instead would fire on a layout whose digit row is shifted (AZERTY `Digit1` →
  // "&") and then silently no-op inside the handler. The handler this replaces
  // was character-based on both halves too (`e.key < "0" || e.key > "9"`).
  useKey: true,
};

/** Zoom shortcuts. Browser build only — in the desktop shell the native View
 *  menu owns these accelerators and the renderer never sees the keydown. */
export const ZOOM_SHORTCUTS = {
  /**
   * `=` and `+` share one physical key (`+` needs Shift on a US layout) and the
   * old handler accepted either character, so both spellings must fire.
   *
   * Matched on the PHYSICAL key rather than the character. Two reasons the
   * obvious character form is wrong: the library splits a combo on `"+"`, so
   * `"meta++"` parses to empty key names and can never match; and it compares
   * modifiers for exact equality, so a `meta+=` binding would not fire while
   * Shift is held. Binding `Equal` with and without Shift covers both.
   */
  zoomIn: { binding: `${eitherMod("Equal")}, ${eitherMod("shift+Equal")}`, display: "Cmd+=" },
  /** Physical key for the same reason as `zoomIn`. */
  zoomOut: { binding: eitherMod("Minus"), display: "Cmd+-" },
  /** Shift is deliberate: plain ⌘0 is the "All labels" filter. Matched on the
   *  PHYSICAL key (no `useKey`) because with Shift held `e.key` is
   *  layout-dependent — ")" on US layouts — while the code is always Digit0. */
  resetZoom: { binding: eitherMod("shift+0"), display: "Cmd+Shift+0" },
} as const satisfies Record<string, ShortcutSpec>;
