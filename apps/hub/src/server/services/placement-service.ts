/**
 * Placement (plan step 3.3): choosing the host for a new worktree, and the
 * `host_requests` a runner leases when no host fits.
 *
 * `worktrees.create` with `placement` calls `place()`. An online host whose
 * labels and facts satisfy the criteria gets the worktree at once (the least
 * loaded one, when several fit). Otherwise the hub records a `host_request` and
 * the worktree is `provisioning`. A runner (step 3.4) leases the request,
 * starts a machine and fulfils the request with the host id. When that host
 * says hello, the hub replays the stored create call on it. A request that no
 * host satisfies within `BAND_PLACEMENT_TIMEOUT_MS` (10 minutes by default)
 * fails with a reason.
 */

import { randomUUID } from "node:crypto";
import { extractVersion, satisfies as inRange, rangeError } from "@band-app/environment";
import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { z } from "zod";
import { HostRequestQueries, type HostRequestRow } from "../infra/db/queries/host-requests";
import { RepoQueries } from "../infra/db/queries/repos";
import { hostRegistry } from "../infra/host/registry";
import {
  type IsolationLevel,
  isExclusiveHost,
  offers,
  requestedIsolation,
  runnerLevel,
} from "./_utils/isolation";
import type { Placement } from "./_utils/placement-input";
import { parseRunners } from "./_utils/runner-config";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { settingsService } from "./settings-service";
import { tokenService } from "./token-service";
import { emit } from "./watcher-service";
import { type WorktreeCreateInput, worktreeService } from "./worktree-service";

const log = createLogger("placement");
const repoQueries = new RepoQueries();

const LOCAL_HOST_ID = "local";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 15 * 60_000;
const SWEEP_MS = 1000;

