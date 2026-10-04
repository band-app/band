/**
 * Revocable hub credentials.
 *
 * Device tokens (UI, CLI) authenticate HTTP, SSE and WebSocket requests. A
 * worker gets a one-time bootstrap token, shown once, and exchanges it for a
 * session token bound to its worker id. Only the SHA-256 of a token is
 * stored, and tokens never reach a log line: log ids only.
 *
 * `settings.tokenSecret` stays valid as the device token with id `shared`,
 * so the desktop app, the CLI and existing browser sessions keep working.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthResult, Hello } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { SharedTokenRevokeError, TokenNotFoundError } from "../errors";
import { SocketRegistry } from "../infra/auth/socket-registry";
import {
  type HostRow,
  type TokenKind,
  TokenQueries,
  type TokenRow,
} from "../infra/db/queries/tokens";

const log = createLogger("token-service");

export const SHARED_TOKEN_ID = "shared";
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_BOOTSTRAP_TTL_MS = 60 * 60 * 1000;
export const MAX_BOOTSTRAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A token's `lastUsedAt` is written at most this often, so a busy client isn't a write per request. */
const TOUCH_INTERVAL_MS = 60_000;

const PREFIX: Record<TokenKind, string> = {
  device: "bdt_",
  worker_bootstrap: "bwb_",
  worker_session: "bws_",
};

export type TokenState = "active" | "revoked" | "expired" | "used";

/** A token as the API shows it: no hash, and a derived state. */
export interface TokenView {
  id: string;
  kind: TokenKind;
  label: string;
  hostId: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  state: TokenState;
}

export interface HostView {
  id: string;
  name: string;
  mode: HostRow["mode"];
  status: HostRow["status"];
  labels: string[];
  lastSeenAt: number | null;
  version: string | null;
  createdAt: number;
}

/** Why `exchangeBootstrap` refused. The link only ever shows the worker a generic reason. */
export class TokenExchangeError extends Error {
  constructor(readonly reason: "invalid" | "expired" | "used" | "worker-mismatch") {
    super(`Bootstrap token refused: ${reason}`);
    this.name = "TokenExchangeError";
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
}

function sameHash(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function stateOf(row: TokenRow, now: number): TokenState {
  if (row.revokedAt != null) {
    return row.kind === "worker_bootstrap" && row.lastUsedAt != null ? "used" : "revoked";
  }
  if (row.expiresAt != null && row.expiresAt <= now) return "expired";
  return "active";
}

function toView(row: TokenRow, now: number): TokenView {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    hostId: row.hostId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    state: stateOf(row, now),
  };
}

export class TokenService {
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly queries = new TokenQueries(),
    private readonly now: () => number = Date.now,
    private readonly sockets = new SocketRegistry(),
  ) {}

  /**
   * Makes the shared `settings.tokenSecret` a device token (id `shared`).
   * Idempotent. When the secret changed (the user rotated it), the row takes
   * the new hash and the old secret stops working.
   */
  ensureSharedToken(secret: string): void {
    const hash = hashToken(secret);
    const existing = this.queries.findById(SHARED_TOKEN_ID);
    if (!existing) {
      this.queries.insert({
        id: SHARED_TOKEN_ID,
        kind: "device",
        hash,
        hostId: null,
        label: "Shared token",
        createdAt: this.now(),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      });
      return;
    }
    if (!sameHash(existing.hash, hash)) this.queries.replaceHash(SHARED_TOKEN_ID, hash);
  }

  /** The live device token this value belongs to, or null. */
  resolveDevice(candidate: string | undefined): TokenRow | null {
    const row = this.live(candidate, "device");
    if (row) this.touch(row);
    return row;
  }

  /** Whether the value is a live device token. */
  acceptsDevice = (candidate: string | undefined): boolean =>
    this.resolveDevice(candidate) !== null;

  createDevice(label: string): { token: string; view: TokenView } {
    const token = newToken("device");
    const row = this.insert("device", token, { label });
    return { token, view: toView(row, this.now()) };
  }

  /**
   * Registers a host and returns the token its worker exchanges on its first
   * `hello`. The worker id is the host id. The token is shown once and is
   * valid for one exchange.
   */
  issueWorkerBootstrap(
    hostName: string,
    labels: string[] = [],
    ttlMs: number = DEFAULT_BOOTSTRAP_TTL_MS,
  ): { token: string; hostId: string; view: TokenView } {
    const ttl = Math.min(Math.max(ttlMs, 1000), MAX_BOOTSTRAP_TTL_MS);
    const hostId = `h-${randomBytes(6).toString("hex")}`;
    const at = this.now();
    this.queries.insertHost({
      id: hostId,
      name: hostName,
      mode: "attached",
      runner: null,
      labels,
      status: "offline",
      lastSeenAt: null,
      info: null,
      version: null,
      createdAt: at,
    });
    const token = newToken("worker_bootstrap");
    const row = this.insert("worker_bootstrap", token, {
      label: hostName,
      hostId,
      expiresAt: at + ttl,
    });
    log.info(`issued worker bootstrap token ${row.id} for host ${hostId}`);
    return { token, hostId, view: toView(row, at) };
  }

