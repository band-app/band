/**
 * Updates this worker from the hub's click (`worker.update`): installs the requested release with
 * npm, then restarts through the service manager that supervises it. Only a worker that runs under
 * launchd or a systemd user unit can be restarted, and only the hub's admin path asks for it.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError } from "@band-app/link";
import { isStrictSemver } from "@band-app/shared/versions";
import type { Registrar } from "./context.ts";
import { RPC_INVALID_PARAMS, str } from "./rpc-util.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "./service.ts";

export type ServiceManager = "launchd" | "systemd";

/** RPC code for an update the worker cannot run or that failed. `error.message` says why. */
export const RPC_UPDATE_FAILED = -32020;

/** The service manager that started this process, from what it puts in the environment. */
export function detectServiceManager(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): ServiceManager | null {
  if (platform === "darwin" && env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return "launchd";
  // `INVOCATION_ID` is set for system units too (a root-run unit, a runner's VM). Only a user unit
  // can be restarted with `systemctl --user`, and that never runs as root.
  if (platform === "linux" && env.INVOCATION_ID && uid !== 0) return "systemd";
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

const PACKAGE_DIR = join("node_modules", "@band-app", "worker");

/**
 * The npm prefix this worker was installed into (`<prefix>/lib/node_modules/@band-app/worker`),
 * or null when it runs from anywhere else (a checkout, the desktop app, the Docker image).
 */
export function installPrefix(
  file: string = fileURLToPath(import.meta.url),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") return null;
  const marker = `${sep}lib${sep}${PACKAGE_DIR}${sep}`;
  const at = file.lastIndexOf(marker);
  return at > 0 ? file.slice(0, at) : null;
}

/** Why this worker cannot update itself with npm, or null when it can. */
export function updateBlockedReason(
  manager: ServiceManager | null,
  prefix: string | null = installPrefix(),
): string | null {
  if (!manager) {
    return "this worker does not run under launchd or a systemd user unit, so it cannot restart itself";
  }
  if (!prefix) {
    return "this worker does not run from an npm global install, so npm cannot update it";
  }
  return null;
}

/** node-pty's prebuilt spawn-helper must be executable; npm 11 skips the install script that sets it. */
function fixSpawnHelper(prefix: string): void {
  try {
    const pkg = join(prefix, "lib", PACKAGE_DIR, "package.json");
    const prebuilds = join(
      dirname(createRequire(pkg).resolve("node-pty/package.json")),
      "prebuilds",
    );
    if (!existsSync(prebuilds)) return;
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  } catch {
    // node-pty is not resolvable from the install; nothing to fix.
  }
}

export interface UpdateDeps {
  manager: ServiceManager | null;
  /** The npm prefix the worker lives in. Defaults to the one derived from where it runs. */
  prefix?: string | null;
  /** The node that runs the worker, whose directory holds the npm to use. */
  execPath?: string;
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
  const prefix = deps.prefix === undefined ? installPrefix() : deps.prefix;
  const blocked = updateBlockedReason(deps.manager, prefix);
  if (blocked || !deps.manager || !prefix) throw new RpcError(RPC_UPDATE_FAILED, blocked ?? "");
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  // A service manager's PATH has no node or npm. The npm beside the running node is the one that
  // matches this install, and its `#!/usr/bin/env node` line needs that node on PATH.
  const nodeDir = dirname(deps.execPath ?? process.execPath);
  const beside = join(nodeDir, "npm");
  const npm = env.BAND_NPM_BIN ?? (existsSync(beside) ? beside : "npm");
  const installEnv = { ...env, PATH: [nodeDir, env.PATH].filter(Boolean).join(delimiter) };
  const result = await run(
    npm,
    ["i", "-g", "--prefix", prefix, `@band-app/worker@${version}`],
    installEnv,
  );
  if (result.code !== 0 && /ENOENT/.test(result.stderr) && !env.BAND_NPM_BIN) {
    throw new RpcError(
      RPC_UPDATE_FAILED,
      `npm not found in ${nodeDir} or on PATH, set BAND_NPM_BIN in the service file`,
    );
  }
  if (result.code !== 0) {
    deps.log("error", { version, code: result.code }, "the worker update failed to install");
    throw new RpcError(
      RPC_UPDATE_FAILED,
      `npm install failed (exit ${result.code}): ${tail(result.stderr)}`,
    );
  }
  fixSpawnHelper(prefix);
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
