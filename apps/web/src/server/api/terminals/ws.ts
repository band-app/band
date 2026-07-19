import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import type { IDisposable } from "node-pty";
import type { WebSocket } from "ws";
import {
  type SpawnOptions,
  type TerminalSession,
  terminalService,
} from "../../services/terminal-service";
import { stripTerminalQueries } from "./strip-queries";

const log = createLogger("terminal-ws");

// RFC 6455 (§5.5.1) caps WebSocket close reasons at 123 bytes (125 total
// payload minus the 2-byte status code). `ws` enforces this in
// `_Sender.close` and *throws* — asynchronously, as an Unhandled Rejection
// that crashes the server — when we hand it a longer string. We pass
// dynamic error messages here (e.g. `Workspace directory does not exist: <
// long absolute path >`) which routinely cross the limit, so every
// reason string is clamped to fit. We also send the full error as a JSON
// frame *before* the close so the client still surfaces the real message
// rather than the truncated tail.
const MAX_CLOSE_REASON_BYTES = 123;

// Server-side protocol-ping cadence. Every interval we ping the client and
// terminate the socket if the previous ping went unanswered — so a client
// that slept or dropped off the network is reaped within one interval instead
// of lingering with live listeners. The PTY is kept alive regardless (see the
// close handler) so the client can reconnect. 30s is lenient enough not to
// race a briefly-backgrounded tab whose timers are throttled.
const HEARTBEAT_INTERVAL_MS = 30_000;

