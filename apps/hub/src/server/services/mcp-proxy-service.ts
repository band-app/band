/**
 * The MCP proxy's state (plan step 4.2): the servers an admin configured, the
 * per-session tokens agents present, the audit log, and the credential the hub
 * injects upstream. The request flow is in `api/mcp-proxy/handler.ts`.
 *
 * A session token (`mcp_...`) names the servers it may reach and expires.
 * Only its SHA-256 is stored, and no log line holds a token or a credential.
 * Agents never see the vault credential: the proxy adds it to the upstream
 * request.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { McpProxyInputError, McpServerNotFoundError } from "../errors";
import {
  type McpAuditRow,
  McpProxyQueries,
  type McpProxyTokenRow,
  type McpServerRow,
} from "../infra/db/queries/mcp-proxy";
import type { McpStdioEnvEntry } from "../infra/db/schema";
import { subscribe } from "../infra/events/status-event-bus";
import { hostRegistry } from "../infra/host/registry";
import { mcpStdioService } from "./mcp-stdio-service";
import { vaultService } from "./vault-service";

const log = createLogger("mcp-proxy-service");

export const MCP_TOKEN_PREFIX = "mcp_";
export const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
export const MAX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SERVERS_PER_TOKEN = 50;
const MAX_TOOL_NAMES = 500;
const TOUCH_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const DEAD_TOKEN_KEEP_MS = 60 * 60 * 1000;
const AUDIT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_ENTRIES = 50;
const MAX_ARGS = 100;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Headers the proxy sets itself, so a credential can't be pointed at them. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  transport: "http" | "stdio";
  /** For `stdio`: the worker that runs `command`, and what it runs. `url` is empty. */
  hostId: string | null;
  command: string | null;
  args: string[];
  env: McpStdioEnvEntry[];
  cwd: string | null;
  vaultItemId: string | null;
  headerName: string;
  headerPrefix: string;
  allowTools: string[] | null;
  readOnly: boolean;
  readOnlyTools: string[];
  enabled: boolean;
  /** Project names that get the server, or null for every project. */
  scopeProjects: string[] | null;
  /** Host ids that get the server, or null for every host. */
  scopeHosts: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  /** Required for an HTTP server, and not allowed for a stdio one. */
  url?: string;
  transport?: "http" | "stdio";
  /** A stdio server's host, command line and environment. `env` names carry a literal or a vault item. */
  hostId?: string;
  command?: string;
  args?: string[];
  env?: McpStdioEnvEntry[];
  cwd?: string | null;
  vaultItemId?: string | null;
  headerName?: string;
  headerPrefix?: string;
  allowTools?: string[] | null;
  readOnly?: boolean;
  readOnlyTools?: string[];
  enabled?: boolean;
  scopeProjects?: string[] | null;
  scopeHosts?: string[] | null;
}

export type McpAuthResult =
  | { ok: true; sessionId: string; tokenId: string }
  | { ok: false; status: 401 | 403; reason: string };

export interface IssuedMcpToken {
  token: string;
  tokenId: string;
  expiresAt: number;
}

export interface McpAuditEntry {
  server: string;
  tool: string;
  sessionId: string;
  ok: boolean;
  error?: string;
}

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

function sameHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function checkUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpProxyInputError("The URL is not valid.");
  }
  if (url.username || url.password) {
    throw new McpProxyInputError("Put credentials in the vault, not in the URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new McpProxyInputError("The URL must be https, or http on loopback.");
  }
  url.hash = "";
  return url.toString();
}

function checkToolList(label: string, list: string[]): string[] {
  if (list.length > MAX_TOOL_NAMES) {
    throw new McpProxyInputError(`${label} has more than ${MAX_TOOL_NAMES} names.`);
  }
  const names = list.map((n) => n.trim());
  if (names.some((n) => n === "" || n.length > 200)) {
    throw new McpProxyInputError(`${label} holds an empty or overlong tool name.`);
  }
  return [...new Set(names)];
}

