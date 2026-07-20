import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { SearchOptions } from "@/dashboard";
import { listen as desktopListen } from "./desktop-ipc";
import { isDesktop } from "./is-desktop";
import { openExternalUrl } from "./open-external-url";
import { createTerminalFileLinkProvider } from "./terminal-file-links";
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
import { getCurrentZoomLevel, subscribeToZoomChanges } from "./zoom";

// ---------------------------------------------------------------------------
// Persistent per-terminal xterm cache with a DOM "parking" model.
//
// Each terminal keeps ONE live xterm instance for the lifetime of its cache
// entry, `open()`ed into a persistent wrapper <div>. That wrapper is *moved*
// between the visible panel container (`attach`) and a shared off-screen parking
// container (`detach`, see `terminal-parking.ts`) — it is never disposed on a
// workspace/tab switch and its React subtree owning it can mount/unmount freely.
//
// This replaces the old model where `TerminalPanel` owned the xterm and
// `MultiWorkspacePanelHost` hid inactive terminals in place under
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

/**
 * Max live xterm instances kept in the cache. The cache is bounded by its OWN
 * LRU (least-recently-attached), NOT by the panel host's `maxCachedWorkspaces`.
 *
 * Tying terminal lifetime to the panel LRU was wrong: with
 * `maxCachedWorkspaces = 1`, every workspace switch evicted the previous
 * workspace and tore its terminal down, so returning always forced a reconnect
 * (and, in some environments, a fresh shell) — defeating the whole point of the
 * parking model (band-app/band#617). Now a switched-away terminal is only PARKED
 * (its wrapper moved off-screen, socket + buffer intact) and is reused on
 * return. Terminals are disposed only when: the pane is closed, the workspace is
 * deleted (`reconcileTerminalWorkspaces`), or this LRU cap is exceeded.
 *
 * The cap also bounds live WebGL contexts (browsers hard-cap ~16); each cached
 * terminal keeps a context alive while parked (reused on re-attach — the addon
 * is rebuilt only on genuine GPU loss, not on a plain switch-back).
 */
const MAX_CACHED_TERMINALS = 8;

export interface PaneMetadata {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export interface CreateOptions {
  workspaceId: string;
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
  readonly workspaceId: string;
  /** Live xterm instance, or null until the async addon load finishes. */
  readonly getTerminal: () => Terminal | null;

  // --- lifecycle (move the persistent wrapper between DOM containers) ---
  attach(liveContainer: HTMLElement, opts?: { autoFocus?: boolean }): void;
  detach(): void;

  // --- LRU bookkeeping (used by the module-level cache cap) ---
  /** Epoch ms of the last attach/touch; the LRU evicts the smallest first. */
  getLastActive(): number;
  /** Mark recently used without attaching (a cache hit in `getOrCreate`). */
  touch(): void;
  /** True while attached to a live (visible) container — never LRU-evicted. */
  isAttached(): boolean;
  /** True once disposed. A mounted-but-hidden panel holding this entry can
   *  detect an LRU eviction and re-resolve a fresh entry on becoming visible. */
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
  const { workspaceId, paneMetadata, useWebGL, autoFocus } = opts;

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
  wrapper.dataset.workspaceId = workspaceId;
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