  /**
   * Trades a bootstrap token for a session token bound to `workerId`. The
   * bootstrap token works once: the update that consumes it is guarded in
   * SQL, so concurrent exchanges can't both succeed. A mismatched worker id
   * leaves the token unconsumed.
   */
  exchangeBootstrap(token: string, workerId: string): string {
    const row = this.queries.findByHash(hashToken(token));
    if (!row || row.kind !== "worker_bootstrap") throw new TokenExchangeError("invalid");
    const at = this.now();
    if (row.revokedAt != null) {
      throw new TokenExchangeError(row.lastUsedAt != null ? "used" : "invalid");
    }
    if (row.expiresAt != null && row.expiresAt <= at) throw new TokenExchangeError("expired");
    if (row.hostId !== workerId) throw new TokenExchangeError("worker-mismatch");
    const sessionToken = newToken("worker_session");
    const session = this.build("worker_session", sessionToken, {
      label: row.label,
      hostId: workerId,
    });
    // One transaction, so a failed insert doesn't burn the token. The spend is
    // guarded in SQL, so of two concurrent exchanges only one wins.
    const spent = this.queries.transaction((q) => {
      if (!q.spendBootstrap(row.id, at)) return false;
      q.insert(session);
      return true;
    });
    if (!spent) throw new TokenExchangeError("used");
    log.info(`exchanged bootstrap token ${row.id} for a session of worker ${workerId}`);
    return sessionToken;
  }

  /**
   * For `LinkServer`: decides a `hello`. A live session token for this
   * worker, sent as `token` or as `sessionToken`, passes unchanged. Anything
   * else must be a bootstrap token, which is exchanged and its new session
   * token returned for `ready`. The reason on refusal is generic on purpose.
   */
  authenticate = (hello: Hello): AuthResult => {
    for (const candidate of [hello.token, hello.sessionToken]) {
      if (!candidate) continue;
      const row = this.live(candidate, "worker_session");
      if (row && row.hostId === hello.workerId) {
        this.touch(row);
        this.queries.markHostSeen(hello.workerId, this.now());
        return { ok: true, sessionToken: candidate };
      }
    }
    try {
      const sessionToken = this.exchangeBootstrap(hello.token, hello.workerId);
      this.queries.markHostSeen(hello.workerId, this.now());
      return { ok: true, sessionToken };
    } catch (err) {
      if (!(err instanceof TokenExchangeError)) throw err;
      log.warn(`worker ${hello.workerId} refused: ${err.reason}`);
      return { ok: false, reason: "invalid or expired token" };
    }
  };

  /** The newest `limit` tokens. */
  list(limit: number = DEFAULT_LIST_LIMIT): TokenView[] {
    const at = this.now();
    return this.queries.list(limit).map((row) => toView(row, at));
  }

  /** The oldest `limit` hosts, the local one first. */
  listHosts(limit: number = DEFAULT_LIST_LIMIT): HostView[] {
    return this.queries.listHosts(limit).map((h) => ({
      id: h.id,
      name: h.name,
      mode: h.mode,
      status: h.status,
      labels: h.labels,
      lastSeenAt: h.lastSeenAt,
      version: h.version,
      createdAt: h.createdAt,
    }));
  }

  /** Revokes a token and closes the sockets it opened. Revoking a revoked token is a no-op. */
  revoke(id: string): TokenView {
    const row = this.queries.findById(id);
    if (!row) throw new TokenNotFoundError(id);
    if (row.id === SHARED_TOKEN_ID) throw new SharedTokenRevokeError();
    if (this.queries.revoke(id, this.now())) {
      this.sockets.closeAll(id);
      this.lastTouch.delete(id);
      log.info(`revoked token ${id}`);
    }
    return toView(this.queries.findById(id) ?? row, this.now());
  }

  /** Remembers a socket opened with this token, so revoking the token closes it. */
  trackSocket(tokenId: string, socket: Parameters<SocketRegistry["add"]>[1]): void {
    this.sockets.add(tokenId, socket);
  }

  /** The row for a presented token when it is live and of `kind`. */
  private live(candidate: string | undefined, kind: TokenKind): TokenRow | null {
    if (!candidate) return null;
    const hash = hashToken(candidate);
    const row = this.queries.findByHash(hash);
    if (!row || !sameHash(row.hash, hash) || row.kind !== kind) return null;
    if (row.revokedAt != null) return null;
    if (row.expiresAt != null && row.expiresAt <= this.now()) return null;
    return row;
  }

  private insert(
    kind: TokenKind,
    token: string,
    extra: { label: string; hostId?: string; expiresAt?: number },
  ): TokenRow {
    const row = this.build(kind, token, extra);
    this.queries.insert(row);
    return row;
  }

  private build(
    kind: TokenKind,
    token: string,
    extra: { label: string; hostId?: string; expiresAt?: number },
  ): TokenRow {
    return {
      id: randomUUID(),
      kind,
      hash: hashToken(token),
      hostId: extra.hostId ?? null,
      label: extra.label,
      createdAt: this.now(),
      expiresAt: extra.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  private touch(row: TokenRow): void {
    const at = this.now();
    const last = this.lastTouch.get(row.id) ?? row.lastUsedAt ?? 0;
    if (at - last < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(row.id, at);
    this.queries.touch(row.id, at);
  }
}

export const tokenService = new TokenService();
