/**
 * Updates the hub itself on an admin's click. The admin sets `hubUpdate.command` (for example
 * `systemctl --user start --no-block band-hub-update.service`) and the hub runs it with `sh -c` on
 * its own machine, in its own session, with the output going to `<BAND_HOME>/hub-update.log`.
 * The command is not built from request input. The hub does not install anything itself: the
 * command does, and usually restarts the hub, so the child must outlive this process.
 *
 * The state of a run is kept in `<BAND_HOME>/hub-update.json` because the restart ends this
 * process. After the restart the status is derived: running the target version means it worked,
 * a restart on another version or no restart within the timeout means it failed.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@band-app/logger";
import { compareVersions, parseInstallMethod } from "@band-app/shared/versions";
import { backupDatabase } from "../infra/db/connection";
import { bandHome } from "../infra/db/queries/settings";
import { SUPERVISOR_SOURCE } from "./_utils/hub-update-supervisor";
import { HUB_VERSION } from "./_utils/hub-version";
import { agentSessionService } from "./agent-session-service";
import { releaseCheckService } from "./release-check-service";
import { settingsService } from "./settings-service";
import { taskService } from "./task-service";

const log = createLogger("hub-update");

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_LINES = 20;
/** Where this process started. A run that began before it and did not reach the target has failed. */
const BOOT_AT = Date.now();

export class HubUpdateError extends Error {
  constructor(
    readonly reason: "not-configured" | "up-to-date" | "busy" | "interruptions",
    message: string,
  ) {
    super(message);
  }
}

interface RunFile {
  target: string;
  startedAt: number;
  /** The version the run started from (built-in runs). */
  from?: string;
  /** True when the supervisor, not an admin's command, carries the run. */
  builtIn?: boolean;
  backup?: string;
  /** Set when the command could not start or exited non-zero, or the supervisor gave up. */
  failure?: string;
}

/** The outcome of the last built-in run, written by the supervisor. */
export interface HubUpdateLastRun {
  from: string;
  to: string;
  at: number;
  result: "ok" | "failed" | "rolled-back";
  backup: string | null;
  message: string;
}

export interface HubUpdateStatus {
  /** Whether an update can run: an admin's command is set, or the built-in updater works here. */
  configured: boolean;
  /** An admin's command is set. It wins over the built-in updater. */
  hasCommand: boolean;
  /** The hub can install and restart itself (npm install under systemd or launchd). */
  builtIn: boolean;
  /** Why the built-in updater cannot run here, or null. */
  builtInBlockedReason: string | null;
  /** `hubUpdate.auto` is on. */
  auto: boolean;
  /** When the automatic update started waiting for running turns, or null. */
  deferredSince: number | null;
  lastRun: HubUpdateLastRun | null;
  /** The last lines of the update log. Admin detail, so the router cuts it for others. */
  logTail: string;
  state: "idle" | "updating" | "failed";
  target: string | null;
  /** Why it failed, with the last lines of the log. Admin detail, so the router cuts it for others. */
  error: string | null;
}

type ServiceManager = "systemd" | "launchd";

const DEFAULT_MAX_TASK_AGE_MIN = 180;
const DEFAULT_MAX_DEFER_H = 6;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_AUTO_POLL_MS = 60_000;
const DEFAULT_KEEP_BACKUPS = 5;

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `<prefix>/lib/node_modules/@band-app/server/...` gives `<prefix>`; null for a checkout or the desktop bundle. */
export function hubInstallPrefix(
  file: string = fileURLToPath(import.meta.url),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") return null;
  const marker = `${sep}lib${sep}node_modules${sep}@band-app${sep}server${sep}`;
  const at = file.lastIndexOf(marker);
  return at > 0 ? file.slice(0, at) : null;
}

function serviceManager(): ServiceManager | null {
  const forced = process.env.BAND_HUB_SERVICE_MANAGER;
  if (forced === "systemd" || forced === "launchd") return forced;
  if (process.env.INVOCATION_ID) return "systemd";
  const label = process.env.BAND_HUB_LAUNCHD_LABEL ?? "app.band.hub";
  if (process.env.XPC_SERVICE_NAME === label) return "launchd";
  return null;
}

export class HubUpdateService {
  private runPath(): string {
    return join(bandHome(), "hub-update.json");
  }

  private logPath(): string {
    return join(bandHome(), "hub-update.log");
  }

  private read(): RunFile | null {
    try {
      const v = JSON.parse(readFileSync(this.runPath(), "utf8")) as Partial<RunFile>;
      return typeof v.target === "string" && typeof v.startedAt === "number"
        ? (v as RunFile)
        : null;
    } catch {
      return null;
    }
  }