  // Attach/parking state.
  let liveContainer: HTMLElement | null = null;
  let attached = false;
  let autoFocusPending = autoFocus ?? paneMetadata?.focus ?? false;
  // LRU recency for the module-level cache cap. Bumped on create/attach/touch.
  let lastActive = Date.now();

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
  ]).then(([xtermMod, fitMod, webLinksMod, searchMod, webglMod]) => {
    if (destroyed) return;
    const { Terminal: XTerm } = xtermMod;
    const { FitAddon: XFitAddon } = fitMod;
    const { WebLinksAddon: XWebLinksAddon } = webLinksMod;
    const { SearchAddon: XSearchAddon } = searchMod;
    const { WebglAddon: XWebglAddon } = webglMod;

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
    });
    terminal = term;

    const themeObserver = new MutationObserver(() => {
      term.options.theme = getTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const fit = new XFitAddon();
    term.loadAddon(fit);
    term.loadAddon(new XWebLinksAddon((_event, uri) => openExternalUrl(uri)));

    const fileLinkProviderDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider(term, (filename) => {
        window.dispatchEvent(
          new CustomEvent("band:open-file", { detail: { filename, workspaceId } }),
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
    // `.xterm-viewport` is created once by `term.open()` and (unlike the WebGL
    // `.xterm-screen` canvas) is not rebuilt on renderer switches, so cache it
    // rather than re-`querySelector` on every ~60 Hz touchmove.
    const viewportEl = wrapper.querySelector(".xterm-viewport") as HTMLElement | null;
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || lastTouchY === null) return;
      const currentY = e.touches[0].clientY;
      const deltaY = lastTouchY - currentY;
      const cellHeight = viewportEl && term.rows > 0 ? viewportEl.clientHeight / term.rows : 17;
      const lineDelta = Math.trunc(deltaY / cellHeight);
      if (lineDelta !== 0) {
        term.scrollLines(lineDelta);
        lastTouchY = currentY + (deltaY - lineDelta * cellHeight);
        e.preventDefault();
      }
    };
    const onTouchEnd = () => {
      lastTouchY = null;
    };
    wrapper.addEventListener("touchstart", onTouchStart, { passive: true });
    wrapper.addEventListener("touchmove", onTouchMove, { passive: false });
    wrapper.addEventListener("touchend", onTouchEnd, { passive: true });
    wrapper.addEventListener("touchcancel", onTouchEnd, { passive: true });

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
    wrapper.addEventListener("touchmove", onLongPressMove, { passive: true });
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
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(terminalId)}`;

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
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.binaryType = "arraybuffer";

      sock.onopen = () => {
        reconnectAttempts = 0;
        lastPongAt = Date.now();
        // Replay state is per-connection: a reconnect must ask again.
        attachSent = false;
        clearReplayGuard();
        if (isReconnect) term.reset();

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
          const initMsg: Record<string, unknown> = { type: "init" };
          if (paneMetadata.command) initMsg.command = paneMetadata.command;
          if (paneMetadata.cwd) initMsg.cwd = paneMetadata.cwd;
          if (paneMetadata.env) initMsg.env = paneMetadata.env;
          if (dims) {
            initMsg.cols = dims.cols;
            initMsg.rows = dims.rows;
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
          term.focus();
          autoFocusPending = false;
        }

        stopHeartbeat();
        heartbeatTimer = setInterval(probeConnection, HEARTBEAT_INTERVAL_MS);
        for (const l of connectListeners) l();
      };

      sock.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // A binary frame received while awaiting replay is the snapshot
          // (serialized at the dims we sent) — lift the refit suppression.
          // `finishReplay` is a no-op once `awaitingReplay` has cleared, so
          // later live frames fall straight through to the write below.
          finishReplay();
          term.write(new Uint8Array(event.data));
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
              term.write(`\r\n\x1b[31m${safe}\x1b[0m\r\n`);
            }
          } catch {
            term.write(event.data as string);
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
            term.write("\r\n\x1b[90m[Process completed]\x1b[0m\r\n");
          }
          setState({ terminated: true });
          return;
        }
        term.write("\r\n\x1b[90m[Reconnecting…]\x1b[0m\r\n");
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

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });
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
    const sendPtyResize = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (term.cols <= 0 || term.rows <= 0) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
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
      fit.fit();
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
      awaitingReplay = true;
      sock.send(JSON.stringify({ type: "attach", cols: dims.cols, rows: dims.rows }));
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
        fit.fit();
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
      fit.fit();
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
      if (!dprChanged) fit.fit();
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
    repairAndFit = () => {
      if (!attached || !hostIsVisible()) return;
      const dprChanged = handleDprChange();
      if (!dprChanged) {
        if (webglSuspect && useWebGL) {
          webglAddon?.dispose();
          webglAddon = null;
          attachWebGL();
        }
        fit.fit();
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
      if (selectionRafId !== null) cancelAnimationFrame(selectionRafId);
      if (reconcileRafId !== null) cancelAnimationFrame(reconcileRafId);
      webglContextLossDisposable?.dispose();
      dprMql?.removeEventListener("change", onDprMediaChange);
      unsubscribeZoom();
      cancelLongPress();
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
    workspaceId,
    getTerminal: () => terminal,

    attach(container, attachOpts) {
      // A disposed entry must never re-enter the DOM. `dispose()` can fire
      // (pane close) while React is still committing the unmount that calls
      // attach/detach — without this guard, detach below would re-append the
      // removed wrapper and resurrect a killed terminal.
      if (destroyed) return;
      liveContainer = container;
      attached = true;
      lastActive = Date.now();
      if (attachOpts?.autoFocus) autoFocusPending = true;
      // Move the persistent wrapper into the live box (no-op if already there).
      if (wrapper.parentElement !== container) container.appendChild(wrapper);
      scheduleRepair();
    },

    detach() {
      if (destroyed) return;
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
      // Re-check the cache cap now that this terminal is evictable again — the
      // cap must hold even when it was exceeded by many simultaneously-attached
      // terminals that then parked (create-time eviction alone wouldn't trim
      // them until the next create). Keeps this just-parked one (most recent).
      evictLeastRecentlyUsed(terminalId);
    },

    getLastActive: () => lastActive,
    touch() {
      lastActive = Date.now();
    },
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
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
  if (existing) {
    existing.touch();
    return existing;
  }
  const entry = createEntry(terminalId, opts);
  cache.set(terminalId, entry);
  evictLeastRecentlyUsed(terminalId);
  return entry;
}

/** Enforce the cache cap: dispose the least-recently-attached DETACHED entries
 *  (never an attached/visible one) until within `MAX_CACHED_TERMINALS`, keeping
 *  the just-created `keepId`. */
function evictLeastRecentlyUsed(keepId: string): void {
  const cache = getCache();
  if (cache.size <= MAX_CACHED_TERMINALS) return;
  const candidates = [...cache.values()]
    .filter((e) => e.terminalId !== keepId && !e.isAttached())
    .sort((a, b) => a.getLastActive() - b.getLastActive());
  let over = cache.size - MAX_CACHED_TERMINALS;
  for (const entry of candidates) {
    if (over <= 0) break;
    cache.delete(entry.terminalId);
    entry._destroy();
    over -= 1;
  }
}

/** Intentional close: dispose the xterm + socket + wrapper and drop the entry.
 *  Call on pane close / workspace eviction — NOT on a plain React unmount. */
export function disposeTerminal(terminalId: string): void {
  const cache = getCache();
  const entry = cache.get(terminalId);
  if (!entry) return;
  cache.delete(terminalId);
  entry._destroy();
}

/** Dispose cached terminals whose workspace is no longer valid (deleted /
 *  worktree removed). Driven by the projects query in `MultiWorkspacePanelHost`,
 *  mirroring the panel-cache reconcile. Never disposes the active workspace's
 *  terminals (its id can transiently drop out of `validWorkspaceIds` while a
 *  delete of the active workspace propagates to the URL). A panel-LRU eviction
 *  is NOT a valid-set change, so this leaves switched-away terminals parked and
 *  reusable — that is the fix for band-app/band#617's "terminal re-created on
 *  switch" with `maxCachedWorkspaces = 1`. */
export function reconcileTerminalWorkspaces(
  validWorkspaceIds: Set<string>,
  activeWorkspaceId: string | null,
): void {
  const cache = getCache();
  for (const [id, entry] of cache) {
    if (!validWorkspaceIds.has(entry.workspaceId) && entry.workspaceId !== activeWorkspaceId) {
      cache.delete(id);
      entry._destroy();
    }
  }
}

export function hasTerminal(terminalId: string): boolean {
  return getCache().has(terminalId);
}
