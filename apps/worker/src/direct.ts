import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { FsEntry, FsStat, Host, HostFs, HostGit, HostSearch } from "@band-app/host-api";
import { TitlePoller } from "@band-app/host-local/terminals/title-poller";
import { mapLinkError } from "@band-app/host-remote";
import {
  type DirectRegisterReply,
  type DirectScopeParams,
  METHOD_DIRECT_REGISTER,
  RPC_INTERNAL_ERROR,
  RpcError,
} from "@band-app/link";
import {
  DIRECT_CALL_PREFIX,
  DIRECT_FALLBACK_CLOSE_CODE,
  DIRECT_TERMINAL_PATH,
  DIRECT_TOKEN_PREFIX,
  type DirectCallReply,
  isDirectProcedure,
} from "@band-app/shared/direct-access";
import { DiffService } from "@band-app/worktree-ops/diff";
import { directOps, type WorktreeOps } from "@band-app/worktree-ops/direct";
import { FilesService } from "@band-app/worktree-ops/files";
import { GitGraphService } from "@band-app/worktree-ops/git-graph";
import type { WorktreeResolver } from "@band-app/worktree-ops/resolver";
import { SearchService } from "@band-app/worktree-ops/search";
import {
  attachSession,
  createInbox,
  type TerminalSocketBackend,
} from "@band-app/worktree-ops/terminal-socket";
import { WebSocketServer } from "ws";
import { handleChatRoute, isChatRoute } from "./chats/local-http.ts";
import type { ChatOwner } from "./chats/owner.ts";
import { hostDirs, type Registrar, type WorkerContext } from "./context.ts";
import { isFileRoute, serveDirectFile } from "./direct-files.ts";
import { mapError, num, type Params, str } from "./rpc-util.ts";

/** Largest request body, a saved file included. The editor opens files of up to 1 MB. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The longest a token may last, whatever the hub asks for. */
const MAX_TOKEN_TTL_MS = 60 * 60_000;
/** Tokens held at once. The oldest goes first past this, so a flood of registrations cannot grow the table. */
const MAX_GRANTS = 1000;
/** WebSocket subprotocols the desktop app offers, as it does to the hub. */
const WS_BASE_PROTOCOL = "band";
const WS_TOKEN_PROTOCOL_PREFIX = "band-token.";
/** How long a terminal socket waits for a PTY the hub is still spawning, and how often it looks. */
const PTY_WAIT_MS = 5000;
const PTY_POLL_MS = 100;
/**
 * Pages that may call the listener: the desktop app's bundled UI for a remote hub
 * (`app://h-<hex>`, `apps/desktop/src/main/app-protocol.ts`). The bundled hub's own
 * pages (`app://local`) never take the direct path, and their CSP keeps them off loopback.
 */
const ALLOWED_ORIGIN = /^app:\/\/h-[0-9a-f]{12}$/;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Grant {
  scope: DirectScopeParams;
  expiresAt: number;
}

/**
 * The worker's direct listener. The desktop app
 * on this machine calls it on `127.0.0.1` for terminals, files, diff and
 * search, so those skip the hub. The hub still decides who may: it registers
 * each token over the link (`direct.register`) with the worktree it is for and
 * an expiry, and the worker keeps only the token's SHA-256.
 *
 * File, diff, search, commit history and path calls run the same services the hub runs
 * (`@band-app/worktree-ops`), over a host whose every call goes through this
 * worker's own method handlers, so the path policy and parameter checks of a
 * link call apply unchanged. The terminal socket speaks the hub's `/terminal`
 * protocol and attaches to PTYs the hub already spawned here. `GET` on the hub's
 * file routes (`direct-files.ts`) streams a worktree file, upload or shared file
 * from this disk under the same token.
 *
 * It is separate from the agent relay (`relay.ts`), whose tokens reach the hub
 * and never this listener.
 */
