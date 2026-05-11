import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { openExternalUrl } from "../lib/open-external-url";

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
  const wsRef = useRef<WebSocket | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    // Dynamic import so @xterm (CJS) is never evaluated during SSR
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]).then(([{ Terminal: XTerm }, { FitAddon: XFitAddon }, { WebLinksAddon: XWebLinksAddon }]) => {
      if (cancelled || !containerRef.current) return;

      // CSS loaded on client only
      import("@xterm/xterm/css/xterm.css");

      const terminal = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        // NOTE: keep lineHeight at the xterm.js default of 1.0. Increasing
        // it adds vertical padding above each row, but box-drawing /
        // block-element glyphs (█▀▄, powerline separators, large ASCII
        // banners like opencode's logo) fill only the font's em-square —
        // not the padded row — so bumping lineHeight slices horizontal
        // gaps through that art. iTerm patches box-drawing glyphs to the
        // cell rect internally; xterm.js's DOM renderer doesn't.
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

      // Custom key bindings:
      // - Shift+Enter → CSI u sequence so shells/tools receive a distinct keycode
      // - Alt+Arrow   → word navigation (ESC+b / ESC+f)
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown") {
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
        containerEl.removeEventListener("touchstart", onTouchStart);
        containerEl.removeEventListener("touchmove", onTouchMove);
        containerEl.removeEventListener("touchend", onTouchEnd);
        containerEl.removeEventListener("touchcancel", onTouchEnd);
        ws.close();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        wsRef.current = null;
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

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-2 overflow-hidden" />
    </div>
  );
}
