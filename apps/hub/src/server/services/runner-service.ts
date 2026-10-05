/**
 * Runner service (plan step 3.4): fulfils `host_requests` by running the
 * configured runner hooks.
 *
 * Every second the service looks at the `runners` in `~/.band/settings.json`.
 * For each runner with a free slot (`maxConcurrent`) it leases the oldest
 * request the runner's labels fit. A lease is atomic, so two runners never get
 * the same request. For a leased request the service:
 *
 *   1. issues a worker bootstrap token (it creates the host row, whose id is
 *      the worker id),
 *   2. runs the runner's `spawn` script with the contract environment
 *      (`docs/runner-hooks.md`), keeping its output in a per-request log,
 *   3. waits for that worker to say hello while it renews the lease, and then
 *      fulfils the request, which makes the hub create the workspace on it.
 *
 * An attempt fails when `spawn` exits non-zero or the worker is not online
 * within `timeoutSec`. The service runs `destroy`, drops the host row, and
 * tries once more with a fresh token. After the second failure the request
 * fails with the tail of the hook's log.
 *
 * Every attempt also records its machine in `runner_machines` (plan step 3.7),
 * with the handle `spawn` prints as `BAND_MACHINE_HANDLE=<id>`. The reaper
 * (`runner-reaper-service.ts`) reads those rows, and asks this service to run
 * the `destroy` and `status` hooks.
 *
 * Hibernate (plan step 3.10). A runner with `snapshot` and `restore` hooks
 * takes a machine snapshot when the hub puts an ephemeral worker to sleep
 * (`snapshotHost`, called by `EphemeralLifecycleService` after it has stored
 * the git state and agent sessions, which stay the fallback). The machine is
 * the worker's `runner_machines` row, and its handle goes to the hook. A wake
 * request leased by the same runner runs `restore` with that snapshot instead
 * of `spawn`, and starts a fresh worker with `spawn` when `restore` fails.
 * Snapshots are kept per runner (`snapshotKeep`, `snapshotTtlSec`) and removed
 * through `snapshotDelete`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Environment, parseEnvironment } from "@band-app/environment";
import { createLogger } from "@band-app/logger";
import type { HostRequestRow } from "../infra/db/queries/host-requests";
import { RunnerMachineQueries, type RunnerMachineRow } from "../infra/db/queries/runner-machines";
import {
  RunnerSnapshotQueries,
  type RunnerSnapshotRow,
} from "../infra/db/queries/runner-snapshots";
import { bandHome } from "../infra/db/queries/settings";
import { hostRegistry } from "../infra/host/registry";
import { ISOLATION_LABEL_KEY, requestedIsolation, runnerLevel } from "./_utils/isolation";
import {
  type HookScript,
  parseRunners,
  type RunnerConfig,
  resolveHookPath,
} from "./_utils/runner-config";
import { environmentBuildService } from "./environment-build-service";
import { gitCredentialService } from "./git-credential-service";
import { HostRequestError, placementService, wakeOf } from "./placement-service";
import { settingsService } from "./settings-service";
import { loadState } from "./state";
import { tokenService } from "./token-service";

const log = createLogger("runner");

const POLL_MS = 1000;
const HELLO_POLL_MS = 200;
const LEASE_MS = 30_000;
const DESTROY_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 60_000;
/** Runs of a failing `destroy` hook before the machine counts as lost. */
const DESTROY_ATTEMPTS = 3;
const ATTEMPTS = 2;
const LOG_FILE_LIMIT = 512 * 1024;
const LOG_LINE_LIMIT = 2000;
const TAIL_LINES = 20;
const REASON_LIMIT = 1800;
const HISTORY_LIMIT = 50;
const SNAPSHOT_SWEEP_MS = 60_000;
const SNAPSHOT_DELETE_TIMEOUT_MS = 5 * 60_000;
/** A `snapshot-delete` that failed is tried again after this long. */
const SNAPSHOT_DELETE_RETRY_MS = 10 * 60_000;

/** How often retention runs, from `BAND_SNAPSHOT_SWEEP_MS`. Read on every tick. */
function snapshotSweepMs(): number {
  const raw = Number(process.env.BAND_SNAPSHOT_SWEEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SNAPSHOT_SWEEP_MS;
}

/** Matches any Band token, so a hook that echoes its environment still leaks nothing. */
const TOKEN_PATTERN = /\b(?:bwb|bws|bdt|brt)_[A-Za-z0-9_-]{6,}/g;

/** Environment names a hook receives from the hub's own environment. Nothing else is passed. */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "USER",
  "SHELL",
];

