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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { compareVersions } from "@band-app/shared/versions";
import { bandHome } from "../infra/db/queries/settings";
import { HUB_VERSION } from "./_utils/hub-version";
import { releaseCheckService } from "./release-check-service";
import { settingsService } from "./settings-service";

const log = createLogger("hub-update");

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_LINES = 20;
/** Where this process started. A run that began before it and did not reach the target has failed. */
const BOOT_AT = Date.now();

export class HubUpdateError extends Error {
  constructor(
    readonly reason: "not-configured" | "up-to-date" | "busy",
    message: string,
  ) {
    super(message);
  }
}

interface RunFile {
  target: string;
  startedAt: number;
  /** Set when the command could not start or exited non-zero. */
  failure?: string;
}

export interface HubUpdateStatus {
  /** Whether an admin has set a command. */
  configured: boolean;
  state: "idle" | "updating" | "failed";
  target: string | null;
  /** Why it failed, with the last lines of the log. Admin detail, so the router cuts it for others. */
  error: string | null;
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
      configured: this.command() !== null,
      state: "failed",
      target: run.target,
      error: tail ? `${message}\n${tail}` : message,
    };
  }

  /** Where the run stands. Reads the state file, so it also answers after the hub restarted. */
  status(): HubUpdateStatus {
    const configured = this.command() !== null;
    const run = this.read();
    if (!run) return { configured, state: "idle", target: null, error: null };
    if ((compareVersions(HUB_VERSION, run.target) ?? -1) >= 0) {
      rmSync(this.runPath(), { force: true });
      return { configured, state: "idle", target: null, error: null };
    }
    if (run.failure) return this.failed(run, run.failure);
    if (BOOT_AT > run.startedAt) {
      return this.failed(run, `The hub restarted on ${HUB_VERSION}, not ${run.target}.`);
    }
    const wait = Number(process.env.BAND_HUB_UPDATE_TIMEOUT_MS);
    if (Date.now() - run.startedAt > (wait > 0 ? wait : DEFAULT_TIMEOUT_MS)) {
      return this.failed(run, `The hub did not come back on ${run.target} in time.`);
    }
    return { configured, state: "updating", target: run.target, error: null };
  }

  /** Starts the configured command detached and returns at once. */
  start(): { target: string } {
    const command = this.command();
    if (!command) throw new HubUpdateError("not-configured", "No hub update command is set");
    const target = releaseCheckService.status().latest;
    if (!target || (compareVersions(HUB_VERSION, target) ?? 0) >= 0) {
      throw new HubUpdateError("up-to-date", "The hub is already up to date");
    }
    if (this.status().state === "updating") {
      throw new HubUpdateError("busy", "A hub update is already running");
    }
    mkdirSync(bandHome(), { recursive: true });
    const run: RunFile = { target, startedAt: Date.now() };
    this.write(run);
    const fd = openSync(this.logPath(), "w", 0o600);
    try {
      writeFileSync(fd, `$ ${command}\n`);
      // A minimal environment, like a runner hook: the hub's own env holds its admin token.
      // The session bus variables let `systemctl --user` reach the user's manager.
      const env: NodeJS.ProcessEnv = { BAND_HUB_TARGET_VERSION: target };
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
        env,
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

  /** Clears a failed run so the button is offered again. */
  dismiss(): void {
    if (this.status().state === "failed" && existsSync(this.runPath())) {
      rmSync(this.runPath(), { force: true });
    }
  }
}

export const hubUpdateService = new HubUpdateService();
