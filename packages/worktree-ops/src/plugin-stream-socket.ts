/**
 * The WebSocket a viewer holds to a plugin's live stream. The hub's
 * `/api/plugins/<id>/worktrees/<worktree>/stream` route and a worker's direct listener both serve
 * it, each over its own way of opening the stream.
 *
 * The plugin's text messages go down as text frames and its bytes as binary frames. A session
 * starts view-only: every message from the viewer is dropped, except the mode request
 * `{"type":"control","enabled":true}`, until the viewer asks for control. Binary frames from the
 * viewer are always dropped.
 */

import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";

const log = createLogger("plugin-stream");

/** Most bytes the viewer may send in one message. Input messages are small JSON. */
export const MAX_INPUT_BYTES = 64 * 1024;

/** A stream opened for one viewer. */
export interface PluginStreamLink {
  messages: AsyncIterable<string | Uint8Array>;
  send(message: string): void;
  close(): void;
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

/**
 * Connects `ws` to the stream `open` returns. A stream that cannot open ends in `onOpenFailed`
 * with the reason, which closes the socket.
 */
export async function bridgePluginStream(
  ws: WebSocket,
  label: string,
  open: () => Promise<PluginStreamLink>,
  onOpenFailed: (message: string) => void,
): Promise<void> {
  let controlling = false;
  let stream: PluginStreamLink | null = null;

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) return;
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString(
      "utf8",
    );
    const enabled = parseModeRequest(text);
    if (enabled !== null) {
      controlling = enabled;
      log.debug("%s is now %s", label, enabled ? "controlled" : "view-only");
      return;
    }
    if (controlling && stream && text.length <= MAX_INPUT_BYTES) stream.send(text);
  });
  ws.once("close", () => stream?.close());

  try {
    stream = await open();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("%s is unavailable: %s", label, message);
    onOpenFailed(message);
    return;
  }
  if (ws.readyState !== ws.OPEN) {
    stream.close();
    return;
  }

  try {
    for await (const message of stream.messages) {
      if (ws.readyState !== ws.OPEN) break;
      // Waiting for the send keeps a slow viewer from queueing the stream in memory.
      await new Promise<void>((resolve) =>
        ws.send(message, { binary: typeof message !== "string" }, () => resolve()),
      );
    }
  } catch (err) {
    log.warn("%s failed: %s", label, (err as Error).message);
  } finally {
    stream.close();
    if (ws.readyState === ws.OPEN) ws.close(1000, "The stream ended");
  }
}
