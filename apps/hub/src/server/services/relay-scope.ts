/**
 * What a worker's agents may ask of the hub through the relay (plan step 2.5).
 *
 * The worker forwards calls from processes it started, so the hub treats each
 * one as coming from that worker and allows only the agent surface the `band`
 * CLI, the MCP endpoint and the hooks use. A call must name a workspace on the
 * worker's own host (a workspace id, a chat of one, or a working directory in
 * one), so an agent on one machine cannot reach another machine's workspaces.
 */

import path from "node:path";
import type { RelayHttpRequest } from "@band-app/link";
import { toWorkspaceId } from "@band-app/shared/workspace-id";

/**
 * The tRPC procedures an agent may call, by exact name. A procedure missing
 * from this list is refused, so one added to a router later stays out of
 * agent reach until someone reads its input and adds it here.
 */
export const RELAY_PROCEDURES: ReadonlySet<string> = new Set([
  "chats.list",
  "chats.create",
  "chats.get",
  "chats.sessionState",
  "chats.update",
  "chats.remove",
  "chats.send",
  "chats.stop",
  "chats.resume",
  "tasks.list",
  "tasks.submit",
  "tasks.isRunning",
  "tasks.abort",
  "queue.push",
  "queue.set",
  "queue.get",
  "queue.remove",
  "queue.update",
  "queue.shift",
  "queue.clear",
  "terminal.list",
  "terminal.create",
  "terminal.send",
  "terminal.output",
  "terminal.kill",
  "browsers.list",
  "browsers.create",
  "browsers.get",
  "browsers.update",
  "browsers.setProfile",
  "browsers.navigate",
  "browsers.remove",
  "subscriptions.create",
  "subscriptions.list",
  "agentSessions.list",
  "agentSessions.launch",
  "editor.openFile",
  "statuses.notify",
  "statuses.clearNeedsAttention",
]);

/** Procedures that take the workspace from the caller's headers, which the hub sets from the token's scope. */
const SCOPE_FROM_HEADERS = new Set(["subscriptions.create", "subscriptions.list"]);

const CHAT_ROUTE = /^\/api\/chats\/([^/]+)\/(events|history|messages)$/;
const MAX_DEPTH = 8;

export interface ScopeLookups {
  /** The host a workspace lives on, or null when there is no such workspace. */
  hostOfWorkspace(workspaceId: string): string | null;
  /** The workspace a chat belongs to, or null when the chat does not exist. */
  workspaceOfChat(chatId: string): string | null;
  /** The workspace whose worktree contains `cwd`, or null. */
  workspaceOfCwd(cwd: string): string | null;
  /** The host a terminal runs on, or null when there is no such terminal. */
  hostOfTerminal(terminalId: string): string | null;
  /** The workspace a browser tab belongs to, or null when there is no such tab. */
  workspaceOfBrowser(browserId: string): string | null;
}

export type RelayVerdict = { ok: true } | { ok: false; status: number; reason: string };

const deny = (status: number, reason: string): RelayVerdict => ({ ok: false, status, reason });

interface Named {
  workspaces: string[];
  chats: string[];
  cwds: string[];
  terminals: string[];
  browsers: string[];
  /** Set when an input carries a key that names a target the relay cannot check. */
  unscoped: boolean;
}

/** Keys that pick a target on their own. An unchecked one next to a valid workspaceId would slip past the scope check. */
const UNSCOPED_KEYS = new Set([
  "taskId",
  "hostId",
  "hostProjectPath",
  "worktreePath",
  "key",
  "profileId",
]);

function collect(value: unknown, into: Named, depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (depth === 0) {
    const { project, name } = record;
    if (typeof project === "string" && typeof name === "string") {
      into.workspaces.push(toWorkspaceId(project, name));
    } else if (project !== undefined || name !== undefined) {
      into.unscoped = true;
    }
  }
  for (const [key, v] of Object.entries(record)) {
    if (depth === 0 && UNSCOPED_KEYS.has(key)) into.unscoped = true;
    if (typeof v === "string") {
      if (key === "terminalId") into.terminals.push(v);
      else if (key === "browserId") into.browsers.push(v);
      else if (key === "workspaceId") into.workspaces.push(v);
      else if (key === "chatId") into.chats.push(v);
      else if (key === "cwd") into.cwds.push(v);
    } else {
      collect(v, into, depth + 1);
    }
  }
}

