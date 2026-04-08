import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import { getTerminalSession, killTerminal, resizeTerminal, spawnTerminal } from "./terminal-manager";

const log = createLogger("terminal-ws");

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const workspaceId = url.searchParams.get("workspaceId");
  const terminalId = url.searchParams.get("terminalId");

  if (!workspaceId || !terminalId) {
    ws.close(4000, "Missing workspaceId or terminalId");
    return;
  }

  // Try reconnection first, otherwise spawn a new terminal
  let session = getTerminalSession(terminalId);
  if (!session) {
    try {
      session = await spawnTerminal(workspaceId, terminalId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to spawn terminal %s for workspace %s: %s", terminalId, workspaceId, message);
      ws.close(4001, message);
      return;
    }
  }

  log.debug("Terminal connected: %s (workspace %s)", terminalId, workspaceId);

  // Replay buffered scrollback so the client sees previous output.
  // Strip terminal query sequences (e.g. cursor position request \x1b[6n)
  // that would cause xterm.js to send spurious responses back to the PTY.
  if (session.scrollback.length > 0) {
    ws.send(stripTerminalQueries(session.scrollback));
  }

  // PTY output -> WebSocket
  const dataDisposable = session.pty.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  // PTY exit -> close WebSocket
  const exitDisposable = session.pty.onExit(({ exitCode }) => {
    log.debug("PTY exited with code %d for terminal %s", exitCode, terminalId);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Terminal exited");
    }
  });

  // WebSocket input -> PTY
  ws.on("message", (data: Buffer | string) => {
    const message = data.toString();
    // Check for JSON commands
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          resizeTerminal(terminalId, parsed.cols, parsed.rows);
          return;
        }
        if (parsed.type === "close") {
          killTerminal(terminalId);
          ws.close(1000, "Terminal closed by client");
          return;
        }
      } catch {
        // Not valid JSON, treat as regular input
      }
    }
    session.pty.write(message);
  });

  // WebSocket close -> detach listeners but keep PTY alive
  ws.on("close", () => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    log.debug("Terminal disconnected: %s (PTY kept alive)", terminalId);
  });
}

/**
 * Strip terminal query/request escape sequences from scrollback so
 * replaying them doesn't cause xterm.js to emit spurious responses.
 *
 * Covers:
 *  \x1b[6n   — Cursor Position Report (DSR CPR)
 *  \x1b[?6n  — Extended CPR
 *  \x1b[5n   — Device Status Report
 *  \x1b[c    — Primary Device Attributes (DA1)
 *  \x1b[>c   — Secondary Device Attributes (DA2)
 *  \x1b[=c   — Tertiary Device Attributes (DA3)
 */
function stripTerminalQueries(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[\??[0-9]*[nc]|\x1b\[>[0-9]*c|\x1b\[=[0-9]*c/g, "");
}