function checkCommand(command: string | undefined): string {
  const trimmed = command?.trim() ?? "";
  if (!trimmed || trimmed.length > 1000 || trimmed.includes("\0")) {
    throw new McpProxyInputError(
      "A stdio server needs a command (an executable, not a shell line).",
    );
  }
  return trimmed;
}

function checkArgs(args: string[]): string[] {
  if (args.length > MAX_ARGS || args.some((a) => a.length > 4096 || a.includes("\0"))) {
    throw new McpProxyInputError("args has too many entries, or one is too long.");
  }
  return args;
}

function checkCwd(cwd: string | null | undefined): string | null {
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (cwd.length > 4096 || cwd.includes("\0"))
    throw new McpProxyInputError("The cwd is not valid.");
  return cwd;
}

function checkScope(label: string, list: string[] | null | undefined): string[] | null {
  if (list === null || list === undefined) return null;
  if (list.length > 200) throw new McpProxyInputError(`${label} has more than 200 entries.`);
  const names = list.map((n) => n.trim());
  if (names.some((n) => n === "" || n.length > 200)) {
    throw new McpProxyInputError(`${label} holds an empty or overlong entry.`);
  }
  return [...new Set(names)];
}

function view(row: McpServerRow): McpServerView {
  return { ...row };
}

export class McpProxyService {
  private stopListening: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What `tools/list` showed per server: tool name to `readOnlyHint`. */
  private readonly toolCache = new Map<string, { at: number; tools: Map<string, boolean> }>();

  constructor(private readonly queries: McpProxyQueries = new McpProxyQueries()) {}

