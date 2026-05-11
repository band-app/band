import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import WebSocket, { type WebSocket as WsServerSocket } from "ws";
import {
  DESKTOP_CDP_HOST,
  DESKTOP_CDP_PORT,
  ensureCdpTargetId,
  markTargetDestroyed,
} from "./browser-host";

const log = createLogger("cdp-proxy");

/**
 * Proxy a WebSocket connection from the Band UI to the desktop's CDP
 * endpoint for a single Band browser tab.
 *
 * Query params:
 *   - bandTabId: Band's `browser_<uuid>` id. Resolved server-side to the
 *     current chromium target id via `browser-host.ts::ensureCdpTargetId`.
 *
 * Close codes:
 *   - 4000 — bad request (missing bandTabId)
 *   - 4001 — could not reach the desktop or its underlying chromium target
 */
export async function handleCdpConnection(ws: WsServerSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const bandTabId = url.searchParams.get("bandTabId");

  if (!bandTabId) {
    ws.close(4000, "Missing bandTabId");
    return;
  }

  // Buffer client messages that arrive before the upstream WS opens.
  // Mirrors the LSP proxy pattern: without this the client's first request
  // (CDP `Runtime.enable`, etc.) can be dropped.
  const pending: string[] = [];
  let upstream: WebSocket | null = null;

  ws.on("message", (raw) => {
    const data = raw.toString();
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    } else {
      pending.push(data);
    }
  });

  let cdpTargetId: string;
  try {
    cdpTargetId = await ensureCdpTargetId(bandTabId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("ensureCdpTargetId failed for %s: %s", bandTabId, message);
    if (ws.readyState === ws.OPEN) {
      ws.close(4001, message.slice(0, 123));
    }
    return;
  }

  const upstreamUrl = `ws://${DESKTOP_CDP_HOST}:${DESKTOP_CDP_PORT}/devtools/page/${encodeURIComponent(cdpTargetId)}`;
  log.info("CDP proxy connecting bandTabId=%s upstream=%s", bandTabId, upstreamUrl);

  upstream = new WebSocket(upstreamUrl);

  upstream.on("open", () => {
    log.info("CDP upstream open bandTabId=%s pending=%d", bandTabId, pending.length);
    for (const msg of pending) {
      upstream?.send(msg);
    }
    pending.length = 0;
  });

  upstream.on("message", (raw) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(raw.toString());
    }
  });

  upstream.on("error", (err) => {
    log.warn("CDP upstream error bandTabId=%s: %s", bandTabId, err.message);
    // Cached targetId may be stale (view destroyed without notifying us).
    markTargetDestroyed(bandTabId);
    if (ws.readyState === ws.OPEN) {
      ws.close(4001, `Desktop CDP error: ${err.message}`.slice(0, 123));
    }
  });

  upstream.on("close", (code) => {
    log.info("CDP upstream closed bandTabId=%s code=%d", bandTabId, code);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Upstream closed");
    }
  });

  ws.on("close", () => {
    log.debug("CDP client closed bandTabId=%s", bandTabId);
    if (
      upstream &&
      (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
    ) {
      try {
        upstream.close();
      } catch {
        // best-effort
      }
    }
  });

  ws.on("error", (err) => {
    log.debug("CDP client error bandTabId=%s: %s", bandTabId, err.message);
    try {
      upstream?.close();
    } catch {
      // best-effort
    }
  });
}
