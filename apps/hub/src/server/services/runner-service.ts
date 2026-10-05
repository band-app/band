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
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Environment, parseEnvironment } from "@band-app/environment";
import { createLogger } from "@band-app/logger";
import type { HostRequestRow } from "../infra/db/queries/host-requests";
import { RunnerMachineQueries, type RunnerMachineRow } from "../infra/db/queries/runner-machines";
import { bandHome } from "../infra/db/queries/settings";
import { hostRegistry } from "../infra/host/registry";
import { ISOLATION_LABEL_KEY, requestedIsolation, runnerLevel } from "./_utils/isolation";
import { parseRunners, type RunnerConfig, resolveHookPath } from "./_utils/runner-config";
import { environmentBuildService } from "./environment-build-service";
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
    if (!/^hr-[A-Za-z0-9-]+$/.test(requestId)) return null;
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

  /** One spawn. Returns the id of the worker that said hello. */
  private async attempt(
    runner: RunnerConfig,
    row: HostRequestRow,
    run: RunnerRun,
    runLog: RunLog,
    state: AttemptState,
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
    try {
      const env = this.hookEnv(runner, row, issued.hostId, issued.token, await repoUrls(row));
      let hostProjectPath: string | undefined;
      const code = await this.runHook({
        runner,
        name: "spawn",
        path: resolveHookPath(runner.spawn, "spawn"),
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
      if (code !== 0) throw new Error(`spawn exited with code ${code}`);
      runLog.write("hub", "spawn finished; waiting for the worker's hello");
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
      try {
        placementService.fulfil(row.id, runner.id, issued.hostId, hostProjectPath);
      } catch (err) {
        if (err instanceof HostRequestError) throw new Aborted(err.message);
        throw err;
      }
      return issued.hostId;
    } finally {
      clearInterval(renew);
    }
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
    name: "spawn" | "destroy" | "status";
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