export class DirectListener {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly grants = new Map<string, Grant>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_BASE_PROTOCOL) ? WS_BASE_PROTOCOL : false),
  });
  private readonly host: Host;
  private readonly terminals: TerminalSocketBackend;
  private readonly titles: TitlePoller;

  constructor(
    private readonly ctx: WorkerContext,
    registrar: Registrar,
    /** The chats this worker owns, served on the same token. */
    private readonly chats: ChatOwner | null = null,
  ) {
    this.host = checkedHost(ctx, registrar);
    const pty = ctx.host.pty;
    this.titles = new TitlePoller(() => pty.listAll());
    this.terminals = {
      attach: (id, dims) => pty.attach(id, dims),
      input: (id, data) => pty.input(id, data),
      resize: (id, cols, rows) => pty.resize(id, cols, rows),
      nudgeResize: (id) => pty.nudgeResize(id),
      // Closing a terminal goes through the hub (`terminal.kill`), which also
      // drops it from the layout. A `close` frame here leaves the PTY running.
      kill: () => Promise.reject(new Error("closing a terminal goes through the hub")),
      onExit: (id, listener) =>
        pty.onExit((event) => {
          if (event.terminalId === id) listener(event);
        }),
      onTitle: (id, listener) => this.titles.watch(id, listener),
    };
  }

  /** Starts listening if needed and returns the port on `127.0.0.1`. */
  port(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.on("upgrade", (req, socket, head) => void this.upgrade(req, socket, head));
      // A failed listen is not cached, so the next registration tries again.
      const fail = (err: Error) => {
        this.listening = null;
        reject(err);
      };
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", fail);
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.listening;
  }

  register(token: string, scope: DirectScopeParams, expiresAt: number): void {
    const now = Date.now();
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
    while (this.grants.size >= MAX_GRANTS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
    this.grants.set(sha256(token), { scope, expiresAt });
  }

  async close(): Promise<void> {
    this.grants.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The scope of a live token, or undefined. */
  private scopeOf(token: string | undefined): DirectScopeParams | undefined {
    if (!token) return undefined;
    const grant = this.grants.get(sha256(token));
    if (!grant) return undefined;
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(sha256(token));
      return undefined;
    }
    return grant.scope;
  }

  /**
   * Refuses a request whose `Host` is not this loopback listener (a DNS
   * rebinding page) or whose `Origin` is a page other than the desktop app's.
   * A request with no `Origin` comes from a process, not a page.
   */
  private refusal(req: IncomingMessage): number | null {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      return 421;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGIN.test(origin)) return 403;
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin && ALLOWED_ORIGIN.test(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {};
    const reply = (status: number, body: DirectCallReply): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...cors,
      });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, code: string, message: string) =>
      reply(status, { error: { code, message } });

    const refused = this.refusal(req);
    if (refused !== null) return fail(refused, "FORBIDDEN", "Refused");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        // GET is the chat event stream, read with fetch so it can carry the token.
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "authorization, content-type, range",
        // Chrome's private network access preflight, for a page calling loopback.
        ...(req.headers["access-control-request-private-network"] === "true" && {
          "Access-Control-Allow-Private-Network": "true",
        }),
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (this.chats && isChatRoute(url.pathname)) {
      const scope = this.scopeOf(bearerToken(req));
      if (!scope) return fail(401, "UNAUTHORIZED", "Unauthorized");
      const release = this.ctx.activity.hold();
      try {
        await handleChatRoute(req, res, {
          owner: this.chats,
          worktreeId: scope.worktreeId,
          uploadsDir: hostDirs(this.ctx.policy.rootPaths)?.uploads,
          headers: cors,
        });
      } catch (err) {
        // Never let one request reject out of the server's handler and take the worker down.
        this.ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, "chat route");
        if (!res.headersSent) fail(500, "INTERNAL", "Internal error");
        else res.destroy();
      } finally {
        release();
      }
      return;
    }
    if (isFileRoute(url.pathname)) {
      const scope = this.scopeOf(bearerToken(req));
      if (!scope) return fail(401, "UNAUTHORIZED", "Unauthorized");
      try {
        await serveDirectFile(this.ctx, req, res, url, scope, cors);
      } catch (err) {
        this.ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, "file route");
        if (!res.headersSent) fail(500, "INTERNAL", "Internal error");
        else res.destroy();
      }
      return;
    }
    if (!url.pathname.startsWith(DIRECT_CALL_PREFIX)) return fail(404, "NOT_FOUND", "Not found");
    const procedure = url.pathname.slice(DIRECT_CALL_PREFIX.length);
    if (!isDirectProcedure(procedure)) return fail(404, "NOT_FOUND", "Not found");
    if (req.method !== "POST") return fail(405, "METHOD_NOT_SUPPORTED", "Use POST");

    const scope = this.scopeOf(bearerToken(req));
    if (!scope) return fail(401, "UNAUTHORIZED", "Unauthorized");

    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
    } catch {
      return fail(400, "BAD_REQUEST", "The body must be JSON of at most 16 MB");
    }
    const op = directOps[procedure];
    const parsed = op.input.safeParse(raw);
    if (!parsed.success) return fail(400, "BAD_REQUEST", parsed.error.message);
    const input = parsed.data as { worktreeId: string };
    if (input.worktreeId !== scope.worktreeId) {
      return fail(403, "FORBIDDEN", "The token is for another worktree");
    }

    const release = this.ctx.activity.hold();
    try {
      // biome-ignore lint/suspicious/noExplicitAny: `op` is one of the union of ops, and `input` passed its own schema.
      const result = await (op.run as (ops: WorktreeOps, input: any) => Promise<unknown>)(
        this.opsFor(scope),
        input,
      );
      reply(200, { result: result ?? null });
    } catch (err) {
      fail(500, "INTERNAL_SERVER_ERROR", err instanceof Error ? err.message : String(err));
    } finally {
      release();
    }
  }

  /** The hub's file, diff and search services, over this worker's checked host, for the token's worktree only. */
  private opsFor(scope: DirectScopeParams): WorktreeOps {
    const resolver: WorktreeResolver = {
      resolve: (worktreeId) =>
        worktreeId === scope.worktreeId
          ? {
              repo: { defaultBranch: scope.defaultBranch, kind: scope.repoKind },
              worktree: { path: scope.path },
              host: this.host,
            }
          : null,
    };
    return {
      files: new FilesService(resolver),
      diff: new DiffService(resolver),
      search: new SearchService(resolver),
      gitGraph: new GitGraphService(resolver),
    };
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // The http server drops its own error listener before `upgrade`, and this handler awaits
    // the daemon below, so a client that resets meanwhile must not crash the worker.
    socket.on("error", () => socket.destroy());
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Refused"}\r\n\r\n`);
    };
    const refused = this.refusal(req);
    if (refused !== null) return refuse(refused);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== DIRECT_TERMINAL_PATH) return refuse(404);
    const worktreeId = url.searchParams.get("worktreeId");
    const terminalId = url.searchParams.get("terminalId");
    if (!worktreeId || !terminalId) return refuse(400);

    const scope = this.scopeOf(socketToken(req));
    if (!scope) return refuse(401);
    if (scope.worktreeId !== worktreeId) return refuse(403);
    // Only a PTY the hub spawned here for this worktree.
    const info = await this.ptyInfo(terminalId);
    if (info && info.worktreeId !== worktreeId) return refuse(403);

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const release = this.ctx.activity.hold();
      ws.once("close", release);
      // Frames that arrive while the PTY is awaited are kept for the session.
      const inbox = createInbox(ws);
      void this.awaitPty(terminalId, worktreeId, info !== null).then((ready) => {
        if (inbox.closed) return;
        if (!ready) {
          // The hub spawns a terminal the worker does not have, so the client goes there.
          ws.close(DIRECT_FALLBACK_CLOSE_CODE, "Terminal is not on this worker");
          return;
        }
        // A PTY that appeared while the socket waited is fresh, so it gets no reconnect nudge.
        attachSession(this.terminals, ws, inbox, terminalId, worktreeId, info === null);
      });
    });
  }

  private ptyInfo(terminalId: string) {
    return this.ctx.host.pty.info(terminalId).catch(() => null);
  }

  /**
   * Whether `terminalId` is a live PTY of `worktreeId`. The UI opens a new
   * tab's socket while its `terminal.create` call is still on its way through
   * the hub, so a missing PTY is awaited for a few seconds.
   */
  private async awaitPty(terminalId: string, worktreeId: string, live: boolean): Promise<boolean> {
    if (live) return true;
    const deadline = Date.now() + PTY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PTY_POLL_MS));
      const info = await this.ptyInfo(terminalId);
      if (info) return info.worktreeId === worktreeId;
    }
    return false;
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return undefined;
}

