import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  METHOD_RELAY_HTTP,
  RELAY_MAX_BODY_BYTES,
  type RelayHttpReply,
  type RelayHttpRequest,
  type RelayScopeParams,
} from "@band-app/link";
import { browserProfileDir, type Registrar, type WorkerContext } from "./context.ts";
import { optStr, str } from "./rpc-util.ts";

/** Request headers the hub reads. The caller's credentials and everything else stay on the worker. */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];

/** How long the hub may take to start answering a call. */
const HUB_ANSWER_MS = 120_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * The worker's local relay (plan step 2.5). Agents and the `band` CLI on the
 * worker call it as they would call the hub, with the token the hub issued
 * for their process. The relay holds no hub credential of its own: each call
 * goes up the worker's link as one `relay.http` request, and the hub decides
 * whether the call is allowed.
 *
 * It listens on `127.0.0.1` only, on a port the system picks, and starts when
 * the first token is registered. A call without a registered token gets 401.
 */
export class Relay {
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  /** SHA-256 of a token to its scope, so a lookup never compares token text. */
  private readonly scopes = new Map<string, RelayScopeParams>();

  constructor(private readonly ctx: WorkerContext) {}

  /** Starts listening if needed and returns the relay's URL. */
  url(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return this.listening;
  }

  register(token: string, scope: RelayScopeParams): void {
    this.scopes.set(sha256(token).toString("hex"), scope);
  }

  revoke(token: string): void {
    this.scopes.delete(sha256(token).toString("hex"));
  }

  async close(): Promise<void> {
    this.scopes.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The scope of the token a request carries, or undefined. */
  private scopeOf(req: IncomingMessage): RelayScopeParams | undefined {
    const token = tokenOf(req);
    if (!token) return undefined;
    return this.scopes.get(sha256(token).toString("hex"));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    const scope = this.scopeOf(req);
    if (!scope) return fail(401, "Unauthorized");
    const path = req.url ?? "/";
    if (!path.startsWith("/")) return fail(400, "Bad request");

    const release = this.ctx.activity.hold();
    try {
      const body = await readBody(req).catch(() => null);
      if (body === null) return fail(413, "Request body too large");

      const headers: Record<string, string> = {};
      for (const name of FORWARDED_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      // On the proxy route `Authorization` is the agent's MCP proxy token, not a relay credential.
      if (isProxyRoute(path) && typeof req.headers.authorization === "string") {
        headers.authorization = req.headers.authorization;
      }
      const request: RelayHttpRequest = {
        scope,
        method: req.method ?? "GET",
        path,
        headers,
        ...(body.length > 0 && { body: body.toString("base64") }),
      };
      let reply: RelayHttpReply;
      try {
        reply = await this.ctx.session.request<RelayHttpReply>(METHOD_RELAY_HTTP, request, {
          timeoutMs: HUB_ANSWER_MS,
        });
      } catch {
        return fail(502, "The hub did not answer");
      }
      const ch = this.ctx.session.getChannel(reply.chan);
      if (!ch) return fail(502, "The hub's reply had no body channel");

      let done = false;
      res.once("close", () => {
        if (!done) ch.reset("caller went away");
      });
      res.writeHead(reply.status, reply.headers);
      try {
        for await (const chunk of ch) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await onceDrained(res);
        }
        done = true;
        ch.end();
        res.end();
      } catch {
        done = true;
        res.destroy();
      }
    } finally {
      release();
    }
  }
}

const PROXY_ROUTE = /^\/mcp-proxy\/[^/]+\/?$/;
const isProxyRoute = (path: string): boolean => PROXY_ROUTE.test(path.split("?")[0]);

/** The header an agent's MCP client sets to name its relay token on the proxy route, where `Authorization` carries the proxy token. */
const RELAY_TOKEN_HEADER = "x-band-relay-token";

function tokenOf(req: IncomingMessage): string | undefined {
  if (isProxyRoute(req.url ?? "")) {
    const named = req.headers[RELAY_TOKEN_HEADER];
    if (typeof named === "string") return named.trim();
    return cookieToken(req);
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return cookieToken(req);
}

function cookieToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "band_token") return rest.join("=");
    }
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > RELAY_MAX_BODY_BYTES) {
      req.destroy();
      throw new Error("too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function onceDrained(res: ServerResponse): Promise<void> {
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

/**
 * Registers the methods the hub uses to issue and revoke tokens. Returns a
 * function that stops the relay.
 */
export function registerRelayMethods(r: Registrar, ctx: WorkerContext): () => Promise<void> {
  const relay = new Relay(ctx);
  r.json("relay.register", async (a) => {
    const chatId = optStr(a, "chatId");
    relay.register(str(a, "token"), {
      worktreeId: str(a, "worktreeId"),
      ...(chatId !== undefined && { chatId }),
    });
    return {
      url: await relay.url(),
      browserPortFile: join(
        browserProfileDir(ctx.stateDir, str(a, "worktreeId")),
        "DevToolsActivePort",
      ),
    };
  });
  r.json("relay.revoke", (a) => relay.revoke(str(a, "token")));
  return () => relay.close();
}