/** Checks that everything `input` names belongs to `workerId`'s host. */
function checkNamed(
  input: unknown,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict & {
  named?: number;
} {
  const named: Named = {
    workspaces: [],
    chats: [],
    cwds: [],
    terminals: [],
    browsers: [],
    unscoped: false,
  };
  collect(input, named);
  const outside = deny(403, "That workspace is not on this host");
  if (named.unscoped) return deny(403, "That call names a target the relay cannot check");
  for (const id of named.workspaces) {
    if (lookups.hostOfWorkspace(id) !== workerId) return outside;
  }
  for (const id of named.chats) {
    const workspace = lookups.workspaceOfChat(id);
    if (workspace === null || lookups.hostOfWorkspace(workspace) !== workerId) return outside;
  }
  for (const cwd of named.cwds) {
    const workspace = lookups.workspaceOfCwd(path.resolve(cwd));
    if (workspace === null || lookups.hostOfWorkspace(workspace) !== workerId) return outside;
  }
  for (const id of named.terminals) {
    if (lookups.hostOfTerminal(id) !== workerId) return outside;
  }
  for (const id of named.browsers) {
    const workspace = lookups.workspaceOfBrowser(id);
    if (workspace === null || lookups.hostOfWorkspace(workspace) !== workerId) return outside;
  }
  return {
    ok: true,
    named:
      named.workspaces.length +
      named.chats.length +
      named.cwds.length +
      named.terminals.length +
      named.browsers.length,
  };
}

/**
 * `chats.create` and `browsers.create` let the caller pick the new id. An id
 * that already exists must belong to the workspace the call names, so an agent
 * cannot take over or collide with another workspace's chat or tab.
 */
function checkChosenId(procedure: string, input: unknown, lookups: ScopeLookups): RelayVerdict {
  if (procedure !== "chats.create" && procedure !== "browsers.create") return { ok: true };
  const { id, workspaceId } = (input ?? {}) as { id?: unknown; workspaceId?: unknown };
  if (id === undefined) return { ok: true };
  if (typeof id !== "string") return deny(400, "id must be a string");
  const owner =
    procedure === "chats.create" ? lookups.workspaceOfChat(id) : lookups.workspaceOfBrowser(id);
  if (owner !== null && owner !== workspaceId) {
    return deny(403, "That id belongs to another workspace");
  }
  return { ok: true };
}

/** One procedure call: allowed, and tied to this host by what it names (or by the token's scope). */
function checkCall(
  procedure: string,
  input: unknown,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  if (!RELAY_PROCEDURES.has(procedure)) return deny(403, `${procedure} is not available to agents`);
  const verdict = checkNamed(input, workerId, lookups);
  if (!verdict.ok) return verdict;
  if (verdict.named === 0 && !SCOPE_FROM_HEADERS.has(procedure)) {
    return deny(403, `${procedure} must name a workspace on this host`);
  }
  return checkChosenId(procedure, input, lookups);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function checkTrpc(
  request: RelayHttpRequest,
  url: URL,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  const procedures = decodeURIComponent(url.pathname.slice("/trpc/".length))
    .split(",")
    .filter((p) => p !== "");
  if (procedures.length === 0) return deny(400, "No procedure named");
  const isBatch = url.searchParams.get("batch") === "1" || procedures.length > 1;
  const raw = request.method === "GET" ? url.searchParams.get("input") : bodyText(request.body);
  let input: unknown;
  if (raw) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return deny(400, "The input is not JSON");
    input = parsed.value;
  }
  for (const [i, procedure] of procedures.entries()) {
    const own =
      isBatch && input !== null && typeof input === "object"
        ? (input as Record<string, unknown>)[String(i)]
        : input;
    const verdict = checkCall(procedure, own, workerId, lookups);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function bodyText(body: string | undefined): string {
  return body ? Buffer.from(body, "base64").toString("utf8") : "";
}

function checkMcp(
  request: RelayHttpRequest,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  const text = bodyText(request.body);
  if (text === "") return { ok: true };
  const parsed = parseJson(text);
  if (!parsed.ok) return deny(400, "The body is not JSON");
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const { method, params } = message as { method?: unknown; params?: Record<string, unknown> };
    if (method !== "tools/call") continue;
    const name = typeof params?.name === "string" ? params.name : "";
    if (!name.startsWith("band_")) return deny(403, "Unknown tool");
    const procedure = name.slice("band_".length).replace(/_/g, ".");
    const verdict = checkCall(procedure, params?.arguments, workerId, lookups);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function checkChatRoute(
  request: RelayHttpRequest,
  chatId: string,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  const body = request.method === "POST" ? parseJson(bodyText(request.body)) : null;
  if (body && !body.ok) return deny(400, "The body is not JSON");
  const workspace = lookups.workspaceOfChat(chatId);
  if (workspace === null) return deny(404, "No such chat");
  return checkNamed({ chatId, ...(body?.ok ? { body: body.value } : {}) }, workerId, lookups);
}

/** Whether a call that came up a worker's link may go on to the hub. */
export function checkRelayRequest(
  request: RelayHttpRequest,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  const scope = checkNamed(
    { workspaceId: request.scope.workspaceId, chatId: request.scope.chatId },
    workerId,
    lookups,
  );
  if (!scope.ok) return scope;
  if (lookups.hostOfWorkspace(request.scope.workspaceId) !== workerId) {
    return deny(403, "That workspace is not on this host");
  }

  let url: URL;
  try {
    url = new URL(request.path, "http://relay.invalid");
  } catch {
    return deny(400, "Bad path");
  }
  const { pathname } = url;
  if (pathname === "/api/health" && request.method === "GET") return { ok: true };
  if (pathname === "/mcp") return checkMcp(request, workerId, lookups);
  if (pathname.startsWith("/trpc/")) {
    try {
      return checkTrpc(request, url, workerId, lookups);
    } catch {
      return deny(400, "Bad path");
    }
  }
  const chat = CHAT_ROUTE.exec(pathname);
  if (chat) {
    try {
      return checkChatRoute(request, decodeURIComponent(chat[1]), workerId, lookups);
    } catch {
      return deny(400, "Bad path");
    }
  }
  return deny(403, "That route is not available to agents");
}