/** A browser cannot set headers on a WebSocket, so the token comes as a subprotocol, as it does for the hub. */
function socketToken(req: IncomingMessage): string | undefined {
  const offered = req.headers["sec-websocket-protocol"];
  if (typeof offered === "string") {
    for (const p of offered.split(",")) {
      const value = p.trim();
      if (value.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) {
        return value.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
      }
    }
  }
  return bearerToken(req);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error("too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** An object whose missing members throw, so a service reaching for something the direct path does not serve fails loudly. */
function only<T extends object>(members: Partial<T>, what: string): T {
  return new Proxy(members, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (typeof key === "symbol" || key === "then") return undefined;
      throw new Error(`${what}.${key} is not served on the direct path`);
    },
  }) as T;
}

/**
 * A host whose calls run this worker's own method handlers in process
 * (`Registrar.invoke`), so a direct call passes the same path policy and
 * parameter checks as the same call from the hub, and fails with the error
 * the hub's `RemoteHost` would have turned the RPC error into.
 */
function checkedHost(ctx: WorkerContext, r: Registrar): Host {
  const call = async <T>(method: string, params: Params): Promise<T> => {
    try {
      return await r.invoke<T>(method, params);
    } catch (err) {
      throw mapLinkError(ctx.host.id, method, toRpcError(err), 0);
    }
  };
  const fs = only<HostFs>(
    {
      stat: (path, options) =>
        call<FsStat>("fs.stat", { path, followSymlinks: options?.followSymlinks }),
      realpath: (path) => call<string>("fs.realpath", { path }),
      readFile: (path) => call<Uint8Array>("fs.readFile", { path }),
      list: (path) => call<FsEntry[]>("fs.list", { path }),
      writeFile: (path, data, options) =>
        call<void>("fs.writeFile", {
          path,
          data: typeof data === "string" ? data : { base64: Buffer.from(data).toString("base64") },
          exclusive: options?.exclusive,
          mode: options?.mode,
        }),
      mkdir: (path, options) => call<void>("fs.mkdir", { path, recursive: options?.recursive }),
      rm: (path, options) =>
        call<void>("fs.rm", { path, recursive: options?.recursive, force: options?.force }),
      rename: (from, to) => call<void>("fs.rename", { from, to }),
      copy: (from, to, options) =>
        call<void>("fs.copy", {
          from,
          to,
          recursive: options?.recursive,
          exclusive: options?.exclusive,
        }),
    },
    "fs",
  );
  const git = only<HostGit>({ exec: (args, cwd) => call("git.exec", { args, cwd }) }, "git");
  const search = only<HostSearch>(
    {
      listFiles: (root) => call<string[]>("search.listFiles", { root }),
      // `search.stream` answers with a link channel, so it has no in-process handler. This is
      // its handler's path check, then the same host call.
      stream: (query, root) =>
        (async function* () {
          let canonical: string;
          try {
            canonical = await ctx.policy.resolve(root, true);
          } catch (err) {
            throw mapLinkError(ctx.host.id, "search.stream", toRpcError(err), 0);
          }
          yield* ctx.host.search.stream(query, canonical);
        })(),
    },
    "search",
  );
  return only<Host>({ id: ctx.host.id, fs, git, search }, "host");
}

