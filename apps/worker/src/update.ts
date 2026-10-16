/**
 * Updates this worker from the hub's click (`worker.update`): installs the requested release with
 * npm, then restarts through the service manager that supervises it. Only a worker that runs under
 * launchd or a systemd user unit can be restarted, and only the hub's admin path asks for it.
 */

import { execFile } from "node:child_process";
import { RpcError } from "@band-app/link";
import type { Registrar } from "./context.ts";
import { RPC_INVALID_PARAMS, str } from "./rpc-util.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "./service.ts";

/** Same rule as `isStrictSemver` in `@band-app/shared`: exactly MAJOR.MINOR.PATCH, nothing else reaches npm. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isStrictSemver = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 32 && STRICT_SEMVER.test(v);

export type ServiceManager = "launchd" | "systemd";

/** RPC code for an update the worker cannot run or that failed. `error.message` says why. */
export const RPC_UPDATE_FAILED = -32020;

/** The service manager that started this process, from what it puts in the environment. */
export function detectServiceManager(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ServiceManager | null {
  if (platform === "darwin" && env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return "launchd";
  if (platform === "linux" && env.INVOCATION_ID) return "systemd";
  return null;
}

export interface CommandResult {
  code: number;
  stderr: string;
}
export type CommandRunner = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

const INSTALL_TIMEOUT_MS = 10 * 60_000;

const defaultRunner: CommandRunner = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ code: 0, stderr });
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ code, stderr: stderr || err.message });
      },
    );
  });

export interface UpdateDeps {
  manager: ServiceManager | null;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  /** How long to wait after the reply before restarting, so the reply reaches the hub. */
  restartDelayMs?: number;
  log: (level: "info" | "error", fields: Record<string, unknown>, msg: string) => void;
}

/** The last lines of a command's stderr, short enough for a toast. */
function tail(text: string): string {
  const lines = text.trim().split("\n").slice(-4).join("\n");
  return lines.length > 600 ? `…${lines.slice(-600)}` : lines;
}

/** The command that restarts the worker through its service manager. */
export function restartCommand(
  manager: ServiceManager,
  env: NodeJS.ProcessEnv,
  uid: number,
): [string, string[]] {
  return manager === "launchd"
    ? [env.BAND_LAUNCHCTL_BIN ?? "launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]]
    : [
        env.BAND_SYSTEMCTL_BIN ?? "systemctl",
        ["--user", "restart", SYSTEMD_UNIT.replace(/\.service$/, "")],
      ];
}

/**
 * Installs `version` and schedules the restart. Resolves once the install succeeded; throws an
 * `RpcError` with the reason when it did not, and the worker keeps running as it was.
 */
export async function updateWorker(version: unknown, deps: UpdateDeps): Promise<{ ok: true }> {
  // The version goes into npm's argv, so it must be nothing but MAJOR.MINOR.PATCH.
  if (!isStrictSemver(version)) {
    throw new RpcError(RPC_INVALID_PARAMS, "version must be MAJOR.MINOR.PATCH");
  }
  if (!deps.manager) {
    throw new RpcError(
      RPC_UPDATE_FAILED,
      "this worker does not run under launchd or a systemd user unit, so it cannot restart itself",
    );
  }
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const result = await run(
    env.BAND_NPM_BIN ?? "npm",
    ["i", "-g", `@band-app/worker@${version}`],
    env,
  );
  if (result.code !== 0) {
    deps.log("error", { version, code: result.code }, "the worker update failed to install");
    throw new RpcError(
      RPC_UPDATE_FAILED,
      `npm install failed (exit ${result.code}): ${tail(result.stderr)}`,
    );
  }
  deps.log("info", { version, manager: deps.manager }, "installed the new worker, restarting");
  const [cmd, args] = restartCommand(deps.manager, env, deps.uid ?? process.getuid?.() ?? 0);
  const timer = setTimeout(() => {
    void run(cmd, args, env).then((r) => {
      if (r.code !== 0) {
        deps.log("error", { code: r.code, stderr: tail(r.stderr) }, "the restart command failed");
      }
    });
  }, deps.restartDelayMs ?? 500);
  timer.unref();
  return { ok: true };
}

export function registerUpdateMethods(
  r: Registrar,
  manager: ServiceManager | null,
  log: UpdateDeps["log"],
): void {
  r.json("worker.update", (a) => updateWorker(str(a, "version"), { manager, log }));
}
