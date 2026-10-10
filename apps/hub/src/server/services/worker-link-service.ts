/**
 * The hub's end of the worker link (plan step 2.3).
 *
 * Workers dial `GET /api/workers/connect` (a WebSocket) and say `hello` with a
 * session token. A worker that holds only a bootstrap token first trades it,
 * once, at `POST /api/workers/exchange`. Both endpoints answer before the
 * device-token check: the worker's own token is the credential, and a device
 * token is not one (`TokenService.authenticate` accepts worker tokens only).
 *
 * Each worker is a `RemoteHost` in the host registry, keyed by its worker id.
 * The service keeps the `hosts` row current (online, offline, lost, last
 * seen, what the worker reported) and tells the UI when a status changes.
 * Revoking a worker's session token cuts its link at once, and the revoked
 * token fails the next `hello`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { HostInfo } from "@band-app/host-api";
import { RemoteHost } from "@band-app/host-remote";
import { LinkServer, MAX_MESSAGE_BYTES, type ServerSession } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { type WebSocket, WebSocketServer } from "ws";
import { selectWsProtocol } from "../../../auth";
import { RepoQueries } from "../infra/db/queries/repos";
import { type HostRow, TokenQueries } from "../infra/db/queries/tokens";
import { type HostRegistry, hostRegistry } from "../infra/host/registry";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { gitCredentialService } from "./git-credential-service";
import { placementService } from "./placement-service";
import { TokenExchangeError, type TokenService, tokenService } from "./token-service";
import { emit } from "./watcher-service";
import { workerCliService } from "./worker-cli-service";
import { workerRelayService } from "./worker-relay-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("worker-link");
const repoQueries = new RepoQueries();

const LOCAL_HOST_ID = "local";
/** How often the hub reads each online worker's capability report again. */
const CAPABILITY_REFRESH_MS = 3 * 60_000;

export const WORKER_CONNECT_PATH = "/api/workers/connect";
export const WORKER_EXCHANGE_PATH = "/api/workers/exchange";
const MAX_EXCHANGE_BODY_BYTES = 4 * 1024;

export interface WorkerLinkOptions {
  tokens?: TokenService;
  queries?: TokenQueries;
  registry?: HostRegistry;
  now?: () => number;
}