/** The RPC error a handler's failure becomes on the link (`mapError`, then the link's internal error). */
function toRpcError(err: unknown): RpcError {
  const mapped = mapError(err);
  if (mapped instanceof RpcError) return mapped;
  return new RpcError(RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
}

/**
 * Registers `direct.register`, which the hub calls to issue a token for one
 * worktree. Returns a function that stops the listener.
 */
export function registerDirectMethods(
  r: Registrar,
  ctx: WorkerContext,
  chats: ChatOwner | null = null,
): () => Promise<void> {
  const listener = new DirectListener(ctx, r, chats);
  r.json(METHOD_DIRECT_REGISTER, async (a): Promise<DirectRegisterReply> => {
    const token = str(a, "token");
    if (!token.startsWith(DIRECT_TOKEN_PREFIX)) throw new Error("not a direct token");
    const s = a.scope as Params | undefined;
    if (!s || typeof s !== "object") throw new Error("scope must be an object");
    const repoKind = s.repoKind;
    const ttlMs = num(a, "ttlMs");
    if (!(ttlMs > 0)) throw new Error("ttlMs must be positive");
    const expiresAt = Date.now() + Math.min(ttlMs, MAX_TOKEN_TTL_MS);
    listener.register(
      token,
      {
        worktreeId: str(s, "worktreeId"),
        path: str(s, "path"),
        defaultBranch: str(s, "defaultBranch"),
        ...(typeof repoKind === "string" && { repoKind }),
      },
      expiresAt,
    );
    return { port: await listener.port(), expiresAt };
  });
  return () => listener.close();
}
