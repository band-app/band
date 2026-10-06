import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import WebSocket, { type WebSocket as WsServerSocket } from "ws";
import { lookupBrowser } from "./browser-lookup";
import {
  DESKTOP_CDP_HOST,
  DESKTOP_CDP_PORT,
  ensureCdpTargetId,
  markTargetDestroyed,
} from "./host-state";
import { openRemoteCdp } from "./remote-cdp";

const log = createLogger("cdp-proxy");

/**
 * Proxy a WebSocket connection from the Band UI to the desktop's CDP
 * endpoint for a single Band browser tab.
 *
 * Query params:
 *   - bandTabId: Band's `browser_<uuid>` id. Resolved server-side to the
 *     current chromium target id via `browser-host.ts::ensureCdpTargetId`.
 *   - worktreeId: for a worktree on a worker, the browser-level CDP endpoint
 *     of that worker's Chromium (`bandTabId` of such a worktree works too).
 *
 * Close codes:
 *   - 4000 — bad request (missing bandTabId)
 *   - 4001 — could not reach the desktop or its underlying chromium target
 *   - 4003 — the tab runs in a non-Default browser profile
 *
 * Tabs in a browser profile (e.g. cookies imported from Chrome) are never
 * relayed: raw CDP can read the session's cookies (`Network.getAllCookies`,
 * request headers in `Network.*` events), and those must not pass through
 * this server. Screenshots (`cdp-targets.ts`) carry no cookie data and stay
 * available.
 */
export async function handleCdpConnection(ws: WsServerSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const bandTabId = url.searchParams.get("bandTabId");
  const requestedWorktreeId = url.searchParams.get("worktreeId");
  const tabWorktreeId = lookupBrowser(bandTabId ?? "")?.worktreeId;
  if (requestedWorktreeId && bandTabId && tabWorktreeId !== requestedWorktreeId) {
    ws.close(4000, "bandTabId does not belong to worktreeId");
    return;
  }
  const worktreeId = requestedWorktreeId ?? tabWorktreeId;

  if (!bandTabId && !worktreeId) {
    ws.close(4000, "Missing bandTabId");
    return;
  }

  let early: string[] = [];
  if (worktreeId) {
    const bridged = await bridgeRemote(ws, worktreeId);
    if (bridged === true) return;
    early = bridged;
  }
  if (!bandTabId) {
    ws.close(4000, "Worktree is not on a remote host");
    return;
  }

  if (lookupBrowser(bandTabId)?.profileId) {
    ws.close(4003, "Tabs in a browser profile can't be streamed over CDP");
    return;
  }

  // Buffer client messages that arrive before the upstream WS opens.
  // Mirrors the LSP proxy pattern: without this the client's first request
  // (CDP `Runtime.enable`, etc.) can be dropped.
  const pending: string[] = early;
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

const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/**
 * Bridges the client to the Chromium of a worktree on a worker. Returns the client
 * messages received so far when the worktree is local, so the caller falls through to the desktop path.
 * The remote profile belongs to the worktree and the hub only relays, so the
 * cookie rule of the desktop's profiles does not apply here.
 */
async function bridgeRemote(ws: WsServerSocket, worktreeId: string): Promise<true | string[]> {
  const pending: string[] = [];
  let pendingBytes = 0;
  let cdp: Awaited<ReturnType<typeof openRemoteCdp>> = null;
  // Registered before the first await so no early client message is dropped.
  ws.on("message", (raw) => {
    const data = raw.toString();
    if (cdp) cdp.send(data);
    else if (pendingBytes + data.length > MAX_PENDING_BYTES) ws.close(1009, "Too much data");
    else {
      pendingBytes += data.length;
      pending.push(data);
    }
  });
  try {
    cdp = await openRemoteCdp(worktreeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("remote CDP failed for worktree %s: %s", worktreeId, message);
    if (ws.readyState === ws.OPEN) ws.close(4001, "Remote browser unavailable");
    return true;
  }
  if (!cdp) {
    ws.removeAllListeners("message");
    return pending;
  }
  const open = cdp;
  if (ws.readyState !== ws.OPEN) {
    // The client left while the browser was starting; its close event already fired.
    open.close();
    return true;
  }
  for (const msg of pending) open.send(msg);
  pending.length = 0;
  ws.on("close", () => open.close());
  ws.on("error", () => open.close());
  void (async () => {
    try {
      for await (const message of open.messages) {
        if (ws.readyState === ws.OPEN) ws.send(message);
      }
    } catch (err) {
      log.debug("remote CDP stream ended for worktree %s: %s", worktreeId, String(err));
    }
    if (ws.readyState === ws.OPEN) ws.close(1000, "Upstream closed");
  })();
  return true;
}
