import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { SearchOptions } from "@/dashboard";
import { listen as desktopListen } from "./desktop-ipc";
import { HubWebSocket, hubWsUrl } from "./hub-config";
import { isDesktop } from "./is-desktop";
import { openExternalUrl } from "./open-external-url";
import { createTerminalFileLinkProvider } from "./terminal-file-links";
import { createTerminalInputQueue } from "./terminal-input-queue";
import { trackMouseEncoding } from "./terminal-mouse-report";
import { attachTerminalMouseWheel } from "./terminal-mouse-wheel";
import { createTerminalOutputQueue } from "./terminal-output-queue";
import {
  selectIdsBeyondHotRetain,
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_LIMIT,
  TERMINAL_TAB_HOT_RETAIN_MS,
} from "./terminal-park-policy";
import { getParkingContainer } from "./terminal-parking";
import {
  type ArrowDirection,
  applySelection,
  type Cell,
  getLineText,
  moveCell,
  pointToCell,
  wordSelectionAt,
} from "./terminal-selection";
import { ownerOfTerminal } from "./terminal-split-registry";
import { attachTerminalTouchScroll } from "./terminal-touch-scroll";
import {
  noteTypingLatencyDispatch,
  noteTypingLatencyOutput,
  registerTypingLatencyTerminal,
} from "./terminal-typing-latency";
import { isWorktreeColdParked, subscribeWorktreeColdPark } from "./worktree-cold-park";
import { getCurrentZoomLevel, subscribeToZoomChanges } from "./zoom";

// ---------------------------------------------------------------------------
// Persistent per-terminal xterm cache with a DOM "parking" model.
//
// Each terminal keeps ONE live xterm instance for the lifetime of its cache
// entry, `open()`ed into a persistent wrapper <div>. That wrapper is *moved*
// between the visible panel container (`attach`) and a shared off-screen parking
// container (`detach`, see `terminal-parking.ts`) — it is never disposed on a
// worktree/tab switch and its React subtree owning it can mount/unmount freely.
//
// This replaces the old model where `TerminalPanel` owned the xterm and
// `MultiWorktreePanelHost` hid inactive terminals in place under
// `content-visibility: hidden`, which dropped the WebGL backing store and
// produced garbled frames on switch-back that only a manual resize fixed
// (band-app/band#615). Parking keeps the surface in a normal-visibility,
// still-painted subtree, so an ordinary switch/foreground/click does a CHEAP
// fit + refresh on re-attach and reuses the live WebGL surface (no rebuild, no
// flicker). The addon is rebuilt only on genuine GPU loss — a `webglcontextlost`
// event (`onContextLoss`) or a desktop `system-resumed` wake.
//
// The entry owns everything terminal-scoped: the xterm + addons, the WebSocket
// with its reconnect/heartbeat machinery, the ResizeObserver, the zoom/DPR
// handlers, the touch gesture handlers, and the small observable UI-state store
// (search / selection / sticky-Ctrl / title / terminated) that the thin React
// `TerminalPanel` view subscribes to via `useSyncExternalStore`.
// ---------------------------------------------------------------------------

/** Base xterm font size at zoom = 1.0 (see `TerminalPanel`'s counter-zoom box
 *  and band-app/band#463 for why the terminal is driven by `fontSize` rather
 *  than CSS `zoom`). */
const BASE_FONT_SIZE = 13;

/** How long a finger must rest on the terminal to trigger word-selection. */
const LONG_PRESS_MS = 500;
/** Max movement (px) tolerated during the long-press timer before we treat the
 *  gesture as a scroll instead of a long-press. */
const LONG_PRESS_SLOP_PX = 10;

/** xterm.js search addon decoration colors — VS Code's terminal-find palette.
 *  Decorations must be set for `onDidChangeResults` to fire (drives the counter). */
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

// The `background` values are mirrored as `--terminal-background` in
// styles/globals.css (dark and light); change both together.
const DARK_TERMINAL_THEME: ITheme = {
  background: "#1e1e1e",
  foreground: "#e8e8e8",
  cursor: "#e8e8e8",
  selectionBackground: "rgba(255, 255, 255, 0.2)",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0, 0, 0, 0.15)",
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

// WebSocket heartbeat / reconnect tuning (identical to the old TerminalPanel).
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** How long the client suppresses container-driven refits while waiting for a
 *  replay snapshot after an `attach` request. A safety valve only: the server
 *  acks every attach (even an empty snapshot), so this fires solely if that
 *  ack is lost, after which normal live resizing resumes. */
const REPLAY_GUARD_TIMEOUT_MS = 3_000;

/** Number of animation frames `attach` will re-poll for a non-zero live box
 *  before giving up (the panel may be 0×0 for a frame right after mount). */
const MAX_LAYOUT_FRAMES = 5;

// A switched-away terminal is only PARKED (its wrapper moved off-screen, socket
// + buffer intact) and is reused on return (band-app/band#617). Terminals are
// disposed only when: the pane is closed, the worktree is deleted
// (`reconcileTerminalWorktrees`), or the renderer policy in
// `terminal-park-policy.ts` cold-parks a terminal that has been hidden long
// enough (see `runParkingPass`). A cold-parked terminal's PTY survives on the
// server; revealing it creates a fresh entry that reconnects and replays.
//
// WebGL contexts: Chromium caps live contexts per page (16 by default) and
// drops the oldest when a new one is created. Each warm terminal keeps its
// context while parked, and the policy's warm set is larger than 16: up to 6
// hidden terminals in each of 4 warm hidden worktrees plus the active
// worktree's, and more during the 30 s grace window. The desktop app raises
// the cap to 128 (`max-active-webgl-contexts` in `apps/desktop/src/main/
// index.ts`); in a plain browser a large working set does lose contexts. That is not fatal: `onContextLoss` disposes the addon; a
// parked terminal is only marked suspect and rebuilds on its next `attach`, and
// only an attached one rebuilds at once, so a loss costs one glyph re-raster on
// reveal. There is deliberately no user setting for this.

export interface PaneMetadata {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export interface CreateOptions {
  worktreeId: string;
  paneMetadata?: PaneMetadata;
  /** WebGL renderer preference, snapshotted at create time. */
  useWebGL: boolean;
  /** Focus the terminal on its first successful connect. */
  autoFocus?: boolean;
}

/** Reactive UI state the React view mirrors via `useSyncExternalStore`. Replaced
 *  by a fresh object on every change so `Object.is` sees the delta. */
export interface TerminalUiState {
  /** xterm + addons loaded and opened. */
  ready: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchOptions: SearchOptions;
  matchInfo: { total: number; current: number };
  selectionMode: boolean;
  pendingCtrl: boolean;
  /** Shell exited / socket closed 1000 — pane kept, no reconnect (#617). */
  terminated: boolean;
}

const INITIAL_STATE: TerminalUiState = {
  ready: false,
  searchOpen: false,
  searchQuery: "",
  searchOptions: DEFAULT_SEARCH_OPTIONS,
  matchInfo: { total: 0, current: 0 },
  selectionMode: false,
  pendingCtrl: false,
  terminated: false,
};

export interface TerminalCacheEntry {
  readonly terminalId: string;
  readonly worktreeId: string;
  /** Live xterm instance, or null until the async addon load finishes. */
  readonly getTerminal: () => Terminal | null;