  private write(run: RunFile): void {
    writeFileSync(this.runPath(), JSON.stringify(run), { mode: 0o600 });
  }

  private command(): string | null {
    const raw = (settingsService.get() as { hubUpdate?: { command?: string } }).hubUpdate?.command;
    const cmd = raw?.trim();
    return cmd ? cmd : null;
  }

  private auto(): boolean {
    return (settingsService.get() as { hubUpdate?: { auto?: boolean } }).hubUpdate?.auto === true;
  }

  /** How many backups to keep after a successful update (`hubUpdate.keepBackups`, default 5). */
  private keepBackups(): number {
    const n = (settingsService.get() as { hubUpdate?: { keepBackups?: number } }).hubUpdate
      ?.keepBackups;
    return typeof n === "number" && n >= 1 ? Math.floor(n) : DEFAULT_KEEP_BACKUPS;
  }

  private prefix(): string | null {
    // `BAND_HUB_INSTALL_PREFIX` lets a hub that runs from another layout (and the tests) name its npm prefix.
    return process.env.BAND_HUB_INSTALL_PREFIX?.trim() || hubInstallPrefix();
  }

  /** Why the built-in updater cannot run on this hub, or null when it can. */
  builtInBlockedReason(): string | null {
    const method = parseInstallMethod(process.env.BAND_INSTALL_METHOD);
    if (method !== "npm") {
      return method
        ? `the built-in updater handles npm installs, not ${method}`
        : "BAND_INSTALL_METHOD is not set to npm";
    }
    if (!serviceManager()) return "the hub does not run under systemd or launchd";
    if (!this.prefix()) return "the hub does not run from an npm global install";
    return null;
  }

  private lastPath(): string {
    return join(bandHome(), "hub-update-last.json");
  }

  private deferredPath(): string {
    return join(bandHome(), "hub-update-deferred.json");
  }

  private readLast(): HubUpdateLastRun | null {
    try {
      const v = JSON.parse(readFileSync(this.lastPath(), "utf8")) as HubUpdateLastRun;
      return typeof v.result === "string" && typeof v.to === "string" ? v : null;
    } catch {
      return null;
    }
  }

  private readDeferred(): number | null {
    try {
      const v = JSON.parse(readFileSync(this.deferredPath(), "utf8")) as { since?: number };
      return typeof v.since === "number" ? v.since : null;
    } catch {
      return null;
    }
  }

  private base(): Omit<HubUpdateStatus, "state" | "target" | "error"> {
    const hasCommand = this.command() !== null;
    const blocked = this.builtInBlockedReason();
    return {
      configured: hasCommand || blocked === null,
      hasCommand,
      builtIn: blocked === null,
      builtInBlockedReason: blocked,
      auto: this.auto(),
      deferredSince: this.readDeferred(),
      lastRun: this.readLast(),
      logTail: this.logTail(),
    };
  }

  private logTail(): string {
    try {
      const lines = readFileSync(this.logPath(), "utf8").trimEnd().split("\n");
      return lines.slice(-LOG_TAIL_LINES).join("\n");
    } catch {
      return "";
    }
  }

  private failed(run: RunFile, message: string): HubUpdateStatus {
    const tail = this.logTail();
    return {
      ...this.base(),
      state: "failed",
      target: run.target,
      error: tail ? `${message}\n${tail}` : message,
    };
  }

