/**
 * The `/terminal` WebSocket protocol, after the server has found or spawned
 * the PTY: request-driven replay (`attach`), parse acknowledgements (`ack`),
 * input, `resize`, `ping`, `close`, title and exit frames. The hub's
 * `/terminal` route and a worker's direct listener
 * both serve it, each over its own terminal backend.
 */

import type { TerminalAttachment, TerminalExitEvent } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";

import { OutputFlow } from "./output-flow";
import { stripTerminalQueries } from "./strip-queries";

/** What the protocol needs from wherever the terminal's PTY lives. */
export interface TerminalSocketBackend {
  attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null>;
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  nudgeResize(terminalId: string): void;
  kill(terminalId: string): Promise<unknown>;
  onExit(terminalId: string, listener: (event: TerminalExitEvent) => void): () => void;
  /** The terminal's foreground process name, every few seconds. */
  onTitle(terminalId: string, listener: (title: string) => void): () => void;
}

const log = createLogger("terminal-ws");

// RFC 6455 (§5.5.1) caps WebSocket close reasons at 123 bytes (125 total
// payload minus the 2-byte status code). `ws` enforces this in
// `_Sender.close` and *throws* — asynchronously, as an Unhandled Rejection
// that crashes the server — when we hand it a longer string. We pass
// dynamic error messages here (e.g. `Worktree directory does not exist: <
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