export interface RunnerRun {
  requestId: string;
  runnerId: string;
  workspaceId: string;
  status: "running" | "ready" | "failed" | "aborted";
  attempt: number;
  workerId: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface RunnerView {
  id: string;
  kind: "hook";
  spawn: string;
  destroy: string | null;
  status: string | null;
  /** Whether sleeping a workspace on this runner's workers snapshots the machine. */
  snapshots: boolean;
  maxLifetimeSec: number | null;
  lifetimeGraceSec: number;
  labels: Record<string, string>;
  isolation: string;
  maxConcurrent: number;
  timeoutSec: number;
  running: number;
}

/** A per-request log. Lines are scrubbed of tokens before they are stored. */
class RunLog {
  private readonly lines: string[] = [];
  private bytes = 0;
  private readonly secrets = new Set<string>();

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  addSecret(secret: string): void {
    if (secret) this.secrets.add(secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    return out.replace(TOKEN_PATTERN, "[redacted]");
  }

  write(source: string, text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      if (raw === "") continue;
      const line = this.scrub(raw).slice(0, LOG_LINE_LIMIT);
      const entry = `${new Date().toISOString()} [${source}] ${line}\n`;
      this.lines.push(`[${source}] ${line}`);
      if (this.lines.length > 500) this.lines.shift();
      this.bytes += entry.length;
      if (this.bytes > LOG_FILE_LIMIT) continue;
      try {
        appendFileSync(this.file, entry, { mode: 0o600 });
      } catch {
        // A log that cannot be written must not stop the run.
      }
    }
  }

  tail(): string {
    return this.lines.slice(-TAIL_LINES).join("\n");
  }
}

/** Splits a stream into lines for the log, whatever the chunk boundaries. */
function pipeLines(stream: NodeJS.ReadableStream | null, sink: (line: string) => void): () => void {
  let rest = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    rest += chunk;
    const parts = rest.split(/\r?\n|\r/);
    rest = parts.pop() ?? "";
    for (const part of parts) sink(part);
    if (rest.length > LOG_LINE_LIMIT) {
      sink(rest);
      rest = "";
    }
  });
  return () => {
    if (rest) sink(rest);
    rest = "";
  };
}

class Aborted extends Error {}

/** What an attempt has made so far, for the cleanup after it fails. */
interface AttemptState {
  hostId: string | null;
  token: string | null;
  reused?: boolean;
  machineId?: string;
}

/** The line a spawn hook prints to name the machine it made. */
const HANDLE_LINE = /^BAND_MACHINE_HANDLE=(\S{1,200})$/;

export interface RunnerServiceOptions {
  /** The loopback URL of this hub, when `BAND_RUNNER_HUB_URL` and `BAND_PUBLIC_URL` say nothing else. */
  hubUrl?: () => string | undefined;
  pollMs?: number;
}