  /** Where the run stands. Reads the state file, so it also answers after the hub restarted. */
  status(): HubUpdateStatus {
    const run = this.read();
    if (!run) return { ...this.base(), state: "idle", target: null, error: null };
    if ((compareVersions(HUB_VERSION, run.target) ?? -1) >= 0) {
      rmSync(this.runPath(), { force: true });
      return { ...this.base(), state: "idle", target: null, error: null };
    }
    if (run.failure) return this.failed(run, run.failure);
    if (!run.builtIn && BOOT_AT > run.startedAt) {
      return this.failed(run, `The hub restarted on ${HUB_VERSION}, not ${run.target}.`);
    }
    // A built-in run has its own health timeout and rollback, so allow it that and two minutes more.
    const wait = run.builtIn
      ? envNumber("BAND_HUB_UPDATE_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS) * 3 + 120_000
      : envNumber("BAND_HUB_UPDATE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    if (Date.now() - run.startedAt > wait) {
      return this.failed(run, `The hub did not come back on ${run.target} in time.`);
    }
    return { ...this.base(), state: "updating", target: run.target, error: null };
  }

  /**
   * The agents a hub restart ends, on every worker. A hub restart stops every agent it runs,
   * including those a worker's agent daemon holds, because only the hub has their ACP state.
   */
  interruptions(): { chatId: string; worktreeId: string; busy: boolean }[] {
    return agentSessionService.liveAgents({ includeHeld: true });
  }

  /** Starts the configured command detached and returns at once. */
  start(confirmInterruptions = false): { target: string } {
    const command = this.command();
    if (!command && this.builtInBlockedReason() !== null) {
      throw new HubUpdateError(
        "not-configured",
        `No hub update command is set, and the built-in updater cannot run here: ${this.builtInBlockedReason()}`,
      );
    }
    const target = releaseCheckService.status().latest;
    if (!target || (compareVersions(HUB_VERSION, target) ?? 0) >= 0) {
      throw new HubUpdateError("up-to-date", "The hub is already up to date");
    }
    if (this.status().state === "updating") {
      throw new HubUpdateError("busy", "A hub update is already running");
    }
    const running = this.interruptions().filter((a) => a.busy);
    if (running.length > 0 && !confirmInterruptions) {
      throw new HubUpdateError(
        "interruptions",
        `The update would end ${running.length} running agent turn${running.length === 1 ? "" : "s"}: ${running.map((a) => a.worktreeId).join(", ")}. Confirm to update anyway.`,
      );
    }
    mkdirSync(bandHome(), { recursive: true });
    if (!command) return this.startBuiltIn(target);
    const run: RunFile = { target, startedAt: Date.now() };
    this.write(run);
    const fd = openSync(this.logPath(), "w", 0o600);
    try {
      writeFileSync(fd, `$ ${command}\n`);
      // A minimal environment, like a runner hook: the hub's own env holds its admin token.
      // The session bus variables let `systemctl --user` reach the user's manager.
      const env: Record<string, string> = { BAND_HUB_TARGET_VERSION: target };
      for (const key of [
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "USER",
        "SHELL",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        const v = process.env[key];
        if (v !== undefined) env[key] = v;
      }
      const child = spawn("sh", ["-c", command], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: env as NodeJS.ProcessEnv,
      });
      child.on("error", (err) => {
        this.write({ ...run, failure: `The command could not start: ${err.message}` });
      });
      child.on("exit", (code, signal) => {
        if (code === 0) return;
        this.write({
          ...run,
          failure: `The command ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}.`,
        });
      });
      child.unref();
      log.info(`hub update to ${target} started`);
    } finally {
      closeSync(fd);
    }
    return { target };
  }

  /**
   * Backs up the database, writes the plan and starts the supervisor, which installs, restarts,
   * checks health and rolls back. Returns once the supervisor is running.
   */
  private startBuiltIn(target: string): { target: string } {
    const prefix = this.prefix();
    const manager = serviceManager();
    if (!prefix || !manager)
      throw new HubUpdateError("not-configured", "The built-in updater cannot run here");
    const home = bandHome();
    const startedAt = Date.now();
    const backupsDir = join(home, "backups");
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
    const backup = join(backupsDir, `${HUB_VERSION}-${stamp}.db`);
    backupDatabase(backup);
    if (!existsSync(backup)) throw new Error(`The database backup was not written to ${backup}`);
    chmodSync(backup, 0o600);

    const dir = join(home, "hub-update");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const scriptPath = join(dir, "supervisor.mjs");
    writeFileSync(scriptPath, SUPERVISOR_SOURCE, { mode: 0o600 });

    // npm runs beside the hub's own node, with node's directory first on PATH so its shebang finds it.
    const nodeDir = dirname(process.execPath);
    const env: Record<string, string> = {
      PATH: process.env.PATH ? `${nodeDir}:${process.env.PATH}` : nodeDir,
    };
    for (const key of [
      "HOME",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "USER",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ]) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    const port = process.env.BAND_PORT ?? process.env.PORT ?? "3456";
    const plan = {
      from: HUB_VERSION,
      to: target,
      startedAt,
      prefix,
      manager,
      npm: process.env.BAND_NPM_BIN ?? join(nodeDir, "npm"),
      systemctl: process.env.BAND_SYSTEMCTL_BIN ?? "systemctl",
      launchctl: process.env.BAND_LAUNCHCTL_BIN ?? "launchctl",
      unit: process.env.BAND_HUB_SYSTEMD_UNIT ?? "band-hub",
      label: process.env.BAND_HUB_LAUNCHD_LABEL ?? "app.band.hub",
      plist:
        process.env.BAND_HUB_LAUNCHD_PLIST ??
        join(
          process.env.HOME ?? "",
          "Library",
          "LaunchAgents",
          `${process.env.BAND_HUB_LAUNCHD_LABEL ?? "app.band.hub"}.plist`,
        ),
      backupsDir,
      keepBackups: this.keepBackups(),
      uid: process.getuid?.() ?? 0,
      healthUrl: process.env.BAND_HUB_UPDATE_HEALTH_URL ?? `http://127.0.0.1:${port}/api/health`,
      timeoutMs: envNumber("BAND_HUB_UPDATE_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS),
      pollMs: envNumber("BAND_HUB_UPDATE_HEALTH_POLL_MS", 2000),
      backup,
      dbFile: join(home, "band.db"),
      runFile: this.runPath(),
      lastFile: this.lastPath(),
      logFile: this.logPath(),
      env,
    };
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
    this.write({ target, startedAt, from: HUB_VERSION, builtIn: true, backup });
    const fd = openSync(this.logPath(), "w", 0o600);
    try {
      writeFileSync(fd, `built-in update ${HUB_VERSION} -> ${target}, backup ${backup}\n`);
    } finally {
      closeSync(fd);
    }
    // A systemd restart kills the unit's whole cgroup, so under systemd the supervisor runs in its
    // own scope. `BAND_SYSTEMD_RUN_BIN` names the binary (tests leave it unset and use a plain child).
    const useScope =
      manager === "systemd" && (process.env.INVOCATION_ID || process.env.BAND_SYSTEMD_RUN_BIN);
    const cmd = useScope ? (process.env.BAND_SYSTEMD_RUN_BIN ?? "systemd-run") : process.execPath;
    const args = useScope
      ? ["--user", "--scope", "--quiet", "--", process.execPath, scriptPath, planPath]
      : [scriptPath, planPath];
    // The token goes in this child's environment only, never in a file or the log.
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        BAND_HUB_UPDATE_TOKEN: settingsService.get().tokenSecret ?? "",
      } as NodeJS.ProcessEnv,
    });
    child.on("error", (err) => {
      this.write({
        target,
        startedAt,
        from: HUB_VERSION,
        builtIn: true,
        backup,
        failure: `The updater could not start: ${err.message}`,
      });
    });
    child.unref();
    log.info(`built-in hub update to ${target} started, backup at ${backup}`);
    return { target };
  }

  /** Starts the poll that runs the automatic update when `hubUpdate.auto` is on. */
  startAuto(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.autoTick(),
      envNumber("BAND_HUB_UPDATE_AUTO_POLL_MS", DEFAULT_AUTO_POLL_MS),
    );
    this.timer.unref();
  }

  stopAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private timer: NodeJS.Timeout | null = null;

  /**
   * One pass of the automatic update. With turns running it waits, starting a clock on the first
   * deferral, and goes ahead once none run or the clock passes the limit. A target that already
   * failed is not retried by itself.
   */
  autoTick(): void {
    try {
      if (!this.auto()) {
        rmSync(this.deferredPath(), { force: true });
        return;
      }
      const st = this.status();
      const target = releaseCheckService.status().latest;
      if (st.state !== "idle" || !target || (compareVersions(HUB_VERSION, target) ?? 0) >= 0) {
        return;
      }
      if (!st.configured) return;
      const last = st.lastRun;
      if (last && last.to === target && last.result !== "ok") return;
      const maxAgeMs =
        envNumber("BAND_HUB_UPDATE_MAX_TASK_AGE_MIN", DEFAULT_MAX_TASK_AGE_MIN) * 60_000;
      const running = taskService
        .listTaskRecords({ status: "running" })
        .filter((t) => Date.now() - t.startedAt < maxAgeMs);
      // A restart also ends agents that are mid-turn on a worker or started a turn themselves,
      // which no task row shows, so those hold the update back too.
      const busyAgents = this.interruptions().filter((a) => a.busy);
      if (running.length > 0 || busyAgents.length > 0) {
        const since = this.readDeferred() ?? Date.now();
        mkdirSync(bandHome(), { recursive: true });
        writeFileSync(this.deferredPath(), JSON.stringify({ since }), { mode: 0o600 });
        const limit = envNumber("BAND_HUB_UPDATE_MAX_DEFER_H", DEFAULT_MAX_DEFER_H) * 3_600_000;
        if (Date.now() - since < limit) return;
      }
      rmSync(this.deferredPath(), { force: true });
      this.start(true);
    } catch (err) {
      log.warn(`automatic hub update failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Clears a failed run so the button is offered again. */
  dismiss(): void {
    if (this.status().state === "failed" && existsSync(this.runPath())) {
      rmSync(this.runPath(), { force: true });
    }
  }
}

export const hubUpdateService = new HubUpdateService();
