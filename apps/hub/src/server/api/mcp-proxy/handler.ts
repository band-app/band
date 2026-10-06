/**
 * `/mcp-proxy/<server>`: the hub's proxy for MCP servers (plan steps 4.2 and 4.4).
 * This file handles HTTP servers; `stdio.ts` handles the ones that run on a worker.
 *
 * An agent presents a per-session `mcp_` token. The hub checks it, adds the
 * vault credential to the upstream request and forwards the JSON-RPC (streamable
 * HTTP: POST, the GET stream and DELETE, with the session id header). The
 * route is answered before the device-token check because the proxy token is
 * its own credential.
 *
 * Filters: `tools/list` answers keep only the tools the server's allowlist and
 * read-only mode permit, and a `tools/call` for any other tool is answered here
 * with a JSON-RPC error and never reaches the upstream. Responses stream through
 * unbuffered unless a `tools/list` or `tools/call` is in flight, and then only
 * the one event (or JSON body) carrying that answer is parsed.
 *
 * Each `tools/call` is audited with server, tool, session and outcome. Arguments
 * and results are never stored, and no token or credential is logged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { rewriteSse, SseEventTooLargeError, sseDataOf } from "../../services/_utils/mcp-sse";
import { COORDINATOR_SERVER, RETRO_SERVER } from "../../services/_utils/project-policy";
import { type McpServerView, mcpProxyService } from "../../services/mcp-proxy-service";
import { handleCoordinatorMcp } from "./coordinator";
import {
  auditUnanswered,
  BodyTooLargeError,
  collect,
  inspectJson,
  isObject,
  type JsonObject,
  type ListPage,
  MAX_INSPECT_BYTES,
  type Plan,
  planRequest,
} from "./filter";
import { readBody, sendJson } from "./http-util";
import { handleRetroMcp } from "./retro";
import { handleStdioProxy } from "./stdio";

const log = createLogger("mcp-proxy");

export const MCP_PROXY_PREFIX = "/mcp-proxy/";
const ROUTE = /^\/mcp-proxy\/([^/]+)\/?$/;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Request headers passed upstream. The caller's credentials never are. */
const UPSTREAM_HEADERS = [
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];
/** Response headers passed back. */
const REPLY_HEADERS = ["content-type", "cache-control", "mcp-session-id"];

/** Writes a chunk and waits for the socket to drain, or for the caller to go away. */
function write(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

interface UpstreamInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
}

/**
 * Sends one request upstream with the vault credential. An OAuth upstream
 * that answers 401 gets one retry with a refreshed token.
 */
async function sendUpstream(server: McpServerView, init: UpstreamInit): Promise<Response> {
  const attempt = (credential: Record<string, string>) =>
    fetch(server.url, {
      method: init.method,
      headers: { ...init.headers, ...credential, "accept-encoding": "identity" },
      body: init.body ? new Uint8Array(init.body) : undefined,
      signal: init.signal,
      redirect: "manual",
    });
  const first = await mcpProxyService.credentialHeaders(server);
  const res = await attempt(first.headers);
  if (res.status !== 401 || !first.refreshable) return res;
  await res.body?.cancel().catch(() => undefined);
  let renewed: Awaited<ReturnType<typeof mcpProxyService.credentialHeaders>>;
  try {
    renewed = await mcpProxyService.credentialHeaders(server, true);
  } catch {
    return new Response(null, { status: 401 });
  }
  return attempt(renewed.headers);
}

/** Asks an HTTP upstream for one page of its tool list, for the read-only lookup. */
function httpListPage(
  server: McpServerView,
  headers: Record<string, string>,
  signal: AbortSignal,
): ListPage {
  return async (cursor) => {
    const res = await sendUpstream(server, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "band-proxy-list",
          method: "tools/list",
          params: cursor ? { cursor } : {},
        }),
      ),
      signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = (
      await collect(res.body as unknown as AsyncIterable<Uint8Array>, MAX_INSPECT_BYTES)
    ).toString("utf8");
    const payloads = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? sseDataOf(text)
      : [text];
    let result: JsonObject | undefined;
    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload) as unknown;
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          if (isObject(message) && message.id === "band-proxy-list" && isObject(message.result)) {
            result = message.result;
          }
        }
      } catch {
        // not JSON, so not the answer
      }
    }
    return result;
  };
}

