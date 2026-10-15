import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import { attachSession, createInbox, safeClose } from "@band-app/worktree-ops/terminal-socket";
import type { WebSocket } from "ws";
import { type SpawnOptions, terminalService } from "../../services/terminal-service";

const log = createLogger("terminal-ws");

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  if (!req.url) {
    safeClose(ws, 4000, "Missing request URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const worktreeId = url.searchParams.get("worktreeId");
  const terminalId = url.searchParams.get("terminalId");

  if (!worktreeId || !terminalId) {
    safeClose(ws, 4000, "Missing worktreeId or terminalId");
    return;
  }

  const inbox = createInbox(ws);

  // Reconnection: reuse existing PTY session
  let existing: boolean;
  try {
    existing = (await terminalService.info(terminalId)) !== null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to look up terminal %s: %s", terminalId, msg);
    // Not a 4xxx: the lookup can fail transiently (the terminal daemon
    // restarting), so let the client reconnect with backoff.
    safeClose(ws, 1011, msg);
    return;
  }
  if (inbox.closed) return;
  if (existing) {
    attachSession(terminalService, ws, inbox, terminalId, worktreeId, false);
    return;
  }

  // New terminal: wait for the first message which may be an `init` with
  // spawn options (command, cwd, env). If the first message is NOT an init,
  // spawn with defaults and process the message normally. If the socket
  // closes before any message arrives, do nothing.
  const message = await inbox.next();
  if (message === null) return;

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
        // round-trip. Synthesize the same `attach` control message the
        // reconnect path uses so replay flows through a single code path.
        const cols = Number.isFinite(parsed.cols) ? (parsed.cols as number) : undefined;
        const rows = Number.isFinite(parsed.rows) ? (parsed.rows as number) : undefined;
        // Explicit `> 0` (not truthiness) to match `startReplay`'s guard.
        if (cols !== undefined && rows !== undefined && cols > 0 && rows > 0) {
          pendingMessage = JSON.stringify({
            type: "attach",
            cols,
            rows,
            flow: parsed.flow === true,
          });
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

  try {
    await terminalService.spawn(worktreeId, terminalId, spawnOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to spawn terminal %s for worktree %s: %s", terminalId, worktreeId, msg);
    safeClose(ws, 4001, msg);
    return;
  }
  if (inbox.closed) return;

  // The queued first message (a synthesized `attach`, a `resize`, or raw
  // input) is processed inside `attachSession` so it goes through the same
  // `attach`-intercepting path as every later message.
  attachSession(terminalService, ws, inbox, terminalId, worktreeId, true, pendingMessage);
}