export class RunnerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private hubUrl: string | undefined;
  private readonly running = new Map<string, RunnerRun>();
  private readonly history: RunnerRun[] = [];
  private readonly settled = new Set<Promise<void>>();
  private readonly machines = new RunnerMachineQueries();
  private readonly destroying = new Map<string, Promise<RunnerMachineRow>>();
  private readonly snapshots = new RunnerSnapshotQueries();
  /** Snapshots a restore is reading right now. Retention leaves them alone. */
  private readonly restoring = new Set<string>();
  private readonly deleteFailedAt = new Map<string, number>();
  private lastSweep = 0;
  private sweeping = false;

  constructor(private readonly options: RunnerServiceOptions = {}) {}

  /** The URL a hook on this machine reaches the hub at. Set once the server listens. */
  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once every run in flight has ended. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.settled.size > 0) await Promise.allSettled([...this.settled]);
  }

  // ---- views ---------------------------------------------------------------

  runners(): { runners: RunnerView[]; errors: string[] } {
    const { runners, errors } = parseRunners(settingsService.get().runners);
    return {
      runners: runners.map((r) => ({
        id: r.id,
        kind: r.kind,
        spawn: r.spawn,
        destroy: r.destroy ?? null,
        status: r.status ?? null,
        snapshots: r.snapshot !== undefined,
        maxLifetimeSec: r.maxLifetimeSec ?? null,
        lifetimeGraceSec: r.lifetimeGraceSec,
        labels: r.labels,
        isolation: r.isolation,
        maxConcurrent: r.maxConcurrent,
        timeoutSec: r.timeoutSec,
        running: this.runningCount(r.id),
      })),
      errors,
    };
  }

  runs(): RunnerRun[] {
    return [...this.running.values(), ...[...this.history].reverse()];
  }

  /** The log of a request's runs, or null when there is none. */
  readLog(requestId: string): string | null {
    // `hr-...` is a request, `h-...` a host whose machine was snapshotted or restored.
    if (!/^hr?-[A-Za-z0-9-]+$/.test(requestId)) return null;
    try {
      return readFileSync(this.logFile(requestId), "utf8");
    } catch {
      return null;
    }
  }

  private logFile(requestId: string): string {
    return join(bandHome(), "runners", "logs", `${requestId}.log`);
  }

  /** Every valid runner in settings. */
  configs(): RunnerConfig[] {
    return parseRunners(settingsService.get().runners).runners;
  }

  /** The configured runner with this id, or undefined (removed from settings, or invalid). */
  findRunner(runnerId: string): RunnerConfig | undefined {
    return this.configs().find((r) => r.id === runnerId);
  }

  /** Whether an attempt of this runner is between its token and its hello. Their machines are not the reaper's yet. */
  hasAttemptInFlight(runnerId: string): boolean {
    return this.runningCount(runnerId) > 0;
  }

  /** Whether the worker id belongs to an attempt in flight. */
  isAttempting(workerId: string): boolean {
    for (const run of this.running.values()) if (run.workerId === workerId) return true;
    return false;
  }

  private runningCount(runnerId: string): number {
    let n = 0;
    for (const run of this.running.values()) if (run.runnerId === runnerId) n++;
    return n;
  }

  // ---- leasing -------------------------------------------------------------

  /** Leases requests for every runner with a free slot and starts them. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { runners } = parseRunners(settingsService.get().runners);
      for (const runner of runners) {
        while (this.runningCount(runner.id) < runner.maxConcurrent) {
          const row = placementService.lease(
            runner.id,
            {
              labels: runner.labels,
              provides: runner.provides,
              isolation: runnerLevel(runner.isolation),
            },
            LEASE_MS,
          );
          if (!row) break;
          this.begin(runner, row);
        }
      }
      if (Date.now() - this.lastSweep >= snapshotSweepMs()) {
        this.lastSweep = Date.now();
        void this.sweepSnapshots();
      }
    } catch (err) {
      log.warn(`tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.ticking = false;
    }
  }

  private begin(runner: RunnerConfig, row: HostRequestRow): void {
    const run: RunnerRun = {
      requestId: row.id,
      runnerId: runner.id,
      workspaceId: row.workspaceId,
      status: "running",
      attempt: 0,
      workerId: null,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    this.running.set(row.id, run);
    const done = this.run(runner, row, run)
      .catch((err) =>
        log.error(`run of ${row.id} crashed: ${err instanceof Error ? err.stack : err}`),
      )
      .finally(() => {
        this.running.delete(row.id);
        run.endedAt = Date.now();
        this.history.push(run);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.settled.delete(done);
      });
    this.settled.add(done);
  }

  // ---- one request ---------------------------------------------------------

  private async run(runner: RunnerConfig, row: HostRequestRow, run: RunnerRun): Promise<void> {
    const runLog = new RunLog(this.logFile(row.id));
    runLog.write("hub", `runner ${runner.id} took request ${row.id} for ${row.workspaceId}`);
    const environment = parseRequestEnvironment(row);
    if (!environment.ok) {
      // No machine can satisfy a malformed environment, so do not start one.
      runLog.write("hub", environment.error);
      run.status = "failed";
      run.error = environment.error;
      try {
        placementService.fail(row.id, environment.error);
      } catch (err) {
        log.warn(`could not fail ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    let lastError = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      run.attempt = attempt;
      runLog.write("hub", `attempt ${attempt} of ${ATTEMPTS}`);
      const attemptState: AttemptState = { hostId: null, token: null };
      try {
        const hostId = await this.attempt(runner, row, run, runLog, attemptState);
        run.workerId = hostId;
        run.status = "ready";
        runLog.write("hub", `worker ${hostId} said hello; request fulfilled`);
        return;
      } catch (err) {
        if (err instanceof Aborted) {
          run.status = "aborted";
          run.error = err.message;
          runLog.write("hub", `stopped: ${err.message}`);
          await this.cleanup(runner, row, attemptState, runLog);
          return;
        }
        lastError = err instanceof Error ? err.message : String(err);
        runLog.write("hub", `attempt ${attempt} failed: ${lastError}`);
        await this.cleanup(runner, row, attemptState, runLog);
      }
    }
    const reason = this.failureReason(runner, lastError, runLog);
    run.status = "failed";
    run.error = lastError;
    try {
      placementService.fail(row.id, reason);
    } catch (err) {
      log.warn(`could not fail ${row.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private failureReason(runner: RunnerConfig, error: string, runLog: RunLog): string {
    const head = `Runner "${runner.id}" failed after ${ATTEMPTS} attempts: ${error}`;
    const tail = runLog.tail();
    const text = tail ? `${head}\nLast log lines:\n${tail}` : head;
    return text.length > REASON_LIMIT ? `...${text.slice(-REASON_LIMIT)}` : text;
  }

  /** Runs `destroy` for a failed attempt and drops the host it created. */
  private async cleanup(
    runner: RunnerConfig,
    row: HostRequestRow,
    state: AttemptState,
    runLog: RunLog,
  ): Promise<void> {
    if (!state.hostId) return;
    const machine = state.machineId ? this.machines.get(state.machineId) : undefined;
    if (runner.destroy) {
      try {
        const code = await this.runDestroy(
          runner,
          row,
          state.hostId,
          machine?.handle ?? null,
          runLog,
        );
        if (code !== 0) runLog.write("hub", `destroy exited with code ${code}`);
        if (machine) this.finishMachine(machine.id, code === 0, `destroy exited with code ${code}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runLog.write("hub", `destroy failed: ${message}`);
        if (machine) this.finishMachine(machine.id, false, `destroy failed: ${message}`);
      }
    } else if (machine) {
      this.finishMachine(machine.id, false, "the runner has no destroy hook");
    }
    // A host that was woken keeps its row: it still holds the sleeping workspaces.
    if (state.reused) return;
    try {
      tokenService.removeHost(state.hostId);
      hostRegistry.unregister(state.hostId);
    } catch (err) {
      runLog.write(
        "hub",
        `could not remove host ${state.hostId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private runDestroy(
    runner: RunnerConfig,
    row: HostRequestRow | null,
    workerId: string | null,
    handle: string | null,
    runLog: RunLog | null,
  ): Promise<number> {
    if (!runner.destroy) return Promise.reject(new Error("the runner has no destroy hook"));
    return this.runHook({
      runner,
      name: "destroy",
      path: resolveHookPath(runner.destroy, "destroy"),
      env: this.hookEnv(runner, row, workerId, null, [], handle),
      timeoutMs: DESTROY_TIMEOUT_MS,
      runLog,
    });
  }

  /** The end of a failed attempt's machine: destroyed when the hook succeeded, else lost. */
  private finishMachine(id: string, destroyed: boolean, note: string): void {
    this.machines.update(id, {
      state: destroyed ? "destroyed" : "lost",
      destroyedAt: destroyed ? Date.now() : null,
      error: destroyed ? "the attempt failed" : note,
    });
  }

  /**
   * One launch of a worker. Returns the id of the worker that said hello. A wake request that this
   * runner holds a snapshot for tries `restore` first, and starts a fresh worker with `spawn` when
   * that fails, so the git and session state the sleep stored is what brings the workspace back.
   */
  private async attempt(
    runner: RunnerConfig,
    row: HostRequestRow,
    run: RunnerRun,
    runLog: RunLog,
    state: AttemptState,
  ): Promise<string> {
    const wake = wakeOf(row);
    const snapshot = wake ? this.restorableSnapshot(runner, wake.hostId) : undefined;
    if (snapshot) {
      this.restoring.add(snapshot.id);
      try {
        return await this.launch(runner, row, run, runLog, state, "restore", snapshot);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        runLog.write(
          "hub",
          `restore of snapshot ${snapshot.snapshotId} failed: ${err instanceof Error ? err.message : err}; starting a fresh worker`,
        );
        this.snapshots.markUnrestored(snapshot.id);
        await this.cleanup(runner, row, state, runLog);
      } finally {
        this.restoring.delete(snapshot.id);
      }
    }
    return this.launch(runner, row, run, runLog, state, "spawn");
  }

  /** The snapshot a wake can restore from: this runner's, still alive, and the runner has a `restore` hook. */
  private restorableSnapshot(runner: RunnerConfig, hostId: string): RunnerSnapshotRow | undefined {
    if (!runner.restore) return undefined;
    const latest = this.snapshots.latestForHost(hostId);
    if (!latest || latest.runnerId !== runner.id || latest.expiresAt <= Date.now())
      return undefined;
    return latest;
  }

  private async launch(
    runner: RunnerConfig,
    row: HostRequestRow,
    run: RunnerRun,
    runLog: RunLog,
    state: AttemptState,
    kind: "spawn" | "restore",
    snapshot?: RunnerSnapshotRow,
  ): Promise<string> {
    const deadline = Date.now() + runner.timeoutSec * 1000;
    const labelList = Object.entries(row.labels).map(([k, v]) => `${k}=${v}`);
    // A worker started for a container or vm workspace serves that workspace only: placement skips hosts with this label.
    const wanted = requestedIsolation(row.environment as Record<string, unknown> | null);
    if (wanted !== "worktree") labelList.push(`${ISOLATION_LABEL_KEY}=${wanted}`);
    // A request to wake a sleeping ephemeral host starts a worker with that host's id.
    const wake = wakeOf(row);
    const ttl = runner.timeoutSec * 1000 + 60_000;
    const issued = wake
      ? tokenService.issueWorkerBootstrapFor(wake.hostId, ttl)
      : tokenService.issueWorkerBootstrap(`runner:${runner.id}`, labelList, ttl);
    state.hostId = issued.hostId;
    state.reused = wake !== null;
    state.token = issued.token;
    runLog.addSecret(issued.token);
    run.workerId = issued.hostId;
    runLog.write("hub", `issued worker ${issued.hostId}`);
    const machineId = this.recordMachine(runner, row, issued.hostId);
    state.machineId = machineId;

    const renew = setInterval(() => {
      try {
        placementService.renew(row.id, runner.id, LEASE_MS);
      } catch {
        // The wait loop below sees the lost lease and stops.
      }
    }, LEASE_MS / 3);
    renew.unref?.();
    let fulfilled = false;
    try {
      const repos = await repoUrls(row);
      const env = this.hookEnv(runner, row, issued.hostId, issued.token, repos);
      // A repository the vault holds a git credential for is cloned by the hub through the worker
      // once it says hello, because the hook has no credential. The hook skips its own clone.
      const hubClone =
        !snapshot && repos[0] && !repos[0].startsWith("/")
          ? (await gitCredentialService.hasCredentialFor(repos[0], row.project))
            ? repos[0]
            : null
          : null;
      if (hubClone) {
        env.BAND_CLONE_BY_HUB = "1";
        gitCredentialService.expectRemote(issued.hostId, hubClone, row.project);
        runLog.write("hub", "the hub will clone the repository with a vault git credential");
      }
      let hostProjectPath: string | undefined;
      if (snapshot) {
        env.BAND_SNAPSHOT_ID = snapshot.snapshotId;
        runLog.write("hub", `restoring snapshot ${snapshot.snapshotId} with the restore hook`);
        // A restore that fails must not leave an earlier mark behind.
        this.snapshots.markUnrestored(snapshot.id);
      }
      const code = await this.runHook({
        runner,
        name: kind,
        path: resolveHookPath(kind === "restore" ? (runner.restore as string) : runner.spawn, kind),
        env,
        timeoutMs: Math.max(deadline - Date.now(), 1),
        runLog,
        watch: () => this.assertHeld(row, runner),
        onStdout: (line) => {
          const m = /^BAND_HOST_PROJECT_PATH=(.+)$/.exec(line.trim());
          if (m) hostProjectPath = m[1];
          const h = HANDLE_LINE.exec(line.trim());
          if (h) this.machines.update(machineId, { handle: h[1] });
        },
      });
      if (code !== 0) throw new Error(`${kind} exited with code ${code}`);
      runLog.write("hub", `${kind} finished; waiting for the worker's hello`);
      const handle = this.machines.get(machineId)?.handle;
      if (handle) runLog.write("hub", `machine handle ${handle}`);
      while (!this.isOnline(issued.hostId)) {
        this.assertHeld(row, runner);
        if (Date.now() >= deadline) {
          throw new Error(`worker ${issued.hostId} did not say hello within ${runner.timeoutSec}s`);
        }
        await sleep(HELLO_POLL_MS);
      }
      this.machines.update(machineId, { state: "running", lastSeenAt: Date.now() });
      if (hubClone && hostProjectPath) {
        await this.cloneOnHost(issued.hostId, hubClone, hostProjectPath);
        runLog.write("hub", `cloned the repository to ${hostProjectPath}`);
      }
      // From here the machine's disk is the one the snapshot held, so the hub skips its git restore.
      if (snapshot) this.snapshots.markRestored(snapshot.id, Date.now());
      try {
        placementService.fulfil(row.id, runner.id, issued.hostId, hostProjectPath);
      } catch (err) {
        if (err instanceof HostRequestError) throw new Aborted(err.message);
        throw err;
      }
      fulfilled = true;
      return issued.hostId;
    } finally {
      clearInterval(renew);
      // A failed attempt removes its host, so its clone grant goes with it.
      if (!fulfilled) gitCredentialService.forget(issued.hostId);
    }
  }

  /**
   * Clones `url` into `dest` on the worker, with git on the worker asking the hub for the
   * credential. Does nothing when `dest` already exists.
   */
  private async cloneOnHost(hostId: string, url: string, dest: string): Promise<void> {
    const host = hostRegistry.hostById(hostId);
    const exists = await host.fs.stat(dest).then(
      () => true,
      () => false,
    );
    if (exists) return;
    await host.git.exec(["clone", "--quiet", "--", url, dest], dirname(dest));
  }

  /** Records the machine of an attempt. An older machine of the same worker id is gone by now, so it is retired. */
  private recordMachine(runner: RunnerConfig, row: HostRequestRow, workerId: string): string {
    const id = `rm-${randomBytes(6).toString("hex")}`;
    this.machines.insert({
      id,
      runnerId: runner.id,
      requestId: row.id,
      workerId,
      handle: null,
      state: "spawning",
      spawnedAt: Date.now(),
      lastSeenAt: null,
      stoppingSince: null,
      destroyedAt: null,
      destroyAttempts: 0,
      error: null,
    });
    // A worker that wakes up gets a new machine under the same id, and the hook wipes the old one
    // (docs/runner-hooks.md). Destroying the old record later would hit the new machine.
    for (const old of this.machines.liveForWorker(workerId, id)) {
      this.machines.update(old.id, {
        state: "destroyed",
        destroyedAt: Date.now(),
        error: `replaced by machine ${id}`,
      });
    }
    return id;
  }

  /** Stops the run when the request was cancelled or the lease went to someone else. */
  private assertHeld(row: HostRequestRow, runner: RunnerConfig): void {
    const current = placementService.get(row.id);
    if (!current || current.status !== "leased" || current.leasedBy !== runner.id) {
      throw new Aborted(`request ${row.id} is ${current?.status ?? "gone"}`);
    }
  }

  private isOnline(hostId: string): boolean {
    return tokenService.hostStatus(hostId) === "online";
  }

  // ---- machines (used by the reaper) ---------------------------------------

  /**
   * Runs the runner's `destroy` hook for a machine and records the result: `destroyed` when the
   * hook exits 0, `lost` when it fails or there is none. `reason` is stored on the row. Two calls
   * for one machine share one run.
   */
  destroyMachine(machineId: string, reason: string): Promise<RunnerMachineRow> {
    const inflight = this.destroying.get(machineId);
    if (inflight) return inflight;
    const run = this.doDestroyMachine(machineId, reason).finally(() =>
      this.destroying.delete(machineId),
    );
    this.destroying.set(machineId, run);
    return run;
  }

  private async doDestroyMachine(machineId: string, reason: string): Promise<RunnerMachineRow> {
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`No machine ${machineId}`);
    if (machine.state === "destroyed") return machine;
    const runner = this.findRunner(machine.runnerId);
    const request = machine.requestId ? placementService.get(machine.requestId) : undefined;
    const runLog = new RunLog(
      machine.requestId
        ? this.logFile(machine.requestId)
        : join(bandHome(), "runners", "logs", `${machine.id}.log`),
    );
    runLog.write(
      "hub",
      `destroying machine ${machine.id} of worker ${machine.workerId}: ${reason}`,
    );
    let outcome: Partial<RunnerMachineRow>;
    if (!runner) {
      outcome = {
        state: "lost",
        error: `runner "${machine.runnerId}" is no longer configured`,
      };
    } else if (!runner.destroy) {
      outcome = { state: "lost", error: `runner "${runner.id}" has no destroy hook` };
    } else {
      let failure: string | null = null;
      try {
        const code = await this.runDestroy(
          runner,
          request ?? null,
          machine.workerId,
          machine.handle,
          runLog,
        );
        if (code !== 0) failure = `destroy exited with code ${code}`;
      } catch (err) {
        failure = `destroy failed: ${err instanceof Error ? err.message : err}`;
      }
      if (failure === null) {
        outcome = { state: "destroyed", destroyedAt: Date.now(), error: reason };
      } else {
        // A hook can fail for a moment (a worker still shutting down). The reaper's next sweep
        // runs it again, and after the third failure the machine counts as lost.
        const attempts = machine.destroyAttempts + 1;
        outcome =
          attempts >= DESTROY_ATTEMPTS
            ? { state: "lost", destroyAttempts: attempts, error: failure }
            : {
                destroyAttempts: attempts,
                error: `${failure} (try ${attempts} of ${DESTROY_ATTEMPTS})`,
              };
      }
    }
    runLog.write(
      "hub",
      `machine ${machine.id} is ${outcome.state ?? machine.state}${outcome.error ? `: ${outcome.error}` : ""}`,
    );
    this.machines.update(machine.id, outcome);
    return this.machines.get(machine.id) ?? machine;
  }

  /** Runs `destroy` for a machine the hub has no record of, named only by the handle `status` printed. */
  async destroyHandle(runner: RunnerConfig, handle: string, reason: string): Promise<boolean> {
    if (!runner.destroy) return false;
    const file = join(bandHome(), "runners", "logs", "reaper.log");
    try {
      if (statSync(file).size > LOG_FILE_LIMIT) rmSync(file, { force: true });
    } catch {
      // No log yet.
    }
    const runLog = new RunLog(file);
    runLog.write("hub", `destroying machine ${handle} of runner ${runner.id}: ${reason}`);
    try {
      const code = await this.runDestroy(runner, null, null, handle, runLog);
      runLog.write("hub", `destroy of ${handle} exited with code ${code}`);
      return code === 0;
    } catch (err) {
      runLog.write(
        "hub",
        `destroy of ${handle} failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /** The handles the runner's `status` hook lists, or null when it has no such hook. Throws when the hook fails. */
  async listHandles(runner: RunnerConfig): Promise<string[] | null> {
    if (!runner.status) return null;
    const handles: string[] = [];
    const errors: string[] = [];
    const code = await this.runHook({
      runner,
      name: "status",
      path: resolveHookPath(runner.status, "status"),
      env: this.hookEnv(runner, null, null, null),
      timeoutMs: STATUS_TIMEOUT_MS,
      runLog: null,
      onStdout: (line) => {
        // A line is a handle, or `BAND_MACHINE_HANDLE=<id> key=value ...` like the VM hooks print.
        const handle = line
          .trim()
          .split(/\s+/)[0]
          ?.replace(/^BAND_MACHINE_HANDLE=/, "");
        if (handle && handle.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/.test(handle)) {
          handles.push(handle);
        }
      },
      onStderr: (line) => {
        if (errors.length < 5) errors.push(line.slice(0, 300));
      },
    });
    if (code !== 0) {
      throw new Error(
        `status exited with code ${code}${errors.length ? `: ${errors.join("; ")}` : ""}`,
      );
    }
    return [...new Set(handles)];
  }

  // ---- hibernate (plan step 3.10) --------------------------------------------

  /** The machine a host's worker runs on, while it lives. */
  private machineOfHost(hostId: string): RunnerMachineRow | undefined {
    return this.machines.latestLiveForWorker(hostId);
  }

  private hostLog(hostId: string): RunLog {
    return new RunLog(this.logFile(hostId));
  }

  /** Whether the runner behind this host can snapshot its machine. */
  supportsSnapshot(hostId: string): boolean {
    const machine = this.machineOfHost(hostId);
    return machine !== undefined && this.findRunner(machine.runnerId)?.snapshot !== undefined;
  }

  /**
   * Snapshots the machine of a host whose workspaces were just stored. Returns false when the
   * runner has no snapshot hook. Throws when the hook fails, which the caller treats as "no
   * snapshot": the git and session state is what restores the workspaces then. Snapshots this
   * host took earlier are deleted, since the new one holds the same disk later.
   */
  async snapshotHost(hostId: string, workspaceIds: string[]): Promise<boolean> {
    const machine = this.machineOfHost(hostId);
    const runner = machine ? this.findRunner(machine.runnerId) : undefined;
    if (!machine || !runner?.snapshot) return false;
    const runLog = this.hostLog(hostId);
    let snapshotId = "";
    let sizeBytes: number | null = null;
    runLog.write("hub", `snapshotting machine ${machine.id} of ${hostId}`);
    const env = this.hookEnv(runner, null, hostId, null, [], machine.handle);
    env.BAND_WORKSPACE_IDS = workspaceIds.join(",");
    const code = await this.runHook({
      runner,
      name: "snapshot",
      path: resolveHookPath(runner.snapshot, "snapshot"),
      env,
      timeoutMs: runner.snapshotTimeoutSec * 1000,
      runLog,
      onStdout: (line) => {
        const id = /^BAND_SNAPSHOT_ID=(\S+)$/.exec(line.trim());
        if (id) snapshotId = id[1] ?? "";
        const size = /^BAND_SNAPSHOT_SIZE=(\d+)$/.exec(line.trim());
        if (size) sizeBytes = Number(size[1]);
      },
    });
    if (code !== 0) throw new Error(`snapshot hook exited with code ${code}`);
    if (!snapshotId) throw new Error("snapshot hook printed no BAND_SNAPSHOT_ID");
    const now = Date.now();
    const previous = this.snapshots.listByHost(hostId);
    this.snapshots.insert({
      id: `sn-${randomBytes(6).toString("hex")}`,
      runnerId: runner.id,
      hostId,
      machineId: machine.id,
      workspaceIds,
      snapshotId,
      sizeBytes,
      restoredAt: null,
      createdAt: now,
      expiresAt: now + runner.snapshotTtlSec * 1000,
    });
    runLog.write("hub", `snapshot ${snapshotId} of ${hostId} recorded`);
    for (const old of previous) await this.deleteSnapshot(old);
    void this.sweepSnapshots();
    return true;
  }

  /**
   * Destroys the machine of a host whose worker has exited after a snapshot took its place, so it
   * does not wait for the reaper's offline threshold.
   */
  async destroyAfterSleep(hostId: string): Promise<void> {
    const machine = this.machineOfHost(hostId);
    if (!machine) return;
    await this.destroyMachine(machine.id, "its worker went to sleep and a snapshot holds its disk");
  }

  /** The newest snapshot of a host, when a restore brought its machine back from it. */
  restoredSnapshot(hostId: string): RunnerSnapshotRow | undefined {
    const latest = this.snapshots.latestForHost(hostId);
    return latest?.restoredAt != null ? latest : undefined;
  }

  /** Deletes every snapshot of a host: a restore used them up, or the worker that was to sleep stayed. */
  async dropHostSnapshots(hostId: string): Promise<void> {
    for (const row of this.snapshots.listByHost(hostId)) await this.deleteSnapshot(row);
  }

  /** Every snapshot the hub holds, newest first. */
  snapshotList(): RunnerSnapshotRow[] {
    return this.snapshots.listAll();
  }

  /**
   * Retention. Per runner the newest `snapshotKeep` snapshots stay, as long as they have not
   * expired. The rest go through the runner's `snapshotDelete` hook. A snapshot a restore is reading
   * is left alone. A workspace whose snapshot is gone still wakes from its stored git state.
   */
  async sweepSnapshots(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const runners = this.configs();
      const now = Date.now();
      const doomed = new Map<string, RunnerSnapshotRow>();
      for (const row of this.snapshots.listExpired(now)) doomed.set(row.id, row);
      for (const runnerId of new Set(this.snapshots.listAll().map((r) => r.runnerId))) {
        const keep = runners.find((r) => r.id === runnerId)?.snapshotKeep ?? 0;
        // A runner that is not configured any more cannot delete anything, so its rows go with a warning.
        const rows = this.snapshots.listByRunner(runnerId).filter((r) => !doomed.has(r.id));
        for (const row of rows.slice(keep)) doomed.set(row.id, row);
      }
      for (const row of doomed.values()) {
        if (this.restoring.has(row.id)) continue;
        const failedAt = this.deleteFailedAt.get(row.id);
        if (failedAt !== undefined && now - failedAt < SNAPSHOT_DELETE_RETRY_MS) continue;
        await this.deleteSnapshot(row);
      }
    } catch (err) {
      log.warn(`snapshot retention failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Runs `snapshotDelete` for a snapshot and forgets it. A failing hook keeps the row for a later sweep. */
  private async deleteSnapshot(row: RunnerSnapshotRow): Promise<void> {
    const runner = this.findRunner(row.runnerId);
    const runLog = this.hostLog(row.hostId);
    if (!runner?.snapshotDelete) {
      log.warn(
        `snapshot ${row.snapshotId} of runner ${row.runnerId} cannot be deleted: ${runner ? "the runner has no snapshotDelete hook" : "the runner is not configured"}. Remove it by hand.`,
      );
      this.snapshots.delete(row.id);
      return;
    }
    try {
      const machine = row.machineId ? this.machines.get(row.machineId) : undefined;
      const env = this.hookEnv(runner, null, row.hostId, null, [], machine?.handle ?? null);
      env.BAND_SNAPSHOT_ID = row.snapshotId;
      const code = await this.runHook({
        runner,
        name: "snapshot-delete",
        path: resolveHookPath(runner.snapshotDelete, "snapshot-delete"),
        env,
        timeoutMs: SNAPSHOT_DELETE_TIMEOUT_MS,
        runLog,
      });
      if (code !== 0) throw new Error(`exited with code ${code}`);
      runLog.write("hub", `deleted snapshot ${row.snapshotId}`);
      this.snapshots.delete(row.id);
      this.deleteFailedAt.delete(row.id);
    } catch (err) {
      this.deleteFailedAt.set(row.id, Date.now());
      const message = err instanceof Error ? err.message : String(err);
      runLog.write("hub", `snapshot-delete of ${row.snapshotId} failed: ${message}`);
      log.warn(`snapshot-delete of ${row.snapshotId} failed: ${message}`);
    }
  }

  // ---- hooks ---------------------------------------------------------------

  /**
   * The contract environment (`docs/runner-hooks.md`). `row` and `workerId` are null for the
   * `status` hook and for the `destroy` of a machine the hub has no record of.
   */
  private hookEnv(
    runner: RunnerConfig,
    row: HostRequestRow | null,
    workerId: string | null,
    token: string | null,
    repos: string[] = [],
    handle: string | null = null,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PASSTHROUGH_ENV) {
      const v = process.env[name];
      if (v !== undefined) env[name] = v;
    }
    Object.assign(env, runner.env);
    const environment = row ? environmentOf(row) : null;
    Object.assign(env, {
      BAND_HUB_URL: this.hubUrlFor(runner),
      BAND_REPO_URLS: repos.join(","),
      BAND_ENVIRONMENT: JSON.stringify(environment ?? {}),
      BAND_ISOLATION: environment?.isolation ?? runnerLevel(runner.isolation),
      BAND_LABELS: Object.entries(row?.labels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
      BAND_REQUIRES: JSON.stringify(row?.requires ?? {}),
      BAND_PROJECT: row?.project ?? "",
      // The project's current environment image (plan step 3.2), empty before its first ready build.
      BAND_PROJECT_IMAGE: row ? this.projectImage(row.project) : "",
      BAND_RUNNER_ID: runner.id,
      BAND_RUNNER_DIR: join(bandHome(), "runners", runner.id),
      BAND_NODE: process.execPath,
    });
    if (workerId) env.BAND_WORKER_ID = workerId;
    if (row) env.BAND_REQUEST_ID = row.id;
    if (handle) env.BAND_MACHINE_HANDLE = handle;
    if (token) env.BAND_BOOTSTRAP_TOKEN = token;
    return env;
  }

  private projectImage(project: string): string {
    try {
      return environmentBuildService.currentImage(project) ?? "";
    } catch {
      return "";
    }
  }

  private hubUrlFor(runner: RunnerConfig): string {
    return (
      runner.env.BAND_HUB_URL ||
      process.env.BAND_RUNNER_HUB_URL?.trim() ||
      process.env.BAND_PUBLIC_URL?.trim() ||
      this.hubUrl ||
      this.options.hubUrl?.() ||
      `http://127.0.0.1:${process.env.BAND_PORT ?? "3456"}`
    );
  }

  /**
   * Runs a hook script and resolves with its exit code. The script is killed
   * after `timeoutMs`. Its output goes to `runLog` line by line.
   */
  private runHook(opts: {
    runner: RunnerConfig;
    name: HookScript;
    path: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    runLog: RunLog | null;
    watch?: () => void;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  }): Promise<number> {
    const { runner, name, path, env, timeoutMs, runLog, watch, onStdout, onStderr } = opts;
    const cwd = join(bandHome(), "runners", runner.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return new Promise<number>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(path, [], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const flushOut = pipeLines(child.stdout, (line) => {
        runLog?.write(`${name} stdout`, line);
        onStdout?.(line);
      });
      const flushErr = pipeLines(child.stderr, (line) => {
        runLog?.write(`${name} stderr`, line);
        onStderr?.(line);
      });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        clearInterval(watcher);
        flushOut();
        flushErr();
        // A daemonized child may keep the pipes open; the hook is done.
        child.stdout?.destroy();
        child.stderr?.destroy();
        fn();
      };
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)}s`)),
        );
      }, timeoutMs);
      const watcher = setInterval(() => {
        try {
          watch?.();
        } catch (err) {
          child.kill("SIGKILL");
          finish(() => reject(err));
        }
      }, HELLO_POLL_MS);
      child.on("error", (err) =>
        finish(() => reject(new Error(`could not run ${name} hook ${path}: ${err.message}`))),
      );
      child.on("exit", (code, signal) => {
        // Give the last output a moment to arrive before the pipes are closed.
        setTimeout(() => finish(() => resolve(code ?? (signal ? 128 : 1))), 50);
      });
    });
  }
}

/** Checks `placement.environment` with the `.band/environment.json` parser. A request without one is fine. */
function parseRequestEnvironment(
  row: HostRequestRow,
): { ok: true; environment: Environment | null } | { ok: false; error: string } {
  if (!row.environment) return { ok: true, environment: null };
  const parsed = parseEnvironment(JSON.stringify(row.environment));
  if (parsed.ok) return { ok: true, environment: parsed.environment };
  const problems = parsed.issues
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join("; ");
  return { ok: false, error: `Invalid placement environment: ${problems}` };
}

/** The parsed environment of a request, `null` when it has none or it is invalid (`run` has failed those). */
function environmentOf(row: HostRequestRow): Environment | null {
  const parsed = parseRequestEnvironment(row);
  return parsed.ok ? parsed.environment : null;
}

/**
 * Where a hook can clone the request's repository from: the origin URL without
 * credentials, or the local path when the project has no origin (only a hook
 * on this machine can use that).
 */
async function repoUrls(row: HostRequestRow): Promise<string[]> {
  const project = loadState().projects.find((p) => p.name === row.project);
  if (!project?.path) return [];
  try {
    const { stdout } = await hostRegistry.local.git.exec(
      ["remote", "get-url", "origin"],
      project.path,
    );
    const url = stdout.trim();
    if (url) return [url.replace(/\/\/[^/@]*@/, "//")];
  } catch {
    // No origin remote.
  }
  return [project.path];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const runnerService = new RunnerService();