  // --- lifecycle (move the persistent wrapper between DOM containers) ---
  attach(liveContainer: HTMLElement, opts?: { autoFocus?: boolean }): void;
  detach(): void;

  // --- parking policy bookkeeping (see `runParkingPass`) ---
  /** Epoch ms since this terminal was last detached (or created parked); null
   *  while attached. */
  getHiddenSince(): number | null;
  /** Monotonic attach counter; breaks hidden-time ties between terminals
   *  hidden in the same pass (a worktree switch hides them all at once). */
  getActivatedSeq(): number;
  /** True while attached to a live (visible) container — never disposed by
   *  the parking policy. */
  isAttached(): boolean;
  /** True once disposed. A mounted-but-hidden panel holding this entry can
   *  detect a cold park and re-resolve a fresh entry on becoming visible. */
  isDestroyed(): boolean;

  // --- reactive state for the React view ---
  subscribe(listener: () => void): () => void;
  getSnapshot(): TerminalUiState;

  // --- imperative handlers wired to the React overlays ---
  openSearch(): void;
  closeSearch(): void;
  setSearchQuery(query: string): void;
  setSearchOptions(options: SearchOptions): void;
  findNext(): void;
  findPrevious(): void;
  toggleCtrl(): void;
  extendSelection(direction: ArrowDirection): void;
  exitSelection(): void;
  selectAll(): void;
  sendInput(data: string): void;
  isSocketOpen(): boolean;
  focus(): void;
  /** Fires after every successful (re)connect; used to flush buffered input. */
  subscribeConnect(listener: () => void): () => void;
  /** Registers the tab-title sink; replays the last known title immediately. */
  registerTitleListener(listener: (title: string) => void): () => void;

