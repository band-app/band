import type { IncomingMessage } from "node:http";
import { createLogger } from "@band/logger";
import type { WebSocket } from "ws";
import { getOrSpawnTerminal, resizeTerminal } from "./terminal-manager";

const log = createLogger("terminal-ws");

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const workspaceId = url.searchParams.get("workspaceId");

  if (!workspaceId) {
    ws.close(4000, "Missing workspaceId");
    return;
  }

  let session: Awaited<ReturnType<typeof getOrSpawnTerminal>>;
  try {
    session = await getOrSpawnTerminal(workspaceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to spawn terminal for workspace %s: %s", workspaceId, message);
    ws.close(4001, message);
    return;
  }

  log.debug("Terminal connected for workspace %s", workspaceId);

  // Replay buffered scrollback so the client sees previous output
  if (session.scrollback.length > 0) {
    ws.send(session.scrollback);
  }

  // PTY output -> WebSocket
  const dataDisposable = session.pty.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  // PTY exit -> close WebSocket
  const exitDisposable = session.pty.onExit(({ exitCode }) => {
    log.debug("PTY exited with code %d for workspace %s", exitCode, workspaceId);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Terminal exited");
    }
  });

  // WebSocket input -> PTY
  ws.on("message", (data: Buffer | string) => {
    const message = data.toString();
    // Check for resize command
    if (message.startsWith('{"type":"resize"')) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          resizeTerminal(workspaceId, parsed.cols, parsed.rows);
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
    log.debug("Terminal disconnected for workspace %s (PTY kept alive)", workspaceId);
  });
}
