import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import { pluginHost } from "../../services/plugin-host-service";

const log = createLogger("plugin-stream");

/** Matches `/api/plugins/<plugin id>/worktrees/<worktree id>/stream`. */
const STREAM_PATH = /^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/worktrees\/([^/]+)\/stream$/;

/** The plugin and worktree a stream upgrade names, or null when the path is some other route. */
export function pluginStreamTarget(
  pathname: string,
): { pluginId: string; worktreeId: string } | null {
  const match = STREAM_PATH.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { pluginId: match[1], worktreeId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/** A text frame the viewer sends to switch between view-only and control, as the desktop viewer does. */
function parseModeRequest(text: string): boolean | null {
  try {
    const msg = JSON.parse(text) as { type?: unknown; enabled?: unknown };
    if (msg.type === "control" && typeof msg.enabled === "boolean") return msg.enabled;
  } catch {
    // Not JSON, so not a request.
  }
  return null;
}

/** Most bytes the viewer may send in one message. Input messages are small JSON. */
export const MAX_INPUT_BYTES = 64 * 1024;

/**
 * Bridges a viewer's WebSocket to a plugin's live stream on the worktree's worker. The plugin's
 * text messages go down as text frames and its bytes as binary frames. A session starts
 * view-only: every message from the viewer is dropped, except the mode request
 * `{"type":"control","enabled":true}`, until the viewer asks for control. Binary frames from the
 * viewer are always dropped. A stream the worker cannot open closes the socket with code 4001 and
 * the reason.
 */
export async function handlePluginStream(
  ws: WebSocket,
  req: IncomingMessage,
  target: { pluginId: string; worktreeId: string },
): Promise<void> {
  let controlling = false;
  let stream: Awaited<ReturnType<typeof pluginHost.openStream>> | null = null;

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) return;
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString(
      "utf8",
    );
    const enabled = parseModeRequest(text);
    if (enabled !== null) {
      controlling = enabled;
      log.debug(
        "%s stream of %s is now %s",
        target.pluginId,
        target.worktreeId,
        enabled ? "controlled" : "view-only",
      );
      return;
    }
    if (controlling && stream && text.length <= MAX_INPUT_BYTES) stream.send(text);
  });
  ws.once("close", () => stream?.close());

  try {
    stream = await pluginHost.openStream(target.pluginId, target.worktreeId, "screen");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("%s stream of %s is unavailable: %s", target.pluginId, target.worktreeId, message);
    ws.close(4001, message.slice(0, 120));
    return;
  }
  if (ws.readyState !== ws.OPEN) {
    stream.close();
    return;
  }

  log.debug(
    "%s viewer connected: %s (%s)",
    target.pluginId,
    target.worktreeId,
    req.socket.remoteAddress ?? "unknown",
  );
  try {
    for await (const message of stream.messages) {
      if (ws.readyState !== ws.OPEN) break;
      // Waiting for the send keeps a slow viewer from queueing the stream in memory.
      await new Promise<void>((resolve) =>
        ws.send(message, { binary: typeof message !== "string" }, () => resolve()),
      );
    }
  } catch (err) {
    log.warn(
      "%s stream of %s failed: %s",
      target.pluginId,
      target.worktreeId,
      (err as Error).message,
    );
  } finally {
    stream.close();
    if (ws.readyState === ws.OPEN) ws.close(1000, "The stream ended");
  }
}
