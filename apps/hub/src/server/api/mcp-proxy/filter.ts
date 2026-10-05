/**
 * The tool filter and audit shared by the HTTP and stdio paths of `/mcp-proxy/<server>`
 * (plan steps 4.2 and 4.4). The transports differ in how a request reaches the server and how its
 * answer comes back. They agree on which tools may be listed and called, and on what gets audited.
 */

import {
  type CallDecision,
  decideCall,
  listedToolAllowed,
  readOnlyHintOf,
  type ToolPolicy,
} from "../../services/_utils/mcp-policy";
import { type McpServerView, mcpProxyService } from "../../services/mcp-proxy-service";

/** The most the proxy holds in memory to inspect one answer. */
export const MAX_INSPECT_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 10;
export const TOOL_DENIED = -32602;
export const BATCH_REJECTED = -32600;

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON-RPC id as a map key, or null for a notification (no id). */
export function idKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;
}

export function rpcError(id: unknown, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export class BodyTooLargeError extends Error {}

export async function collect(body: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new BodyTooLargeError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function policyOf(server: McpServerView): ToolPolicy {
  return {
    allowTools: server.allowTools,
    readOnly: server.readOnly,
    readOnlyTools: server.readOnlyTools,
  };
}

/**
 * Asks the upstream for one page of its `tools/list` and returns the answer's `result`, or
 * undefined when it gave none. How the question travels is the transport's business.
 */
export type ListPage = (cursor: string | undefined) => Promise<JsonObject | undefined>;

const lookupsInFlight = new Map<string, Promise<void>>();
const lookupMissedAt = new Map<string, number>();
/** A server whose lookup just ran is not asked again for this long, whatever the callers name. */
const LOOKUP_COOLDOWN_MS = 5_000;

/** Runs one lookup per server at a time, and none within the cooldown after the last. */
function lookUpToolsOnce(server: McpServerView, listPage: ListPage): Promise<void> {
  const running = lookupsInFlight.get(server.id);
  if (running) return running;
  const last = lookupMissedAt.get(server.id);
  if (last !== undefined && Date.now() - last < LOOKUP_COOLDOWN_MS) return Promise.resolve();
  const run = lookUpTools(server, listPage)
    .catch(() => undefined)
    .finally(() => {
      lookupsInFlight.delete(server.id);
      lookupMissedAt.set(server.id, Date.now());
    });
  lookupsInFlight.set(server.id, run);
  return run;
}

/** Learns each tool's `readOnlyHint` from the upstream's own `tools/list`, for a read-only server. */
async function lookUpTools(server: McpServerView, listPage: ListPage): Promise<void> {
  const tools = new Map<string, boolean>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await listPage(cursor);
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

export interface Plan {
  /** A reply to send without contacting the upstream, when a call was refused. */
  immediate?: { status: number; body?: unknown };
  /** Ids of `tools/list` requests being forwarded, whose answers get filtered. */
  listIds: Set<string>;
  /** Ids of `tools/call` requests being forwarded, with the tool, for the audit log. */
  callIds: Map<string, string>;
}

/** Decides what to do with one POST body. Refused calls are audited here. */
export async function planRequest(
  server: McpServerView,
  sessionId: string,
  text: string,
  listPage: ListPage,
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
      await lookUpToolsOnce(server, listPage);
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
export function inspectJson(
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
export function auditUnanswered(
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
