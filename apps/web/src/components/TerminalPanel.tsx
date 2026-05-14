import {
  SearchBar,
  type SearchBarHandle,
  type SearchOptions,
  useSettingsQuery,
} from "@band-app/dashboard-core";
import type { FitAddon } from "@xterm/addon-fit";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../lib/open-external-url";
import {
  type ArrowDirection,
  applySelection,
  type Cell,
  getLineText,
  moveCell,
  pointToCell,
  wordSelectionAt,
} from "../lib/terminal-selection";
import { TerminalToolbar } from "./TerminalToolbar";

/** How long a finger must rest on the terminal to trigger word-selection. */
const LONG_PRESS_MS = 500;
/** Maximum movement (px) tolerated during the long-press timer before we
 *  treat the gesture as a scroll instead of a long-press. */
const LONG_PRESS_SLOP_PX = 10;

/** xterm.js search addon decoration colors. The addon requires decorations to be
 *  set in order for `onDidChangeResults` to fire (which drives the "N of M"
 *  counter), so we always pass these in. Same palette VS Code uses for its
 *  terminal find: muted background highlight for all matches, brighter accent
 *  for the active match. Hex must be `#RRGGBB` (no alpha) per the addon's API. */
const SEARCH_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#a9913680",
  matchOverviewRuler: "#a9913680",
  activeMatchColorOverviewRuler: "#a99136",
} as const;

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

function toXtermSearchOptions(opts: SearchOptions): ISearchOptions {
  return {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    regex: opts.regex,
    decorations: SEARCH_DECORATIONS,
  };
}

/** xterm.js theme that follows the app's dark mode. Background/foreground use the
 *  same neutrals as the rest of the UI so the terminal blends into the panel. */
const DARK_TERMINAL_THEME: ITheme = {
  background: "#1e1e1e",
  foreground: "#e8e8e8",
  cursor: "#e8e8e8",
  selectionBackground: "rgba(255, 255, 255, 0.2)",
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0, 0, 0, 0.15)",
  // Tweak ANSI colors so they remain readable on a white background. The default
  // bright-yellow / bright-green xterm palette washes out badly in light mode.
  black: "#000000",
  red: "#cd3131",
  green: "#0a8043",
  yellow: "#946800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#0a8043",
  brightYellow: "#946800",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#1e1e1e",
};

function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark");
}

