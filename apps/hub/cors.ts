import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Authorization, Content-Type, Last-Event-ID";

const ALLOWED_HEADER_NAMES = new Set(["authorization", "content-type", "last-event-id"]);

export type OriginVerdict = "none" | "same" | "allowed" | "denied";

/**
 * Origins the Electron shell loads the bundled UI from: `app://local` for the
 * bundled hub and `app://h-<12 hex>` for a remote one. Any other `app://` host,
 * `file://` and `null` are not built in; `null` can be added to the configured
 * origins.
 */
const BUILTIN_ORIGIN = /^app:\/\/(local|h-[0-9a-f]{12})$/;

function isBuiltinOrigin(origin: string): boolean {
  return BUILTIN_ORIGIN.test(origin);
}

export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function requestHosts(req: IncomingMessage): string[] {
  const hosts: string[] = [];
  const host = req.headers.host;
  if (host) hosts.push(host);
  const forwarded = req.headers["x-forwarded-host"];
  if (typeof forwarded === "string" && forwarded) hosts.push(forwarded.split(",")[0].trim());
  return hosts;
}

/**
 * Classifies the `Origin` header of a request. Requests without one (the CLI,
 * curl, same-origin GETs in some browsers) are `none` and are not subject to
 * CORS. An origin that names the host the request was sent to is `same`.
 */
export function classifyOrigin(
  req: IncomingMessage,
  getAllowed: () => readonly string[],
): OriginVerdict {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return "none";
  if (isBuiltinOrigin(origin)) return "allowed";
  if (origin === "null") return getAllowed().includes("null") ? "allowed" : "denied";
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "denied";
  }
  if (requestHosts(req).includes(originHost)) return "same";
  return getAllowed().includes(origin.replace(/\/+$/, "")) ? "allowed" : "denied";
}

/**
 * Answers preflights and rejects requests from origins outside the allowlist.
 * Returns true when the response was written. Allowed cross-origin responses
 * never carry `Access-Control-Allow-Credentials`: cross-origin clients
 * authenticate with a Bearer token, not the cookie.
 */
export function createCorsMiddleware(getAllowedOrigins: () => readonly string[]) {
  return function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
    const verdict = classifyOrigin(req, getAllowedOrigins);
    if (verdict === "none" || verdict === "same") return false;

    const pathname = (req.url ?? "").split("?")[0];
    // The OpenAPI spec is public and already answers `*` itself.
    if (verdict === "denied" && pathname === "/api/openapi.json") return false;

    if (verdict === "denied") {
      res.writeHead(403, { "Content-Type": "text/plain", Vary: "Origin" });
      res.end("Origin not allowed");
      return true;
    }

    const origin = req.headers.origin as string;
    res.setHeader("Access-Control-Allow-Origin", origin);
    const vary = res.getHeader("Vary");
    res.setHeader("Vary", vary ? `${vary}, Origin` : "Origin");

    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      const requestedRaw = req.headers["access-control-request-headers"];
      const requested =
        typeof requestedRaw === "string"
          ? requestedRaw
              .split(",")
              .map((h) => h.trim())
              .filter((h) => ALLOWED_HEADER_NAMES.has(h.toLowerCase()))
              .join(", ")
          : "";
      res.writeHead(204, {
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": requested || DEFAULT_ALLOWED_HEADERS,
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return true;
    }
    return false;
  };
}