  /** @internal disposal — call via the module-level `disposeTerminal`. */
  _destroy(): void;
}

// ---------------------------------------------------------------------------
// Module-level cache, stashed on globalThis so Vite HMR keeps live terminals.
// ---------------------------------------------------------------------------

const CACHE_KEY = "__bandTerminalCache__";

interface CacheGlobal {
  [CACHE_KEY]?: Map<string, TerminalCacheEntry>;
}

function getCache(): Map<string, TerminalCacheEntry> {
  const store = globalThis as unknown as CacheGlobal;
  if (!store[CACHE_KEY]) store[CACHE_KEY] = new Map();
  return store[CACHE_KEY];
}

// ---------------------------------------------------------------------------
// Entry factory
// ---------------------------------------------------------------------------

function createEntry(terminalId: string, opts: CreateOptions): TerminalCacheEntry {
  const { worktreeId, paneMetadata, useWebGL, autoFocus } = opts;

  // Persistent wrapper the xterm opens into. Created synchronously so `attach`
  // can move it into the DOM before the async addon load resolves. Fills its
  // parent (the live box or the parking container) and carries the counter-zoom
  // that keeps xterm's hit-testing in unzoomed pixel space (band-app/band#463).
  const wrapper = document.createElement("div");
  wrapper.dataset.testid = "terminal-wrapper";
  // Stable identity so integration tests can locate this terminal's render
  // surface whether it's attached to a live panel or parked off-screen (the
  // panel-host-scoped surface probes can't see a parked wrapper).
  wrapper.dataset.terminalId = terminalId;
  wrapper.dataset.worktreeId = worktreeId;
  wrapper.style.position = "absolute";
  wrapper.style.inset = "0";
  wrapper.style.overflow = "hidden";
  // Counter-zoom out of the document-level CSS `zoom` so xterm's hit-testing
  // runs in unzoomed pixels (band-app/band#463). `setProperty` avoids relying on
  // `zoom` being present in the TS `CSSStyleDeclaration` typings.
  wrapper.style.setProperty("zoom", "calc(1 / var(--app-zoom, 1))");
  // Start parked so a terminal created for a not-yet-visible panel is warm.
  getParkingContainer().appendChild(wrapper);

  // Reactive state store.
  let state: TerminalUiState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  const setState = (patch: Partial<TerminalUiState>) => {
    state = { ...state, ...patch };
    notify();
  };

  const connectListeners = new Set<() => void>();
  let titleListener: ((title: string) => void) | null = null;
  let lastTitle: string | null = null;
  const emitTitle = (title: string) => {
    lastTitle = title;
    titleListener?.(title);
  };

  // Live references filled once the async load resolves.
  let terminal: Terminal | null = null;
  let searchAddon: SearchAddon | null = null;
  let webglAddon: WebglAddon | null = null;
  let ws: WebSocket | null = null;
  // Every write to the socket's input side goes through here, so bursts of
  // small writes become one message (terminal-input-queue.ts).
  const inputQueue = createTerminalInputQueue((data) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data);
    return true;
  });

  // Attach/parking state.
  let liveContainer: HTMLElement | null = null;
  let attached = false;
  let autoFocusPending = autoFocus ?? paneMetadata?.focus ?? false;
  // Parking policy clocks. A new entry starts parked, so it is hidden from now.
  let hiddenSince: number | null = Date.now();
  let activatedSeq = 0;

  // WebGL "surface may be corrupted" flag. The GPU can corrupt the glyph
  // atlas and the renderer's buffers (display sleep / screen unlock, texture
  // memory pressure), and a damaged surface cannot be repaired in place —
  // `clearTextureAtlas` + full refresh still redraws the damage. The only
  // reliable repair is disposing and recreating the WebGL addon (fresh
  // context, buffers, atlas), which `repairAndFit` does whenever this flag is
  // set. Set only on GENUINE loss signals: a desktop `system-resumed` wake
  // (`handleSurfaceMayBeCorrupt`), an off-screen `onContextLoss`, and a
  // parked DPR/zoom change (`remeasureAndReattach`, whose new metrics need a
  // fresh atlas). Ordinary foreground/switch-back/click deliberately do NOT
  // set it — a still-painted parked surface keeps its context, so those do a
  // cheap fit + refresh instead (rebuilding there raced the compositor and
  // flickered). The rebuild costs a few ms of glyph rasterization.
  let webglSuspect = false;
  // Epoch ms of the last WebGL addon build (initial load, DPR/zoom rebuild,
  // or suspect repair). Lets the focus-driven repair below skip a rebuild
  // that another path performed moments earlier (e.g. the auto-focus right
  // after the first attach) instead of paying for a second context + atlas.
  let lastWebglBuildAt = 0;

  // Selection (long-press → word-select → arrow-extend) state.
  let selectionAnchor: Cell | null = null;
  let selectionHead: Cell | null = null;

  let destroyed = false;
  let cleanup: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Async xterm + addon load. Everything terminal-scoped is set up here; the
  // returned `cleanup` tears it all down in `_destroy`.
  // -------------------------------------------------------------------------
  Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-search"),
    import("@xterm/addon-webgl"),
    import("@xterm/addon-unicode11"),
  ]).then(([xtermMod, fitMod, webLinksMod, searchMod, webglMod, unicode11Mod]) => {
    if (destroyed) return;
    const { Terminal: XTerm } = xtermMod;
    const { FitAddon: XFitAddon } = fitMod;
    const { WebLinksAddon: XWebLinksAddon } = webLinksMod;
    const { SearchAddon: XSearchAddon } = searchMod;
    const { WebglAddon: XWebglAddon } = webglMod;
    const { Unicode11Addon: XUnicode11Addon } = unicode11Mod;

    import("@xterm/xterm/css/xterm.css");

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: BASE_FONT_SIZE * getCurrentZoomLevel(),
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      // 1.2 row spacing is only safe under WebGL (redraws continuous glyphs at
      // full cell rect); the DOM renderer needs 1.0 to keep box art continuous.
      lineHeight: useWebGL ? 1.2 : 1.0,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: getTerminalTheme(),
      // Orca's scrollback wheel speed. Alt+wheel's 5x is xterm's default.
      scrollSensitivity: 1.15,
    });
    terminal = term;
    // All output reaches xterm through this queue: paced while the terminal is
    // visible, budgeted while it is parked (terminal-output-queue.ts).
    const output = createTerminalOutputQueue((data, onParsed) => term.write(data, onParsed));

    const themeObserver = new MutationObserver(() => {
      term.options.theme = getTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Unicode 11 width tables, so emoji like U+1F7E0 take two cells as they
    // do in the PTY's own wcwidth. The xterm default (Unicode 6) counts them
    // as one and the next character overlaps the emoji. The server's headless
    // mirror uses the same version (`terminal-pool.ts`) so replayed screens
    // keep the same cursor columns.
    term.loadAddon(new XUnicode11Addon());
    term.unicode.activeVersion = "11";

    const fit = new XFitAddon();
    term.loadAddon(fit);
    // Pixel size of the live box at the last fit. A reveal whose box kept its
    // size skips the fit (see `repairAndFit`).
    let lastFitBox: { width: number; height: number } | null = null;
    const fitToBox = () => {
      fit.fit();
      lastFitBox = liveContainer
        ? { width: liveContainer.clientWidth, height: liveContainer.clientHeight }
        : null;
    };
    const boxResizedSinceFit = (): boolean =>
      !lastFitBox ||
      !liveContainer ||
      liveContainer.clientWidth !== lastFitBox.width ||
      liveContainer.clientHeight !== lastFitBox.height;
    term.loadAddon(new XWebLinksAddon((_event, uri) => openExternalUrl(uri)));

    const fileLinkProviderDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider(term, (filename) => {
        window.dispatchEvent(
          new CustomEvent("band:open-file", { detail: { filename, worktreeId } }),
        );
      }),
    );

    term.open(wrapper);

    // --- WebGL renderer with context-loss recovery ---
    let webglContextLossDisposable: { dispose(): void } | undefined;
    const attachWebGL = (): boolean => {
      try {
        const addon = new XWebglAddon({ customGlyphs: true });
        term.loadAddon(addon);
        // Disable pointer/touch on the WebGL <canvas> so iOS taps reach the
        // hidden helper textarea (keyboard) and our gesture handlers.
        const screenEl = wrapper.querySelector(".xterm-screen") as HTMLElement | null;
        const webglCanvas = screenEl?.querySelector(
          ":scope > canvas:last-of-type",
        ) as HTMLCanvasElement | null;
        if (webglCanvas) {
          webglCanvas.style.pointerEvents = "none";
          webglCanvas.style.touchAction = "none";
        }
        webglAddon = addon;
        lastWebglBuildAt = Date.now();
        webglContextLossDisposable?.dispose();
        webglContextLossDisposable = addon.onContextLoss(() => {
          console.warn("[terminal-cache] WebGL context lost, reattaching addon");
          addon.dispose();
          webglAddon = null;
          // If attached+visible, re-establish now; otherwise mark suspect and
          // let the next `attach` rebuild against the live layout.
          if (attached && hostIsVisible()) {
            attachWebGL();
          } else {
            webglSuspect = true;
          }
        });
        return true;
      } catch (err) {
        console.warn("[terminal-cache] WebGL renderer unavailable, falling back to DOM", err);
        return false;
      }
    };
    if (useWebGL) attachWebGL();

    // --- Find-in-terminal ---
    const search = new XSearchAddon();
    searchAddon = search;
    term.loadAddon(search);
    const searchResultsDisposable = search.onDidChangeResults((event) => {
      setState({
        matchInfo: {
          total: event.resultCount,
          current: event.resultIndex >= 0 ? event.resultIndex + 1 : 0,
        },
      });
    });

    // --- Custom key bindings (sticky-Ctrl, Cmd+F, Shift+Enter, Alt+Arrow) ---
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle center tabs (WorktreeCenterDockview's
      // window handler). Never send them to the shell as a Tab.
      if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) return false;
      if (e.type === "keydown") {
        if (state.pendingCtrl && e.key.length === 1 && !e.metaKey && !e.altKey && !e.ctrlKey) {
          const lower = e.key.toLowerCase();
          const code = lower.charCodeAt(0);
          if (code >= 97 && code <= 122) {
            term.input(String.fromCharCode(code - 96));
            setState({ pendingCtrl: false });
            e.preventDefault();
            return false;
          }
          setState({ pendingCtrl: false });
        }
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          publicApi.openSearch();
          return false;
        }
        if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          term.input("\n");
          return false;
        }
        if (e.altKey && !e.metaKey && !e.ctrlKey) {
          if (e.key === "ArrowLeft") {
            term.input("\x1bb");
            return false;
          }
          if (e.key === "ArrowRight") {
            term.input("\x1bf");
            return false;
          }
        }
      }
      return true;
    });

    // --- Mobile touch: scroll / long-press word-select / tap-to-focus ---
    // All bound to the persistent wrapper so they survive attach/detach moves.
    // Finger scrolling (and its momentum) lives in terminal-touch-scroll.ts. It
    // stops every touchmove in the capture phase so xterm's own gesture
    // handler never sees one, which is why the long-press move listener below
    // also runs in the capture phase.
    const mouseEncoding = trackMouseEncoding(term);
    const touchScroll = attachTerminalTouchScroll(wrapper, term, mouseEncoding);
    attachTerminalMouseWheel(wrapper, term, mouseEncoding);

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
        const screenEl = wrapper.querySelector(".xterm-screen") as HTMLElement | null;
        if (!screenEl) return;
        const cell = pointToCell(start.x, start.y, term, screenEl);
        const lineText = getLineText(term, cell.row);
        const { anchor, head } = wordSelectionAt(cell, lineText);
        applySelection(term, anchor, head);
        selectionAnchor = anchor;
        selectionHead = head;
        setState({ selectionMode: true });
        tapStartX = null;
        tapStartY = null;
        term.blur();
        if (typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(15);
          } catch {
            // vibration may be policy-blocked; ignore
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
    wrapper.addEventListener("touchstart", onLongPressStart, { passive: true });
    wrapper.addEventListener("touchmove", onLongPressMove, { capture: true, passive: true });
    wrapper.addEventListener("touchend", cancelLongPress, { passive: true });
    wrapper.addEventListener("touchcancel", cancelLongPress, { passive: true });

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
        if (selectionAnchor !== null) {
          selectionAnchor = null;
          selectionHead = null;
          setState({ selectionMode: false });
          term.clearSelection();
        }
        term.focus();
      }
    };
    const onTapCancel = () => {
      tapStartX = null;
      tapStartY = null;
    };
    wrapper.addEventListener("touchstart", onTapStart, { passive: true });
    wrapper.addEventListener("touchend", onTapEnd, { passive: true });
    wrapper.addEventListener("touchcancel", onTapCancel, { passive: true });

    // --- WebSocket with reconnect + heartbeat ---
    const wsUrl = `${hubWsUrl("/terminal")}?worktreeId=${encodeURIComponent(worktreeId)}&terminalId=${encodeURIComponent(terminalId)}`;

    let intentionalClose = false;
    // Shell exited (close 1000) or fatal server error (≥4000): the terminal is
    // terminated for good. Unlike `intentionalClose` (teardown), the entry stays
    // alive (pane kept), but NOTHING may reconnect — not the backoff, and not a
    // tab-refocus / network-online resume. Without this, `handleResume` would
    // silently respawn a fresh shell, the exact behaviour band-app/band#617
    // eliminates.
    let terminated = false;
    let didConnectOnce = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastPongAt = 0;

    // Request-driven replay (reconnect width-sync). The server no longer
    // replays eagerly on connect; instead we ask for the serialized snapshot
    // ONLY once we're attached + visible + fitted to the live container, and
    // the request carries our fitted { cols, rows }. That guarantees the
    // server serializes the mirror at exactly the width we render it at, so
    // xterm's wrapped-line reflow can't scatter the replayed cells. Reset per
    // connection in `onopen`.
    //  - `attachSent`: the `attach` (or dims-carrying `init`) went out for
    //    THIS connection; a genuine later resize uses the normal live path.
    //  - `awaitingReplay`: request sent, snapshot/ack not yet received —
    //    container-driven refits are suppressed so a ResizeObserver tick can't
    //    change our width between requesting and rendering the snapshot.
    let attachSent = false;
    let awaitingReplay = false;
    let replayGuardTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const stopHeartbeat = () => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const probeConnection = () => {
      const sock = ws;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        sock.close();
        return;
      }
      try {
        sock.send(JSON.stringify({ type: "ping" }));
      } catch {
        sock.close();
      }
    };
    const scheduleReconnect = () => {
      if (intentionalClose || terminated || reconnectTimer !== null) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
      if (delay < RECONNECT_MAX_MS) reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    function connect() {
      if (intentionalClose || terminated || destroyed) return;
      clearReconnectTimer();
      const isReconnect = didConnectOnce;
      const sock = new HubWebSocket(wsUrl);
      ws = sock;
      sock.binaryType = "arraybuffer";

      // Parse acknowledgements for this connection's output (`flow: true` in
      // the attach), batched per task. The server pauses the PTY while too
      // many bytes are unacknowledged (`api/terminals/output-flow.ts`).
      let unacked = 0;
      const sendAck = () => {
        const bytes = unacked;
        unacked = 0;
        if (ws === sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "ack", bytes }));
        }
      };
      const ack = (bytes: number) => {
        if (ws !== sock || bytes === 0) return;
        if (unacked === 0) queueMicrotask(sendAck);
        unacked += bytes;
      };

      sock.onopen = () => {
        reconnectAttempts = 0;
        lastPongAt = Date.now();
        // Replay state is per-connection: a reconnect must ask again.
        attachSent = false;
        lastSentCols = 0;
        lastSentRows = 0;
        clearReplayGuard();
        if (isReconnect) {
          // The replay reconstructs the whole screen; output queued from the
          // previous connection would land on top of it.
          output.clear();
          term.reset();
          mouseEncoding.reset();
        }

        // Are we already fitted to a visible live box? If so we can carry our
        // dims in the handshake and get the replay in one round-trip.
        const dims = fittedDims();

        if (
          !didConnectOnce &&
          paneMetadata &&
          (paneMetadata.command || paneMetadata.cwd || paneMetadata.env)
        ) {
          // New terminal with spawn options. Send `init` unconditionally so
          // the PTY spawns and the command runs even if the pane isn't visible
          // yet. Fold in the fitted dims when we have them so the server can
          // replay immediately (folding avoids a separate `attach` racing into
          // the gap before the server's persistent listener is installed).
          const initMsg: Record<string, unknown> = { type: "init", flow: true };
          if (paneMetadata.command) initMsg.command = paneMetadata.command;
          if (paneMetadata.cwd) initMsg.cwd = paneMetadata.cwd;
          if (paneMetadata.env) initMsg.env = paneMetadata.env;
          if (dims) {
            initMsg.cols = dims.cols;
            initMsg.rows = dims.rows;
            lastSentCols = dims.cols;
            lastSentRows = dims.rows;
            attachSent = true;
            awaitingReplay = true;
            replayGuardTimer = setTimeout(clearReplayGuard, REPLAY_GUARD_TIMEOUT_MS);
          }
          sock.send(JSON.stringify(initMsg));
        } else {
          // Reconnect, or a plain terminal with no spawn options: request the
          // replay carrying our fitted dims. No-ops when not visible yet — the
          // ResizeObserver / `attach` path retries once the panel surfaces.
          requestReplay();
        }
        didConnectOnce = true;

        if (dims && autoFocusPending && !isReconnect) {
          // Leave focus in an open dialog (Quick Open, the worktree picker)
          // the user moved to while the socket connected. Its focus trap
          // would pull focus back with the query selected, and the next
          // keystroke would replace everything typed so far.
          if (!document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) {
            term.focus();
          }
          autoFocusPending = false;
        }

        stopHeartbeat();
        heartbeatTimer = setInterval(probeConnection, HEARTBEAT_INTERVAL_MS);
        for (const l of connectListeners) l();
      };

      sock.onmessage = (event) => {
        // A socket replaced by `resync` can still deliver frames before it closes.
        if (ws !== sock) return;
        if (event.data instanceof ArrayBuffer) {
          // A binary frame received while awaiting replay is the snapshot
          // (serialized at the dims we sent) — lift the refit suppression.
          // `finishReplay` is a no-op once `awaitingReplay` has cleared, so
          // later live frames fall straight through to the write below.
          finishReplay();
          const bytes = new Uint8Array(event.data);
          const onParsed = noteTypingLatencyOutput(terminalId, bytes);
          if (attached && !document.hidden) {
            output.push(bytes, true, { onParsed, onConsumed: () => ack(bytes.byteLength) });
          } else {
            // Nobody can see this terminal, so it must never pause the PTY
            // (another device may be watching it). Its queue has its own cap.
            ack(bytes.byteLength);
            output.push(bytes, false, { onParsed });
          }
        } else {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === "pong") {
              lastPongAt = Date.now();
            } else if (msg.type === "attached") {
              // Attach ack — sent even when the snapshot is empty (fresh
              // spawn), so the guard lifts without waiting for the timeout.
              finishReplay();
            } else if (msg.type === "title" && typeof msg.title === "string") {
              emitTitle(msg.title);
            } else if (msg.type === "error" && typeof msg.message === "string") {
              // Strip control/escape bytes so a server-supplied error string
              // can't drive xterm via injected ANSI/CSI sequences (forged
              // scrollback, screen clears, cursor moves) — we only want to show
              // its plain text, in red.
              const safe = msg.message.replace(/\p{Cc}/gu, "");
              output.pushNotice(`\r\n\x1b[31m${safe}\x1b[0m\r\n`);
            }
          } catch {
            output.push(event.data as string, attached && !document.hidden);
          }
        }
      };

      sock.onclose = (event) => {
        // Ignore a stale socket's late close (a resume can replace it).
        if (ws !== sock) return;
        stopHeartbeat();
        if (intentionalClose) return;
        // Explicit, deliberate close-code handling (band-app/band#617):
        //  - 1000  → PTY exited or closed by client. Terminate: keep the pane
        //            and scrollback, print a marker, and do NOT reconnect (no
        //            silent respawn of a fresh shell).
        //  - ≥4000 → app-level fatal (bad params / spawn failed); the server
        //            already sent an `error` frame. Terminate without retrying.
        //  - else  → abnormal drop (network loss, zombie-socket terminate at
        //            code 1006). Reconnect with backoff; the server keeps the
        //            PTY alive and replays scrollback (#613).
        if (event.code === 1000 || event.code >= 4000) {
          terminated = true;
          if (event.code === 1000) {
            output.pushNotice("\r\n\x1b[90m[Process completed]\x1b[0m\r\n");
          }
          setState({ terminated: true });
          return;
        }
        // The reconnect replays the whole screen, so queued output from this
        // connection would only be parsed to be thrown away.
        output.clear();
        output.pushNotice("\r\n\x1b[90m[Reconnecting…]\x1b[0m\r\n");
        scheduleReconnect();
      };
    }

    const handleResume = () => {
      if (intentionalClose || terminated) return;
      const sock = ws;
      if (!sock || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
        reconnectAttempts = 0;
        clearReconnectTimer();
        connect();
      } else if (sock.readyState === WebSocket.OPEN) {
        probeConnection();
      }
    };
    // Shown again after being parked: write the output that queued meanwhile.
    // If the queue overflowed, output was dropped and xterm's state is stale,
    // so reconnect: the server replays a serialized snapshot of the screen
    // and scrollback, exactly as after a network drop.
    showParkedOutput = () => {
      if (output.flush()) return;
      output.clear();
      if (terminated) {
        // No shell left to replay from: say what the pane is missing.
        term.write("\r\n\x1b[90m[Output skipped while hidden]\x1b[0m\r\n");
        return;
      }
      if (intentionalClose) return;
      const stale = ws;
      connect();
      // `connect` replaced `ws`, so the stale socket's late frames and its
      // close are ignored.
      stale?.close();
    };

    // Coming back to the foreground (tab re-shown, or — in the Electron app —
    // the window regaining OS focus, which does NOT fire `visibilitychange`).
    // Re-check the socket and do a CHEAP repaint: backgrounding/throttling can
    // drop the rAF frames carrying a TUI's in-place redraws, so `repairAndFit`
    // fits + unconditionally refreshes every row. It deliberately does NOT mark
    // the surface suspect — an off-screen parked surface stays painted (see
    // terminal-parking.ts) so ordinary focus/visibility changes never lose the
    // GPU context, and rebuilding the WebGL addon here raced the compositor and
    // produced a blank-then-repaint flicker (#615 repair fallout). Genuine
    // texture loss has its own signals: `onContextLoss` and `system-resumed`.
    // `scheduleRepair` is rAF-debounced (self-guards on attached+visible), so a
    // switch-back that fires both `visibilitychange` and `focus` coalesces into
    // a single repair — same idiom as `attach`.
    const handleForeground = () => {
      handleResume();
      // Output that arrived while the page was hidden was queued as parked.
      if (attached) showParkedOutput();
      scheduleRepair();
    };
    const handleVisibility = () => {
      if (!document.hidden) handleForeground();
    };
    // Genuine GPU texture loss with NO `webglcontextlost` event: display sleep /
    // screen unlock can discard texture memory while the window keeps OS focus,
    // so neither `focus` nor `visibilitychange` fires. This is the one non-event
    // path that must rebuild the surface, so it — and ONLY it, besides
    // `onContextLoss` — marks the surface suspect before repairing. The desktop
    // main process forwards powerMonitor's resume/unlock as `system-resumed`.
    const handleSurfaceMayBeCorrupt = () => {
      handleResume();
      webglSuspect = true;
      scheduleRepair();
    };
    window.addEventListener("online", handleResume);
    window.addEventListener("focus", handleForeground);
    document.addEventListener("visibilitychange", handleVisibility);
    // Desktop shell only (`system-resumed` is an Electron IPC event; `isDesktop`
    // is false in the browser).
    let unlistenSystemResumed: (() => void) | null = null;
    if (isDesktop) {
      desktopListen("system-resumed", handleSurfaceMayBeCorrupt)
        .then((off) => {
          if (destroyed) off();
          else unlistenSystemResumed = off;
        })
        .catch(() => {});
    }

    // Focus entering the terminal itself (the user clicking into it). This does
    // a CHEAP repaint only — it must NOT rebuild the WebGL addon: a click that
    // disposes and recreates the surface races the compositor and flickers, and
    // clicking is not evidence of GPU corruption. Genuine corruption is handled
    // by `onContextLoss` / `system-resumed`. Still WebGL-gated + throttled off
    // the last addon build: the DOM renderer needs no repaint-on-click, and a
    // repaint right after a build (auto-focus on connect, close-search refocus,
    // tap-to-focus) is redundant with the fit+refresh that build already did.
    const handleFocusIn = () => {
      if (!useWebGL || lastWebglBuildAt === 0) return;
      if (Date.now() - lastWebglBuildAt < 1_000) return;
      scheduleRepair();
    };
    wrapper.addEventListener("focusin", handleFocusIn);

    connect();

    const disposeTypingLatency = registerTypingLatencyTerminal(terminalId, term, wrapper);
    // The typing-latency dispatch stamp is taken when the data reaches the
    // socket, which a coalesced write does a turn of the event loop later.
    const noteDispatch = () => noteTypingLatencyDispatch(terminalId);
    term.onData((data) => inputQueue.write(data, noteDispatch));
    term.onTitleChange((title) => emitTitle(title));

    // Re-apply the active selection after each xterm resize (xterm clears it on
    // rowsChanged); defer to the next frame so it lands after every sync resize
    // handler but before paint.
    let selectionRafId: number | null = null;
    const reapplySelectionOnNextFrame = () => {
      if (selectionRafId !== null) return;
      if (!selectionAnchor || !selectionHead) return;
      selectionRafId = requestAnimationFrame(() => {
        selectionRafId = null;
        if (selectionAnchor && selectionHead) applySelection(term, selectionAnchor, selectionHead);
      });
    };
    const selectionResizeDisposable = term.onResize(reapplySelectionOnNextFrame);

    // --- Resize / DPR / zoom handling ---
    let lastDpr = window.devicePixelRatio;
    // The size the server last got on this connection (from `init`, `attach`
    // or `resize`). A resize that repeats it is dropped: the kernel signals the
    // app only on a real change, so a repeat can't do anything useful.
    let lastSentCols = 0;
    let lastSentRows = 0;
    let resizeRafId: number | null = null;
    // Sends the latest fitted size at most once per animation frame, so a fit
    // that the layout undoes within the same frame never reaches the PTY (each
    // size change that does reach it makes a TUI redraw).
    const sendPtyResize = () => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (term.cols <= 0 || term.rows <= 0) return;
        if (term.cols === lastSentCols && term.rows === lastSentRows) return;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      });
    };

    // --- Request-driven replay (reconnect width-sync) ---
    const clearReplayGuard = () => {
      awaitingReplay = false;
      if (replayGuardTimer !== null) {
        clearTimeout(replayGuardTimer);
        replayGuardTimer = null;
      }
    };
    // Fit to the live container and return the resulting dims, or null when
    // not attached to a visible box (so we never capture the parking
    // container's size or a 0×0 pre-layout frame).
    const fittedDims = (): { cols: number; rows: number } | null => {
      if (!attached || !hostIsVisible()) return null;
      fitToBox();
      if (term.cols <= 0 || term.rows <= 0) return null;
      return { cols: term.cols, rows: term.rows };
    };
    // Ask the server to replay the serialized snapshot at our fitted dims.
    // Sent at most once per connection (`attachSent`); no-ops until we're
    // attached + visible + fitted, so `onopen`/`attach`/the ResizeObserver can
    // all call it and the first one that finds the panel surfaced wins.
    const requestReplay = () => {
      if (attachSent) return;
      const sock = ws;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const dims = fittedDims();
      if (!dims) return;
      attachSent = true;
      lastSentCols = dims.cols;
      lastSentRows = dims.rows;
      awaitingReplay = true;
      sock.send(JSON.stringify({ type: "attach", cols: dims.cols, rows: dims.rows, flow: true }));
      if (replayGuardTimer !== null) clearTimeout(replayGuardTimer);
      replayGuardTimer = setTimeout(clearReplayGuard, REPLAY_GUARD_TIMEOUT_MS);
    };
    // Once the snapshot (or its ack) lands, lift the refit suppression and
    // reconcile: if the container size drifted during the request→render
    // window, fit + resize now. A no-op when the width is unchanged (xterm's
    // resize short-circuits equal dims), so the common case doesn't reflow the
    // just-written snapshot. Tracked so `cleanup`/`_destroy` can cancel a
    // pending reconcile and it never runs against a torn-down entry.
    let reconcileRafId: number | null = null;
    const finishReplay = () => {
      if (!awaitingReplay) return;
      clearReplayGuard();
      if (reconcileRafId !== null) cancelAnimationFrame(reconcileRafId);
      reconcileRafId = requestAnimationFrame(() => {
        reconcileRafId = null;
        if (!attached || !hostIsVisible()) return;
        fitToBox();
        sendPtyResize();
      });
    };
    const remeasureAndReattach = (opt: { newFontSize?: number } = {}): void => {
      const { newFontSize } = opt;
      // Always apply the new font size so the terminal is correctly scaled when
      // it next surfaces (a zoom that fires while parked must still take effect).
      if (newFontSize !== undefined) {
        if (term.options.fontSize !== newFontSize) term.options.fontSize = newFontSize;
      } else {
        const fs = term.options.fontSize;
        if (typeof fs === "number") {
          term.options.fontSize = fs + 1;
          term.options.fontSize = fs;
        }
      }
      // Parked: never rebuild the WebGL surface or fit against the off-screen
      // parking box (it would leave the terminal sized to 800×600). Defer both
      // to the next `attach`, which rebuilds a suspect surface and re-fits to
      // the live container. Keeps the "no re-fit while parked" invariant and
      // avoids per-parked-terminal WebGL context churn.
      if (!attached || !hostIsVisible()) {
        webglSuspect = true;
        return;
      }
      if (webglAddon) {
        webglAddon.dispose();
        webglAddon = null;
        attachWebGL();
      }
      fitToBox();
    };
    const handleDprChange = (): boolean => {
      const currentDpr = window.devicePixelRatio;
      if (currentDpr === lastDpr) return false;
      lastDpr = currentDpr;
      remeasureAndReattach();
      return true;
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      // Only react when attached to a visible live box — never fit to the
      // parking container's size.
      if (!attached || !hostIsVisible()) return;
      // First time the panel surfaces on this connection: this IS the fit that
      // lets us request the replay at the live width. Do that instead of a
      // bare resize.
      if (!attachSent) {
        requestReplay();
        return;
      }
      // Between requesting replay and rendering the snapshot, don't let a
      // container tick change our width — that would reintroduce the reflow
      // scatter the request-driven flow exists to prevent.
      if (awaitingReplay) return;
      const dprChanged = handleDprChange();
      // A reveal moves the wrapper out of the fixed-size parking box, which
      // fires this observer even when the live box kept its size since the
      // last fit. Skip that one, for the reason given at `repairAndFit`.
      if (!dprChanged && !boxResizedSinceFit()) return;
      if (!dprChanged) fitToBox();
      sendPtyResize();
    });
    resizeObserver.observe(wrapper);

    const handleZoomChange = (zoom: number) => {
      const target = Math.round(BASE_FONT_SIZE * zoom * 100) / 100;
      if (term.options.fontSize === target) return;
      remeasureAndReattach({ newFontSize: target });
      // Don't push a resize mid-replay: the pending snapshot is bound to the
      // dims we already sent (see the ResizeObserver guard).
      if (attached && hostIsVisible() && !awaitingReplay) sendPtyResize();
    };
    const unsubscribeZoom = subscribeToZoomChanges(handleZoomChange);

    let dprMql: MediaQueryList | undefined;
    const onDprMediaChange = () => {
      handleDprChange();
      dprMql?.removeEventListener("change", onDprMediaChange);
      bindDprListener();
    };
    const bindDprListener = () => {
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMql.addEventListener("change", onDprMediaChange);
    };
    bindDprListener();

    // Full repair used on (re)attach: re-measure geometry, rebuild the WebGL
    // surface if suspect, then force an unconditional repaint of every row so a
    // stale/unchanged-dimension frame can't survive (mirrors superset).
    //
    // The fit is skipped when the live box has the same pixel size as at the
    // last fit and the surface wasn't rebuilt, which is the common worktree
    // switch-back (orca's `pane-reveal-fit.ts`). A reattached WebGL surface's
    // cell metrics can briefly differ, so a fit there could propose a grid one
    // column off, reflow the buffer and snap back, and xterm's rewrap isn't a
    // perfect inverse. A zoom or font change while parked marks the surface
    // suspect, so it still refits here, on the DOM renderer too.
    repairAndFit = () => {
      if (!attached || !hostIsVisible()) return;
      const dprChanged = handleDprChange();
      if (!dprChanged) {
        const rebuild = webglSuspect && useWebGL;
        if (rebuild) {
          webglAddon?.dispose();
          webglAddon = null;
          attachWebGL();
        }
        if (webglSuspect || boxResizedSinceFit()) fitToBox();
      }
      webglSuspect = false;
      if (term.rows > 0) term.refresh(0, term.rows - 1);
      // If this connection hasn't requested its replay yet (the panel just
      // surfaced), do that now — it carries the dims we just fitted to.
      // Otherwise keep the PTY in sync with the live box, unless we're
      // mid-replay (the snapshot is bound to the dims already sent).
      if (!attachSent) {
        requestReplay();
        return;
      }
      if (!awaitingReplay) sendPtyResize();
    };

    hostIsVisible = () =>
      !!liveContainer && liveContainer.clientWidth > 0 && liveContainer.clientHeight > 0;

    // The load resolved after an `attach` request — surface now.
    if (attached) scheduleRepair();

    setState({ ready: true });

    cleanup = () => {
      intentionalClose = true;
      clearReconnectTimer();
      stopHeartbeat();
      window.removeEventListener("online", handleResume);
      window.removeEventListener("focus", handleForeground);
      document.removeEventListener("visibilitychange", handleVisibility);
      unlistenSystemResumed?.();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      searchResultsDisposable.dispose();
      selectionResizeDisposable.dispose();
      fileLinkProviderDisposable.dispose();
      disposeTypingLatency();
      output.dispose();
      if (selectionRafId !== null) cancelAnimationFrame(selectionRafId);
      if (reconcileRafId !== null) cancelAnimationFrame(reconcileRafId);
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      webglContextLossDisposable?.dispose();
      dprMql?.removeEventListener("change", onDprMediaChange);
      unsubscribeZoom();
      cancelLongPress();
      touchScroll.dispose();
      mouseEncoding.dispose();
      ws?.close();
      term.dispose(); // cascades to loaded addons
    };
  });

  // -------------------------------------------------------------------------
  // Closures wired up during the async load; default to no-ops until then.
  // -------------------------------------------------------------------------
  let hostIsVisible = (): boolean =>
    !!liveContainer && liveContainer.clientWidth > 0 && liveContainer.clientHeight > 0;
  let repairAndFit: () => void = () => {};
  let showParkedOutput: () => void = () => {};

  let repairRafId: number | null = null;
  const scheduleRepair = () => {
    if (repairRafId !== null) return;
    let frame = 0;
    const run = () => {
      repairRafId = null;
      if (!attached) return;
      if (!hostIsVisible()) {
        if (frame < MAX_LAYOUT_FRAMES) {
          frame += 1;
          repairRafId = requestAnimationFrame(run);
        }
        return;
      }
      repairAndFit();
    };
    repairRafId = requestAnimationFrame(run);
  };

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  const publicApi: TerminalCacheEntry = {
    terminalId,
    worktreeId,
    getTerminal: () => terminal,

    attach(container, attachOpts) {
      // A disposed entry must never re-enter the DOM. `dispose()` can fire
      // (pane close) while React is still committing the unmount that calls
      // attach/detach — without this guard, detach below would re-append the
      // removed wrapper and resurrect a killed terminal.
      if (destroyed) return;
      liveContainer = container;
      const wasParked = !attached;
      if (wasParked) activatedSeq = nextActivationSeq();
      attached = true;
      if (wasParked) showParkedOutput();
      hiddenSince = null;
      scheduleParkingPass();
      if (attachOpts?.autoFocus) autoFocusPending = true;
      // Move the persistent wrapper into the live box (no-op if already there).
      if (wrapper.parentElement !== container) container.appendChild(wrapper);
      // A box that already has a size is fitted and refreshed now, so the
      // frame that reveals it (the caller is a layout effect) paints the
      // terminal. A box still at 0×0 right after mount waits on the rAF retry.
      if (hostIsVisible()) {
        if (repairRafId !== null) {
          cancelAnimationFrame(repairRafId);
          repairRafId = null;
        }
        repairAndFit();
      } else {
        scheduleRepair();
      }
    },

    detach() {
      if (destroyed) return;
      if (attached) hiddenSince = Date.now();
      attached = false;
      liveContainer = null;
      // Parking moves the wrapper into an off-screen but PAINTED container (see
      // terminal-parking.ts), so a plain switch-away no longer invalidates the
      // WebGL surface — the next `attach` does a cheap fit + refresh and reuses
      // the live canvas, no rebuild (no switch-back flicker). Genuine off-screen
      // texture loss (sleep/unlock) still rebuilds via `system-resumed`, which
      // marks every cached entry suspect; and `onContextLoss` covers a real
      // context drop. So detach intentionally does NOT set `webglSuspect`.
      if (repairRafId !== null) {
        cancelAnimationFrame(repairRafId);
        repairRafId = null;
      }
      // Park the wrapper (no dispose, no re-fit — retains last cols/rows).
      const parking = getParkingContainer();
      if (wrapper.parentElement !== parking) parking.appendChild(wrapper);
      // This terminal just became a parking candidate; re-plan the timers.
      scheduleParkingPass();
    },

    getHiddenSince: () => hiddenSince,
    getActivatedSeq: () => activatedSeq,
    isAttached: () => attached,
    isDestroyed: () => destroyed,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,

    openSearch() {
      setState({ searchOpen: true });
    },
    closeSearch() {
      searchAddon?.clearDecorations();
      setState({ searchOpen: false, searchQuery: "", matchInfo: { total: 0, current: 0 } });
      terminal?.focus();
    },
    setSearchQuery(query) {
      setState({ searchQuery: query });
      const addon = searchAddon;
      if (!addon) return;
      if (!query) {
        addon.clearDecorations();
        setState({ matchInfo: { total: 0, current: 0 } });
        return;
      }
      addon.findNext(query, toXtermSearchOptions(state.searchOptions));
    },
    setSearchOptions(options) {
      setState({ searchOptions: options });
      if (!searchAddon || !state.searchQuery) return;
      searchAddon.findNext(state.searchQuery, toXtermSearchOptions(options));
    },
    findNext() {
      if (!state.searchQuery) return;
      searchAddon?.findNext(state.searchQuery, toXtermSearchOptions(state.searchOptions));
    },
    findPrevious() {
      if (!state.searchQuery) return;
      searchAddon?.findPrevious(state.searchQuery, toXtermSearchOptions(state.searchOptions));
    },
    toggleCtrl() {
      setState({ pendingCtrl: !state.pendingCtrl });
    },
    extendSelection(direction) {
      if (!terminal || !selectionAnchor || !selectionHead) return;
      const next = moveCell(selectionHead, direction, terminal);
      selectionHead = next;
      applySelection(terminal, selectionAnchor, next);
    },
    exitSelection() {
      selectionAnchor = null;
      selectionHead = null;
      setState({ selectionMode: false });
      terminal?.clearSelection();
    },
    selectAll() {
      if (!terminal) return;
      const anchor: Cell = { col: 0, row: 0 };
      const lastRow = Math.max(0, terminal.buffer.active.length - 1);
      const head: Cell = { col: Math.max(0, terminal.cols - 1), row: lastRow };
      applySelection(terminal, anchor, head);
      selectionAnchor = anchor;
      selectionHead = head;
      setState({ selectionMode: true });
      terminal.blur();
    },
    sendInput(data) {
      inputQueue.write(data);
    },
    isSocketOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
    focus() {
      terminal?.focus();
    },
    subscribeConnect(listener) {
      connectListeners.add(listener);
      return () => connectListeners.delete(listener);
    },
    registerTitleListener(listener) {
      titleListener = listener;
      if (lastTitle !== null) listener(lastTitle);
      return () => {
        if (titleListener === listener) titleListener = null;
      };
    },

    _destroy() {
      if (destroyed) return;
      destroyed = true;
      if (repairRafId !== null) {
        cancelAnimationFrame(repairRafId);
        repairRafId = null;
      }
      cleanup?.();
      cleanup = null;
      listeners.clear();
      connectListeners.clear();
      titleListener = null;
      wrapper.remove();
    },
  };

  return publicApi;
}

