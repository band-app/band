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
import { releaseCheckService } from "./release-check-service";
import { emit } from "./watcher-service";
import { workerLinkService } from "./worker-link-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("worker-update");

/** npm can take a while on a slow link. */
const INSTALL_TIMEOUT_MS = 11 * 60_000;
const RESTART_TIMEOUT_MS = 3 * 60_000;

export type WorkerUpdateState = "installing" | "restarting" | "failed";

export interface WorkerUpdateStatus {
  target: string;
  state: WorkerUpdateState;
  error: string | null;
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
    if (!view.serviceManager) {
      throw new WorkerUpdateError(
        "not-updatable",
        `This worker does not run under launchd or a systemd user unit. Update it by hand: ${workerUpdateCommand(view.updateTarget ?? HUB_VERSION)}`,
      );
    }
    if (!view.updateTarget) {
      throw new WorkerUpdateError("not-updatable", "The worker is already up to date");
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
