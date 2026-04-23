import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import {
  getTerminalSession,
  killTerminal,
  resizeTerminal,
  type SpawnOptions,
  spawnTerminal,
} from "./terminal-manager";

const log = createLogger("terminal-ws");

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const workspaceId = url.searchParams.get("workspaceId");
  const terminalId = url.searchParams.get("terminalId");

  if (!workspaceId || !terminalId) {
    ws.close(4000, "Missing workspaceId or terminalId");
    return;
  }

  // Reconnection: reuse existing PTY session
  const existing = getTerminalSession(terminalId);
  if (existing) {
    attachSession(ws, terminalId, workspaceId, existing, false);
    return;
  }

  // New terminal: wait for the first message which may be an `init` with
  // spawn options (command, cwd, env). If the first message is NOT an init,
  // spawn with defaults and process the message normally.
  ws.once("message", async (data: Buffer | string) => {
    const message = data.toString();

    let spawnOpts: SpawnOptions | undefined;
    let pendingMessage: string | undefined;

    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "init") {
          spawnOpts = {
            command: typeof parsed.command === "string" ? parsed.command : undefined,
            cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
            env:
              parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
                ? (parsed.env as Record<string, string>)
                : undefined,
          };
        } else {
          // Not an init message — spawn with defaults and queue for processing
          pendingMessage = message;
        }
      } catch {
        // Not valid JSON — treat as raw terminal input
        pendingMessage = message;
      }
    } else {
      pendingMessage = message;
    }

    let session: Awaited<ReturnType<typeof spawnTerminal>>;
    try {
      session = await spawnTerminal(workspaceId, terminalId, spawnOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to spawn terminal %s for workspace %s: %s", terminalId, workspaceId, msg);
      ws.close(4001, msg);
      return;
    }

    attachSession(ws, terminalId, workspaceId, session, true);

    // Process the queued message (resize, close, or raw input)
    if (pendingMessage) {
      handleMessage(ws, terminalId, session, pendingMessage);
    }
  });

  // If the WebSocket closes before any message arrives, do nothing
  ws.once("close", () => {
    ws.removeAllListeners("message");
  });
}

// ---------------------------------------------------------------------------
// Attach a PTY session to a WebSocket
// ---------------------------------------------------------------------------

interface TerminalSession {
  pty: {
    onData: (cb: (data: string) => void) => { dispose: () => void };
    onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void };
    write: (data: string) => void;
  };
  scrollback: string;
  workspaceId: string;
}

function attachSession(
  ws: WebSocket,
  terminalId: string,
  workspaceId: string,
  session: TerminalSession,
  isNew: boolean,
): void {
  log.debug(
    "Terminal %s: %s (workspace %s)",
    isNew ? "connected" : "reconnected",
    terminalId,
    workspaceId,
  );

  // Replay buffered scrollback so the client sees previous output.
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
    handleMessage(ws, terminalId, session, data.toString());
  });

  // WebSocket close -> detach listeners but keep PTY alive
  ws.on("close", () => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    log.debug("Terminal disconnected: %s (PTY kept alive)", terminalId);
  });
}

// ---------------------------------------------------------------------------
// Handle a single WebSocket message
// ---------------------------------------------------------------------------

function handleMessage(
  ws: WebSocket,
  terminalId: string,
  session: TerminalSession,
  message: string,
): void {
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
      if (parsed.type === "init") {
        // Init after session is already established — ignore
        return;
      }
    } catch {
      // Not valid JSON, treat as regular input
    }
  }
  session.pty.write(message);
}

// ---------------------------------------------------------------------------
// Strip terminal query escape sequences from scrollback
// ---------------------------------------------------------------------------

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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — matching real ESC sequences in terminal output
  return data.replace(/\x1b\[\??[0-9]*[nc]|\x1b\[>[0-9]*c|\x1b\[=[0-9]*c/g, "");
}
