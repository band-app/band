/**
 * Pairing links, answered before the device-token check because the pairing code is the
 * credential (`TokenService.exchangePairing`).
 *
 * - `POST /api/pair/exchange {"code"}` answers `{ token, deviceId, label, admin }` and sets the
 *   `band_token` cookie. The Expo app and the page below call it.
 * - `GET /?pair=<code>` answers a small page that makes that POST and opens the app. The GET
 *   itself spends nothing, so a chat app that previews the link does not use it up.
 *
 * A refusal is one generic message whatever the reason, and no code reaches a log line.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { createLogger } from "@band-app/logger";

import { buildCookieHeader } from "../../../../auth";
import { PairingExchangeError, tokenService } from "../../services/token-service";

const log = createLogger("pairing");

export const PAIR_EXCHANGE_PATH = "/api/pair/exchange";
const MAX_BODY_BYTES = 4096;
export const PAIR_REFUSED_MESSAGE =
  "This link was already used or has expired. Ask for a new one in Settings > Devices.";

/** Whether this is the page request of a pairing link. */
export function isPairLinkRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.pathname === "/" && url.searchParams.has("pair");
  } catch {
    return false;
  }
}

function isSecure(req: IncomingMessage): boolean {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    req.headers["cf-visitor"]?.includes('"scheme":"https"') === true
  );
}

const PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff}.c{text-align:center;max-width:28rem;padding:1rem}p{color:#aaa}";

/** The page a pairing link opens. The code stays in the URL and goes only to this origin's exchange route. */
export function handlePairLink(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(`<!DOCTYPE html>
<html><head><title>Band</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PAGE_STYLE}</style></head>
<body><div class="c"><h1 id="title">Signing in…</h1><p id="msg" data-testid="pair__message"></p>
<noscript><p>Turn on JavaScript to sign in.</p></noscript></div>
<script>
(async () => {
  const code = new URLSearchParams(location.search).get("pair") || "";
  const fail = (text) => {
    document.getElementById("title").textContent = "Link not valid";
    const msg = document.getElementById("msg");
    msg.textContent = text;
    msg.setAttribute("data-state", "refused");
    document.body.setAttribute("data-pair", "refused");
  };
  try {
    const r = await fetch(${JSON.stringify(PAIR_EXCHANGE_PATH)}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) return fail(${JSON.stringify(PAIR_REFUSED_MESSAGE)});
    location.replace("/");
  } catch {
    fail("Could not reach the hub. Check the connection and open the link again.");
  }
})();
</script></body></html>`);
}

export async function handlePairExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    send(405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      send(413, { error: "Request body too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  let code: unknown;
  try {
    code = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { code?: unknown }).code;
  } catch {
    send(400, { error: "Body must be JSON" });
    return;
  }
  if (typeof code !== "string" || code === "") {
    send(400, { error: "code must be a string" });
    return;
  }
  try {
    const out = tokenService.exchangePairing(code);
    send(200, out, { "Set-Cookie": buildCookieHeader(out.token, isSecure(req)) });
  } catch (err) {
    if (!(err instanceof PairingExchangeError)) throw err;
    log.debug(`pairing exchange refused: ${err.reason}`);
    send(401, { error: PAIR_REFUSED_MESSAGE });
  }
}
