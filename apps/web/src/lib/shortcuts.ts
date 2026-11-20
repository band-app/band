/**
 * The shortcut registry: every Band command that can have a keyboard chord,
 * its default chord, and the user's overrides.
 *
 * Chord strings use the palette's notation: `Cmd+` is the platform modifier
 * (Command on macOS, Ctrl elsewhere), `Ctrl+` is the literal Control key,
 * then `Alt+`, `Shift+` and the key (`Cmd+Shift+]`, `Alt+Shift+D`).
 *
 * Overrides live in the synced client-state key `band:shortcut-overrides`
 * (scope `all`): `{ [commandId]: chord | null }`, where `null` means the user
 * cleared the command. A command without an entry uses its default chord.
 * Every keydown handler asks `matchesCommand(event, id)` instead of testing
 * keys itself, so a rebound chord replaces the old one everywhere.
 */

import { clientStorage } from "./client-state";

export const SHORTCUT_OVERRIDES_KEY = "band:shortcut-overrides";

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  if (ua.userAgentData?.platform) return ua.userAgentData.platform === "macOS";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

export interface Chord {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase single character, or a name: `space`, `tab`, `arrowleft`, `escape`... */
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  "←": "arrowleft",
  "→": "arrowright",
  "↑": "arrowup",
  "↓": "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  esc: "escape",
  " ": "space",
};

const KEY_DISPLAY: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  space: "Space",
  tab: "Tab",
  escape: "Esc",
  enter: "Enter",
  backspace: "Backspace",
};

export function parseChord(chord: string): Chord | null {
  const parts = chord.split("+");
  // A literal "+" key shows up as an empty last segment ("Cmd++").
  let key = parts.pop() ?? "";
  if (key === "" && chord.endsWith("+")) {
    key = "+";
    if (parts[parts.length - 1] === "") parts.pop();
  }
  key = key.toLowerCase();
  key = KEY_ALIASES[key] ?? key;
  if (!key) return null;
  const out: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key };
  for (const m of parts) {
    const mod = m.toLowerCase();
    if (mod === "cmd" || mod === "meta") out.cmd = true;
    else if (mod === "ctrl" || mod === "control") out.ctrl = true;
    else if (mod === "alt" || mod === "option") out.alt = true;
    else if (mod === "shift") out.shift = true;
    else return null;
  }
  return out;
}

/** The chord in a fixed order, so two spellings of one chord compare equal. */
export function normalizeChord(chord: string): string | null {
  const c = parseChord(chord);
  if (!c) return null;
  // Off macOS "Ctrl+Cmd" and "Cmd" are the same physical key.
  const cmd = c.cmd;
  const ctrl = c.ctrl && !(!isMac() && cmd);
  const keyName = KEY_DISPLAY[c.key] ? c.key : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return [ctrl && "Ctrl", cmd && "Cmd", c.alt && "Alt", c.shift && "Shift", keyName]
    .filter(Boolean)
    .join("+");
}

/** The physical key an event names, independent of Shift or Alt rewriting `event.key`. */
function codeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  switch (code) {
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backquote":
      return "`";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Space":
      return "space";
    case "Tab":
      return "tab";
    case "Escape":
      return "escape";
    case "Enter":
      return "enter";
    case "Backspace":
      return "backspace";
    case "ArrowLeft":
      return "arrowleft";
    case "ArrowRight":
      return "arrowright";
    case "ArrowUp":
      return "arrowup";
    case "ArrowDown":
      return "arrowdown";
    default:
      return null;
  }
}

interface EventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function eventMatchesChord(e: EventLike, chord: Chord): boolean {
  const mac = isMac();
  const needMeta = mac ? chord.cmd : false;
  const needCtrl = mac ? chord.ctrl : chord.ctrl || chord.cmd;
  if (e.metaKey !== needMeta || e.ctrlKey !== needCtrl || e.altKey !== chord.alt) return false;
  // `=` and `+` share a key: "Cmd+=" also fires as "Cmd+Shift+=" (⌘+).
  const shiftFree = chord.key === "=" || chord.key === "+";
  if (!shiftFree && e.shiftKey !== chord.shift) return false;
  const byCode = codeKey(e.code);
  const key =
    e.key.length === 1
      ? e.key.toLowerCase()
      : (KEY_ALIASES[e.key.toLowerCase()] ?? e.key.toLowerCase());
  if (chord.key === "+") return key === "+" || byCode === "=";
  return byCode === chord.key || key === chord.key;
}

