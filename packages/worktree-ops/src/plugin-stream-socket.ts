/**
 * The WebSocket a viewer holds to a plugin's live stream. The hub's
 * `/api/plugins/<id>/worktrees/<worktree>/stream` route and a worker's direct listener both serve
 * it, each over its own way of opening the stream.
 *
 * The plugin's text messages go down as text frames and its bytes as binary frames. A session
 * passes the viewer's text messages to the plugin from the start. The legacy mode request
 * `{"type":"control",...}` is accepted and ignored. Binary frames from the viewer are always
 * dropped.
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

/** The legacy mode request a page may still send. It has no effect. */
function isModeRequest(text: string): boolean {
  try {
    const msg = JSON.parse(text) as { type?: unknown; enabled?: unknown };
    return msg.type === "control" && typeof msg.enabled === "boolean";
  } catch {
    return false;
  }
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
  let stream: PluginStreamLink | null = null;

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) return;
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString(
      "utf8",
    );
    if (isModeRequest(text)) return;
    if (stream && text.length <= MAX_INPUT_BYTES) stream.send(text);
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
