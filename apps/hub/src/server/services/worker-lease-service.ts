/**
 * The hub's lease on each worker (issue #901). While a worker's link is up, the hub renews its
 * lease every fifth of the lease time (`BAND_WORKER_LEASE_MS`, default 5 minutes). A worker whose
 * lease runs out stops its agents, terminals and run scripts (see `apps/worker/src/lease.ts`),
 * whether the hub is down or its own network is.
 *
 * The hub uses the same clock the other way: it does not offer "Open on another host" for a
 * worktree whose worker is offline until the latest lease it could have granted has expired, so
 * the old copy cannot still be running when the new one starts. After a hub restart the memory of
 * the last renewal is gone, so the bound comes from `hosts.last_seen_at`, which every
 * acknowledged renewal writes, plus one renewal interval.
 */

import {
  type LeaseRenewParams,
  METHOD_LEASE_RENEW,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";

import { RepoQueries } from "../infra/db/queries/repos";
import { tokenService } from "./token-service";

const log = createLogger("worker-lease");

const RENEW_TIMEOUT_MS = 10_000;
export const DEFAULT_LEASE_MS = 5 * 60_000;

/** The lease time: `BAND_WORKER_LEASE_MS`, read on every call. */
export function leaseMs(): number {
  const raw = Number(process.env.BAND_WORKER_LEASE_MS);
  return Number.isFinite(raw) && raw >= 500 ? Math.round(raw) : DEFAULT_LEASE_MS;
}

/** How often the hub renews: a fifth of the lease, so four renewals can fail before it runs out. */
export function renewEveryMs(): number {
  return Math.max(250, Math.round(leaseMs() / 5));
}

interface Entry {
  session: ServerSession;
  timer: NodeJS.Timeout;
  /** `false` once the worker answered that it has no lease method (an older worker). */
  supported: boolean | null;
  lastAckAt: number;
  /** When the latest renewal was sent, acknowledged or not. */
  lastAttemptAt: number;
  /** When the latest renewal was sent and has no answer yet. */
  inFlight: boolean;
  /** When the latest renewal ended without an answer (link lost, error or timeout). */
  lastFailAt: number;
  /** The renewal loop that is running for this host, if any. */
  running: Promise<void> | null;
  /** A renewal was asked for while one was in flight: send one more, so the newest list wins. */
  again: boolean;
}

export class WorkerLeaseService {
  private readonly entries = new Map<string, Entry>();
  private readonly repos = new RepoQueries();

  /** A worker's link session started. Renewals begin when it is connected. */
  attach(session: ServerSession): void {
    if (session.hello.mode === "ephemeral") return;
    const hostId = session.workerId;
    const old = this.entries.get(hostId);
    if (old) clearInterval(old.timer);
    const timer = setInterval(() => void this.renew(hostId), renewEveryMs());
    timer.unref();
    this.entries.set(hostId, {
      session,
      timer,
      supported: old?.supported ?? null,
      lastAckAt: old?.lastAckAt ?? 0,
      lastAttemptAt: old?.lastAttemptAt ?? 0,
      inFlight: false,
      lastFailAt: old?.lastFailAt ?? 0,
      running: null,
      again: false,
    });
  }

  /** The worker is connected: renew at once, so its lease starts with the link. */
  onConnected(session: ServerSession): void {
    if (this.entries.get(session.workerId)?.session === session) void this.renew(session.workerId);
  }

  /** The link session ended for good. The last acknowledgement stays, it bounds the worker's lease. */
  detach(session: ServerSession): void {
    const entry = this.entries.get(session.workerId);
    if (entry?.session !== session) return;
    clearInterval(entry.timer);
  }

  stop(): void {
    for (const entry of this.entries.values()) clearInterval(entry.timer);
    this.entries.clear();
  }

  /** Folders on `hostId` that a continuation superseded: the worker starts nothing in them. */
  private blockedPaths(hostId: string): string[] {
    return this.repos.supersededPaths(hostId);
  }

  /**
   * Sends the host's current blocked list now, outside the timer, after the hub changed which of
   * its folders are superseded. It is the same renewal the timer sends (same `ttlMs`), so it never
   * extends a lease the hub would not grant. Calls that arrive while one is in flight share one
   * follow-up renewal. An offline host, or a worker with no `lease.renew`, is skipped.
   */
  pushBlockedPaths(hostId: string): Promise<void> {
    return this.renew(hostId);
  }

  private renew(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId);
    if (!entry || entry.supported === false || !entry.session.attached) return Promise.resolve();
    if (entry.running) {
      entry.again = true;
      return entry.running;
    }
    const run = (async () => {
      do {
        entry.again = false;
        await this.renewOnce(hostId, entry);
      } while (entry.again && entry.supported !== false && entry.session.attached);
    })().finally(() => {
      entry.running = null;
      entry.again = false;
    });
    entry.running = run;
    return run;
  }

  private async renewOnce(hostId: string, entry: Entry): Promise<void> {
    const params: LeaseRenewParams = { ttlMs: leaseMs(), blockedPaths: this.blockedPaths(hostId) };
    entry.lastAttemptAt = Date.now();
    entry.inFlight = true;
    try {
      await entry.session.request(METHOD_LEASE_RENEW, params, { timeoutMs: RENEW_TIMEOUT_MS });
      entry.supported = true;
      entry.inFlight = false;
      entry.lastAckAt = Date.now();
      tokenService.touchHost(hostId, entry.lastAckAt);
    } catch (err) {
      entry.inFlight = false;
      entry.lastFailAt = Date.now();
      if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) {
        entry.supported = false;
        clearInterval(entry.timer);
        return;
      }
      log.debug(
        { hostId, message: err instanceof Error ? err.message : String(err) },
        "no renewal",
      );
    }
  }

  /**
   * The latest moment the worker could still be running under a lease the hub granted, or null
   * when it has none (an older worker that never fences, or a host that never connected).
   */
  expiresAt(hostId: string): number | null {
    const entry = this.entries.get(hostId);
    if (entry?.supported === false) return null;
    const seen = tokenService.hostSeen(hostId)?.lastSeenAt ?? null;
    // A renewal the worker may have received but whose answer was lost counts until the hub gave
    // up on it: the moment the link failed it, or while it is still pending, the time the hub
    // waits for the answer.
    if (entry && entry.lastAckAt > 0) {
      let attempt = 0;
      if (entry.lastAttemptAt > entry.lastAckAt) {
        attempt = entry.inFlight
          ? entry.lastAttemptAt + RENEW_TIMEOUT_MS
          : Math.max(entry.lastFailAt, entry.lastAttemptAt);
      }
      return Math.max(entry.lastAckAt, attempt, seen ?? 0) + leaseMs();
    }
    if (seen === null) return null;
    return seen + leaseMs() + renewEveryMs();
  }

  /** Milliseconds until the worker's lease is certainly over, 0 when it already is. */
  remainingMs(hostId: string, now = Date.now()): number {
    const at = this.expiresAt(hostId);
    return at === null ? 0 : Math.max(0, at - now);
  }
}

export const workerLeaseService = new WorkerLeaseService();