export const leaseFilterInput = z
  .object({
    /** What the runner offers. A request is leasable when every label it asks for is here. */
    labels: z.record(z.string(), z.string()).optional(),
    /** Facts about what the runner starts. When given, a request's `requires` must hold for them. */
    provides: z.record(z.string(), z.string()).optional(),
    /** The isolation the runner's machines have. A request asking for more is left alone. */
    isolation: z.enum(["worktree", "container", "vm"]).optional(),
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

/** What a wake request (plan step 3.5) carries in `input.wake`: the sleeping host to bring back. */
export interface WakeInput {
  hostId: string;
  worktreeIds: string[];
}

/** The sleeping host a request is for, or null for an ordinary request for a new worktree. */
export function wakeOf(row: HostRequestRow): WakeInput | null {
  const wake = (row.input as { wake?: WakeInput }).wake;
  return wake && typeof wake.hostId === "string" ? wake : null;
}

/** What placement knows about a host. */
interface Candidate {
  id: string;
  labels: string[];
  facts: Record<string, string>;
}

// ---- matching -------------------------------------------------------------

/**
 * Whether `actual` satisfies `constraint`. A version range (`>=24`, `^3.12`,
 * `24.x`, `>=20 <23`, see `@band-app/environment`) is matched against the
 * version found in `actual`. Anything else (`linux`, `arm64`) must match exactly.
 */
export function satisfies(actual: string | undefined, constraint: string): boolean {
  if (actual === undefined) return false;
  const wanted = constraint.trim();
  if (rangeError(wanted) !== null) return actual === wanted;
  const version = extractVersion(actual);
  return version !== null && inRange(version, wanted);
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

  timeoutMs(): number {
    const raw = Number(process.env.BAND_PLACEMENT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  // ---- choosing a host ----------------------------------------------------

  private async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const row of tokenService.listHosts(1000)) {
      if (row.status !== "online" || !row.usable) continue;
      // An ephemeral worker is claimed by the worktree it was started for.
      if ((row.info as { mode?: unknown } | null)?.mode === "ephemeral") continue;
      const info =
        row.id === LOCAL_HOST_ID ? await hostRegistry.local.info().catch(() => null) : null;
      const stored = (row.info ?? {}) as Record<string, unknown>;
      const versions = stringRecord(info?.versions ?? stored.versions);
      const tools = stringRecord(info?.tools ?? stored.tools);
      out.push({
        id: row.id,
        labels: [
          ...new Set([...stringList(row.labels), ...stringList(info?.labels ?? stored.labels)]),
        ],
        facts: {
          ...versions,
          // What is on the host's PATH wins over the hub's own runtime version.
          ...tools,
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

  /**
   * The least loaded online host that satisfies `placement`, or null. A
   * `container` or `vm` worktree gets a worker of its own, so it never reuses
   * a host, and a `worktree` worktree never lands on a host that was started
   * for one of those.
   */
  async place(placement: Placement, onlyHosts?: string[]): Promise<string | null> {
    if (requestedIsolation(placement.environment ?? null) !== "worktree") return null;
    const fits = (await this.candidates()).filter(
      (c) =>
        !isExclusiveHost(c.labels) &&
        (onlyHosts === undefined || onlyHosts.includes(c.id)) &&
        matches(c, placement),
    );
    if (fits.length === 0) return null;
    const load = this.queries.worktreeCounts();
    fits.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    return fits[0].id;
  }

  /**
   * The hosts that hold a repo owned by one worker (no remote URL and no checkout on the hub),
   * or null for any other repo. A repo with a checkout on the hub can still be cloned from the
   * hub's path by a hook on the hub's machine.
   */
  private holdersOfRemotelessRepo(repo: string): string[] | null {
    const known = repoQueries.findLocation(repo);
    if (!known || known.remoteUrl || known.path) return null;
    return [...(repoQueries.allHostPaths().get(repo)?.keys() ?? [])];
  }

  /**
   * Picks a host for a worktree, or records a request for one. Asking again
   * for a worktree that already has an open request returns that request.
   */
  async placeWorktree(input: WorktreeCreateInput, placement: Placement): Promise<PlaceResult> {
    const worktreeId = toWorktreeId(input.repo, input.branch);
    const open = this.queries.findOpenForWorktree(worktreeId);
    if (open) return { kind: "request", requestId: open.id };
    // A repo with no remote URL has nothing a new worker could clone, so it only runs on a host
    // that already holds it, and waiting for a runner would never help.
    const holders = this.holdersOfRemotelessRepo(input.repo);
    const hostId = await this.place(placement, holders ?? undefined);
    if (hostId) return { kind: "host", hostId };
    if (holders) {
      throw new Error(
        `Repo "${input.repo}" has no remote URL, so it can only run on the host that holds it (${
          holders.join(", ") || "none recorded"
        }), and none of them is online and fits the placement.`,
      );
    }
    // A concurrent create for the same worktree may have recorded a request
    // while `place` awaited. Nothing below awaits, so this check and the insert
    // run together.
    const raced = this.queries.findOpenForWorktree(worktreeId);
    if (raced) return { kind: "request", requestId: raced.id };
    this.assertRunnerOffers(requestedIsolation(placement.environment ?? null), worktreeId);
    const now = this.now();
    const { placement: _placement, ...replay } = input;
    const id = `hr-${randomUUID().slice(0, 12)}`;
    this.queries.insert({
      id,
      worktreeId,
      repo: input.repo,
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
    log.info(`no host fits ${worktreeId}; recorded request ${id}`);
    this.publish(id, worktreeId, "pending");
    return { kind: "request", requestId: id };
  }

  /**
   * Refuses a `container` or `vm` request that no configured runner could
   * take, so the caller gets the reason now and not after the placement timeout.
   */
  private assertRunnerOffers(wanted: IsolationLevel, worktreeId: string): void {
    if (wanted === "worktree") return;
    const { runners } = parseRunners(settingsService.get().runners);
    if (runners.some((r) => offers(runnerLevel(r.isolation), wanted))) return;
    const reason =
      wanted === "vm"
        ? "No runner offers isolation vm. Set isolation to vm on a runner in settings.json. The bundled hooks start no virtual machines yet."
        : "No runner offers isolation container. Add a runner with isolation container to settings.json, such as the bundled docker hook.";
    log.warn(`${worktreeId} asked for isolation ${wanted}, but ${reason}`);
    throw new Error(`Cannot place ${worktreeId}: ${reason}`);
  }

  /**
   * Asks for a machine to bring a sleeping ephemeral host back (plan step
   * 3.5). The request repeats the placement of the one that created the host
   * and names the host in `input.wake`, so the runner starts a worker with the
   * same id. Asking again while a request is open returns that request.
   */
  requestWake(wake: WakeInput, repo: string, branch: string): HostRequestRow {
    const first = wake.worktreeIds[0];
    if (!first) throw new Error("A wake request names no worktree");
    const open = this.queries.findOpenForWorktree(first);
    if (open) return open;
    const earlier = this.queries.latestForHost(wake.hostId);
    const now = this.now();
    const row: HostRequestRow = {
      id: `hr-${randomUUID().slice(0, 12)}`,
      worktreeId: first,
      repo,
      branch,
      labels: earlier?.labels ?? {},
      requires: earlier?.requires ?? {},
      environment: earlier?.environment ?? null,
      input: {
        wake,
        ...(typeof (earlier?.input as { hostRepoPath?: unknown })?.hostRepoPath === "string"
          ? { hostRepoPath: (earlier?.input as { hostRepoPath: string }).hostRepoPath }
          : {}),
      },
      status: "pending",
      leasedBy: null,
      leaseExpiresAt: null,
      hostId: null,
      error: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.queries.insert(row);
    log.info(`recorded request ${row.id} to wake ${wake.hostId}`);
    this.publish(row.id, first, "pending");
    return row;
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
      // A runner that names no level offers `worktree`, so it never takes a container or vm request.
      if (
        !offers(
          filter.isolation ?? "worktree",
          requestedIsolation(row.environment as Record<string, unknown> | null),
        )
      ) {
        continue;
      }
      const provides = filter.provides;
      if (
        provides &&
        !Object.entries(row.requires).every(([k, constraint]) => satisfies(provides[k], constraint))
      ) {
        continue;
      }
      // A runner that lost the race to another one tries the next request.
      if (this.queries.lease(row.id, runnerId, now, now + ttl)) {
        this.publish(row.id, row.worktreeId, "leased");
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

  /** The runner started `hostId` for this request, with the repository at `hostRepoPath`. The worktree completes once that host is online. */
  fulfil(
    requestId: string,
    runnerId: string,
    hostId: string,
    hostRepoPath?: string,
  ): HostRequestRow {
    if (!tokenService.listHosts(1000).some((h) => h.id === hostId)) {
      throw new HostRequestError("conflict", `No host "${hostId}"`);
    }
    // The runner knows where the repository is on the machine it started.
    const current = this.queries.get(requestId);
    const input = hostRepoPath && current ? { ...current.input, hostRepoPath } : undefined;
    if (!this.queries.fulfil(requestId, runnerId, hostId, this.now(), input)) {
      throw this.notHeld(requestId, runnerId);
    }
    const row = this.require(requestId);
    this.publish(row.id, row.worktreeId, "fulfilled");
    void this.finish(row);
    return row;
  }

  fail(requestId: string, reason: string): HostRequestRow {
    const row = this.require(requestId);
    if (this.queries.fail(requestId, reason, this.now())) {
      log.warn(`request ${requestId} failed: ${reason}`);
      this.publish(row.id, row.worktreeId, "failed");
    }
    return this.require(requestId);
  }

  /** Stops waiting for a host (or dismisses a failure). A worktree already created stays. */
  cancel(requestId: string): HostRequestRow {
    const row = this.require(requestId);
    if (this.queries.cancel(requestId, this.now()))
      this.publish(row.id, row.worktreeId, "cancelled");
    return this.require(requestId);
  }

  /** The requests the UI lists: waiting worktrees. A wake request shows as its worktree waking instead. */
  list(): HostRequestRow[] {
    return this.queries.listActive().filter((r) => wakeOf(r) === null);
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
      if (row) this.publish(id, row.worktreeId, "pending");
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

  /** Creates the worktree on the fulfilled request's host, once that host is online. */
  private async finish(row: HostRequestRow): Promise<void> {
    if (!row.hostId || this.completing.has(row.id)) return;
    const host = tokenService.listHosts(1000).find((h) => h.id === row.hostId);
    if (host?.status !== "online") return;
    this.completing.add(row.id);
    try {
      const wake = wakeOf(row);
      if (wake) {
        await ephemeralLifecycleService.restoreHost(
          wake.hostId,
          (row.input as { hostRepoPath?: string }).hostRepoPath,
        );
        if (this.queries.complete(row.id, this.now())) {
          log.info(`host ${wake.hostId} is awake`);
          this.publish(row.id, row.worktreeId, "fulfilled");
        }
        return;
      }
      await worktreeService.create({
        ...(row.input as WorktreeCreateInput),
        hostId: row.hostId,
      });
      if (this.queries.complete(row.id, this.now())) {
        log.info(`worktree ${row.worktreeId} is ready on ${row.hostId}`);
        this.publish(row.id, row.worktreeId, "fulfilled");
      } else {
        // Cancelled while the checkout was being made: don't leave an orphan.
        await worktreeService
          .remove({ repo: row.repo, name: row.branch })
          .catch((err) => log.warn(`could not remove cancelled ${row.worktreeId}: ${err}`));
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

  private publish(requestId: string, worktreeId: string, status: HostRequestRow["status"]): void {
    emit({
      kind: "host-request-changed",
      hostRequestId: requestId,
      hostRequestStatus: status,
      worktreeId,
    });
  }
}

export const placementService = new PlacementService();
