/**
 * Stdio MCP servers behind `/mcp-proxy/<server>` (plan step 4.4).
 *
 * A stdio server runs as a process on a worker (or the local host), started by
 * `host.mcp.openStdio` and reached through one link channel that carries its
 * JSON-RPC lines. The hub keeps one process per MCP session: the proxy's
 * `initialize` starts it and a `DELETE`, a revoked token, an idle timeout or a
 * lost link ends it.
 *
 * The server's env may name vault items. Their plaintext is read here, sent
 * inside `mcp.stdio.open` for that one process and never logged or stored.
 */

import { randomBytes } from "node:crypto";
import { HostOfflineError, type McpStdio } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { hostRegistry } from "../infra/host/registry";
import { vaultService } from "./vault-service";

const log = createLogger("mcp-stdio");

const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_PROXY_SESSION = 8;
/** The longest line a server may write. A longer one ends the session. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_MS = 30_000;

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const keyOf = (id: unknown): string | null =>
  typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : null;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** What the service needs to know about a stdio server. */
export interface StdioTarget {
  id: string;
  name: string;
  hostId: string | null;
  command: string | null;
  args: string[];
  env: ({ name: string; value: string } | { name: string; vaultItemId: string })[];
  cwd: string | null;
}

/** A session that cannot start, with the HTTP status the proxy answers. */
export class StdioOpenError extends Error {
  constructor(
    readonly status: 429 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "StdioOpenError";
  }
}

export class StdioSessionClosedError extends Error {
  constructor(readonly reason: string) {
    super(`The stdio MCP server's session ended: ${reason}`);
    this.name = "StdioSessionClosedError";
  }
}

interface Pending {
  resolve: (message: JsonObject) => void;
  reject: (err: Error) => void;
}

export class StdioSession {
  readonly id = `ms-${randomBytes(18).toString("base64url")}`;
  lastUsedAt = Date.now();
  private readonly pending = new Map<string, Pending>();
  private listener: ((message: JsonObject) => void) | undefined;
  private onCloseStream: (() => void) | undefined;
  private closedReason: string | undefined;
  private internalIds = 0;

  constructor(
    readonly serverName: string,
    readonly proxySessionId: string,
    private readonly proc: McpStdio,
    private readonly onClosed: (session: StdioSession) => void,
  ) {
    void this.read();
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Sends messages to the server. Throws once the session has ended. */
  write(messages: unknown[]): void {
    if (this.closedReason !== undefined) throw new StdioSessionClosedError(this.closedReason);
    this.lastUsedAt = Date.now();
    for (const message of messages) this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** True when `id` names a request that has no answer yet. */
  isPending(id: unknown): boolean {
    const key = keyOf(id);
    return key !== null && this.pending.has(key);
  }

  /** Answers to the requests among `messages`, in order. Notifications and responses are only sent. */
  async exchange(messages: unknown[], signal: AbortSignal): Promise<JsonObject[]> {
    const waits: Promise<JsonObject>[] = [];
    const keys: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const timeoutMs = envMs("BAND_MCP_STDIO_CALL_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS);
    for (const message of messages) {
      if (!isObject(message) || typeof message.method !== "string") continue;
      const key = keyOf(message.id);
      if (key === null) continue;
      keys.push(key);
      const wait = new Promise<JsonObject>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The stdio MCP server did not answer in time")),
          timeoutMs,
        );
        timer.unref();
        timers.push(timer);
        this.pending.set(key, {
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
      // A write that throws below leaves these unawaited, so mark them handled.
      wait.catch(() => undefined);
      waits.push(wait);
    }
    const forget = () => {
      for (const key of keys) this.pending.delete(key);
      for (const timer of timers) clearTimeout(timer);
    };
    const aborted = new Promise<never>((_, reject) => {
      const stop = () => reject(new Error("The caller went away"));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      this.write(messages);
      return await Promise.race([Promise.all(waits), aborted]);
    } finally {
      forget();
    }
  }

  /** One `tools/list` page, for the proxy's read-only lookup. */
  async listPage(cursor: string | undefined, signal: AbortSignal): Promise<JsonObject | undefined> {
    const id = `band-proxy-list-${++this.internalIds}`;
    try {
      const [answer] = await this.exchange(
        [{ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} }],
        signal,
      );
      return answer && isObject(answer.result) ? answer.result : undefined;
    } catch {
      return undefined;
    }
  }

  /** Server messages that answer no request (notifications, server requests), for the GET stream. */
  attach(listener: (message: JsonObject) => void, onClose?: () => void): boolean {
    if (this.listener) return false;
    this.listener = listener;
    this.onCloseStream = onClose;
    return true;
  }

  detach(listener: (message: JsonObject) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const waiter of this.pending.values()) waiter.reject(new StdioSessionClosedError(reason));
    this.pending.clear();
    this.onCloseStream?.();
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
    this.onClosed(this);
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout) {
        this.lastUsedAt = Date.now();
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.handleLine(line);
          nl = buffer.indexOf("\n");
        }
        if (buffer.length > MAX_LINE_BYTES) {
          this.close("the server wrote a line that was too long");
          return;
        }
      }
      this.close("the server process ended");
    } catch (err) {
      this.close(err instanceof HostOfflineError ? "host-offline" : "link-lost");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a server may print a stray line, which is not JSON-RPC
    }
    for (const item of Array.isArray(message) ? message : [message]) {
      if (!isObject(item)) continue;
      const key = "method" in item ? null : keyOf(item.id);
      const waiter = key === null ? undefined : this.pending.get(key);
      if (waiter && key !== null) {
        this.pending.delete(key);
        waiter.resolve(item);
      } else if ("method" in item) {
        // Only notifications and server requests. A late answer to a caller that left is dropped, so it never skips the filters.
        this.listener?.(item);
      }
    }
  }
}