/** Build the chord string for a keydown, or null for a bare modifier press. */
export function chordFromEvent(e: EventLike): string | null {
  const key = codeKey(e.code) ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  if (["control", "shift", "alt", "meta", "altgraph", "os", "dead"].includes(key)) return null;
  const mac = isMac();
  const cmd = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  return normalizeChord(
    [
      ctrl && "Ctrl",
      cmd && "Cmd",
      e.altKey && "Alt",
      e.shiftKey && "Shift",
      key.length === 1 ? key.toUpperCase() : key,
    ]
      .filter(Boolean)
      .join("+"),
  );
}

/** A chord for display: symbols on macOS, words elsewhere. */
export function formatChord(chord: string): string {
  const c = parseChord(chord);
  if (!c) return chord;
  const keyText = KEY_DISPLAY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (isMac()) {
    return `${c.ctrl ? "⌃" : ""}${c.cmd ? "⌘" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${keyText}`;
  }
  const parts: string[] = [];
  if (c.ctrl || c.cmd) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(keyText);
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

export type CommandGroup =
  | "Tabs and panes"
  | "Files and editor"
  | "Navigation"
  | "View"
  | "Worktree"
  | "Chat"
  | "App";

export interface CommandDef {
  id: string;
  label: string;
  group: CommandGroup;
  /** Default chord, or a function of the platform. Undefined means none. */
  defaultChord?: string | ((mac: boolean) => string | undefined);
  /** True for a command that is also an item of a right-click menu. */
  contextMenu?: boolean;
  /** Only exists in the desktop app (browser tabs are webview guests). */
  desktopOnly?: boolean;
  /** The desktop app's native menu owns the chord there, so it cannot be rebound in the app. */
  nativeAccelerator?: boolean;
}

export const COMMAND_DEFS: CommandDef[] = [
  { id: "command-palette", label: "Command Palette", group: "App", defaultChord: "Cmd+Shift+P" },
  {
    id: "new-untitled-tab",
    label: "New Untitled File",
    group: "Files and editor",
    defaultChord: "Cmd+N",
  },
  { id: "new-terminal", label: "New Terminal", group: "Tabs and panes", defaultChord: "Cmd+T" },
  {
    id: "new-chat",
    label: "New Chat (Default Agent)",
    group: "Tabs and panes",
    // Ctrl+Alt is AltGr on Windows and "open terminal" on Linux.
    defaultChord: (mac) => (mac ? "Cmd+Alt+T" : "Cmd+Shift+N"),
  },
  {
    id: "new-browser",
    label: "New Browser",
    group: "Tabs and panes",
    defaultChord: "Cmd+Shift+B",
    desktopOnly: true,
  },
  { id: "quick-open", label: "Quick Open", group: "Files and editor", defaultChord: "Cmd+P" },
  {
    id: "search-files",
    label: "Search in Files",
    group: "Files and editor",
    defaultChord: "Cmd+Shift+F",
  },
  { id: "find-in-file", label: "Find in File", group: "Files and editor", defaultChord: "Cmd+F" },
  {
    id: "format-current-file",
    label: "Format Current File",
    group: "Files and editor",
    defaultChord: "Shift+Alt+F",
  },
  { id: "change-language-mode", label: "Change Language Mode…", group: "Files and editor" },
  {
    id: "show-chat",
    label: "Show Chat",
    group: "View",
    // Ctrl+Cmd+I needs the Cmd key; elsewhere VS Code's chat chord.
    defaultChord: (mac) => (mac ? "Ctrl+Cmd+I" : "Ctrl+Alt+I"),
  },
  { id: "show-changes", label: "Show Changes", group: "View", defaultChord: "Cmd+Shift+G" },
  { id: "show-terminal", label: "Show Terminal", group: "View", defaultChord: "Ctrl+`" },
  { id: "show-files", label: "Show Files", group: "View", defaultChord: "Cmd+Shift+E" },
  { id: "show-browser", label: "Show Browser", group: "View" },
  { id: "close-tab", label: "Close Tab", group: "Tabs and panes", defaultChord: "Cmd+W" },
  {
    id: "split-right",
    label: "Split Right",
    group: "Tabs and panes",
    // Ctrl+D is the shell's EOF.
    defaultChord: (mac) => (mac ? "Cmd+D" : "Ctrl+Shift+D"),
  },
  {
    id: "split-down",
    label: "Split Down",
    group: "Tabs and panes",
    defaultChord: (mac) => (mac ? "Cmd+Shift+D" : "Alt+Shift+D"),
  },
  { id: "next-tab", label: "Next Tab", group: "Tabs and panes", defaultChord: "Cmd+Shift+]" },
  {
    id: "previous-tab",
    label: "Previous Tab",
    group: "Tabs and panes",
    defaultChord: "Cmd+Shift+[",
  },
  { id: "next-pane", label: "Next Pane", group: "Tabs and panes", defaultChord: "Cmd+]" },
  { id: "previous-pane", label: "Previous Pane", group: "Tabs and panes", defaultChord: "Cmd+[" },
  {
    id: "toggle-maximize",
    label: "Maximize / Restore Pane",
    group: "Tabs and panes",
    defaultChord: "Cmd+Shift+M",
  },
  { id: "dictate", label: "Dictate", group: "Chat", defaultChord: "Cmd+Shift+Space" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", group: "View", defaultChord: "Cmd+B" },
  {
    id: "toggle-right-panel",
    label: "Toggle Explorer / Changes Panel",
    group: "View",
    defaultChord: "Cmd+Alt+B",
  },
  { id: "switch-worktree", label: "Switch Worktree…", group: "Navigation", defaultChord: "Cmd+K" },
  {
    id: "worktree-go-back",
    label: "Previous Worktree",
    group: "Navigation",
    defaultChord: "Cmd+Alt+←",
  },
  {
    id: "worktree-go-forward",
    label: "Next Worktree",
    group: "Navigation",
    defaultChord: "Cmd+Alt+→",
  },
  { id: "show-all-repos", label: "Show All Repos", group: "Navigation", defaultChord: "Cmd+0" },
  {
    id: "focus-repos",
    label: "Focus Repos",
    group: "Navigation",
    // Off macOS Cmd+0 and Ctrl+0 are one key, so focusing the list takes Alt+0.
    defaultChord: (mac) => (mac ? "Ctrl+0" : "Alt+0"),
  },
  {
    id: "open-file-external",
    label: "Open File in External Editor",
    group: "Files and editor",
    defaultChord: "Cmd+O",
  },
  {
    id: "zoom-in",
    label: "Zoom In",
    group: "View",
    defaultChord: "Cmd+=",
    nativeAccelerator: true,
  },
  {
    id: "zoom-out",
    label: "Zoom Out",
    group: "View",
    defaultChord: "Cmd+-",
    nativeAccelerator: true,
  },
  {
    id: "zoom-reset",
    label: "Actual Size",
    group: "View",
    defaultChord: "Cmd+Shift+0",
    nativeAccelerator: true,
  },
  {
    id: "open-settings",
    label: "Open Settings",
    group: "App",
    defaultChord: "Cmd+,",
    desktopOnly: true,
    nativeAccelerator: true,
  },
  {
    id: "reload",
    label: "Reload",
    group: "App",
    defaultChord: "Cmd+R",
    desktopOnly: true,
    nativeAccelerator: true,
  },
  { id: "editor-go-back", label: "Go Back", group: "Files and editor" },
  { id: "editor-go-forward", label: "Go Forward", group: "Files and editor" },
  { id: "toggle-mode", label: "Toggle Edit/Plan Mode", group: "Chat" },
  // Right-click menu of a worktree, run on the worktree on screen.
  { id: "worktree-git-pull", label: "Git pull", group: "Worktree", contextMenu: true },
  { id: "worktree-git-push", label: "Git push", group: "Worktree", contextMenu: true },
  {
    id: "worktree-toggle-pin",
    label: "Pin / Unpin worktree",
    group: "Worktree",
    contextMenu: true,
  },
  {
    id: "worktree-toggle-unread",
    label: "Mark worktree as read / unread",
    group: "Worktree",
    contextMenu: true,
  },
  { id: "worktree-copy-path", label: "Copy worktree path", group: "Worktree", contextMenu: true },
  { id: "worktree-reveal", label: "Open worktree in Finder", group: "Worktree", contextMenu: true },
  { id: "worktree-run-setup", label: "Run setup", group: "Worktree", contextMenu: true },
  { id: "worktree-run-teardown", label: "Run teardown", group: "Worktree", contextMenu: true },
];

const DEFS_BY_ID = new Map(COMMAND_DEFS.map((d) => [d.id, d]));

export function commandDef(id: string): CommandDef | undefined {
  return DEFS_BY_ID.get(id);
}

export function defaultChordFor(id: string): string | undefined {
  const d = DEFS_BY_ID.get(id)?.defaultChord;
  return typeof d === "function" ? d(isMac()) : d;
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export type ShortcutOverrides = Record<string, string | null>;

const listeners = new Set<() => void>();
let cacheRaw: string | null | undefined;
let cacheValue: ShortcutOverrides = {};

function readRaw(): string | null {
  try {
    return clientStorage.getItem(SHORTCUT_OVERRIDES_KEY);
  } catch {
    return null;
  }
}

/** Parse the stored value, ignoring entries that are not `string | null` for a known command. */
export function parseOverrides(raw: string | null): ShortcutOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ShortcutOverrides = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null) out[id] = null;
      else if (typeof v === "string" && parseChord(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function getOverrides(): ShortcutOverrides {
  const raw = readRaw();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheValue = parseOverrides(raw);
  }
  return cacheValue;
}

function writeOverrides(next: ShortcutOverrides): void {
  try {
    if (Object.keys(next).length === 0) clientStorage.removeItem(SHORTCUT_OVERRIDES_KEY);
    else clientStorage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the override only lasts until reload.
    cacheValue = next;
  }
  for (const l of listeners) l();
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHORTCUT_OVERRIDES_KEY || e.key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** The chord a command uses now: the override, `undefined` when cleared, else the default. */
export function effectiveChord(id: string): string | undefined {
  const overrides = getOverrides();
  if (Object.hasOwn(overrides, id)) return overrides[id] ?? undefined;
  return defaultChordFor(id);
}

export function isOverridden(id: string): boolean {
  return Object.hasOwn(getOverrides(), id);
}

export function setBinding(id: string, chord: string | null): void {
  const normalized = chord === null ? null : normalizeChord(chord);
  if (chord !== null && !normalized) return;
  const next = { ...getOverrides() };
  // A binding equal to the default is stored as no override.
  const def = defaultChordFor(id);
  if (normalized !== null && def && normalizeChord(def) === normalized) delete next[id];
  else if (normalized === null && !def) delete next[id];
  else next[id] = normalized;
  writeOverrides(next);
}

export function resetBinding(id: string): void {
  const next = { ...getOverrides() };
  delete next[id];
  writeOverrides(next);
}

export function resetAllBindings(): void {
  writeOverrides({});
}

/** Other commands whose effective chord equals `chord`. */
export function findConflicts(chord: string, exceptId: string): CommandDef[] {
  const target = normalizeChord(chord);
  if (!target) return [];
  return COMMAND_DEFS.filter((d) => {
    if (d.id === exceptId) return false;
    const c = effectiveChord(d.id);
    return c !== undefined && normalizeChord(c) === target;
  });
}

/**
 * Assign `chord` to `id`. Commands that held the chord lose it (set to
 * cleared). Callers show the conflict and ask the user before calling this.
 */
export function assignBinding(id: string, chord: string): void {
  const normalized = normalizeChord(chord);
  if (!normalized) return;
  const next = { ...getOverrides() };
  for (const other of findConflicts(normalized, id)) next[other.id] = null;
  const def = defaultChordFor(id);
  if (def && normalizeChord(def) === normalized) delete next[id];
  else next[id] = normalized;
  writeOverrides(next);
}

let capturing = false;

/** While Settings > Keyboard records a chord, no command fires. */
export function setShortcutCapture(active: boolean): void {
  capturing = active;
}

/** True when the keydown is the command's current chord. */
export function matchesCommand(e: KeyboardEvent, id: string): boolean {
  if (capturing) return false;
  const chord = effectiveChord(id);
  if (!chord) return false;
  const parsed = parseChord(chord);
  return parsed ? eventMatchesChord(e, parsed) : false;
}

/** The chord for display next to a menu item or palette row, or undefined. */
export function chordLabel(id: string): string | undefined {
  const c = effectiveChord(id);
  return c ? formatChord(c) : undefined;
}

// ---------------------------------------------------------------------------
// Handlers for commands that no component listens for itself
// ---------------------------------------------------------------------------

const handlers = new Map<string, () => void>();

/** Register what a command does. The dispatcher runs it when its chord is pressed. */
export function registerHandler(id: string, fn: () => void): () => void {
  handlers.set(id, fn);
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id);
  };
}

export function hasHandler(id: string): boolean {
  return handlers.has(id);
}

export function runCommand(id: string): boolean {
  const fn = handlers.get(id);
  if (!fn) return false;
  fn();
  return true;
}

/** Ids of registered commands whose current chord the event is. */
export function handlerCommandFor(e: KeyboardEvent): string | null {
  for (const id of handlers.keys()) if (matchesCommand(e, id)) return id;
  return null;
}

/** Which split the event asks for (split right / split down), by the current chords. */
export function splitDirectionForCommand(e: KeyboardEvent): "right" | "below" | null {
  if (matchesCommand(e, "split-right")) return "right";
  if (matchesCommand(e, "split-down")) return "below";
  return null;
}

/**
 * Like `matchesCommand`, but a Cmd chord also fires with Ctrl on macOS. The browser build's zoom
 * keys always took either modifier, so Ctrl+= still zooms there.
 */
export function matchesCommandWithEitherModifier(e: KeyboardEvent, id: string): boolean {
  if (matchesCommand(e, id)) return true;
  const chord = effectiveChord(id);
  const parsed = chord ? parseChord(chord) : null;
  if (!parsed || !parsed.cmd || parsed.ctrl || capturing || !isMac() || !e.ctrlKey || e.metaKey) {
    return false;
  }
  return eventMatchesChord(
    {
      key: e.key,
      code: e.code,
      metaKey: true,
      ctrlKey: false,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    },
    parsed,
  );
}