// ---------------------------------------------------------------------------
// Module-level API
// ---------------------------------------------------------------------------

/** Get the cached entry for `terminalId`, creating it (xterm + wrapper + socket)
 *  on first call. Idempotent — subsequent calls return the same entry and ignore
 *  `opts`, so `subscribe`/`getSnapshot` identities stay stable across renders. */
export function getOrCreateTerminal(terminalId: string, opts: CreateOptions): TerminalCacheEntry {
  const cache = getCache();
  const existing = cache.get(terminalId);
  if (existing) return existing;
  const entry = createEntry(terminalId, opts);
  cache.set(terminalId, entry);
  scheduleParkingPass();
  return entry;
}

// ---------------------------------------------------------------------------
// Renderer parking policy (orca's hidden-view parking, see
// `terminal-park-policy.ts`). Two levels, evaluated in one pass:
//
//  1. Per worktree: every terminal of a cold-parked worktree is disposed.
//     The worktree-level decision (30 s delay, 4 most recently hidden warm for
//     5 minutes, the most recently left warm indefinitely) is shared with the
//     other heavy panes and lives in `worktree-cold-park.ts`.
//  2. Per terminal tab, inside each worktree: a tab whose panes have all been
//     detached for 30 s becomes a candidate; the 6 most recently hidden tabs
//     stay warm for 5 minutes, the most recently hidden one indefinitely. A
//     split tab's panes are parked or kept together.
//
// An attached (visible) terminal is never disposed. The pass re-runs on every
// attach/detach/create and whenever the cold worktree set changes, and
// otherwise sleeps until the next per-terminal deadline.
// ---------------------------------------------------------------------------

