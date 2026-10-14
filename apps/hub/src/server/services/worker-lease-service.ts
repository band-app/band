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
import { loadState } from "./state";
import { tokenService } from "./token-service";

const log = createLogger("worker-lease");
const LOCAL_HOST_ID = "local";

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
}

export class WorkerLeaseService {
  private readonly entries = new Map<string, Entry>();

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
    const out: string[] = [];
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if ((wt.hostId ?? LOCAL_HOST_ID) === hostId && wt.supersededBy) out.push(wt.path);
      }
    }
    return out;
  }

  private async renew(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId);
    if (!entry || entry.supported === false || !entry.session.attached) return;
    const params: LeaseRenewParams = { ttlMs: leaseMs(), blockedPaths: this.blockedPaths(hostId) };
    try {
      await entry.session.request(METHOD_LEASE_RENEW, params, { timeoutMs: 10_000 });
      entry.supported = true;
      entry.lastAckAt = Date.now();
      tokenService.touchHost(hostId, entry.lastAckAt);
    } catch (err) {
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
    if (entry && entry.lastAckAt > 0) return Math.max(entry.lastAckAt, seen ?? 0) + leaseMs();
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
