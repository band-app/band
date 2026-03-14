import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
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

    const terminal = new Terminal({
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

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

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
      // Send initial terminal size
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

    // Terminal input -> WebSocket
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Auto-fit on container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [workspaceId]);

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
      });
    }
  }, [visible]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
