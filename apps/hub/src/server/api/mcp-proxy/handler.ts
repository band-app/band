/**
 * `/mcp-proxy/<server>`: the hub's proxy for HTTP MCP servers (plan step 4.2).
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
import {
  type CallDecision,
  decideCall,
  listedToolAllowed,
  readOnlyHintOf,
  type ToolPolicy,
} from "../../services/_utils/mcp-policy";
import { rewriteSse, SseEventTooLargeError, sseDataOf } from "../../services/_utils/mcp-sse";
import { type McpServerView, mcpProxyService } from "../../services/mcp-proxy-service";

const log = createLogger("mcp-proxy");

export const MCP_PROXY_PREFIX = "/mcp-proxy/";
const ROUTE = /^\/mcp-proxy\/([^/]+)\/?$/;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** The most the proxy holds in memory to inspect one answer. */
const MAX_INSPECT_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 10;
const TOOL_DENIED = -32602;
const BATCH_REJECTED = -32600;

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

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON-RPC id as a map key, or null for a notification (no id). */
function idKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function rpcError(id: unknown, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > max) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

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

async function collect(body: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new BodyTooLargeError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

function policyOf(server: McpServerView): ToolPolicy {
  return {
    allowTools: server.allowTools,
    readOnly: server.readOnly,
    readOnlyTools: server.readOnlyTools,
  };
}

const lookupsInFlight = new Map<string, Promise<void>>();
const lookupMissedAt = new Map<string, number>();
/** A server whose lookup just ran is not asked again for this long, whatever the callers name. */
const LOOKUP_COOLDOWN_MS = 5_000;

/** Runs one lookup per server at a time, and none within the cooldown after the last. */
function lookUpToolsOnce(
  server: McpServerView,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const running = lookupsInFlight.get(server.id);
  if (running) return running;
  const last = lookupMissedAt.get(server.id);
  if (last !== undefined && Date.now() - last < LOOKUP_COOLDOWN_MS) return Promise.resolve();
  const run = lookUpTools(server, headers, signal)
    .catch(() => undefined)
    .finally(() => {
      lookupsInFlight.delete(server.id);
      lookupMissedAt.set(server.id, Date.now());
    });
  lookupsInFlight.set(server.id, run);
  return run;
}

/** Learns each tool's `readOnlyHint` from the upstream's own `tools/list`, for a read-only server. */
async function lookUpTools(
  server: McpServerView,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const tools = new Map<string, boolean>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
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
      return;
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
    if (!result || !Array.isArray(result.tools)) return;
    for (const tool of result.tools) {
      if (isObject(tool) && typeof tool.name === "string") {
        tools.set(tool.name, readOnlyHintOf(tool));
      }
    }
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  mcpProxyService.rememberTools(server.id, tools);
}

interface Plan {
  /** A reply to send without contacting the upstream, when a call was refused. */
  immediate?: { status: number; body?: unknown };
  /** Ids of `tools/list` requests being forwarded, whose answers get filtered. */
  listIds: Set<string>;
  /** Ids of `tools/call` requests being forwarded, with the tool, for the audit log. */
  callIds: Map<string, string>;
}

/** Decides what to do with one POST body. Refused calls are audited here. */
async function planRequest(
  server: McpServerView,
  sessionId: string,
  text: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Plan> {
  const plan: Plan = { listIds: new Set(), callIds: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    plan.immediate = { status: 400, body: rpcError(null, -32700, "Parse error") };
    return plan;
  }
  const batch = Array.isArray(parsed);
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const policy = policyOf(server);
  const refused = new Map<number, string>();

  // Answers are matched to requests by id, so one id used twice could route a list answer past the filter.
  const ids = messages.flatMap((m) => (isObject(m) && idKey(m.id) !== null ? [idKey(m.id)] : []));
  if (new Set(ids).size !== ids.length) {
    plan.immediate = {
      status: 400,
      body: rpcError(null, BATCH_REJECTED, "A request id was used more than once"),
    };
    return plan;
  }

  for (const [index, message] of messages.entries()) {
    if (!isObject(message)) continue;
    const key = idKey(message.id);
    if (message.method === "tools/list" && key !== null) plan.listIds.add(key);
    if (message.method !== "tools/call") continue;
    const params = isObject(message.params) ? message.params : {};
    const tool = typeof params.name === "string" ? params.name : "";
    // A call with no id would be forwarded with no answer to audit.
    let decision: CallDecision =
      tool && key !== null
        ? decideCall(policy, tool, mcpProxyService.knownReadOnly(server.id, tool))
        : "deny";
    if (decision === "unknown") {
      await lookUpToolsOnce(server, headers, signal);
      decision = decideCall(policy, tool, mcpProxyService.knownReadOnly(server.id, tool));
    }
    if (decision !== "allow") {
      refused.set(index, tool);
      mcpProxyService.recordCall({
        server: server.name,
        tool: tool || "(unnamed)",
        sessionId,
        ok: false,
        error: "not-allowed",
      });
    } else if (key !== null) {
      plan.callIds.set(key, tool);
    }
  }

  if (refused.size === 0) return plan;
  const replies: JsonObject[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isObject(message) || idKey(message.id) === null) continue;
    const tool = refused.get(index);
    replies.push(
      tool !== undefined
        ? rpcError(message.id, TOOL_DENIED, `Tool "${tool}" is not available through this proxy`)
        : rpcError(message.id, BATCH_REJECTED, "Rejected with the other requests in its batch"),
    );
  }
  if (replies.length === 0) {
    plan.immediate = { status: 202 };
  } else {
    plan.immediate = { status: 200, body: batch ? replies : replies[0] };
  }
  plan.listIds.clear();
  plan.callIds.clear();
  return plan;
}

/**
 * Applies the plan to one JSON-RPC message from the upstream: filters a
 * `tools/list` answer and audits a `tools/call` answer. Returns the same
 * object when nothing changed.
 */
function inspectMessage(
  message: unknown,
  server: McpServerView,
  sessionId: string,
  plan: Plan,
): unknown {
  if (!isObject(message) || "method" in message) return message;
  const key = idKey(message.id);
  if (key === null) return message;

  const tool = plan.callIds.get(key);
  if (tool !== undefined) {
    plan.callIds.delete(key);
    const failed = "error" in message || (isObject(message.result) && message.result.isError);
    mcpProxyService.recordCall({
      server: server.name,
      tool,
      sessionId,
      ok: !failed,
      error: failed ? "upstream-error" : undefined,
    });
    return message;
  }

  if (!plan.listIds.delete(key)) return message;
  const result = message.result;
  if (!isObject(result) || !Array.isArray(result.tools)) return message;
  const seen = new Map<string, boolean>();
  for (const entry of result.tools) {
    if (isObject(entry) && typeof entry.name === "string") {
      seen.set(entry.name, readOnlyHintOf(entry));
    }
  }
  mcpProxyService.rememberTools(server.id, seen);
  const policy = policyOf(server);
  const kept = result.tools.filter((entry) => listedToolAllowed(policy, entry));
  if (kept.length === result.tools.length) return message;
  return { ...message, result: { ...result, tools: kept } };
}

/** Rewrites a JSON value (one message or a batch). Returns null when nothing changed. */
function inspectJson(
  text: string,
  server: McpServerView,
  sessionId: string,
  plan: Plan,
): string | null {
  if (plan.listIds.size === 0 && plan.callIds.size === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const next = Array.isArray(parsed)
    ? parsed.map((m) => inspectMessage(m, server, sessionId, plan))
    : inspectMessage(parsed, server, sessionId, plan);
  const changed = Array.isArray(parsed)
    ? (next as unknown[]).some((m, i) => m !== parsed[i])
    : next !== parsed;
  return changed ? JSON.stringify(next) : null;
}

/** Records the calls whose answer never came, so every forwarded call has an audit row. */
function auditUnanswered(
  server: McpServerView,
  sessionId: string,
  plan: Plan,
  error: string,
): void {
  for (const tool of plan.callIds.values()) {
    mcpProxyService.recordCall({ server: server.name, tool, sessionId, ok: false, error });
  }
  plan.callIds.clear();
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
  const server = mcpProxyService.getEnabledServer(name);
  if (!server) return sendJson(res, 404, { error: "No such MCP server" });

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
    ? await planRequest(server, auth.sessionId, body.toString("utf8"), headers, abort.signal)
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