const PARK_STATE_KEY = "__bandTerminalParkState__";

interface ParkState {
  activationSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  passQueued: boolean;
}

function getParkState(): ParkState {
  const store = globalThis as unknown as { [PARK_STATE_KEY]?: ParkState };
  if (!store[PARK_STATE_KEY]) {
    store[PARK_STATE_KEY] = { activationSeq: 0, timer: null, passQueued: false };
    subscribeWorktreeColdPark(scheduleParkingPass);
  }
  return store[PARK_STATE_KEY];
}

function nextActivationSeq(): number {
  const state = getParkState();
  state.activationSeq += 1;
  return state.activationSeq;
}

/** Run the pass in a microtask. A worktree switch detaches several terminals
 *  in one React commit; batching them keeps it to one pass. The pass must not
 *  run synchronously inside `detach` anyway: it can dispose entries, and
 *  `detach` is called from React effect cleanups. */
function scheduleParkingPass(): void {
  const state = getParkState();
  if (state.passQueued) return;
  state.passQueued = true;
  queueMicrotask(() => {
    state.passQueued = false;
    runParkingPass();
  });
}

function runParkingPass(): void {
  const state = getParkState();
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const nowMs = Date.now();

  const byWorktree = new Map<string, TerminalCacheEntry[]>();
  for (const entry of getCache().values()) {
    const list = byWorktree.get(entry.worktreeId);
    if (list) list.push(entry);
    else byWorktree.set(entry.worktreeId, [entry]);
  }

  let nextDeadline = Number.POSITIVE_INFINITY;
  for (const [worktreeId, entries] of byWorktree) {
    let remaining = entries;
    if (isWorktreeColdParked(worktreeId)) {
      // Dispose every detached terminal of a cold worktree, except entries
      // that were never attached: revealing a cold worktree creates fresh
      // entries a moment before their attach effect runs, and this pass can
      // land in between while the worktree is still marked cold. Those fall
      // through to the per-tab policy below instead.
      remaining = [];
      for (const entry of entries) {
        if (entry.isAttached() || entry.getActivatedSeq() === 0) remaining.push(entry);
        else disposeTerminal(entry.terminalId);
      }
    }

    // Per-tab policy. Orca ranks terminal TABS; in Band each split pane is its
    // own entry, so group panes by their outer tab (`ownerOfTerminal`) and
    // park or keep a tab's panes together. A tab is hidden once all its panes
    // are detached, since the latest detach; its activation is its latest
    // pane's.
    const tabs = new Map<string, TerminalCacheEntry[]>();
    for (const entry of remaining) {
      const tabId = ownerOfTerminal(entry.terminalId) ?? entry.terminalId;
      const panes = tabs.get(tabId);
      if (panes) panes.push(entry);
      else tabs.set(tabId, [entry]);
    }
    const tabCandidates: { id: string; hiddenSinceMs: number; lastActivatedSeq: number }[] = [];
    for (const [tabId, panes] of tabs) {
      let hiddenSinceMs = Number.NEGATIVE_INFINITY;
      let lastActivatedSeq = 0;
      let attached = false;
      for (const pane of panes) {
        const paneHiddenSince = pane.getHiddenSince();
        if (paneHiddenSince === null || pane.isAttached()) {
          attached = true;
          break;
        }
        hiddenSinceMs = Math.max(hiddenSinceMs, paneHiddenSince);
        lastActivatedSeq = Math.max(lastActivatedSeq, pane.getActivatedSeq());
      }
      if (attached) continue;
      for (const deadline of [
        hiddenSinceMs + TERMINAL_TAB_COLD_PARK_DELAY_MS,
        hiddenSinceMs + TERMINAL_TAB_HOT_RETAIN_MS,
      ]) {
        if (deadline > nowMs && deadline < nextDeadline) nextDeadline = deadline;
      }
      if (nowMs - hiddenSinceMs >= TERMINAL_TAB_COLD_PARK_DELAY_MS) {
        tabCandidates.push({ id: tabId, hiddenSinceMs, lastActivatedSeq });
      }
    }
    const parkedTabs = selectIdsBeyondHotRetain(tabCandidates, {
      nowMs,
      hotRetainMs: TERMINAL_TAB_HOT_RETAIN_MS,
      hotRetainLimit: TERMINAL_TAB_HOT_RETAIN_LIMIT,
    });
    for (const tabId of parkedTabs) {
      for (const pane of tabs.get(tabId) ?? []) disposeTerminal(pane.terminalId);
    }
  }

  if (nextDeadline !== Number.POSITIVE_INFINITY) {
    state.timer = setTimeout(runParkingPass, nextDeadline - nowMs);
  }
}

/** Intentional close: dispose the xterm + socket + wrapper and drop the entry.
 *  Call on pane close / worktree deletion / cold park — NOT on a plain React
 *  unmount. */
export function disposeTerminal(terminalId: string): void {
  const cache = getCache();
  const entry = cache.get(terminalId);
  if (!entry) return;
  cache.delete(terminalId);
  entry._destroy();
}

/** Dispose cached terminals whose worktree is no longer valid (deleted /
 *  worktree removed). Driven by the repos query in `MultiWorktreePanelHost`,
 *  mirroring the mounted-set reconcile. Never disposes the active worktree's
 *  terminals (its id can transiently drop out of `validWorktreeIds` while a
 *  delete of the active worktree propagates to the URL). */
export function reconcileTerminalWorktrees(
  validWorktreeIds: Set<string>,
  activeWorktreeId: string | null,
): void {
  const cache = getCache();
  for (const [id, entry] of cache) {
    if (!validWorktreeIds.has(entry.worktreeId) && entry.worktreeId !== activeWorktreeId) {
      cache.delete(id);
      entry._destroy();
    }
  }
}

export function hasTerminal(terminalId: string): boolean {
  return getCache().has(terminalId);
}