export function clampCloseReason(reason: string): string {
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

export function safeClose(ws: WebSocket, code: number, reason: string): void {
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

/**
 * Inbound frames, buffered from the moment the socket opens. The handler
 * awaits the backend (an existence check, a spawn) before it can decide what
 * a frame means, and `ws` drops frames that arrive while no `message`
 * listener is registered — the client's `init` / `attach` would be lost.
 */
export interface Inbox {
  readonly closed: boolean;
  /** Next frame, or `null` once the socket closes. */
  next(): Promise<string | null>;
  /** Hand every queued and future frame to `handler`. */
  listen(handler: (message: string) => void): void;
}

export function createInbox(ws: WebSocket): Inbox {
  const queue: string[] = [];
  let handler: ((message: string) => void) | null = null;
  let waiter: ((message: string | null) => void) | null = null;
  let closed = false;
  ws.on("message", (data: Buffer | string) => {
    const message = data.toString();
    if (handler) {
      handler(message);
    } else if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(message);
    } else {
      queue.push(message);
    }
  });
  ws.once("close", () => {
    closed = true;
    waiter?.(null);
    waiter = null;
  });
  return {
    get closed() {
      return closed;
    },
    next() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    listen(next) {
      handler = next;
      for (let message = queue.shift(); message !== undefined; message = queue.shift()) {
        next(message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Attach a PTY session to a WebSocket
// ---------------------------------------------------------------------------

export function attachSession(
  backend: TerminalSocketBackend,
  ws: WebSocket,
  inbox: Inbox,
  terminalId: string,
  worktreeId: string,
  isNew: boolean,
  pendingMessage?: string,
): void {
  log.debug(
    "Terminal %s: %s (worktree %s)",
    isNew ? "connected" : "reconnected",
    terminalId,
    worktreeId,
  );

  // Live-output subscription, created by `startReplay` below. It hands over
  // the snapshot first and only then starts forwarding, so replayed state
  // and live bytes can never interleave out of order, and its `seq` cut
  // guarantees no chunk is lost or duplicated in between.
  let attachment: TerminalAttachment | null = null;
  // Backpressure for the live output below, created with the attachment.
  let flow: OutputFlow | null = null;
  let closed = false;
  let replayStarted = false;

  // Send the PTY's foreground process name as title updates (text/JSON
  // frames), only when it changes. The backend's `onTitle` polls once for
  // every open terminal.
  let lastProcess = "";
  const unsubscribeTitle = backend.onTitle(terminalId, (currentProcess) => {
    if (currentProcess === lastProcess) return;
    lastProcess = currentProcess;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "title", title: currentProcess }));
    }
  });

  // PTY exit -> close WebSocket
  const unsubscribeExit = backend.onExit(terminalId, (event) => {
    unsubscribeTitle();
    log.debug("PTY exited with code %d for terminal %s", event.exitCode, terminalId);
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
  // the wrong columns (a reload with a stale mirror width). The backend
  // resizes the PTY + mirror to the client dims BEFORE serializing to
  // establish that invariant. The raw scrollback buffer is NOT replayed: its
  // tail slice can start mid-escape-sequence, which garbles TUI apps that
  // draw with relative cursor motion (claude-code, vim). The serialize output
  // shouldn't contain query escapes, but stripTerminalQueries stays as the
  // #613 guard (OSC 10/11 color *sets* replayed from scrollback are report
  // forms it strips too). Sent as a binary frame so the client can
  // distinguish it from JSON control messages.
  const startReplay = async (cols?: number, rows?: number, acks = false): Promise<void> => {
    if (replayStarted) return;
    replayStarted = true;

    // Falls back to the mirror's current dims if the client sent none.
    const dims =
      cols !== undefined && rows !== undefined && cols > 0 && rows > 0 ? { cols, rows } : undefined;
    let attached: TerminalAttachment | null;
    try {
      attached = await backend.attach(terminalId, dims);
    } catch (err) {
      // Not a 4xxx: the backend can fail transiently (the terminal daemon
      // restarting), so let the client reconnect and attach again.
      log.error("Failed to attach terminal %s: %s", terminalId, err);
      safeClose(ws, 1011, "Terminal attach failed");
      return;
    }
    if (closed) {
      attached?.detach();
      return;
    }
    if (!attached) {
      // The PTY exited between the connect and the attach.
      if (ws.readyState === ws.OPEN) ws.close(1000, "Terminal exited");
      return;
    }
    attachment = attached;
    const output = new OutputFlow(ws, attached);
    flow = output;
    // A client that sends `flow: true` acknowledges every binary frame,
    // snapshot included, once xterm has parsed it.
    if (acks) output.enableAcks();
    const sendOutput = (data: string) => {
      if (ws.readyState !== ws.OPEN) return;
      const bytes = Buffer.from(data);
      ws.send(bytes);
      output.noteSent(bytes.length);
    };

    // PTY output -> WebSocket (binary frames). Started in a `finally` so a
    // synchronous `ws.send` throw on the snapshot (this file documents `ws`
    // throwing) cannot skip the forwarder and wedge an OPEN socket.
    try {
      if (attached.snapshot.length > 0) sendOutput(stripTerminalQueries(attached.snapshot));
    } finally {
      attached.start(sendOutput);
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
    if (!isNew && attached.snapshot.length > 0) {
      backend.nudgeResize(terminalId);
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
          void startReplay(cols, rows, parsed.flow === true).catch((err) => {
            log.error("Failed to replay terminal %s: %s", terminalId, err);
          });
          return;
        }
        if (parsed.type === "ack") {
          if (Number.isFinite(parsed.bytes) && parsed.bytes > 0) flow?.ack(parsed.bytes as number);
          return;
        }
      } catch {
        // Not valid JSON — fall through to the raw-input path.
      }
    }
    handleMessage(backend, ws, terminalId, message);
  };

  // WebSocket close -> detach listeners but keep PTY alive
  ws.on("close", () => {
    closed = true;
    unsubscribeTitle();
    clearInterval(pingInterval);
    flow?.dispose();
    attachment?.detach();
    unsubscribeExit();
    log.debug("Terminal disconnected: %s (PTY kept alive)", terminalId);
  });

  // Process the queued first message (a synthesized `attach` folding the
  // client's initial dims, a `resize`, or raw input) first, then every frame
  // the inbox buffered while the spawn / lookup was in flight.
  if (pendingMessage) {
    processMessage(pendingMessage);
  }
  inbox.listen(processMessage);
}

// ---------------------------------------------------------------------------
// Handle a single WebSocket message
// ---------------------------------------------------------------------------

function handleMessage(
  backend: TerminalSocketBackend,
  ws: WebSocket,
  terminalId: string,
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
        backend.resize(terminalId, parsed.cols as number, parsed.rows as number);
        return;
      }
      if (parsed.type === "close") {
        void backend.kill(terminalId).catch((err) => {
          log.error("Failed to kill terminal %s: %s", terminalId, err);
        });
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
  backend.input(terminalId, message);
}
