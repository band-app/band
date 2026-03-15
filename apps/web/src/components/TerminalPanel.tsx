import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

interface TerminalPanelProps {
  workspaceId: string;
  visible: boolean;
}

export function TerminalPanel({ workspaceId, visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    // Dynamic import so @xterm (CJS) is never evaluated during SSR
    Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([{ Terminal: XTerm }, { FitAddon: XFitAddon }]) => {
        if (cancelled || !containerRef.current) return;

        // CSS loaded on client only
        import("@xterm/xterm/css/xterm.css");

        const terminal = new XTerm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
          theme: {
            background: "#181818",
            foreground: "#e8e8e8",
            cursor: "#e8e8e8",
            selectionBackground: "rgba(255, 255, 255, 0.2)",
          },
        });

        const fitAddon = new XFitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current!);

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Connect WebSocket
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${proto}//${location.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}`,
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
      },
    );

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [workspaceId]);

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

  return <div ref={containerRef} className="h-full w-full overflow-hidden p-3" />;
}
