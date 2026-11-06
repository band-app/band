/**
 * Updates a worker on an admin's click: asks it to install the target release with npm and restart
 * through its service manager (`worker.update`), then waits for it to dial back on that version.
 * The hub only sends the command; a worker that cannot restart itself is updated by hand.
 *
 * The state of each update lives in memory, so the Hosts screen can show "updating" and an error
 * after a reload. A hub restart forgets it, and the next `hosts.list` shows the worker's real version.
 */

import { METHOD_WORKER_UPDATE, RPC_METHOD_NOT_FOUND, RpcError } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { workerUpdateCommand } from "@band-app/shared/versions";
import { TokenQueries } from "../infra/db/queries/tokens";
import { describeHostVersion } from "./_utils/host-version";
import { HUB_VERSION } from "./_utils/hub-version";
import { agentSessionService } from "./agent-session-service";
import { hubUpdateService } from "./hub-update-service";
import { releaseCheckService } from "./release-check-service";
import { settingsService } from "./settings-service";
import { emit } from "./watcher-service";
import { workerLinkService } from "./worker-link-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("worker-update");

/** npm can take a while on a slow link. */
const INSTALL_TIMEOUT_MS = 11 * 60_000;
const RESTART_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_AUTO_POLL_MS = 60_000;
const DEFAULT_MAX_DEFER_H = 6;

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type WorkerUpdateState = "installing" | "restarting" | "failed";

export interface WorkerUpdateStatus {
  target: string;
  state: WorkerUpdateState;
  error: string | null;
}

export interface UpdateAllEntry {
  hostId: string;
  name: string;
  state: "pending" | "updating" | "updated" | "skipped" | "failed";
  message: string | null;
}

export interface UpdateAllStatus {
  running: boolean;
  results: UpdateAllEntry[];
}

export class WorkerUpdateError extends Error {
  constructor(
    readonly reason: "not-found" | "not-updatable" | "busy",
    message: string,
  ) {
    super(message);
  }
}

export class WorkerUpdateService {
  private readonly updates = new Map<string, WorkerUpdateStatus>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queries = new TokenQueries();

  private all: UpdateAllStatus = { running: false, results: [] };
  /** When the automatic update first found each worker busy. In memory: a hub restart restarts the wait. */
  private readonly deferred = new Map<string, number>();
  private autoTimer: NodeJS.Timeout | null = null;

  /**
   * The workers set to update automatically. Kept in `settings.workerUpdate.autoHostIds` (no
   * migration, and the same place as the hub's own `hubUpdate.auto`). An id of a removed worker
   * stays until the next write and does nothing.
   */
  autoHostIds(): string[] {
    const ids = (settingsService.get() as { workerUpdate?: { autoHostIds?: unknown } }).workerUpdate
      ?.autoHostIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  isAuto(hostId: string): boolean {
    return this.autoHostIds().includes(hostId);
  }

  /** When the automatic update started waiting for this worker's agents, or null. */
  deferredSince(hostId: string): number | null {
    return this.deferred.get(hostId) ?? null;
  }

  setAuto(hostId: string, auto: boolean): void {
    const row = this.queries.findHost(hostId);
    if (!row || hostId === "local")
      throw new WorkerUpdateError("not-found", `No worker "${hostId}"`);
    const others = this.autoHostIds().filter((id) => id !== hostId);
    settingsService.update({
      workerUpdate: { autoHostIds: auto ? [...others, hostId] : others },
    } as Parameters<typeof settingsService.update>[0]);
    if (!auto) this.deferred.delete(hostId);
    emit({ kind: "host-status-changed", hostId });
  }

  startAuto(): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(
      () => this.autoTick(),
      envNumber("BAND_WORKER_UPDATE_AUTO_POLL_MS", DEFAULT_AUTO_POLL_MS),
    );
    this.autoTimer.unref();
  }