function getTerminalTheme(): ITheme {
  return isDarkMode() ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

export interface PaneMetadata {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

interface TerminalPanelProps {
  workspaceId: string;
  terminalId: string;
  visible: boolean;
  /** Optional metadata from workspace terminal config (command, cwd, env). */
  paneMetadata?: PaneMetadata;
  /** When true, auto-focus this terminal after it opens. */
  autoFocus?: boolean;
  /** Called when the terminal emits a title change (e.g. shell sets window title via escape sequence). */
  onTitleChange?: (title: string) => void;
}

export function TerminalPanel({
  workspaceId,
  terminalId,
  visible,
  paneMetadata,
  autoFocus,
  onTitleChange,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // Read the renderer preference and stash it in a ref. We *snapshot* the
  // value when the main mount effect runs — toggling the setting at runtime
  // should not tear down a live terminal session. The settings description
  // tells users to reopen the terminal for changes to take effect.
  // The ref is kept in sync each render so that any *next* mount of this
  // panel picks up the latest value (e.g. a tab close + reopen).
  const { settings } = useSettingsQuery();
  const useWebGLRenderer = settings.useWebGLTerminalRenderer ?? true;
  const useWebGLRendererRef = useRef(useWebGLRenderer);
  useWebGLRendererRef.current = useWebGLRenderer;

  // ---- Find-in-terminal state (Cmd+F / Ctrl+F) ----
  // Wires xterm.js's SearchAddon to the same SearchBar component used by
  // DiffView and FileBrowser. Decorations are required for the addon's
  // `onDidChangeResults` event to fire — that's what drives the "N of M"
  // counter, so we always pass them via `toXtermSearchOptions`.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [matchInfo, setMatchInfo] = useState<{ total: number; current: number }>({
    total: 0,
    current: 0,
  });
  const searchBarRef = useRef<SearchBarHandle>(null);
  // Stable ref for the xterm key-event closure (which is captured once at mount).
  const openSearchRef = useRef<() => void>(() => {});

  // ---- iOS keyboard accessory toolbar state ----
  // `terminalReady` flips once the dynamic-imported xterm.js instance is
  // attached and addons are loaded. We can't render TerminalToolbar before
  // then because it dereferences `terminalRef.current` directly (e.g. for
  // `hasSelection()`). Promoting the ref to state is overkill — a single
  // boolean is enough to trigger the re-render that paints the toolbar.
  const [terminalReady, setTerminalReady] = useState(false);
  // Sticky Ctrl modifier wired up to the toolbar. Ref mirrors state because
  // the xterm `attachCustomKeyEventHandler` closure is captured once at mount
  // and cannot read React state directly. `setPendingCtrl` from useState is a
  // stable identity, so reading it from inside the captured closure is safe.
  const pendingCtrlRef = useRef(false);
  const [pendingCtrl, setPendingCtrl] = useState(false);
  const handleToggleCtrl = useCallback(() => {
    const next = !pendingCtrlRef.current;
    pendingCtrlRef.current = next;
    setPendingCtrl(next);
  }, []);

  // Long-press → word-select → arrow-extend state.
  // `selectionAnchor` is the cell that stays fixed; `selectionHead` is the
  // moving cell the arrow buttons push around. Both are absolute buffer
  // coordinates (row includes scrollback offset). null = idle mode.
  // The refs mirror state for the same reason as pendingCtrl: the touch
  // handlers installed inside the mount effect capture once. The "enter"
  // path is inlined into the long-press timer callback in the mount effect
  // — it has more local context (the live terminal + screen element) than
  // a top-level callback could see without ref-routing every dependency.
  const selectionAnchorRef = useRef<Cell | null>(null);
  const selectionHeadRef = useRef<Cell | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const exitSelectionMode = useCallback(() => {
    selectionAnchorRef.current = null;
    selectionHeadRef.current = null;
    setSelectionMode(false);
    terminalRef.current?.clearSelection();
  }, []);
  const handleExtendSelection = useCallback((direction: ArrowDirection) => {
    const terminal = terminalRef.current;
    const anchor = selectionAnchorRef.current;
    const head = selectionHeadRef.current;
    if (!terminal || !anchor || !head) return;
    const next = moveCell(head, direction, terminal);
    selectionHeadRef.current = next;
    applySelection(terminal, anchor, next);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    // Dynamic import so @xterm (CJS) is never evaluated during SSR.
    // WebGL addon is imported unconditionally — it's small and we want
    // it available for the onContextLoss reload path.
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/addon-search"),
      import("@xterm/addon-webgl"),
    ]).then(([xtermMod, fitMod, webLinksMod, searchMod, webglMod]) => {
      const { Terminal: XTerm } = xtermMod;
      const { FitAddon: XFitAddon } = fitMod;
      const { WebLinksAddon: XWebLinksAddon } = webLinksMod;
      const { SearchAddon: XSearchAddon } = searchMod;
      const { WebglAddon: XWebglAddon } = webglMod;
      if (cancelled || !containerRef.current) return;
      const wantsWebGL = useWebGLRendererRef.current;

      // CSS loaded on client only
      import("@xterm/xterm/css/xterm.css");

      const terminal = new XTerm({
        // Opt in to addon-only APIs (decorations, markers, etc.) that
        // xterm.js 6.1-beta gates behind this flag. Without it, the search
        // addon's `findNext` throws "You must set the allowProposedApi
        // option to true to use proposed API" the first time the user
        // types in the find bar. The addons we ship (search, webgl) are
        // first-party xterm.js addons that depend on these APIs.
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        // iTerm-style row spacing — only safe with the WebGL renderer.
        // The WebGL addon redraws box-drawing (U+2500-U+257F), block
        // elements (U+2580-U+259F), powerline separators, and other
        // continuous glyphs at the full cell rect (via its `customGlyphs`
        // option, default true) so a 1.2 lineHeight doesn't slice horizontal
        // gaps through the opencode banner, claude-code's powerline
        // statusline, or other ASCII art. xterm.js's DOM renderer does
        // NOT do this — falling back to it means we have to revert to
        // lineHeight: 1.0 to keep block art continuous.
        // See https://github.com/band-app/band/issues/391 for history.
        lineHeight: wantsWebGL ? 1.2 : 1.0,
        macOptionIsMeta: true, // Alt+Left/Right → word navigation on macOS
        scrollback: 10000,
        theme: getTerminalTheme(),
      });

      // Keep the terminal palette in sync with the app theme. ThemeSync toggles
      // the "dark" class on <html>; we mirror that onto xterm at runtime.
      const themeObserver = new MutationObserver(() => {
        terminal.options.theme = getTerminalTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });

      const fitAddon = new XFitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new XWebLinksAddon((_event, uri) => openExternalUrl(uri)));
      terminal.open(containerRef.current!);

      // Swap the default DOM renderer for the GPU-accelerated WebGL renderer
      // (when the user setting allows it and a WebGL2 context is available).
      // Must happen *after* `terminal.open()` because the addon needs the
      // attached DOM node to size its <canvas>. devicePixelRatio is handled
      // internally — retina displays render crisply.
      //
      // Browsers occasionally drop the WebGL context (tab discard, GPU process
      // restart, etc.); xterm.js fires `onContextLoss` in that case and the
      // recommended recovery is to dispose the addon and load a fresh one.
      // If the initial `loadAddon` throws (no WebGL2, headless env, exotic
      // hardware), we leave the DOM renderer in place rather than break the
      // panel — the setting description warns users that fallback is silent.
      let webglContextLossDisposable: { dispose(): void } | undefined;
      const attachWebGL = (): boolean => {
        try {
          const addon = new XWebglAddon({ customGlyphs: true });
          terminal.loadAddon(addon);
          // The WebGL addon appends a <canvas> to `.xterm-screen` and only sets
          // width/height — no `pointer-events` or `touch-action`. That canvas
          // sits on top of `.xterm-helper-textarea`, the hidden element xterm.js
          // uses to receive keyboard focus and synthesize taps. On iOS Safari
          // the opaque canvas swallows every touch: taps never reach the helper
          // textarea (so the soft keyboard never appears), our drag-to-scroll
          // handler doesn't fire reliably, and long-press selection is dead.
          // The canvas is purely a render target — it never needs DOM events —
          // so disable pointer/touch handling on it. We re-run this on every
          // `attachWebGL()` invocation so the `onContextLoss` recovery path
          // (which appends a fresh canvas) doesn't reintroduce the regression.
          const screenEl = containerRef.current?.querySelector(
            ".xterm-screen",
          ) as HTMLElement | null;
          const webglCanvas = screenEl?.querySelector(
            ":scope > canvas:last-of-type",
          ) as HTMLCanvasElement | null;
          if (webglCanvas) {
            webglCanvas.style.pointerEvents = "none";
            webglCanvas.style.touchAction = "none";
          }
          webglAddonRef.current = addon;
          webglContextLossDisposable?.dispose();
          webglContextLossDisposable = addon.onContextLoss(() => {
            console.warn("[TerminalPanel] WebGL context lost, reattaching addon");
            addon.dispose();
            webglAddonRef.current = null;
            // Try once to re-establish; if it also fails, stay on DOM renderer.
            attachWebGL();
          });
          return true;
        } catch (err) {
          console.warn("[TerminalPanel] WebGL renderer unavailable, falling back to DOM", err);
          return false;
        }
      };
      if (wantsWebGL) attachWebGL();

      // Find-in-terminal. The SearchAddon scans the entire scrollback buffer
      // and uses xterm.js's decoration API to highlight matches — works with
      // the canvas renderer because decorations are renderer-agnostic.
      const searchAddon = new XSearchAddon();
      terminal.loadAddon(searchAddon);
      const searchResultsDisposable = searchAddon.onDidChangeResults((event) => {
        // resultIndex is -1 when the match count exceeds the addon's
        // highlightLimit (default 1000). Show "N matches" then.
        setMatchInfo({
          total: event.resultCount,
          current: event.resultIndex >= 0 ? event.resultIndex + 1 : 0,
        });
      });

      // Custom key bindings:
      // - Cmd/Ctrl+F  → open find bar (intercept before xterm and before the
      //                 browser's native find-in-page in non-Electron contexts)
      // - Shift+Enter → CSI u sequence so shells/tools receive a distinct keycode
      // - Alt+Arrow   → word navigation (ESC+b / ESC+f)
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown") {
          // Pending Ctrl (set by the iOS toolbar's sticky Ctrl button): the
          // user already tapped "Ctrl" once; transform the next single
          // printable key into a Ctrl+key control character. Letters a..z map
          // to 0x01..0x1A, the same byte the desktop renderer would emit for
          // Ctrl+A..Ctrl+Z. Anything outside that range silently clears the
          // pending flag (consistent with how a real Ctrl modifier behaves on
          // a hardware keyboard — Ctrl+5 just sends `5`).
          if (
            pendingCtrlRef.current &&
            e.key.length === 1 &&
            !e.metaKey &&
            !e.altKey &&
            !e.ctrlKey
          ) {
            const lower = e.key.toLowerCase();
            const code = lower.charCodeAt(0);
            if (code >= 97 && code <= 122) {
              terminal.input(String.fromCharCode(code - 96));
              pendingCtrlRef.current = false;
              // Schedule the state update so React renders the un-armed
              // button — we're inside a non-React event handler.
              setPendingCtrl(false);
              e.preventDefault();
              return false;
            }
            // Non-letter printable: just clear the pending modifier and let
            // the key go through unmodified. This matches "armed-and-dismiss"
            // behavior in Termius / Blink.
            pendingCtrlRef.current = false;
            setPendingCtrl(false);
          }
          // Cmd+F (macOS) / Ctrl+F (Linux/Windows) → open the find bar.
          // Call preventDefault so the browser doesn't open native find-in-page
          // alongside our overlay (no-op in Electron, important in the web app).
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            openSearchRef.current();
            return false;
          }
          // Shift+Enter → send CSI 13;2u (kitty/fixterms keyboard protocol)
          if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            terminal.input("\x1b[13;2u");
            return false;
          }
          if (e.altKey && !e.metaKey && !e.ctrlKey) {
            if (e.key === "ArrowLeft") {
              terminal.input("\x1bb");
              return false;
            }
            if (e.key === "ArrowRight") {
              terminal.input("\x1bf");
              return false;
            }
          }
        }
        return true;
      });

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      // Trigger a re-render so the iOS keyboard accessory toolbar (which
      // dereferences `terminalRef.current`) can mount. We deliberately wait
      // until *after* the addons are loaded so `hasSelection()` etc. behave.
      setTerminalReady(true);

      // Mobile touch scrolling. xterm renders `.xterm-screen` (canvas/dom) on top
      // of the scrollable `.xterm-viewport`, so touches on the visible terminal
      // never reach the scroll layer in iOS Safari and native finger-scroll fails.
      // Translate vertical touch drags into `terminal.scrollLines()` calls so the
      // user can pull up/down to scroll back through history.
      const containerEl = containerRef.current!;
      let lastTouchY: number | null = null;
      const onTouchStart = (e: TouchEvent) => {
        lastTouchY = e.touches.length === 1 ? e.touches[0].clientY : null;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length !== 1 || lastTouchY === null) return;
        const currentY = e.touches[0].clientY;
        const deltaY = lastTouchY - currentY;
        // Estimate the cell height from the rendered viewport so the scroll
        // speed matches finger movement at any font size / DPR.
        const viewport = containerEl.querySelector(".xterm-viewport") as HTMLElement | null;
        const cellHeight =
          viewport && terminal.rows > 0 ? viewport.clientHeight / terminal.rows : 17;
        const lineDelta = Math.trunc(deltaY / cellHeight);
        if (lineDelta !== 0) {
          terminal.scrollLines(lineDelta);
          // Carry the unconsumed sub-line remainder into the next move so
          // slow drags still accumulate instead of being rounded away.
          lastTouchY = currentY + (deltaY - lineDelta * cellHeight);
          e.preventDefault();
        }
      };
      const onTouchEnd = () => {
        lastTouchY = null;
      };
      containerEl.addEventListener("touchstart", onTouchStart, { passive: true });
      containerEl.addEventListener("touchmove", onTouchMove, { passive: false });
      containerEl.addEventListener("touchend", onTouchEnd, { passive: true });
      containerEl.addEventListener("touchcancel", onTouchEnd, { passive: true });

      // Long-press → word-select. Sets a timer on touchstart; cancels on any
      // significant movement (so a scroll drag wins) or early lift. When it
      // fires we resolve the touch point into a buffer cell, read the line
      // text, expand to word boundaries, and tell the toolbar to switch into
      // selection mode. From that point the toolbar's arrows extend the
      // highlighted range.
      //
      // Implementation note: we read the .xterm-screen element fresh each
      // time. xterm.js destroys and rebuilds it on certain renderer switches,
      // so caching it at mount could leave us pointing at a detached node.
      let longPressTimer: number | null = null;
      let longPressStart: { x: number; y: number } | null = null;
      const cancelLongPress = () => {
        if (longPressTimer !== null) {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        longPressStart = null;
      };
      const onLongPressStart = (e: TouchEvent) => {
        cancelLongPress();
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        longPressStart = { x: t.clientX, y: t.clientY };
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          const start = longPressStart;
          if (!start) return;
          const screenEl = containerEl.querySelector(".xterm-screen") as HTMLElement | null;
          if (!screenEl) return;
          const cell = pointToCell(start.x, start.y, terminal, screenEl);
          const lineText = getLineText(terminal, cell.row);
          const { anchor, head } = wordSelectionAt(cell, lineText);
          applySelection(terminal, anchor, head);
          selectionAnchorRef.current = anchor;
          selectionHeadRef.current = head;
          setSelectionMode(true);
          // Suppress the tap-to-focus that would otherwise fire when the
          // finger lifts (we don't want the iOS keyboard to pop open right
          // after the user just made a selection).
          tapStartX = null;
          tapStartY = null;
          // Light haptic — feels native, no-op where unsupported (desktop,
          // most non-iOS browsers). Wrapped in typeof check because the
          // Vibration API isn't in lib.dom.d.ts on all TS versions.
          if (typeof navigator.vibrate === "function") {
            try {
              navigator.vibrate(15);
            } catch {
              // Some browsers throw if vibration is policy-blocked; ignore.
            }
          }
        }, LONG_PRESS_MS);
      };
      const onLongPressMove = (e: TouchEvent) => {
        if (!longPressStart || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - longPressStart.x);
        const dy = Math.abs(t.clientY - longPressStart.y);
        if (dx > LONG_PRESS_SLOP_PX || dy > LONG_PRESS_SLOP_PX) cancelLongPress();
      };
      containerEl.addEventListener("touchstart", onLongPressStart, { passive: true });
      containerEl.addEventListener("touchmove", onLongPressMove, { passive: true });
      containerEl.addEventListener("touchend", cancelLongPress, { passive: true });
      containerEl.addEventListener("touchcancel", cancelLongPress, { passive: true });

      // Mobile focus-on-tap. Disabling `pointer-events` on the WebGL canvas
      // (see `attachWebGL` above) lets touches reach `.xterm-screen`, but
      // xterm.js's built-in click→focus path doesn't reliably re-engage the
      // iOS soft keyboard in two scenarios:
      //   1. Split terminals — tapping another panel needs to move focus to
      //      that panel's `.xterm-helper-textarea`, but the synthesized click
      //      via the canvas+pointer-events-none layout doesn't always trigger
      //      xterm's internal focus call.
      //   2. After the user taps "Done" on the soft keyboard, the textarea is
      //      blurred. iOS only re-opens the keyboard when `.focus()` is called
      //      synchronously inside a user gesture.
      // Bind our own touchstart/touchend that explicitly calls
      // `terminal.focus()` on taps (touches that release within ~10px of where
      // they started). Larger movements are scroll drags handled by the scroll
      // handler above — we deliberately skip focus there so a flick-to-scroll
      // doesn't accidentally pop the keyboard.
      let tapStartX: number | null = null;
      let tapStartY: number | null = null;
      const onTapStart = (e: TouchEvent) => {
        if (e.touches.length === 1) {
          tapStartX = e.touches[0].clientX;
          tapStartY = e.touches[0].clientY;
        } else {
          tapStartX = null;
          tapStartY = null;
        }
      };
      const onTapEnd = (e: TouchEvent) => {
        const startX = tapStartX;
        const startY = tapStartY;
        tapStartX = null;
        tapStartY = null;
        if (startX === null || startY === null || e.changedTouches.length !== 1) return;
        const dx = Math.abs(e.changedTouches[0].clientX - startX);
        const dy = Math.abs(e.changedTouches[0].clientY - startY);
        if (dx < 10 && dy < 10) {
          // Tap during selection mode: exit selection. iOS users expect a
          // tap outside the selection to dismiss the edit menu; ours behaves
          // the same. The toolbar's own buttons sit in a fixed-position
          // overlay outside containerEl so their taps don't reach this
          // handler.
          if (selectionAnchorRef.current !== null) {
            selectionAnchorRef.current = null;
            selectionHeadRef.current = null;
            setSelectionMode(false);
            terminal.clearSelection();
          }
          terminal.focus();
        }
      };
      const onTapCancel = () => {
        tapStartX = null;
        tapStartY = null;
      };
      containerEl.addEventListener("touchstart", onTapStart, { passive: true });
      containerEl.addEventListener("touchend", onTapEnd, { passive: true });
      containerEl.addEventListener("touchcancel", onTapCancel, { passive: true });

      // Connect WebSocket
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${location.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(terminalId)}`,
      );
      wsRef.current = ws;

      // Binary frames = PTY data, text frames = JSON control messages (e.g. title updates)
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        // Send init message with pane metadata (command, cwd, env) if available.
        // The server uses this to configure the PTY on first spawn.
        if (paneMetadata && (paneMetadata.command || paneMetadata.cwd || paneMetadata.env)) {
          const initMsg: Record<string, unknown> = { type: "init" };
          if (paneMetadata.command) initMsg.command = paneMetadata.command;
          if (paneMetadata.cwd) initMsg.cwd = paneMetadata.cwd;
          if (paneMetadata.env) initMsg.env = paneMetadata.env;
          ws.send(JSON.stringify(initMsg));
        }

        fitAddon.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );

        // Auto-focus this terminal if requested
        if (autoFocus) {
          terminal.focus();
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary frame = raw PTY output
          terminal.write(new Uint8Array(event.data));
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === "title" && typeof msg.title === "string") {
              onTitleChangeRef.current?.(msg.title);
            }
          } catch {
            // Not valid JSON — write as-is (shouldn't happen)
            terminal.write(event.data);
          }
        }
      };

      ws.onclose = () => {
        terminal.write("\r\n\x1b[90m[Terminal disconnected]\x1b[0m\r\n");
      };

      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Propagate shell title changes (e.g. running command, cwd) to the tab
      terminal.onTitleChange((title) => {
        onTitleChangeRef.current?.(title);
      });

      // Auto-fit on container resize (skip zero-size to avoid killing server PTY)
      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN && terminal.cols > 0 && terminal.rows > 0) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
        }
      });
      resizeObserver.observe(containerRef.current!);

      cleanup = () => {
        themeObserver.disconnect();
        resizeObserver.disconnect();
        searchResultsDisposable.dispose();
        webglContextLossDisposable?.dispose();
        cancelLongPress();
        containerEl.removeEventListener("touchstart", onTouchStart);
        containerEl.removeEventListener("touchmove", onTouchMove);
        containerEl.removeEventListener("touchend", onTouchEnd);
        containerEl.removeEventListener("touchcancel", onTouchEnd);
        containerEl.removeEventListener("touchstart", onLongPressStart);
        containerEl.removeEventListener("touchmove", onLongPressMove);
        containerEl.removeEventListener("touchend", cancelLongPress);
        containerEl.removeEventListener("touchcancel", cancelLongPress);
        containerEl.removeEventListener("touchstart", onTapStart);
        containerEl.removeEventListener("touchend", onTapEnd);
        containerEl.removeEventListener("touchcancel", onTapCancel);
        ws.close();
        // `terminal.dispose()` cascades to all loaded addons (including the
        // WebGL addon if present), so we don't need to dispose it manually.
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        webglAddonRef.current = null;
        wsRef.current = null;
        setTerminalReady(false);
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [terminalId, workspaceId, paneMetadata, autoFocus]);

  // Refit when visibility changes and notify server of new size
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        const term = terminalRef.current;
        const ws = wsRef.current;
        if (term && ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
    }
  }, [visible]);

  // Listen for the workspace-level ⌃` "focus Terminal" event. Many
  // TerminalPanel instances may exist (one per terminal session × one
  // per workspace) — the visibility gate ensures only the active
  // session in the active workspace actually grabs focus.
  useEffect(() => {
    const handler = () => {
      if (!visible) return;
      terminalRef.current?.focus();
    };
    window.addEventListener("band:focus-terminal", handler);
    return () => window.removeEventListener("band:focus-terminal", handler);
  }, [visible]);

  // ---- Find-in-terminal handlers ----
  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus + select-all on next frame so re-pressing Cmd+F re-uses the prior query.
    requestAnimationFrame(() => {
      searchBarRef.current?.focus();
      searchBarRef.current?.select();
    });
  }, []);
  // Keep the xterm key-event closure pointed at the latest handler.
  openSearchRef.current = handleOpenSearch;

  const handleCloseSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchQuery("");
    setMatchInfo({ total: 0, current: 0 });
    terminalRef.current?.focus();
  }, []);

  const handleNext = useCallback(() => {
    if (!searchQuery) return;
    searchAddonRef.current?.findNext(searchQuery, toXtermSearchOptions(searchOptions));
  }, [searchQuery, searchOptions]);

  const handlePrevious = useCallback(() => {
    if (!searchQuery) return;
    searchAddonRef.current?.findPrevious(searchQuery, toXtermSearchOptions(searchOptions));
  }, [searchQuery, searchOptions]);

  // Re-run the search whenever the query or options change. xterm.js's search
  // addon does its own debouncing internally for decoration rendering, but
  // we don't add extra debounce here — typical scrollback (10k lines) scans
  // in <5ms. Empty query clears decorations.
  useEffect(() => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!searchQuery) {
      addon.clearDecorations();
      setMatchInfo({ total: 0, current: 0 });
      return;
    }
    addon.findNext(searchQuery, toXtermSearchOptions(searchOptions));
  }, [searchQuery, searchOptions]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {searchOpen && (
        <SearchBar
          ref={searchBarRef}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          options={searchOptions}
          onOptionsChange={setSearchOptions}
          placeholder="Find in terminal..."
          matchInfo={matchInfo}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onClose={handleCloseSearch}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-2 overflow-hidden" />
      </div>
      {/* iOS / touch keyboard accessory toolbar. Renders nothing on desktop
          (gated by `useVirtualKeyboardToolbar`). Sits in `position: fixed`
          relative to the visual viewport so it floats just above the soft
          keyboard when open and pins to the screen bottom otherwise. */}
      {terminalReady && terminalRef.current && (
        <TerminalToolbar
          terminal={terminalRef.current}
          sendInput={(data) => {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN) ws.send(data);
          }}
          pendingCtrl={pendingCtrl}
          onToggleCtrl={handleToggleCtrl}
          selectionMode={selectionMode}
          onExtendSelection={handleExtendSelection}
          onExitSelection={exitSelectionMode}
        />
      )}
    </div>
  );
}