  /** Revokes a session's tokens when it ends, and sweeps dead tokens and old audit rows. */
  start(): void {
    if (this.stopListening) return;
    this.stopListening = subscribe((event) => {
      if (event.kind === "agent-session-ended" && event.agentSession) {
        this.revokeSession(event.agentSession.id);
        if (event.agentSession.chatId) this.revokeSession(event.agentSession.chatId);
      } else if (event.kind === "chat-removed" && event.chatId) {
        this.revokeSession(event.chatId);
      }
    });
    this.sweep();
    mcpStdioService.start();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    mcpStdioService.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep(now = Date.now()): void {
    this.queries.deleteDeadTokens(now - DEAD_TOKEN_KEEP_MS);
    this.queries.pruneAudit(now - AUDIT_KEEP_MS);
  }

  // ---- servers ------------------------------------------------------------------

  listServers(): McpServerView[] {
    return this.queries.listServers().map(view);
  }

  /** The server a request may proxy to, or undefined when it is missing or disabled. */
  getEnabledServer(name: string): McpServerView | undefined {
    const row = this.queries.findServer(name);
    return row?.enabled ? view(row) : undefined;
  }

  /**
   * The enabled servers a session in `project` on `hostId` may use. A server
   * with a scope list the session is not in is left out.
   */
  serversForSession(project: string, hostId: string): McpServerView[] {
    return this.queries
      .listServers()
      .filter(
        (row) =>
          row.enabled &&
          (!row.scopeProjects || row.scopeProjects.includes(project)) &&
          (!row.scopeHosts || row.scopeHosts.includes(hostId)),
      )
      .map(view);
  }

  addServer(input: McpServerInput): McpServerView {
    const name = input.name.trim();
    if (!SERVER_NAME.test(name)) {
      throw new McpProxyInputError(
        "The name must be lowercase letters, digits, hyphens and underscores, starting with a letter or digit.",
      );
    }
    if (this.queries.findServer(name)) {
      throw new McpProxyInputError(`An MCP server named "${name}" already exists.`);
    }
    const now = Date.now();
    const transport = input.transport ?? "http";
    const base = {
      id: `m-${randomUUID().slice(0, 12)}`,
      name,
      allowTools: input.allowTools ? checkToolList("allowTools", input.allowTools) : null,
      readOnly: input.readOnly ?? false,
      readOnlyTools: checkToolList("readOnlyTools", input.readOnlyTools ?? []),
      enabled: input.enabled ?? true,
      scopeProjects: checkScope("scopeProjects", input.scopeProjects),
      scopeHosts: checkScope("scopeHosts", input.scopeHosts),
      createdAt: now,
      updatedAt: now,
    };
    let row: McpServerRow;
    if (transport === "stdio") {
      if (input.url || input.vaultItemId || input.headerName || input.headerPrefix) {
        throw new McpProxyInputError(
          "A stdio server takes a host, a command and env, not a URL or a header credential.",
        );
      }
      row = {
        ...base,
        url: "",
        transport,
        hostId: this.checkHost(input.hostId),
        command: checkCommand(input.command),
        args: checkArgs(input.args ?? []),
        env: this.checkEnv(input.env ?? []),
        cwd: checkCwd(input.cwd),
        vaultItemId: null,
        headerName: "Authorization",
        headerPrefix: "Bearer ",
      };
    } else {
      if (!input.url) throw new McpProxyInputError("An HTTP server needs a URL.");
      if (input.hostId || input.command || input.args || input.env || input.cwd) {
        throw new McpProxyInputError(
          "Only a stdio server takes a host, command, args, env or cwd.",
        );
      }
      row = {
        ...base,
        url: checkUrl(input.url),
        transport,
        hostId: null,
        command: null,
        args: [],
        env: [],
        cwd: null,
        vaultItemId: this.checkVaultItem(input.vaultItemId),
        headerName: this.checkHeaderName(input.headerName ?? "Authorization"),
        headerPrefix: this.checkHeaderPrefix(input.headerPrefix ?? "Bearer "),
      };
    }
    this.queries.insertServer(row);
    log.info({ name, id: row.id }, "mcp server added");
    return view(row);
  }

  updateServer(name: string, patch: Partial<Omit<McpServerInput, "name">>): McpServerView {
    const row = this.queries.findServer(name);
    if (!row) throw new McpServerNotFoundError(name);
    const next: Partial<Omit<McpServerRow, "id" | "name">> = { updatedAt: Date.now() };
    const stdio = row.transport === "stdio";
    const httpOnly = [patch.url, patch.vaultItemId, patch.headerName, patch.headerPrefix];
    const stdioOnly = [patch.hostId, patch.command, patch.args, patch.env, patch.cwd];
    if ((stdio ? httpOnly : stdioOnly).some((v) => v !== undefined)) {
      throw new McpProxyInputError(
        stdio
          ? "A stdio server has no URL or header credential."
          : "Only a stdio server has a host, command, args, env or cwd.",
      );
    }
    if (patch.url !== undefined) next.url = checkUrl(patch.url);
    if (patch.hostId !== undefined) next.hostId = this.checkHost(patch.hostId);
    if (patch.command !== undefined) next.command = checkCommand(patch.command);
    if (patch.args !== undefined) next.args = checkArgs(patch.args);
    if (patch.env !== undefined) next.env = this.checkEnv(patch.env);
    if (patch.cwd !== undefined) next.cwd = checkCwd(patch.cwd);
    if (patch.vaultItemId !== undefined) next.vaultItemId = this.checkVaultItem(patch.vaultItemId);
    if (patch.headerName !== undefined) next.headerName = this.checkHeaderName(patch.headerName);
    if (patch.headerPrefix !== undefined) {
      next.headerPrefix = this.checkHeaderPrefix(patch.headerPrefix);
    }
    if (patch.allowTools !== undefined) {
      next.allowTools = patch.allowTools ? checkToolList("allowTools", patch.allowTools) : null;
    }
    if (patch.readOnly !== undefined) next.readOnly = patch.readOnly;
    if (patch.readOnlyTools !== undefined) {
      next.readOnlyTools = checkToolList("readOnlyTools", patch.readOnlyTools);
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.scopeProjects !== undefined) {
      next.scopeProjects = checkScope("scopeProjects", patch.scopeProjects);
    }
    if (patch.scopeHosts !== undefined)
      next.scopeHosts = checkScope("scopeHosts", patch.scopeHosts);
    this.queries.updateServer(name, next);
    this.toolCache.delete(row.id);
    // New destination or credential: tokens issued for the old one must not carry over.
    const moved = (["url", "vaultItemId", "hostId", "command", "cwd"] as const).some(
      (key) => next[key] !== undefined && next[key] !== row[key],
    );
    const reconfigured = (["args", "env"] as const).some(
      (key) => next[key] !== undefined && JSON.stringify(next[key]) !== JSON.stringify(row[key]),
    );
    if (moved || reconfigured) {
      this.queries.dropServerFromTokens(name, Date.now());
    }
    // A running process holds the old command line and secrets, so it ends with the change.
    if (moved || reconfigured || next.enabled === false) mcpStdioService.closeServer(name);
    log.info({ name }, "mcp server updated");
    return view({ ...row, ...next });
  }

  removeServer(name: string): void {
    const row = this.queries.findServer(name);
    if (!row || !this.queries.removeServer(name)) throw new McpServerNotFoundError(name);
    this.toolCache.delete(row.id);
    this.queries.dropServerFromTokens(name, Date.now());
    mcpStdioService.closeServer(name);
    log.info({ name }, "mcp server removed");
  }

  private checkHost(hostId: string | undefined): string {
    if (!hostId?.trim()) throw new McpProxyInputError("A stdio server needs a host id.");
    try {
      hostRegistry.hostById(hostId);
    } catch {
      throw new McpProxyInputError(`No host with the id "${hostId}".`);
    }
    return hostId;
  }

  /** Each name is a valid variable name, used once, with a literal or a vault item that holds a secret value. */
  private checkEnv(entries: McpStdioEnvEntry[]): McpStdioEnvEntry[] {
    if (entries.length > MAX_ENV_ENTRIES) {
      throw new McpProxyInputError(`env has more than ${MAX_ENV_ENTRIES} entries.`);
    }
    const seen = new Set<string>();
    return entries.map((entry) => {
      if (!ENV_NAME.test(entry.name)) {
        throw new McpProxyInputError(`"${entry.name}" is not a valid environment variable name.`);
      }
      if (seen.has(entry.name)) {
        throw new McpProxyInputError(`env names ${entry.name} twice.`);
      }
      seen.add(entry.name);
      if ("vaultItemId" in entry) {
        const kind = vaultService.kindOf(entry.vaultItemId);
        if (!kind) throw new McpProxyInputError("No credential with that id in the vault.");
        if (kind === "oauth") {
          throw new McpProxyInputError("An OAuth connection can't be passed as an env value.");
        }
        return { name: entry.name, vaultItemId: entry.vaultItemId };
      }
      if (entry.value.length > 4096 || entry.value.includes("\0")) {
        throw new McpProxyInputError(`The value of ${entry.name} is too long or has a NUL byte.`);
      }
      return { name: entry.name, value: entry.value };
    });
  }

  private checkVaultItem(id: string | null | undefined): string | null {
    if (id === undefined || id === null || id === "") return null;
    const kind = vaultService.kindOf(id);
    if (!kind) throw new McpProxyInputError("No credential with that id in the vault.");
    if (kind === "env") {
      throw new McpProxyInputError("An env credential can't authenticate an MCP server.");
    }
    return id;
  }

  private checkHeaderName(name: string): string {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new McpProxyInputError("That header name can't carry a credential.");
    }
    return name;
  }

