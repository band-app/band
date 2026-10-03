import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || "";
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  }
  return cookies;
}

/** First subprotocol a browser offers; the hub echoes it so the handshake succeeds. */
export const WS_BASE_PROTOCOL = "band";
/** Subprotocol carrying the token: `band-token.<token>`. Browsers can't set headers on a WebSocket. */
export const WS_TOKEN_PROTOCOL_PREFIX = "band-token.";

export function wsProtocols(req: IncomingMessage): string[] {
  const header = req.headers["sec-websocket-protocol"];
  if (typeof header !== "string") return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Token from `Authorization: Bearer`, if the request has one. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

/**
 * Whether a WebSocket upgrade carries the token: the cookie (same-origin),
 * a Bearer header (non-browser clients), or the `band-token.<token>`
 * subprotocol (cross-origin browsers). Never the query string.
 */
export function isAuthorizedUpgrade(
  req: IncomingMessage,
  expected: string,
  opts: { allowCookie?: boolean } = {},
): boolean {
  if (opts.allowCookie !== false && tokensEqual(parseCookies(req).band_token, expected)) {
    return true;
  }
  if (tokensEqual(bearerToken(req), expected)) return true;
  return wsProtocols(req).some(
    (p) =>
      p.startsWith(WS_TOKEN_PROTOCOL_PREFIX) &&
      tokensEqual(p.slice(WS_TOKEN_PROTOCOL_PREFIX.length), expected),
  );
}

/** `ws` `handleProtocols` hook: select `band`, never echo the token protocol. */
export function selectWsProtocol(protocols: Set<string>): string | false {
  return protocols.has(WS_BASE_PROTOCOL) ? WS_BASE_PROTOCOL : false;
}

export function tokensEqual(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isSecureRequest(req: IncomingMessage): boolean {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    req.headers["cf-visitor"]?.includes('"scheme":"https"') === true
  );
}

function buildCookieHeader(token: string, secure: boolean): string {
  const parts = [`band_token=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=31536000"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function createAuthMiddleware(token: string | undefined) {
  const expectedToken = token || null;

  /**
   * Returns true if the request was handled (auth endpoint or rejection).
   * Returns false if the request should continue to the normal handler.
   */
  function handleAuth(req: IncomingMessage, res: ServerResponse): boolean {
    // No token configured — skip auth entirely (dev mode)
    if (!expectedToken) return false;

    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Health check endpoint (auth-protected)
    if (url.pathname === "/api/health" && req.method === "GET") {
      const queryToken = url.searchParams.get("token");
      const cookies = parseCookies(req);
      if (
        tokensEqual(queryToken, expectedToken) ||
        tokensEqual(bearerToken(req), expectedToken) ||
        tokensEqual(cookies.band_token, expectedToken)
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            app: "band-web-server",
            hostname: hostname(),
          }),
        );
      } else {
        res.writeHead(401);
        res.end("Unauthorized");
      }
      return true;
    }

    // Check token in query param
    const queryToken = url.searchParams.get("token");
    if (queryToken && tokensEqual(queryToken, expectedToken)) {
      // Set cookie and continue to normal handler (no redirect — tunnel
      // proxies follow redirects internally and lose the Set-Cookie).
      res.setHeader("Set-Cookie", buildCookieHeader(expectedToken, isSecureRequest(req)));
      return false;
    }

    // Check Authorization: Bearer header
    if (tokensEqual(bearerToken(req), expectedToken)) {
      return false; // Authenticated — continue to normal handler
    }

    // Check cookie
    const cookies = parseCookies(req);
    if (tokensEqual(cookies.band_token, expectedToken)) {
      return false; // Authenticated — continue to normal handler
    }

    // Unauthorized
    res.writeHead(401, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html><head><title>Unauthorized</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff}
.c{text-align:center}h1{font-size:4rem;margin:0}p{color:#888}</style></head>
<body><div class="c"><h1>401</h1><p>Scan the QR code from the Band dashboard to access this page.</p></div></body></html>`);
    return true;
  }

  return { handleAuth, expectedToken };
}
