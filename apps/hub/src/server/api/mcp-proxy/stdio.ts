/**
 * `/mcp-proxy/<server>` for a stdio MCP server (plan step 4.4).
 *
 * The proxy is the streamable HTTP server the agent talks to. Behind it the
 * server is a process on a worker, reached through a link channel, and the
 * proxy turns each POST into JSON-RPC lines on the process's stdin and the
 * matching stdout lines into the reply. The `initialize` request starts one
 * process and its `Mcp-Session-Id`; `DELETE`, a revoked token and idle time
 * end it.
 *
 * The same tool filter and audit as for HTTP servers apply (`filter.ts`).
 * Answers come back as one JSON body per POST. Messages the server sends that
 * answer no request (notifications, requests to the client) go to the `GET`
 * stream when one is open, and are dropped otherwise.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import type { McpAuthResult, McpServerView } from "../../services/mcp-proxy-service";
import {
  mcpStdioService,
  StdioOpenError,
  type StdioSession,
  StdioSessionClosedError,
} from "../../services/mcp-stdio-service";
import {
  auditUnanswered,
  BATCH_REJECTED,
  BodyTooLargeError,
  idKey,
  inspectJson,
  isObject,
  type JsonObject,
  type Plan,
  planRequest,
  rpcError,
} from "./filter";
import { readBody, sendJson } from "./http-util";

const log = createLogger("mcp-proxy-stdio");

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type Authenticated = Extract<McpAuthResult, { ok: true }>;

const sessionHeader = (req: IncomingMessage): string | undefined => {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" ? value : undefined;
};

/** The session a request names, when it belongs to this token's session and server. */
function ownedSession(
  req: IncomingMessage,
  server: McpServerView,
  auth: Authenticated,
): StdioSession | undefined {
  const id = sessionHeader(req);
  const session = id ? mcpStdioService.get(id) : undefined;
  if (!session || session.closed) return undefined;
  if (session.serverName !== server.name || session.proxySessionId !== auth.sessionId) {
    return undefined;
  }
  return session;
}

const MAX_BATCH_MESSAGES = 100;

function isInitialize(parsed: unknown): boolean {
  return isObject(parsed) && parsed.method === "initialize" && idKey(parsed.id) !== null;
}

export async function handleStdioProxy(
  req: IncomingMessage,
  res: ServerResponse,
  server: McpServerView,
  auth: Authenticated,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "DELETE") {
    const session = ownedSession(req, server, auth);
    if (!session) return sendJson(res, 404, { error: "No such MCP session" });
    session.close("closed by the client");
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (method === "GET") {
    const session = ownedSession(req, server, auth);
    if (!session) return sendJson(res, 404, { error: "No such MCP session" });
    const forward = (message: JsonObject) => {
      res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };
    let beat: ReturnType<typeof setInterval> | undefined;
    if (
      !session.attach(forward, () => {
        if (beat) clearInterval(beat);
        res.end();
      })
    ) {
      return sendJson(res, 409, { error: "This session already has a stream open" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": open\n\n");
    beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    beat.unref();
    const stop = () => {
      if (beat) clearInterval(beat);
      session.detach(forward);
    };
    res.on("close", stop);
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req, MAX_REQUEST_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return sendJson(res, 413, { error: "Request body too large" });
    }
    throw err;
  }
  const text = body.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sendJson(res, 400, rpcError(null, -32700, "Parse error"));
  }

  if (Array.isArray(parsed) && parsed.length > MAX_BATCH_MESSAGES) {
    return sendJson(res, 400, rpcError(null, -32600, "Too many messages in one batch"));
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let session: StdioSession | undefined;
  const replyHeaders: Record<string, string> = {};
  let opened = false;
  if (sessionHeader(req)) {
    session = ownedSession(req, server, auth);
    // MCP clients start over with a new `initialize` on a 404.
    if (!session) return sendJson(res, 404, { error: "No such MCP session" });
  } else {
    if (!isInitialize(parsed)) {
      return sendJson(res, 400, { error: "Send initialize first, then the Mcp-Session-Id header" });
    }
    try {
      session = await mcpStdioService.open(server, auth.sessionId);
    } catch (err) {
      if (err instanceof StdioOpenError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
    replyHeaders["mcp-session-id"] = session.id;
    opened = true;
  }
  const live = session;

  const plan: Plan = await planRequest(server, auth.sessionId, text, (cursor) =>
    live.listPage(cursor, abort.signal),
  );
  if (plan.immediate) {
    const { status, body: reply } = plan.immediate;
    if (reply === undefined) {
      res.writeHead(status, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    return sendJson(res, status, reply);
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.some((m) => isObject(m) && live.isPending(m.id))) {
    return sendJson(res, 400, rpcError(null, BATCH_REJECTED, "A request id is already in use"));
  }

  let answers: JsonObject[];
  try {
    answers = await live.exchange(messages, abort.signal);
  } catch (err) {
    const gone = err instanceof StdioSessionClosedError;
    // A client that never got its session id can't close it.
    if (opened) live.close("the first request failed");
    auditUnanswered(server, auth.sessionId, plan, gone ? "stdio-closed" : "no-response");
    if (abort.signal.aborted) return;
    if (gone) {
      return sendJson(res, 404, { error: "The stdio MCP server's session ended" });
    }
    log.warn(
      { server: server.name, err: err instanceof Error ? err.name : "unknown" },
      "no answer",
    );
    return sendJson(res, 504, { error: "The stdio MCP server did not answer in time" });
  }

  if (answers.length === 0) {
    // Only notifications and responses went in.
    res.writeHead(202, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const reply = Array.isArray(parsed) ? answers : answers[0];
  const raw = JSON.stringify(reply);
  const filtered = inspectJson(raw, server, auth.sessionId, plan) ?? raw;
  auditUnanswered(server, auth.sessionId, plan, "no-response");
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(filtered)),
    ...replyHeaders,
  });
  res.end(filtered);
}
