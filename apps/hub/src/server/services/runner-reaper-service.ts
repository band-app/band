/**
 * The reaper (plan step 3.7): machines started by runner hooks never leak.
 *
 * `RunnerService` records every machine it spawns in `runner_machines`. On a timer the
 * reaper compares those rows with the hosts and with each runner's `status` hook, and
 * destroys, through the runner's `destroy` hook:
 *
 *   - a machine whose worker never said hello (`timeoutSec` plus a grace period after the
 *     spawn), for a spawn no attempt in flight owns any more, such as one a hub restart cut off;
 *   - a machine whose host row is gone, or whose worker has been offline past a threshold
 *     (also `lost`: three missed heartbeats);
 *   - a machine the `status` hook lists that the hub has no live record of (an orphan);
 *   - a machine past the runner's `maxLifetimeSec`. The reaper first asks the worker to hand
 *     its worktrees over like an idle one (step 3.5: snapshot, agent sessions, exit), and
 *     destroys only after the worker has exited with every worktree stored.
 *
 * A machine whose worktrees are not stored is never destroyed early. It waits until the hard
 * deadline (`lifetimeGraceSec` after the lifetime, or after the offline threshold). If that
 * passes, the machine is destroyed anyway and the hub logs an error naming the worktrees.
 *
 * Environment (read on every sweep, except the interval, read at start):
 *   BAND_REAPER_INTERVAL_MS      time between sweeps, default 30 s
 *   BAND_REAPER_HELLO_GRACE_MS   extra time after `timeoutSec` for a hello, default 60 s
 *   BAND_REAPER_OFFLINE_MS       how long a worker may be offline before its machine goes, default 2 min
 */

import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  RunnerMachineQueries,
  type RunnerMachineRow,
  type RunnerMachineState,
} from "../infra/db/queries/runner-machines";
import { hostRegistry } from "../infra/host/registry";
import type { RunnerConfig } from "./_utils/runner-config";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { type RunnerService, runnerService } from "./runner-service";
import { loadState } from "./state";
import { tokenService } from "./token-service";

const log = createLogger("reaper");

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_HELLO_GRACE_MS = 60_000;
const DEFAULT_OFFLINE_MS = 120_000;
const LIST_LIMIT = 200;

