/**
 * Placement (plan step 3.3): choosing the host for a new workspace, and the
 * `host_requests` a runner leases when no host fits.
 *
 * `workspaces.create` with `placement` calls `place()`. An online host whose
 * labels and facts satisfy the criteria gets the workspace at once (the least
 * loaded one, when several fit). Otherwise the hub records a `host_request` and
 * the workspace is `provisioning`. A runner (step 3.4) leases the request,
 * starts a machine and fulfils the request with the host id. When that host
 * says hello, the hub replays the stored create call on it. A request that no
 * host satisfies within `BAND_PLACEMENT_TIMEOUT_MS` (10 minutes by default)
 * fails with a reason.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { z } from "zod";
import { HostRequestQueries, type HostRequestRow } from "../infra/db/queries/host-requests";
import { hostRegistry } from "../infra/host/registry";
import type { Placement } from "./_utils/placement-input";
import { tokenService } from "./token-service";
import { emit } from "./watcher-service";
import { type WorkspaceCreateInput, workspaceService } from "./workspace-service";

const log = createLogger("placement");

const LOCAL_HOST_ID = "local";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 15 * 60_000;
const SWEEP_MS = 1000;

export const leaseFilterInput = z
  .object({
    /** What the runner offers. A request is leasable when every label it asks for is here. */
    labels: z.record(z.string(), z.string()).optional(),
  })
  .default({});
export type { Placement };
export type LeaseFilter = z.infer<typeof leaseFilterInput>;

export class HostRequestError extends Error {
  constructor(
    readonly reason: "not-found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "HostRequestError";
  }
}

/** What placement knows about a host. */
interface Candidate {
  id: string;
  labels: string[];
  facts: Record<string, string>;
}

// ---- matching -------------------------------------------------------------

/** Compares dotted numbers. Missing segments count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether `actual` satisfies `constraint`: `>=24`, `>24`, `<=24`, `<24`, `=24`
 * or a plain `24` (which also matches `24.1.2`). A non-numeric constraint
 * (`linux`) must match exactly.
 * TODO(3.1): replace with the environment spec's requirement helper once it merges.
 */
export function satisfies(actual: string | undefined, constraint: string): boolean {
  if (actual === undefined) return false;
  const m = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*)$/.exec(constraint.trim());
  if (!m) return actual === constraint.trim();
  const found = /^v?(\d+(?:\.\d+)*)/.exec(actual.trim());
  if (!found) return false;
  const [, op, wanted] = m;
  const cmp = compareVersions(found[1], wanted);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    default:
      return found[1] === wanted || found[1].startsWith(`${wanted}.`);
  }
}