/** An error's name and code only: a fetch error's message may quote a request header. */
function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${err.name} ${code}` : err.name;
}

const bearerOf = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
};

export async function handleMcpProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = (req.url ?? "").split("?")[0];
  const route = ROUTE.exec(pathname);
  if (!route) return sendJson(res, 404, { error: "Not found" });
  let name: string;
  try {
    name = decodeURIComponent(route[1]);
  } catch {
    return sendJson(res, 400, { error: "Bad request" });
  }
  const method = req.method ?? "GET";
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    return sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET, POST, DELETE" });
  }

  const auth = mcpProxyService.authenticate(bearerOf(req), name);
  if (!auth.ok) {
    return sendJson(
      res,
      auth.status,
      { error: auth.reason },
      auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="band-mcp-proxy"' } : {},
    );
  }
  // The hub's own coordinator tools, not an upstream.
  if (name === COORDINATOR_SERVER) return handleCoordinatorMcp(req, res, auth);
  if (name === RETRO_SERVER) return handleRetroMcp(req, res, auth);
  const server = mcpProxyService.getEnabledServer(name);
  if (!server) return sendJson(res, 404, { error: "No such MCP server" });

  if (server.transport === "stdio") return handleStdioProxy(req, res, server, auth);

  let body: Buffer | undefined;
  if (method === "POST") {
    try {
      body = await readBody(req, MAX_REQUEST_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendJson(res, 413, { error: "Request body too large" });
      }
      throw err;
    }
  }

  const headers: Record<string, string> = {};
  for (const header of UPSTREAM_HEADERS) {
    const value = req.headers[header];
    if (typeof value === "string") headers[header] = value;
  }
  if (method === "POST") {
    headers["content-type"] ??= "application/json";
    headers.accept ??= "application/json, text/event-stream";
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const plan: Plan = body
    ? await planRequest(
        server,
        auth.sessionId,
        body.toString("utf8"),
        httpListPage(server, headers, abort.signal),
      )
    : { listIds: new Set(), callIds: new Map() };
  if (plan.immediate) {
    const { status, body: reply } = plan.immediate;
    if (reply === undefined) {
      res.writeHead(status, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    return sendJson(res, status, reply);
  }

  let upstream: Response;
  try {
    upstream = await sendUpstream(server, { method, headers, body, signal: abort.signal });
  } catch (err) {
    log.warn({ server: name, err: errorCode(err) }, "upstream failed");
    auditUnanswered(server, auth.sessionId, plan, "upstream-unreachable");
    return sendJson(res, 502, { error: "The upstream MCP server did not answer" });
  }

  // The agent's own token is not what the upstream rejected, so a 401 here is the stored credential's.
  if (upstream.status === 401 || (upstream.status >= 300 && upstream.status < 400)) {
    await upstream.body?.cancel().catch(() => undefined);
    log.warn({ server: name, status: upstream.status }, "upstream refused the stored credential");
    auditUnanswered(server, auth.sessionId, plan, `upstream-${upstream.status}`);
    return sendJson(res, 502, {
      error:
        upstream.status === 401
          ? "The upstream MCP server rejected the stored credential"
          : "The upstream MCP server redirected, which the proxy does not follow",
    });
  }

  const replyHeaders: Record<string, string> = {};
  for (const header of REPLY_HEADERS) {
    const value = upstream.headers.get(header);
    if (value !== null) replyHeaders[header] = value;
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const stream = upstream.body as unknown as AsyncIterable<Uint8Array> | null;
  const inspecting = plan.listIds.size > 0 || plan.callIds.size > 0;

  try {
    if (!stream) {
      res.writeHead(upstream.status, replyHeaders);
      res.end();
      auditUnanswered(server, auth.sessionId, plan, `upstream-${upstream.status}`);
      return;
    }

    if (inspecting && !/application\/json|text\/event-stream/.test(contentType)) {
      // The filter cannot read this answer, so it does not go through.
      await upstream.body?.cancel().catch(() => undefined);
      auditUnanswered(server, auth.sessionId, plan, "unreadable-response");
      return sendJson(res, 502, {
        error: "The upstream MCP server's answer could not be filtered",
      });
    }

    if (inspecting && contentType.includes("application/json")) {
      const text = (await collect(stream, MAX_INSPECT_BYTES)).toString("utf8");
      try {
        JSON.parse(text);
      } catch {
        auditUnanswered(server, auth.sessionId, plan, "unreadable-response");
        return sendJson(res, 502, {
          error: "The upstream MCP server's answer could not be filtered",
        });
      }
      const rewritten = inspectJson(text, server, auth.sessionId, plan) ?? text;
      auditUnanswered(server, auth.sessionId, plan, "no-response");
      res.writeHead(upstream.status, {
        ...replyHeaders,
        "Content-Length": String(Buffer.byteLength(rewritten)),
      });
      res.end(rewritten);
      return;
    }

    res.writeHead(upstream.status, replyHeaders);
    res.flushHeaders();
    const source =
      inspecting && contentType.includes("text/event-stream")
        ? rewriteSse(
            stream,
            (data) => inspectJson(data, server, auth.sessionId, plan),
            MAX_INSPECT_BYTES,
          )
        : stream;
    for await (const chunk of source) {
      if (res.destroyed) break;
      await write(res, chunk);
    }
    auditUnanswered(
      server,
      auth.sessionId,
      plan,
      upstream.ok ? "no-response" : `upstream-${upstream.status}`,
    );
    res.end();
  } catch (err) {
    auditUnanswered(server, auth.sessionId, plan, "stream-failed");
    if (!abort.signal.aborted) {
      log.warn(
        { server: name, err: errorCode(err) },
        err instanceof SseEventTooLargeError ? "event too large to inspect" : "proxy stream failed",
      );
    }
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: "The upstream MCP server's answer could not be proxied" });
  }
}
