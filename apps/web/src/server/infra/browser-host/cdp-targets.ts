import { createLogger } from "@band-app/logger";
import WebSocket from "ws";
import {
  DESKTOP_CDP_HOST,
  DESKTOP_CDP_PORT,
  ensureCdpTargetId,
  markTargetDestroyed,
} from "./host-state";

const log = createLogger("cdp-targets");

// ---------------------------------------------------------------------------
// CDP screencast experiment — server-side helpers that talk CDP for a
// single Band tab. All public APIs accept Band's persistent `bandTabId`
// and resolve to the current chromium target id internally via
// `browser-host.ts`.
//
// HTTP route handlers (e.g. /api/cdp/tabs/:id/snapshot) and the WS proxy
// (/cdp?bandTabId=…) live in start-server.ts / vite.config.ts and call
// into this module.
// ---------------------------------------------------------------------------

export class CdpUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpUnreachableError";
  }
}

/**
 * Open a short-lived CDP WebSocket to the Band browser tab and capture a
 * single JPEG frame via `Page.captureScreenshot`. Used by
 * `/api/cdp/tabs/:bandTabId/snapshot`.
 *
 * `Page.captureScreenshot` works on tabs whose WebContentsView is hidden
 * (the screenshot path forces a rasterization on demand), so this is the
 * right primitive for thumbnails of background tabs.
 *
 * On a stale cached cdpTargetId (the desktop destroyed the view but didn't
 * notify us yet), the ws.error handler clears the cache so the next call
 * triggers a fresh ensure.
 */
export async function captureSnapshot(bandTabId: string): Promise<Buffer> {
  const cdpTargetId = await ensureCdpTargetId(bandTabId);
  const wsUrl = `ws://${DESKTOP_CDP_HOST}:${DESKTOP_CDP_PORT}/devtools/page/${encodeURIComponent(cdpTargetId)}`;

  return await new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    let settled = false;

    const settle = (err: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // best-effort
      }
      if (err) reject(err);
      else if (data) resolve(data);
      else reject(new Error("captureSnapshot: no data and no error"));
    };

    // 5s hard timeout — chromium can hang on a tab that's still loading.
    const timeout = setTimeout(() => {
      settle(new Error(`captureSnapshot timed out for tab ${bandTabId}`));
    }, 5000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: nextId++,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 50 },
        }),
      );
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          result?: { data?: string };
          error?: { message?: string };
        };
        if (msg.error) {
          clearTimeout(timeout);
          settle(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
          return;
        }
        if (typeof msg.result?.data === "string") {
          clearTimeout(timeout);
          settle(null, Buffer.from(msg.result.data, "base64"));
        }
      } catch (err) {
        clearTimeout(timeout);
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      log.debug("captureSnapshot ws error for tab %s: %s", bandTabId, err.message);
      // Cached targetId is likely stale (desktop destroyed the view without
      // notifying). Clear so the next call re-ensures.
      markTargetDestroyed(bandTabId);
      settle(new CdpUnreachableError(err.message));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (!settled) {
        settle(new Error(`CDP socket closed before screenshot returned (tab ${bandTabId})`));
      }
    });
  });
}