export class WorkerLinkService {
  readonly server: LinkServer;
  private readonly tokens: TokenService;
  private readonly queries: TokenQueries;
  private readonly registry: HostRegistry;
  private readonly now: () => number;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: selectWsProtocol,
  });
  private unsubscribeRevoke: (() => void) | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(options: WorkerLinkOptions = {}) {
    this.tokens = options.tokens ?? tokenService;
    this.queries = options.queries ?? new TokenQueries();
    this.registry = options.registry ?? hostRegistry;
    this.now = options.now ?? Date.now;
    this.server = new LinkServer({ authenticate: this.tokens.authenticate });
    this.server.on("session", (session: ServerSession) => this.onSession(session));
    this.server.on("connected", (session: ServerSession) => void this.onConnected(session));
    this.server.on("disconnected", (session: ServerSession) =>
      this.setStatus(session.workerId, "offline", this.now()),
    );
    this.server.on("lost", (session: ServerSession) =>
      this.setStatus(session.workerId, "lost", this.now()),
    );
    this.server.on("expired", (session: ServerSession) => {
      // A newer session for the same worker owns the host now.
      if (this.server.getSession(session.workerId) === undefined) {
        this.setStatus(session.workerId, "offline");
      }
    });
  }

  /** Makes every known worker resolvable, so a worktree on an offline host still finds its host. */
  start(): void {
    for (const row of this.queries.listHosts(1000)) {
      if (row.id !== LOCAL_HOST_ID) this.remoteHost(row.id);
    }
    // A hub restart ends every link, so a host left `online` in the database is not.
    for (const row of this.queries.listHosts(1000)) {
      if (row.id !== LOCAL_HOST_ID && row.status === "online") {
        this.queries.setHostStatus(row.id, "offline");
      }
    }
    // Which agents are installed and logged in changes while a worker runs, so ask again now and then.
    const every = Number(process.env.BAND_CAPABILITY_REFRESH_MS);
    this.refreshTimer = setInterval(
      () => void this.refreshReports(),
      Number.isFinite(every) && every > 0 ? every : CAPABILITY_REFRESH_MS,
    );
    this.refreshTimer.unref();
    this.unsubscribeRevoke = this.tokens.onRevoked((row) => {
      if (row.kind === "worker_session" && row.hostId) {
        if (this.server.drop(row.hostId, "token revoked")) log.info(`cut link of ${row.hostId}`);
      }
    });
  }

  /**
   * Reads `host.info` again from every online worker and stores its capability report. The call is
   * passive, so it does not keep an ephemeral worker awake. A change goes out as a host status
   * event, which Settings > Hosts follows.
   */
  async refreshReports(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.allSettled(
        this.queries
          .listHosts(1000)
          .filter((row) => row.id !== LOCAL_HOST_ID && row.status === "online")
          .map((row) => this.refreshReport(row)),
      );
    } finally {
      this.refreshing = false;
    }
  }

  private refreshing = false;

  private async refreshReport(row: {
    id: string;
    info?: ({ report?: Parameters<typeof reportKey>[0] } & Record<string, unknown>) | null;
  }): Promise<void> {
    try {
      const info = await this.remoteHost(row.id).info();
      const { repoMappings: _mappings, ...facts } = info;
      const stored = { ...(row.info ?? {}), ...facts };
      const changed = reportKey(stored.report) !== reportKey(row.info?.report);
      this.queries.setHostInfo(row.id, stored);
      if (changed) this.publish(row.id, "online");
    } catch (err) {
      log.debug(
        `could not refresh the report of ${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.unsubscribeRevoke?.();
    for (const ws of this.wss.clients) ws.terminate();
    await this.server.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** The `RemoteHost` for a worker id, made on first use. */
  private remoteHost(workerId: string): RemoteHost {
    try {
      const known = this.registry.hostById(workerId);
      if (known instanceof RemoteHost) return known;
    } catch {
      // Not registered yet.
    }
    const host = new RemoteHost({
      id: workerId,
      session: () => this.server.getSession(workerId),
    });
    this.registry.register(host);
    return host;
  }

  private onSession(session: ServerSession): void {
    this.remoteHost(session.workerId).attachSession(session);
    workerRelayService.attach(session);
    workerCliService.attach(session);
    gitCredentialService.attach(session);
    ephemeralLifecycleService.attach(session);
  }

  private async onConnected(session: ServerSession): Promise<void> {
    const { workerId, hello } = session;
    const at = this.now();
    let info: HostInfo | null = null;
    try {
      info = await this.remoteHost(workerId).info();
    } catch (err) {
      log.warn(
        `could not read host info from ${workerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
    // The worker may have dropped while we asked.
    if (this.server.getSession(workerId) !== session || !session.attached) return;
    // The hello alone says what the worker offers, so a failed `host.info` call
    // still leaves the host row with its agents, roots and capabilities.
    // What the worker maps to folders is a cache in `repo_hosts`, not part of the host's info.
    const { repoMappings, ...infoFacts } = info ?? ({} as Partial<HostInfo>);
    if (repoMappings) repoQueries.replaceWorkerMappings(workerId, repoMappings);
    const stored: Record<string, unknown> = {
      ...infoFacts,
      roots: info?.roots ?? hello.roots,
      capabilities: info?.capabilities ?? hello.capabilities,
      labels: info?.labels ?? Object.entries(hello.labels).map(([k, v]) => `${k}=${v}`),
      agents: hello.agents,
      tools: info?.tools ?? hello.tools ?? {},
      mode: hello.mode,
    };
    this.queries.markHostOnline(workerId, at, { info: stored, version: hello.buildId });
    log.info(`worker ${workerId} is online`);
    this.publish(workerId, "online");
    void ephemeralLifecycleService.onConnected(session);
    // A request a runner fulfilled with this host can finish now.
    placementService.onHostOnline(workerId);
    // Worktrees removed while the worker was away still have a checkout on it.
    void worktreeService.finishPendingRemovals(workerId).catch((err) => {
      log.warn(`pending removals on ${workerId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  private setStatus(workerId: string, status: HostRow["status"], lastSeenAt?: number): void {
    try {
      this.queries.setHostStatus(workerId, status, lastSeenAt);
    } catch (err) {
      log.warn(
        `could not record ${workerId} as ${status}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    log.info(`worker ${workerId} is ${status}`);
    this.publish(workerId, status);
  }

  private publish(hostId: string, hostStatus: HostRow["status"]): void {
    emit({ kind: "host-status-changed", hostId, hostStatus });
  }

  // ---- HTTP ---------------------------------------------------------------

  /** `POST /api/workers/exchange`: a bootstrap token for a session token, once. */
  async handleExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      send(405, { error: "Method not allowed" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_EXCHANGE_BODY_BYTES) {
        send(413, { error: "Request body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: { token?: unknown; workerId?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      send(400, { error: "Body must be JSON" });
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.token !== "string" ||
      body.token === "" ||
      (body.workerId !== undefined && body.workerId !== null && typeof body.workerId !== "string")
    ) {
      send(400, { error: "token must be a string" });
      return;
    }
    try {
      const out = this.tokens.exchangeForWorker(body.token, body.workerId ?? undefined);
      send(200, out);
    } catch (err) {
      if (!(err instanceof TokenExchangeError)) throw err;
      log.warn(`bootstrap exchange refused: ${err.reason}`);
      // One answer for every reason, so the response says nothing about which tokens exist.
      send(401, { error: "invalid or expired token" });
    }
  }

  /** `GET /api/workers/connect`: the WebSocket upgrade. The `hello` authenticates it. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => this.server.handleConnection(ws));
  }
}

export const workerLinkService = new WorkerLinkService();

/** A report without its timestamp, so two reads of the same state compare equal. */
function reportKey(report: unknown): string {
  const { checkedAt: _at, ...rest } = (report ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
}