function envMs(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class MachineError extends Error {
  constructor(
    readonly reason: "not-found" | "gone" | "has-worktrees",
    message: string,
  ) {
    super(message);
    this.name = "MachineError";
  }
}

export interface MachineView {
  id: string;
  runnerId: string;
  requestId: string | null;
  workerId: string;
  handle: string | null;
  state: RunnerMachineState;
  spawnedAt: number;
  lastSeenAt: number | null;
  stoppingSince: number | null;
  destroyedAt: number | null;
  /** The reason it was destroyed, or what it is waiting for, or why a destroy failed. */
  note: string | null;
  /** Status of the machine's host, or null when the host row is gone. */
  hostStatus: string | null;
  /** Worktrees the hub tracks on the machine's host. */
  worktrees: number;
}

export class RunnerReaperService {
  private readonly machines = new RunnerMachineQueries();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly startedAt = Date.now();
  private readonly pending = new Set<Promise<unknown>>();
  /** Machines whose "waiting" note was already logged, so a long wait logs once. */
  private readonly warned = new Set<string>();

  constructor(private readonly runners: RunnerService = runnerService) {}

  start(): void {
    if (this.timer) return;
    const interval = envMs("BAND_REAPER_INTERVAL_MS", DEFAULT_INTERVAL_MS, 20);
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once the destroys in flight have ended. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ---- views -----------------------------------------------------------------

  list(): MachineView[] {
    const counts = ephemeralLifecycleService.worktreeCountsByHost();
    return this.machines.list(LIST_LIMIT).map((m) => this.view(m, counts.get(m.workerId) ?? 0));
  }

  private view(
    m: RunnerMachineRow,
    worktrees = ephemeralLifecycleService.worktreeCount(m.workerId),
  ): MachineView {
    return {
      id: m.id,
      runnerId: m.runnerId,
      requestId: m.requestId,
      workerId: m.workerId,
      handle: m.handle,
      state: m.state,
      spawnedAt: m.spawnedAt,
      lastSeenAt: m.lastSeenAt,
      stoppingSince: m.stoppingSince,
      destroyedAt: m.destroyedAt,
      note: m.error,
      hostStatus: tokenService.hostStatus(m.workerId),
      worktrees,
    };
  }

  // ---- admin action ----------------------------------------------------------

  /**
   * Destroys a machine now, for an admin. A machine whose worktrees are not stored is refused
   * unless `force` is set, because they would be lost with it.
   */
  async destroy(machineId: string, opts: { force?: boolean } = {}): Promise<MachineView> {
    const machine = this.machines.get(machineId);
    if (!machine) throw new MachineError("not-found", `No machine ${machineId}`);
    if (machine.state === "destroyed") {
      throw new MachineError("gone", `Machine ${machineId} is already destroyed`);
    }
    if (!opts.force && !this.isSafeToDestroy(machine)) {
      throw new MachineError(
        "has-worktrees",
        `Machine ${machineId} holds worktrees that are not stored. Let it sleep first, or destroy it with force.`,
      );
    }
    const done = await this.runners.destroyMachine(
      machineId,
      opts.force ? "destroyed by an admin (forced)" : "destroyed by an admin",
    );
    return this.view(done);
  }

  // ---- the sweep -------------------------------------------------------------

  /** One pass over the live machines and the runners' `status` hooks. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const machine of this.machines.listLive()) {
        try {
          await this.reap(machine, Date.now());
        } catch (err) {
          log.warn(`could not check machine ${machine.id}: ${errorText(err)}`);
        }
      }
      await this.reapOrphans();
    } catch (err) {
      log.warn(`sweep failed: ${errorText(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reap(machine: RunnerMachineRow, now: number): Promise<void> {
    const runner = this.runners.findRunner(machine.runnerId);
    // Without the runner's settings there is no destroy hook to run.
    if (!runner) {
      this.note(
        machine,
        `runner ${machine.runnerId} is no longer configured, so it cannot be destroyed`,
      );
      return;
    }
    const host = tokenService.hostSeen(machine.workerId);
    const online = host?.status === "online";

    if (machine.state === "spawning") {
      if (this.runners.isAttempting(machine.workerId)) return;
      if (online) {
        // The hello came, but the hub stopped before it recorded it.
        this.machines.update(machine.id, { state: "running", lastSeenAt: now });
        machine = { ...machine, state: "running", lastSeenAt: now };
      } else {
        const limitMs =
          runner.timeoutSec * 1000 + envMs("BAND_REAPER_HELLO_GRACE_MS", DEFAULT_HELLO_GRACE_MS, 0);
        if (now - machine.spawnedAt >= limitMs) {
          await this.destroyNow(
            machine,
            `the worker did not say hello within ${Math.round(limitMs / 1000)}s of the spawn`,
            { dropHost: true },
          );
        }
        return;
      }
    }

    if (!host) {
      await this.destroyNow(machine, "its host is gone");
      return;
    }
    if (online) this.machines.update(machine.id, { lastSeenAt: now });

    const lifetimeMs = runner.maxLifetimeSec ? runner.maxLifetimeSec * 1000 : null;
    if (lifetimeMs !== null && now - machine.spawnedAt >= lifetimeMs) {
      await this.endOfLife(machine, runner, online, now, lifetimeMs);
      return;
    }

    if (online) return;
    const offlineMs = envMs("BAND_REAPER_OFFLINE_MS", DEFAULT_OFFLINE_MS, 0);
    // A hub restart marks every worker offline without a time, and workers take a moment to redial.
    const since = Math.max(
      host.lastSeenAt ?? machine.lastSeenAt ?? machine.spawnedAt,
      this.startedAt,
    );
    if (now - since < offlineMs) return;
    await this.guarded(
      machine,
      `its worker has been ${host.status} for ${Math.round((now - since) / 1000)}s`,
      since + offlineMs + runner.lifetimeGraceSec * 1000,
      now,
    );
  }

  /** A machine past its maximum lifetime: store the worktrees, wait for the worker to exit, then destroy. */
  private async endOfLife(
    machine: RunnerMachineRow,
    runner: RunnerConfig,
    online: boolean,
    now: number,
    lifetimeMs: number,
  ): Promise<void> {
    const deadline = machine.spawnedAt + lifetimeMs + runner.lifetimeGraceSec * 1000;
    if (machine.state === "running") {
      this.machines.update(machine.id, { state: "stopping", stoppingSince: now });
      log.info(`machine ${machine.id} reached its maximum lifetime of ${runner.maxLifetimeSec}s`);
    }
    const reason = `maximum lifetime of ${runner.maxLifetimeSec}s reached`;
    if (!online) {
      await this.guarded(machine, reason, deadline, now);
      return;
    }
    if (
      ephemeralLifecycleService.worktreeCount(machine.workerId) === 0 &&
      ephemeralLifecycleService.isStored(machine.workerId)
    ) {
      await this.destroyNow(machine, `${reason}; it holds no worktrees`);
      return;
    }
    if (now >= deadline) {
      await this.guarded(machine, reason, deadline, now);
      return;
    }
    if (!ephemeralLifecycleService.isEphemeral(machine.workerId)) {
      this.note(
        machine,
        "waiting: the worker is not ephemeral, so it cannot hand its worktrees over",
      );
      return;
    }
    const asked = await ephemeralLifecycleService.requestSleep(machine.workerId);
    const blocker = ephemeralLifecycleService.sleepBlocker(machine.workerId);
    this.note(
      machine,
      asked
        ? `waiting for the worker to store its worktrees${blocker ? `: ${blocker}` : ""}`
        : "waiting: the worker did not take the request to sleep",
    );
  }

  /**
   * Destroys the machine once its worktrees are stored (or it has none). Until `deadline` it
   * waits otherwise. After the deadline it destroys the machine anyway and logs the loss.
   */
  private async guarded(
    machine: RunnerMachineRow,
    reason: string,
    deadline: number,
    now: number,
  ): Promise<void> {
    if (ephemeralLifecycleService.isStored(machine.workerId)) {
      await this.destroyNow(machine, reason);
      return;
    }
    if (now < deadline) {
      this.note(
        machine,
        `waiting: ${reason}, but its worktrees are not stored; hard deadline in ${Math.ceil((deadline - now) / 1000)}s`,
      );
      return;
    }
    const lost = this.unstored(machine.workerId);
    log.error(
      `HARD DEADLINE: destroying machine ${machine.id} (${reason}) although worktree(s) ${lost.join(", ") || "of its host"} were not stored`,
    );
    await this.destroyNow(
      machine,
      `${reason}; hard deadline passed with worktrees NOT stored: ${lost.join(", ")}`,
    );
  }

  private unstored(hostId: string): string[] {
    const out: string[] = [];
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if (wt.hostId === hostId) out.push(toWorktreeId(repo.name, wt.name, wt.hostId));
      }
    }
    return out;
  }

  private isSafeToDestroy(machine: RunnerMachineRow): boolean {
    return ephemeralLifecycleService.isStored(machine.workerId);
  }

  /** Records what a machine is waiting for, once per change. */
  private note(machine: RunnerMachineRow, text: string): void {
    if (machine.error === text) return;
    this.machines.update(machine.id, { error: text });
    const key = `${machine.id}:${text}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      log.info(`machine ${machine.id}: ${text}`);
    }
  }

  private async destroyNow(
    machine: RunnerMachineRow,
    reason: string,
    opts: { dropHost?: boolean } = {},
  ): Promise<void> {
    log.info(`destroying machine ${machine.id} of runner ${machine.runnerId}: ${reason}`);
    const task = this.runners.destroyMachine(machine.id, reason);
    this.pending.add(task);
    try {
      const done = await task;
      if (done.state === "destroyed" && opts.dropHost) this.dropUnusedHost(machine.workerId);
    } finally {
      this.pending.delete(task);
    }
  }

  /** A host whose worker never connected has nothing to keep. */
  private dropUnusedHost(hostId: string): void {
    try {
      tokenService.removeHost(hostId);
      hostRegistry.unregister(hostId);
    } catch (err) {
      log.warn(`could not remove host ${hostId}: ${errorText(err)}`);
    }
  }

  // ---- orphans ---------------------------------------------------------------

  /** Destroys machines a runner's `status` hook lists that no live record accounts for. */
  private async reapOrphans(): Promise<void> {
    const known = new Set(
      this.machines
        .listLive()
        .map((m) => m.handle)
        .filter((h): h is string => h !== null),
    );
    for (const runner of this.runnerConfigs()) {
      if (!runner.status || !runner.destroy) continue;
      // A live machine with no recorded handle (its spawn printed none) could be any listed
      // handle, so nothing can be called an orphan.
      if (this.machines.listLive().some((m) => m.runnerId === runner.id && m.handle === null)) {
        continue;
      }
      // A spawn in flight may have printed its handle before the hub recorded it.
      if (this.runners.hasAttemptInFlight(runner.id)) continue;
      let handles: string[] | null;
      try {
        handles = await this.runners.listHandles(runner);
      } catch (err) {
        log.warn(`status of runner ${runner.id} failed: ${errorText(err)}`);
        continue;
      }
      // Re-read after the hook ran: a spawn may have started while it listed.
      if (this.runners.hasAttemptInFlight(runner.id)) continue;
      const nowKnown = new Set([
        ...known,
        ...this.machines
          .listLive()
          .map((m) => m.handle)
          .filter((h): h is string => h !== null),
      ]);
      for (const handle of handles ?? []) {
        if (nowKnown.has(handle)) continue;
        const ok = await this.runners.destroyHandle(runner, handle, "no record of this machine");
        if (ok) {
          log.info(`destroyed orphan ${handle} of runner ${runner.id}`);
          // A machine whose destroy failed earlier is gone now.
          this.machines.settleHandle(runner.id, handle, "destroyed by the reaper as an orphan");
        } else {
          log.warn(`could not destroy orphan ${handle} of runner ${runner.id}`);
        }
      }
    }
  }

  private runnerConfigs(): RunnerConfig[] {
    return this.runners.configs();
  }
}

export const runnerReaperService = new RunnerReaperService();