function clampCloseReason(reason: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(reason);
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  // Truncate at a codepoint boundary by re-decoding the byte slice with the
  // fatal flag — TextDecoder defaults to replacing partial sequences with
  // U+FFFD, which would silently widen the byte count again. We back off
  // one byte at a time until the slice decodes cleanly.
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (let end = MAX_CLOSE_REASON_BYTES; end > 0; end--) {
    try {
      return dec.decode(bytes.subarray(0, end));
    } catch {
      // partial multi-byte sequence at the boundary — back off
    }
  }
  return "";
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  // Surface the full reason as a JSON frame before closing so the client
  // can display it. Closing immediately afterwards means the frame is sent
  // in the same flush as the close frame (ws coalesces); if the socket
  // happens to already be CLOSING/CLOSED, `send` is a no-op.
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "error", message: reason }));
    } catch {
      // send failures aren't actionable here — fall through to close
    }
  }
  ws.close(code, clampCloseReason(reason));
}

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  if (!req.url) {
    safeClose(ws, 4000, "Missing request URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const workspaceId = url.searchParams.get("workspaceId");
  const terminalId = url.searchParams.get("terminalId");

  if (!workspaceId || !terminalId) {
    safeClose(ws, 4000, "Missing workspaceId or terminalId");
    return;
  }

  // Reconnection: reuse existing PTY session
  const existing = terminalService.getSession(terminalId);
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
              parsed.env &&
              typeof parsed.env === "object" &&
              !Array.isArray(parsed.env) &&
              // A client could send non-string values (e.g. a number); the PTY
              // spawn expects a string map, so reject the whole env field
              // rather than silently passing a non-string through.
              Object.values(parsed.env).every((v) => typeof v === "string")
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

    let session: TerminalSession;
    try {
      session = await terminalService.spawn(workspaceId, terminalId, spawnOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to spawn terminal %s for workspace %s: %s", terminalId, workspaceId, msg);
      safeClose(ws, 4001, msg);
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

  // Live-output forwarder. Registered by the async replay block below only
  // AFTER the replay snapshot has been sent, so replayed state and live
  // bytes can never interleave out of order; `serialize` pauses the PTY
  // while it drains, which guarantees no output is lost or duplicated in
  // between.
  let dataDisposable: IDisposable | undefined;
  let closed = false;

  // Poll the PTY foreground process name and send title updates (text/JSON frames).
  // This mimics how iTerm detects the running command without relying on OSC sequences.
  // 3 s is a deliberate trade-off: a 1 s poll picked up `cd`/`vim` transitions
  // ~2 s sooner but kept the event loop awake at 1 Hz for every open terminal,
  // which compounds when several PTYs are open. 3 s is fast enough that title
  // updates still feel near-instant to a user reading the change.
  let lastProcess = "";
  const processInterval = setInterval(() => {
    try {
      const currentProcess = session.pty.process;
      if (currentProcess && currentProcess !== lastProcess) {
        lastProcess = currentProcess;
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "title", title: currentProcess }));
        }
      }
    } catch {
      // pty.process can throw if the process has exited
    }
  }, 3000);

  // PTY exit -> close WebSocket
  const exitDisposable = session.pty.onExit(({ exitCode }) => {
    clearInterval(processInterval);
    log.debug("PTY exited with code %d for terminal %s", exitCode, terminalId);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Terminal exited");
    }
  });

  // Protocol-level heartbeat: reap server sockets whose client vanished
  // (machine slept, network dropped) so their listeners don't leak. The PTY
  // is intentionally left alive — `ws.on("close")` keeps it — so the client
  // can reconnect and resume. `ws.ping()` triggers a TCP-level pong from any
  // live peer; if the previous ping went unanswered we terminate.
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
  });
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      ws.terminate();
      return;
    }
    isAlive = false;
    try {
      ws.ping();
    } catch {
      // socket already closing — the close handler will clean up
    }
  }, HEARTBEAT_INTERVAL_MS);

  // WebSocket input -> PTY
  ws.on("message", (data: Buffer | string) => {
    handleMessage(ws, terminalId, session, data.toString());
  });

  // WebSocket close -> detach listeners but keep PTY alive
  ws.on("close", () => {
    closed = true;
    clearInterval(processInterval);
    clearInterval(pingInterval);
    dataDisposable?.dispose();
    exitDisposable.dispose();
    log.debug("Terminal disconnected: %s (PTY kept alive)", terminalId);
  });

  // Replay a serialized reconstruction of the terminal state so the client
  // sees previous output, then wire up live forwarding. The raw scrollback
  // buffer is NOT replayed: its tail slice can start mid-escape-sequence,
  // which garbles TUI apps that draw with relative cursor motion
  // (claude-code, vim) after a reload/reconnect. The serialize output
  // shouldn't contain query escapes, but stripTerminalQueries stays as the
  // #613 guard (OSC 10/11 color *sets* replayed from scrollback are report
  // forms it strips too). Sent as a binary frame so the client can
  // distinguish it from JSON control messages.
  void (async () => {
    // Replay is best-effort: a serialize failure (e.g. the PTY dying
    // mid-drain) must not abandon the attach, or the client would hold an
    // OPEN socket that accepts keystrokes but never shows output. The
    // forwarder below is registered no matter what.
    let snapshot: string | null = null;
    try {
      snapshot = await terminalService.serialize(terminalId);
    } catch (err) {
      log.error("Failed to serialize terminal %s for replay: %s", terminalId, err);
    }
    if (closed) return;
    if (snapshot && ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(stripTerminalQueries(snapshot)));
    }

    // PTY output -> WebSocket (binary frames)
    dataDisposable = session.pty.onData((data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(data));
      }
    });

    // The snapshot restores the pixels, but a live full-screen TUI doesn't
    // know a client re-attached and won't repaint on its own — and the
    // client's follow-up resize carries unchanged dims, so it produces no
    // SIGWINCH. Nudge the PTY so the app redraws. Skipped on a fresh spawn
    // (nothing drawn yet) and when there was no state to replay.
    if (!isNew && snapshot) {
      terminalService.nudgeResize(terminalId);
    }
  })().catch((err) => {
    log.error("Failed to replay terminal %s: %s", terminalId, err);
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
      if (parsed.type === "ping") {
        // Application-level heartbeat. The browser WebSocket API can't send
        // or observe protocol-level ping/pong, so the client pings over the
        // data channel and relies on this pong to detect a dead socket after
        // sleep / network loss.
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        terminalService.resize(terminalId, parsed.cols, parsed.rows);
        return;
      }
      if (parsed.type === "close") {
        terminalService.kill(terminalId);
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
