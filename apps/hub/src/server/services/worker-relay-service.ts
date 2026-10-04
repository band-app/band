/**
 * The hub's end of the worker relay (plan step 2.5).
 *
 * A worker forwards the calls its agents make (`band` CLI, MCP, hooks) as
 * `relay.http` requests on its link. This service checks each against the
 * worker's own workspaces (`relay-scope.ts`), replays the allowed ones against
 * the hub's own HTTP server on loopback, and streams the answer back down a
 * channel. Replaying through the real server keeps one implementation of every
 * route, its auth and its error shapes.
 */

import {
  METHOD_RELAY_HTTP,
  type RelayHttpReply,
  type RelayHttpRequest,
  RpcError,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { CHAT_ID_HEADER, WORKSPACE_ID_HEADER } from "../api/context";
import { WorkspaceQueries } from "../infra/db/queries/workspaces";
import { browserService } from "./browser-service";
import { chatService } from "./chat-service";
import {
  checkRelayRequest,
  filterProjectsReply,
  pinWorkspaceHost,
  type ScopeLookups,
  trpcRefusalBody,
} from "./relay-scope";
import { resolveWorkspaceIdByCwd } from "./state";
import { subscriptionService } from "./subscription-service";
import { terminalService } from "./terminal-service";

const log = createLogger("worker-relay");

/** Response headers worth passing back to the agent. Content length and encoding change in transit. */
const REPLY_HEADERS = ["content-type", "cache-control", "mcp-session-id"];

/** Request headers passed on to the hub. A worker cannot add credentials or scope headers of its own. */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];

const RPC_INVALID_PARAMS = -32602;

const workspaceQueries = new WorkspaceQueries();

const defaultLookups: ScopeLookups = {
  hostOfWorkspace: (id) => workspaceQueries.findHostId(id),
  workspaceOfChat: (id) => chatService.get(id)?.workspaceId ?? null,
  workspaceOfCwd: (cwd) => resolveWorkspaceIdByCwd(cwd),
  hostOfTerminal: (id) => terminalService.hostIdOf(id),
  workspaceOfBrowser: (id) => browserService.get(id)?.workspaceId ?? null,
  workspaceOfSubscription: (id) =>
    subscriptionService.list().find((s) => s.id === id)?.workspaceId ?? null,
};

export class WorkerRelayService {
  private target: { baseUrl: string; token: string | undefined } | null = null;

  constructor(private readonly lookups: ScopeLookups = defaultLookups) {}

  /** Where the hub's own server listens, and the token it accepts. Called once the server is up. */
  configure(baseUrl: string, token: string | undefined): void {
    this.target = { baseUrl, token };
  }

  /** Answers `relay.http` on a worker's session. */
  attach(session: ServerSession): void {
    session.handle(METHOD_RELAY_HTTP, (params) => this.handle(session, params));
  }

  private async handle(session: ServerSession, params: unknown): Promise<RelayHttpReply> {
    let request = parseRequest(params);
    const verdict = checkRelayRequest(request, session.workerId, this.lookups);
    if (!verdict.ok) {
      log.warn(
        `refused ${request.method} ${request.path.split("?")[0]} from ${session.workerId}: ${verdict.reason}`,
      );
      return this.answer(session, verdict.status, refusalBody(request, verdict));
    }
    if (!this.target) return this.answer(session, 503, { error: "The hub is not ready" });
    request = pinWorkspaceHost(request, session.workerId);
    const { baseUrl, token } = this.target;

    const headers: Record<string, string> = {
      "accept-encoding": "identity",
      [WORKSPACE_ID_HEADER]: request.scope.workspaceId,
    };
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (request.scope.chatId) headers[CHAT_ID_HEADER] = request.scope.chatId;
    if (token) headers.authorization = `Bearer ${token}`;

    const abort = new AbortController();
    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD" || !request.body
            ? undefined
            : Buffer.from(request.body, "base64"),
        signal: abort.signal,
        redirect: "manual",
      });
    } catch (err) {
      log.warn(`relay call failed: ${err instanceof Error ? err.message : err}`);
      return this.answer(session, 502, { error: "The hub could not answer" });
    }

    const replyHeaders: Record<string, string> = {};
    for (const name of REPLY_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) replyHeaders[name] = value;
    }
    // The project list covers every host, so a worker gets only its own workspaces.
    if (request.path.split("?")[0] === "/trpc/projects.list" && upstream.ok) {
      try {
        const filtered = filterProjectsReply(await upstream.json(), session.workerId);
        return this.answer(session, upstream.status, filtered);
      } catch (err) {
        log.warn(`relay call failed: ${err instanceof Error ? err.message : err}`);
        return this.answer(session, 502, { error: "The hub could not answer" });
      }
    }
    const ch = session.openChannel("relay.body", { path: request.path.split("?")[0] });
    // A reset from the worker (the caller went away) stops the upstream read.
    void (async () => {
      try {
        for await (const _ of ch) {
          // The worker sends nothing on this channel. A reset throws out of the loop.
        }
      } catch {
        abort.abort();
      }
    })();
    void (async () => {
      try {
        if (upstream.body) {
          for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
            await ch.send(chunk);
          }
        }
        ch.end();
      } catch (err) {
        ch.reset(err instanceof Error ? err.message : "relay stream failed");
        abort.abort();
      }
    })();
    return { status: upstream.status, headers: replyHeaders, chan: ch.id };
  }

  /** A short JSON answer, sent the same way as any other. */
  private answer(session: ServerSession, status: number, body: unknown): RelayHttpReply {
    const ch = session.openChannel("relay.body");
    ch.send(Buffer.from(JSON.stringify(body)))
      .then(() => ch.end())
      .catch(() => undefined);
    return { status, headers: { "content-type": "application/json" }, chan: ch.id };
  }
}

/** A refused tRPC call answers in tRPC's error shape, which the CLI and web client print; other routes keep a plain body. */
function refusalBody(
  request: RelayHttpRequest,
  verdict: { status: number; reason: string },
): unknown {
  const [pathname, query = ""] = request.path.split("?");
  if (!pathname.startsWith("/trpc/")) return { error: verdict.reason };
  const batch = new URLSearchParams(query).get("batch") === "1" || pathname.includes(",");
  return trpcRefusalBody(verdict.status, verdict.reason, batch);
}

function parseRequest(params: unknown): RelayHttpRequest {
  const p = params as Partial<RelayHttpRequest> | null;
  const scope = p?.scope;
  if (
    !p ||
    typeof p.method !== "string" ||
    typeof p.path !== "string" ||
    typeof scope?.workspaceId !== "string" ||
    (scope.chatId !== undefined && typeof scope.chatId !== "string") ||
    !/^\/(?![/\\])/.test(p.path) ||
    !["GET", "POST", "DELETE", "OPTIONS", "HEAD"].includes(p.method) ||
    typeof p.headers !== "object" ||
    p.headers === null ||
    Object.values(p.headers).some((v) => typeof v !== "string") ||
    (p.body !== undefined && typeof p.body !== "string")
  ) {
    throw new RpcError(RPC_INVALID_PARAMS, "bad relay.http params");
  }
  return p as RelayHttpRequest;
}

export const workerRelayService = new WorkerRelayService();
