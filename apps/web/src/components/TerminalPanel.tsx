import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { openExternalUrl } from "../lib/open-external-url";

interface TerminalPanelProps {
  workspaceId: string;
  terminalId: string;
  visible: boolean;
}

export function TerminalPanel({ workspaceId, terminalId, visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
        macOptionIsMeta: true, // Alt+Left/Right → word navigation on macOS
        scrollback: 10000,
        theme: {
          background: "#181818",
          foreground: "#e8e8e8",
          cursor: "#e8e8e8",
          selectionBackground: "rgba(255, 255, 255, 0.2)",
        },
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

      // Connect WebSocket
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${location.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(terminalId)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        fitAddon.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      };

      ws.onmessage = (event) => {
        terminal.write(event.data);
      };

      ws.onclose = () => {
        terminal.write("\r\n\x1b[90m[Terminal disconnected]\x1b[0m\r\n");
      };

      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
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
        resizeObserver.disconnect();
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
  }, [terminalId, workspaceId]);

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

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-2 overflow-hidden" />
    </div>
  );
}
