import type { IncomingMessage } from "node:http";
import type { Duplex } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import { hostRegistry } from "./registry";

const log = createLogger("desktop-proxy");

/** Matches `/api/hosts/<id>/desktop`. The id is a `hosts` row id, or `local`. */
const DESKTOP_PATH = /^\/api\/hosts\/([^/]+)\/desktop$/;

/** The host id a desktop upgrade names, or null when the path is some other route. */
export function desktopHostId(pathname: string): string | null {
  const match = DESKTOP_PATH.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Hosts that have a viewer now. A second viewer is refused rather than sharing the pointer. */
const viewers = new Set<string>();

/** Most bytes a viewer may send before the host has opened the desktop. */
const MAX_PENDING_BYTES = 64 * 1024;

/** noVNC offers `binary`. Take it when offered, else the `band` protocol the other routes use. */
export function selectDesktopProtocol(protocols: Set<string>): string | false {
  if (protocols.has("binary")) return "binary";
  return protocols.has("band") ? "band" : false;
}

/**
 * Bridges a viewer's WebSocket to the host's x11vnc. Binary frames from the viewer go to x11vnc
 * as they are, and x11vnc's bytes go back as binary frames, so the viewer speaks plain RFB.
 * The host's `desktop.open` rejects with a message that names what is missing, which closes the
 * socket with code 4001 and that message as the reason.
 */
export async function handleDesktopConnection(
  ws: WebSocket,
  req: IncomingMessage,
  hostId: string,
): Promise<void> {
  if (viewers.has(hostId)) {
    ws.close(4409, "Another viewer is already connected to this desktop");
    return;
  }
  viewers.add(hostId);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    viewers.delete(hostId);
  };

  // Frames the viewer sends while the host is still opening the desktop would be dropped.
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let desktop: Duplex | null = null;
  let opened = false;
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const chunk = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data))
        : data;
    if (desktop) {
      desktop.write(chunk);
      return;
    }
    pendingBytes += chunk.length;
    if (pendingBytes > MAX_PENDING_BYTES) {
      ws.close(1009, "Too much data before the desktop opened");
      return;
    }
    pending.push(chunk);
  });
  ws.once("close", () => {
    desktop?.close();
    release();
  });

  try {
    desktop = await hostRegistry.hostById(hostId).desktop.open();
    opened = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("desktop of host %s is unavailable: %s", hostId, message);
    release();
    ws.close(4001, message.slice(0, 120));
    return;
  }
  if (ws.readyState !== ws.OPEN) {
    desktop.close();
    release();
    return;
  }

  log.debug("desktop viewer connected: %s (%s)", hostId, req.socket.remoteAddress ?? "unknown");
  for (const chunk of pending.splice(0)) desktop.write(chunk);

  try {
    for await (const bytes of desktop.output) {
      if (ws.readyState !== ws.OPEN) break;
      // Waiting for the send keeps a slow viewer from queueing the whole stream in memory.
      await new Promise<void>((resolve) => ws.send(bytes, { binary: true }, () => resolve()));
    }
  } catch (err) {
    log.warn("desktop stream of host %s failed: %s", hostId, (err as Error).message);
  } finally {
    if (opened) {
      desktop.close();
      release();
      if (ws.readyState === ws.OPEN) ws.close(1000, "The desktop connection ended");
    }
  }
}
