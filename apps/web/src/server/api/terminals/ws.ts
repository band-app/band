import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
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
          // The client folds its fitted dims into the `init` when the panel is
          // already visible at connect, so replay can happen without a separate
          // round-trip (and without an `attach` racing into the gap between
          // this one-shot handler and the persistent listener `attachSession`
          // installs). Synthesize the same `attach` control message the
          // reconnect path uses so replay flows through a single code path.
          const cols = Number.isFinite(parsed.cols) ? (parsed.cols as number) : undefined;
          const rows = Number.isFinite(parsed.rows) ? (parsed.rows as number) : undefined;
          // Explicit `> 0` (not truthiness) to match `startReplay`'s guard.
          if (cols !== undefined && rows !== undefined && cols > 0 && rows > 0) {
            pendingMessage = JSON.stringify({ type: "attach", cols, rows });
          }
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

    // The queued first message (a synthesized `attach`, a `resize`, or raw
    // input) is processed inside `attachSession` so it goes through the same
    // `attach`-intercepting path as every later message.
    attachSession(ws, terminalId, workspaceId, session, true, pendingMessage);
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
  pendingMessage?: string,
): void {
  log.debug(
    "Terminal %s: %s (workspace %s)",
    isNew ? "connected" : "reconnected",
    terminalId,
    workspaceId,
  );

  // Live-output forwarder. Registered by `startReplay` below in the same
  // synchronous slot as the snapshot send, so replayed state and live bytes
  // can never interleave out of order; `serialize` pauses the PTY while it
  // drains, which guarantees no output is lost or duplicated in between.
  // Structural type rather than node-pty's IDisposable — this tier
  // deliberately never references node-pty (see terminal-service.ts).
  let dataDisposable: { dispose(): void } | undefined;
  let closed = false;
  let replayStarted = false;

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

  // Replay a serialized reconstruction of the terminal state so the client
  // sees previous output, then wire up live forwarding. Deferred until the
  // client sends an `attach` control message carrying its fitted { cols, rows
  // }: the snapshot MUST be serialized at exactly the width the client will
  // render it at, or xterm's wrapped-line reflow scatters the cells across
  // the wrong columns (a reload with a stale mirror width). Resizing the PTY
  // + mirror to the client dims BEFORE serializing establishes that
  // invariant. The raw scrollback buffer is NOT replayed: its tail slice can
  // start mid-escape-sequence, which garbles TUI apps that draw with relative
  // cursor motion (claude-code, vim). The serialize output shouldn't contain
  // query escapes, but stripTerminalQueries stays as the #613 guard (OSC
  // 10/11 color *sets* replayed from scrollback are report forms it strips
  // too). Sent as a binary frame so the client can distinguish it from JSON
  // control messages.
  const startReplay = async (cols?: number, rows?: number): Promise<void> => {
    if (replayStarted) return;
    replayStarted = true;

    // Resize the PTY + headless mirror to the client's render width FIRST, so
    // the serialized snapshot reconstructs the grid at that exact width and
    // nothing reflows between serialize and display. Falls back to the
    // mirror's current dims if the client sent none.
    if (cols !== undefined && rows !== undefined && cols > 0 && rows > 0) {
      terminalService.resize(terminalId, cols, rows);
    }

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

    // PTY output -> WebSocket (binary frames). Registered BEFORE the
    // snapshot send but in the same synchronous block, so no PTY chunk can
    // interleave ahead of the snapshot on the wire — and a synchronous
    // `ws.send` throw on the snapshot (this file documents `ws` throwing)
    // cannot skip the forwarder and wedge an OPEN socket.
    dataDisposable = session.pty.onData((data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(data));
      }
    });

    if (snapshot && ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(stripTerminalQueries(snapshot)));
    }

    // Acknowledge the attach even when there is no snapshot to send (a fresh
    // spawn with empty scrollback). The client suppresses container-driven
    // refits between requesting replay and receiving it; without this ack it
    // would never learn the request completed and stay suppressed.
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "attached" }));
    }

    // The snapshot restores the pixels, but a live full-screen TUI doesn't
    // know a client re-attached and won't repaint on its own — and the
    // client's follow-up resize carries unchanged dims, so it produces no
    // SIGWINCH. Nudge the PTY so the app redraws. Skipped on a fresh spawn
    // (nothing drawn yet) and when there was no state to replay.
    if (!isNew && snapshot) {
      terminalService.nudgeResize(terminalId);
    }
  };

  // WebSocket input -> PTY, with the `attach` control message intercepted to
  // drive the request-driven replay above. Everything else is forwarded to
  // the shared message handler.
  const processMessage = (message: string): void => {
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "attach") {
          // Reject non-positive dims at the call site (not just in startReplay's
          // own guard) so processMessage visibly validates before delegating.
          const cols =
            Number.isFinite(parsed.cols) && parsed.cols > 0 ? (parsed.cols as number) : undefined;
          const rows =
            Number.isFinite(parsed.rows) && parsed.rows > 0 ? (parsed.rows as number) : undefined;
          void startReplay(cols, rows).catch((err) => {
            log.error("Failed to replay terminal %s: %s", terminalId, err);
          });
          return;
        }
      } catch {
        // Not valid JSON — fall through to the raw-input path.
      }
    }
    handleMessage(ws, terminalId, session, message);
  };

  ws.on("message", (data: Buffer | string) => {
    processMessage(data.toString());
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

  // Process the queued first message (a synthesized `attach` folding the
  // client's initial dims, a `resize`, or raw input) through the same path.
  if (pendingMessage) {
    processMessage(pendingMessage);
  }
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
      if (
        parsed.type === "resize" &&
        Number.isFinite(parsed.cols) &&
        Number.isFinite(parsed.rows)
      ) {
        // Numeric validation matches the `attach` path; the pool clamps to a
        // sane range (see TerminalPool.resize).
        terminalService.resize(terminalId, parsed.cols as number, parsed.rows as number);
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