  private checkHeaderPrefix(prefix: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (prefix.length > 32 || /[\u0000-\u001f\u007f]/.test(prefix)) {
      throw new McpProxyInputError("The header prefix is too long or has control characters.");
    }
    return prefix;
  }

  // ---- credential -----------------------------------------------------------------

  /**
   * The header that carries the vault credential upstream, or none when the
   * server has no credential. `refreshable` is true for OAuth, whose token the
   * proxy renews after a 401. `forceRefresh` renews it first.
   */
  async credentialHeaders(
    server: McpServerView,
    forceRefresh = false,
  ): Promise<{ headers: Record<string, string>; refreshable: boolean }> {
    if (!server.vaultItemId) return { headers: {}, refreshable: false };
    const credential = await vaultService.getCredential(server.vaultItemId, forceRefresh);
    if (credential.kind === "oauth") {
      return { headers: { authorization: `Bearer ${credential.value}` }, refreshable: true };
    }
    return {
      headers: { [server.headerName.toLowerCase()]: `${server.headerPrefix}${credential.value}` },
      refreshable: false,
    };
  }

  // ---- session tokens -----------------------------------------------------------------

  /**
   * A token for one agent session to reach `servers` through the proxy. It
   * expires after `ttlMs` (default 1 hour, at most 24) and is revoked when the
   * session ends. The token is returned once.
   */
  issueSessionToken(
    sessionId: string,
    servers: string[],
    ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ): IssuedMcpToken {
    if (!sessionId.trim()) throw new McpProxyInputError("A session id is required.");
    const names = [...new Set(servers)];
    if (names.length === 0 || names.length > MAX_SERVERS_PER_TOKEN) {
      throw new McpProxyInputError(`Name between 1 and ${MAX_SERVERS_PER_TOKEN} servers.`);
    }
    for (const name of names) {
      if (!this.queries.findServer(name)) throw new McpServerNotFoundError(name);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TOKEN_TTL_MS) {
      throw new McpProxyInputError("The lifetime must be positive and at most 24 hours.");
    }
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const row: McpProxyTokenRow = {
      id: `mt-${randomUUID().slice(0, 12)}`,
      hash: sha256hex(token),
      sessionId,
      servers: names,
      createdAt: now,
      expiresAt: now + ttlMs,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.queries.insertToken(row);
    log.info({ tokenId: row.id, sessionId, servers: names }, "mcp session token issued");
    return { token, tokenId: row.id, expiresAt: row.expiresAt };
  }

  /** Revokes every token of a session. Returns how many were live. */
  revokeSession(sessionId: string): number {
    const revoked = this.queries.revokeSession(sessionId, Date.now());
    if (revoked > 0) log.info({ sessionId, revoked }, "mcp session tokens revoked");
    mcpStdioService.closeProxySession(sessionId);
    return revoked;
  }

  /** Checks a presented token for one server. 401 for a bad token, 403 for one that can't reach this server. */
  authenticate(token: string | undefined, serverName: string): McpAuthResult {
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
      return { ok: false, status: 401, reason: "Missing or invalid token" };
    }
    const hash = sha256hex(token);
    const row = this.queries.findTokenByHash(hash);
    const now = Date.now();
    if (!row || !sameHash(row.hash, hash) || row.revokedAt !== null || row.expiresAt <= now) {
      return { ok: false, status: 401, reason: "Missing or invalid token" };
    }
    if (!row.servers.includes(serverName)) {
      return { ok: false, status: 403, reason: "This token cannot use that server" };
    }
    if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) {
      this.queries.touchToken(row.id, now);
    }
    return { ok: true, sessionId: row.sessionId, tokenId: row.id };
  }

  // ---- tool cache --------------------------------------------------------------------

  /** Remembers which tools of a server are read-only, from a `tools/list` answer. */
  rememberTools(serverId: string, tools: Map<string, boolean>): void {
    const now = Date.now();
    const previous = this.toolCache.get(serverId);
    const fresh = previous && now - previous.at <= TOOL_CACHE_TTL_MS ? previous.tools : undefined;
    this.toolCache.set(serverId, { at: now, tools: new Map([...(fresh ?? []), ...tools]) });
  }

  /** What a recent `tools/list` showed for a tool: its `readOnlyHint`, or undefined when unseen. */
  knownReadOnly(serverId: string, tool: string): boolean | undefined {
    const entry = this.toolCache.get(serverId);
    if (!entry || Date.now() - entry.at > TOOL_CACHE_TTL_MS) return undefined;
    return entry.tools.get(tool);
  }

  // ---- audit -----------------------------------------------------------------------------

  recordCall(entry: McpAuditEntry): void {
    try {
      this.queries.insertAudit({
        at: Date.now(),
        server: entry.server,
        tool: entry.tool.slice(0, 200),
        sessionId: entry.sessionId,
        ok: entry.ok,
        error: entry.error ?? null,
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "mcp audit write failed");
    }
  }

  listAudit(limit: number, server?: string): McpAuditRow[] {
    return this.queries.listAudit(limit, server);
  }
}

export const mcpProxyService = new McpProxyService();