export class McpStdioService {
  private readonly sessions = new Map<string, StdioSession>();
  private readonly starting: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepIdle(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeAll("hub stopping");
  }

  get(id: string): StdioSession | undefined {
    return this.sessions.get(id);
  }

  /** Starts a server process for one MCP session. */
  async open(server: StdioTarget, proxySessionId: string): Promise<StdioSession> {
    if (!server.hostId || !server.command) {
      throw new StdioOpenError(502, "This MCP server has no host or command configured");
    }
    // Opens in flight count too, because the awaits below would let a burst pass the caps.
    const live = [...this.sessions.values()];
    if (
      live.length + this.starting.length >= MAX_SESSIONS ||
      live.filter((s) => s.proxySessionId === proxySessionId).length +
        this.starting.filter((id) => id === proxySessionId).length >=
        MAX_SESSIONS_PER_PROXY_SESSION
    ) {
      throw new StdioOpenError(429, "Too many stdio MCP sessions are open");
    }
    this.starting.push(proxySessionId);
    try {
      return await this.openReserved(server, proxySessionId);
    } finally {
      this.starting.splice(this.starting.indexOf(proxySessionId), 1);
    }
  }

  private async openReserved(server: StdioTarget, proxySessionId: string): Promise<StdioSession> {
    if (!server.hostId || !server.command) throw new StdioOpenError(502, "No host or command");
    let host: ReturnType<typeof hostRegistry.hostById>;
    try {
      host = hostRegistry.hostById(server.hostId);
    } catch {
      throw new StdioOpenError(503, `The host "${server.hostId}" for this MCP server is not known`);
    }
    const env = await this.resolveEnv(server);
    let proc: McpStdio;
    try {
      proc = await host.mcp.openStdio({
        serverId: server.id,
        command: server.command,
        args: server.args,
        env,
        cwd: server.cwd ?? undefined,
      });
    } catch (err) {
      if (err instanceof HostOfflineError) {
        throw new StdioOpenError(503, `The host "${server.hostId}" is offline`);
      }
      // The error text may quote the command line, so only its name goes in the log.
      log.warn(
        {
          server: server.name,
          host: server.hostId,
          err: err instanceof Error ? err.name : "unknown",
        },
        "stdio mcp server did not start",
      );
      throw new StdioOpenError(
        502,
        `The stdio MCP server could not start on host "${server.hostId}"`,
      );
    }
    const session = new StdioSession(server.name, proxySessionId, proc, (s) =>
      this.sessions.delete(s.id),
    );
    this.sessions.set(session.id, session);
    log.info(
      { server: server.name, host: server.hostId, pid: proc.pid },
      "stdio mcp session opened",
    );
    return session;
  }

  /** Ends every session of one agent's proxy token. */
  closeProxySession(proxySessionId: string): void {
    for (const s of this.sessions.values()) {
      if (s.proxySessionId === proxySessionId) s.close("the proxy session ended");
    }
  }

  /** Ends every session of a server that was changed or removed. */
  closeServer(serverName: string): void {
    for (const s of this.sessions.values()) {
      if (s.serverName === serverName) s.close("the server was changed");
    }
  }

  closeAll(reason: string): void {
    for (const s of this.sessions.values()) s.close(reason);
  }

  sweepIdle(now = Date.now()): void {
    const idle = envMs("BAND_MCP_STDIO_IDLE_MS", DEFAULT_IDLE_MS);
    for (const s of this.sessions.values()) {
      if (now - s.lastUsedAt > idle) s.close("idle");
    }
  }

  private async resolveEnv(server: StdioTarget): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const entry of server.env) {
      if ("vaultItemId" in entry) {
        try {
          env[entry.name] = (await vaultService.getCredential(entry.vaultItemId)).value;
        } catch {
          throw new StdioOpenError(502, `The credential for ${entry.name} is not in the vault`);
        }
      } else {
        env[entry.name] = entry.value;
      }
    }
    return env;
  }
}

export const mcpStdioService = new McpStdioService();