export function matches(host: Candidate, placement: Placement): boolean {
  for (const [k, v] of Object.entries(placement.labels ?? {})) {
    if (!host.labels.includes(`${k}=${v}`)) return false;
  }
  for (const [k, constraint] of Object.entries(placement.requires ?? {})) {
    if (!satisfies(host.facts[k], constraint)) return false;
  }
  return true;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---- service --------------------------------------------------------------

export interface PlacementOptions {
  queries?: HostRequestQueries;
  now?: () => number;
}

export type PlaceResult = { kind: "host"; hostId: string } | { kind: "request"; requestId: string };

export class PlacementService {
  private readonly queries: HostRequestQueries;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly completing = new Set<string>();

  constructor(options: PlacementOptions = {}) {
    this.queries = options.queries ?? new HostRequestQueries();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private timeoutMs(): number {
    const raw = Number(process.env.BAND_PLACEMENT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  // ---- choosing a host ----------------------------------------------------

  private async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const row of tokenService.listHosts(1000)) {
      if (row.status !== "online" || !row.usable) continue;
      const info =
        row.id === LOCAL_HOST_ID ? await hostRegistry.local.info().catch(() => null) : null;
      const stored = (row.info ?? {}) as Record<string, unknown>;
      const versions = stringRecord(info?.versions ?? stored.versions);
      out.push({
        id: row.id,
        labels: [
          ...new Set([...stringList(row.labels), ...stringList(info?.labels ?? stored.labels)]),
        ],
        facts: {
          ...versions,
          ...(typeof (info?.os ?? stored.os) === "string"
            ? { os: String(info?.os ?? stored.os) }
            : {}),
          ...(typeof (info?.arch ?? stored.arch) === "string"
            ? { arch: String(info?.arch ?? stored.arch) }
            : {}),
        },
      });
    }
    return out;
  }

  /** The least loaded online host that satisfies `placement`, or null. */
  async place(placement: Placement): Promise<string | null> {
    const fits = (await this.candidates()).filter((c) => matches(c, placement));
    if (fits.length === 0) return null;
    const load = this.queries.worktreeCounts();
    fits.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    return fits[0].id;
  }

  /**
   * Picks a host for a workspace, or records a request for one. Asking again
   * for a workspace that already has an open request returns that request.
   */
  async placeWorkspace(input: WorkspaceCreateInput, placement: Placement): Promise<PlaceResult> {
    const workspaceId = toWorkspaceId(input.project, input.branch);
    const open = this.queries.findOpenForWorkspace(workspaceId);
    if (open) return { kind: "request", requestId: open.id };
    const hostId = await this.place(placement);
    if (hostId) return { kind: "host", hostId };
    // A concurrent create for the same workspace may have recorded a request
    // while `place` awaited. Nothing below awaits, so this check and the insert
    // run together.
    const raced = this.queries.findOpenForWorkspace(workspaceId);
    if (raced) return { kind: "request", requestId: raced.id };
    const now = this.now();
    const { placement: _placement, ...replay } = input;
    const id = `hr-${randomUUID().slice(0, 12)}`;
    this.queries.insert({
      id,
      workspaceId,
      project: input.project,
      branch: input.branch,
      labels: placement.labels ?? {},
      requires: placement.requires ?? {},
      environment: placement.environment ?? null,
      input: replay,
      status: "pending",
      leasedBy: null,
      leaseExpiresAt: null,
      hostId: null,
      error: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    log.info(`no host fits ${workspaceId}; recorded request ${id}`);
    this.publish(id, workspaceId, "pending");
    return { kind: "request", requestId: id };
  }

  // ---- the lease API a runner uses ----------------------------------------

  /** Takes the oldest request `filter` allows, for `ttlMs`. Returns null when there is none. */
  lease(
    runnerId: string,
    filter: LeaseFilter = {},
    ttlMs = DEFAULT_LEASE_MS,
  ): HostRequestRow | null {
    const now = this.now();
    this.expireLeases(now);
    const ttl = Math.min(Math.max(ttlMs, 1), MAX_LEASE_MS);
    const offered = Object.entries(filter.labels ?? {}).map(([k, v]) => `${k}=${v}`);
    for (const row of this.queries.listLeasable(now)) {
      const wanted = Object.entries(row.labels).map(([k, v]) => `${k}=${v}`);
      if (filter.labels && !wanted.every((l) => offered.includes(l))) continue;
      // A runner that lost the race to another one tries the next request.
      if (this.queries.lease(row.id, runnerId, now, now + ttl)) {
        this.publish(row.id, row.workspaceId, "leased");
        return this.queries.get(row.id) ?? null;
      }
    }
    return null;
  }

  renew(requestId: string, runnerId: string, ttlMs = DEFAULT_LEASE_MS): HostRequestRow {
    const now = this.now();
    const ttl = Math.min(Math.max(ttlMs, 1), MAX_LEASE_MS);
    if (!this.queries.renew(requestId, runnerId, now, now + ttl)) {
      throw this.notHeld(requestId, runnerId);
    }
    return this.require(requestId);
  }

  /** The runner started `hostId` for this request, with the repository at `hostProjectPath`. The workspace completes once that host is online. */
  fulfil(
    requestId: string,
    runnerId: string,
    hostId: string,
    hostProjectPath?: string,
  ): HostRequestRow {
    if (!tokenService.listHosts(1000).some((h) => h.id === hostId)) {
      throw new HostRequestError("conflict", `No host "${hostId}"`);
    }
    // The runner knows where the repository is on the machine it started.
    const current = this.queries.get(requestId);
    const input = hostProjectPath && current ? { ...current.input, hostProjectPath } : undefined;
    if (!this.queries.fulfil(requestId, runnerId, hostId, this.now(), input)) {
      throw this.notHeld(requestId, runnerId);
    }
    const row = this.require(requestId);
    this.publish(row.id, row.workspaceId, "fulfilled");
    void this.finish(row);
    return row;
  }

  fail(requestId: string, reason: string): HostRequestRow {
    const row = this.require(requestId);
    if (this.queries.fail(requestId, reason, this.now())) {
      log.warn(`request ${requestId} failed: ${reason}`);
      this.publish(row.id, row.workspaceId, "failed");
    }
    return this.require(requestId);
  }

  /** Stops waiting for a host (or dismisses a failure). A workspace already created stays. */
  cancel(requestId: string): HostRequestRow {
    const row = this.require(requestId);
    if (this.queries.cancel(requestId, this.now()))
      this.publish(row.id, row.workspaceId, "cancelled");
    return this.require(requestId);
  }

  list(): HostRequestRow[] {
    return this.queries.listActive();
  }

  get(requestId: string): HostRequestRow | undefined {
    return this.queries.get(requestId);
  }

  // ---- completing and expiring --------------------------------------------

  /** Called when a worker says hello: a fulfilled request waiting for it can finish. */
  onHostOnline(hostId: string): void {
    for (const row of this.queries.listAwaitingHost()) {
      if (row.hostId === hostId) void this.finish(row);
    }
  }

  private expireLeases(now: number): void {
    for (const id of this.queries.releaseExpired(now)) {
      const row = this.queries.get(id);
      log.info(`lease on ${id} expired`);
      if (row) this.publish(id, row.workspaceId, "pending");
    }
  }

  /** Expires leases, fails requests nobody met in time, and finishes requests whose host is up. */
  sweep(): void {
    try {
      const now = this.now();
      this.expireLeases(now);
      for (const row of this.queries.listTimedOut(now - this.timeoutMs())) {
        const seconds = Math.round(this.timeoutMs() / 1000);
        this.fail(
          row.id,
          row.status === "fulfilled"
            ? `Host ${row.hostId} did not connect within ${seconds}s`
            : `No host matched the placement within ${seconds}s`,
        );
      }
      for (const row of this.queries.listAwaitingHost()) void this.finish(row);
    } catch (err) {
      log.warn(`sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Creates the workspace on the fulfilled request's host, once that host is online. */
  private async finish(row: HostRequestRow): Promise<void> {
    if (!row.hostId || this.completing.has(row.id)) return;
    const host = tokenService.listHosts(1000).find((h) => h.id === row.hostId);
    if (host?.status !== "online") return;
    this.completing.add(row.id);
    try {
      await workspaceService.create({
        ...(row.input as WorkspaceCreateInput),
        hostId: row.hostId,
      });
      if (this.queries.complete(row.id, this.now())) {
        log.info(`workspace ${row.workspaceId} is ready on ${row.hostId}`);
        this.publish(row.id, row.workspaceId, "fulfilled");
      } else {
        // Cancelled while the checkout was being made: don't leave an orphan.
        await workspaceService
          .remove({ project: row.project, name: row.branch })
          .catch((err) => log.warn(`could not remove cancelled ${row.workspaceId}: ${err}`));
      }
    } catch (err) {
      this.fail(row.id, err instanceof Error ? err.message : String(err));
    } finally {
      this.completing.delete(row.id);
    }
  }

  private require(requestId: string): HostRequestRow {
    const row = this.queries.get(requestId);
    if (!row) throw new HostRequestError("not-found", `No host request "${requestId}"`);
    return row;
  }

  private notHeld(requestId: string, runnerId: string): HostRequestError {
    if (!this.queries.get(requestId)) {
      return new HostRequestError("not-found", `No host request "${requestId}"`);
    }
    return new HostRequestError(
      "conflict",
      `Request "${requestId}" is not leased to runner "${runnerId}" (its lease may have expired)`,
    );
  }

  private publish(requestId: string, workspaceId: string, status: HostRequestRow["status"]): void {
    emit({
      kind: "host-request-changed",
      hostRequestId: requestId,
      hostRequestStatus: status,
      workspaceId,
    });
  }
}

export const placementService = new PlacementService();