  stopAuto(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  /**
   * One pass of the automatic update. A worker is updated when it is online, set to update
   * automatically, behind the hub (the target is the hub's own version, never a newer release, so
   * the hub updates first), able to restart itself and not already updating or failed. With an
   * agent on it that the restart would end (held agents survive, so they do not count) it waits,
   * starting a clock on the first deferral, and goes ahead once none run or the limit passes.
   */
  autoTick(): void {
    try {
      const auto = new Set(this.autoHostIds());
      for (const id of [...this.deferred.keys()]) if (!auto.has(id)) this.deferred.delete(id);
      if (auto.size === 0) return;
      const latest = releaseCheckService.status().latest;
      for (const row of this.queries.listHosts(1000)) {
        if (row.id === "local" || !auto.has(row.id) || row.status !== "online") continue;
        const view = describeHostVersion(row, HUB_VERSION, latest);
        if (view.versionState !== "behind" || !view.canUpdate) continue;
        if (view.updateTarget !== HUB_VERSION) continue;
        // A running or failed update is left to the admin (Retry or Dismiss).
        if (this.updates.has(row.id)) continue;
        if (this.interruptions(row.id).length > 0) {
          const since = this.deferred.get(row.id) ?? Date.now();
          this.deferred.set(row.id, since);
          const limit =
            envNumber("BAND_WORKER_UPDATE_MAX_DEFER_H", DEFAULT_MAX_DEFER_H) * 3_600_000;
          if (Date.now() - since < limit) continue;
        }
        this.deferred.delete(row.id);
        this.update(row.id).catch((err) => {
          log.warn(
            `automatic update of worker ${row.id} failed to start: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    } catch (err) {
      log.warn(`automatic worker update pass failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  allStatus(): UpdateAllStatus {
    return this.all;
  }

  /**
   * Updates every online worker that is behind, one after the other, and returns at once. A worker
   * with running agents is skipped unless `confirmInterruptions` is true. `allStatus` reports each
   * worker as it finishes. With `includeHub` the hub update command runs last, once every worker
   * update ended without a failure.
   */
  updateAll(confirmInterruptions: boolean, includeHub = false): UpdateAllStatus {
    if (this.all.running)
      throw new WorkerUpdateError("busy", "An update of all workers is running");
    const latest = releaseCheckService.status().latest;
    const results: UpdateAllEntry[] = [];
    for (const row of this.queries.listHosts(1000)) {
      if (row.id === "local" || row.status !== "online") continue;
      const view = describeHostVersion(row, HUB_VERSION, latest);
      if (!view.updateTarget || !view.serviceManager) continue;
      results.push({ hostId: row.id, name: row.name, state: "pending", message: null });
    }
    if (includeHub) {
      if (!hubUpdateService.status().configured) {
        throw new WorkerUpdateError("not-updatable", "No hub update command is set");
      }
      results.push({ hostId: "hub", name: "Hub", state: "pending", message: null });
    }
    this.all = { running: results.length > 0, results };
    if (results.length > 0) void this.runAll(confirmInterruptions);
    return this.all;
  }

  private async runAll(confirmInterruptions: boolean): Promise<void> {
    try {
      for (const entry of this.all.results) {
        if (entry.hostId === "hub") {
          this.updateHubEntry(entry, confirmInterruptions);
          continue;
        }
        const agents = this.interruptions(entry.hostId);
        if (agents.length > 0 && !confirmInterruptions) {
          entry.state = "skipped";
          entry.message = `${agents.length === 1 ? "1 agent is" : `${agents.length} agents are`} running`;
          continue;
        }
        entry.state = "updating";
        try {
          await this.update(entry.hostId);
          await this.untilSettled(entry.hostId);
          const end = this.updates.get(entry.hostId);
          if (end?.state === "failed") {
            entry.state = "failed";
            entry.message = end.error;
          } else {
            entry.state = "updated";
          }
        } catch (err) {
          entry.state = "failed";
          entry.message = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.all.running = false;
    }
  }

  private updateHubEntry(entry: UpdateAllEntry, confirmInterruptions: boolean): void {
    if (this.all.results.some((r) => r.hostId !== "hub" && r.state === "failed")) {
      entry.state = "skipped";
      entry.message = "a worker update failed";
      return;
    }
    try {
      hubUpdateService.start(confirmInterruptions);
      entry.state = "updating";
    } catch (err) {
      entry.state = "failed";
      entry.message = err instanceof Error ? err.message : String(err);
    }
  }

  private async untilSettled(hostId: string): Promise<void> {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS + RESTART_TIMEOUT_MS + 30_000;
    while (Date.now() < deadline) {
      const state = this.updates.get(hostId)?.state;
      if (state === undefined || state === "failed") return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  statusOf(hostId: string): WorkerUpdateStatus | null {
    return this.updates.get(hostId) ?? null;
  }

  /**
   * Starts installing the host's update target on the worker and returns at once. Rejects only when
   * the update cannot start; the install's progress and any failure show in `statusOf`.
   */
  async update(hostId: string): Promise<{ target: string }> {
    const row = this.queries.findHost(hostId);
    if (!row || hostId === "local")
      throw new WorkerUpdateError("not-found", `No worker "${hostId}"`);
    const view = describeHostVersion(row, HUB_VERSION, releaseCheckService.status().latest);
    if (row.status !== "online") {
      throw new WorkerUpdateError("not-updatable", "The worker is not connected");
    }
    if (!view.updateTarget) {
      throw new WorkerUpdateError("not-updatable", "The worker is already up to date");
    }
    if (view.updateBlockedReason) {
      throw new WorkerUpdateError(
        "not-updatable",
        `This worker cannot update itself: ${view.updateBlockedReason}`,
      );
    }
    if (!view.serviceManager) {
      throw new WorkerUpdateError(
        "not-updatable",
        `This worker does not run under launchd or a systemd user unit. Update it by hand: ${workerUpdateCommand(view.updateTarget)}`,
      );
    }
    const current = this.updates.get(hostId);
    if (current && current.state !== "failed") {
      throw new WorkerUpdateError("busy", "An update is already running on this worker");
    }
    const session = workerLinkService.server.getSession(hostId);
    if (!session?.attached)
      throw new WorkerUpdateError("not-updatable", "The worker is not connected");

    const target = view.updateTarget;
    this.set(hostId, { target, state: "installing", error: null }, row.status);
    log.info(`updating worker ${hostId} to ${target}`);
    // The install can take minutes and the hub may sit behind a proxy that gives up on a long
    // request, so the call answers now and the host row carries the progress and the result.
    void this.run(hostId, target, session, row.status);
    return { target };
  }

  private async run(
    hostId: string,
    target: string,
    session: NonNullable<ReturnType<typeof workerLinkService.server.getSession>>,
    hostStatus: "online" | "offline" | "lost" | "disposed",
  ): Promise<void> {
    try {
      await session.request(
        METHOD_WORKER_UPDATE,
        { version: target },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
    } catch (err) {
      const message = this.describe(err, target);
      this.set(hostId, { target, state: "failed", error: message }, hostStatus);
      log.warn(`update of worker ${hostId} failed: ${message}`);
      return;
    }
    // The worker may have restarted and said hello before this reply arrived.
    if (this.updates.get(hostId)?.state !== "installing") return;
    this.set(hostId, { target, state: "restarting", error: null }, hostStatus);
    const wait = Number(process.env.BAND_WORKER_UPDATE_RESTART_TIMEOUT_MS);
    const timer = setTimeout(
      () => {
        this.timers.delete(hostId);
        const now = this.updates.get(hostId);
        if (now?.state !== "restarting") return;
        // The reply or the reconnect may have been missed while the worker did come back.
        const row = this.queries.findHost(hostId);
        if (row?.status === "online" && row.version === target) {
          this.updates.delete(hostId);
          emit({ kind: "host-status-changed", hostId, hostStatus: "online" });
          return;
        }
        this.set(
          hostId,
          { target, state: "failed", error: `The worker did not reconnect on ${target}` },
          row?.status ?? "offline",
        );
      },
      wait > 0 ? wait : RESTART_TIMEOUT_MS,
    );
    timer.unref();
    this.timers.set(hostId, timer);
  }

  /** A worker said hello. An update waiting for it is over: it succeeded when it runs the target. */
  onConnected(hostId: string, version: string | null): void {
    const current = this.updates.get(hostId);
    if (!current || current.state === "failed") return;
    // A link that flapped during the install says hello on the old version; the install still runs.
    if (current.state === "installing" && version !== current.target) return;
    clearTimeout(this.timers.get(hostId));
    this.timers.delete(hostId);
    if (version === current.target) {
      this.updates.delete(hostId);
      log.info(`worker ${hostId} now runs ${version}`);
    } else {
      this.set(
        hostId,
        {
          target: current.target,
          state: "failed",
          error: `The worker restarted on ${version ?? "an unknown version"}, not ${current.target}`,
        },
        "online",
      );
    }
  }

  /** The agents on a host that restarting its worker would end. */
  interruptions(hostId: string): { chatId: string; worktreeId: string; busy: boolean }[] {
    const hostOf = new Map<string, string | null>();
    const hostIdOf = (worktreeId: string): string | null => {
      if (!hostOf.has(worktreeId)) {
        try {
          hostOf.set(worktreeId, worktreeService.resolve(worktreeId)?.host.id ?? null);
        } catch {
          hostOf.set(worktreeId, null);
        }
      }
      return hostOf.get(worktreeId) ?? null;
    };
    return agentSessionService.liveAgents().filter((a) => hostIdOf(a.worktreeId) === hostId);
  }

  /** Dismisses a failed update, so the Update button is offered again. */
  clear(hostId: string): void {
    if (this.updates.get(hostId)?.state === "failed") this.updates.delete(hostId);
  }

  private describe(err: unknown, target: string): string {
    if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) {
      return `This worker is too old to update itself. Run on the worker: ${workerUpdateCommand(target)}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private set(
    hostId: string,
    status: WorkerUpdateStatus,
    hostStatus: "online" | "offline" | "lost" | "disposed",
  ): void {
    this.updates.set(hostId, status);
    emit({ kind: "host-status-changed", hostId, hostStatus });
  }
}

export const workerUpdateService = new WorkerUpdateService();
