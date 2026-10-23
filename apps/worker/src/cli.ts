import { accessSync, constants } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkills } from "@band-app/host-local/agents/skills-install";
import type { Logger } from "@band-app/logger";

const exeName = process.platform === "win32" ? "band.exe" : "band";

/** The npm package that holds the `band` binary for this platform. */
export function cliPackageName(platform = process.platform, arch = process.arch): string {
  return `@band-app/worker-cli-${platform}-${arch}`;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the `band` CLI this worker carries, first match wins:
 *
 *   1. `BAND_CLI_PATH`.
 *   2. The platform package `@band-app/worker-cli-<platform>-<arch>`, an optional
 *      dependency of the worker, so npm installs only the one that fits.
 *   3. `<Resources>/binaries/band` beside the desktop app's bundled worker.
 *   4. `apps/cli/target/{release,debug}/band` in a checkout.
 */
export function resolveCliBinary(
  here = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.BAND_CLI_PATH && isExecutable(env.BAND_CLI_PATH)) return env.BAND_CLI_PATH;
  try {
    const pkgJson = createRequire(join(here, "noop.js")).resolve(
      `${cliPackageName()}/package.json`,
    );
    const bin = join(dirname(pkgJson), "bin", exeName);
    if (isExecutable(bin)) return bin;
  } catch {
    // The package is not installed for this platform.
  }
  // The desktop app ships the worker at <Resources>/worker and the CLI at <Resources>/binaries.
  const desktop = resolve(here, "..", "binaries", exeName);
  if (isExecutable(desktop)) return desktop;
  // apps/worker/src or apps/worker/dist, both two levels below apps/.
  for (const profile of ["release", "debug"]) {
    const dev = resolve(here, "..", "..", "cli", "target", profile, exeName);
    if (isExecutable(dev)) return dev;
  }
  return null;
}

/**
 * The `band` CLI that ships with this worker (no hub involved). The agents and
 * terminals the worker starts get its directory first on their PATH.
 */
export class WorkerCli {
  private constructor(readonly binary: string) {}

  /**
   * Resolves the CLI, drops the copy the old fetch-from-the-hub scheme left in
   * `<stateDir>/bin` (nothing puts that directory on PATH any more, but a stale
   * binary there is dead weight), and installs the band skills with it. Returns
   * null, after one log line, when no CLI can be found.
   */
  static async start(stateDir: string, log: Logger): Promise<WorkerCli | null> {
    await Promise.all(
      [exeName, `${exeName}.sha256`].map((f) => rm(join(stateDir, "bin", f), { force: true })),
    ).catch(() => undefined);
    const binary = resolveCliBinary();
    if (!binary) {
      log.warn(
        { package: cliPackageName() },
        `no band CLI found: install ${cliPackageName()} or set BAND_CLI_PATH. Agents and terminals on this worker run without band`,
      );
      return null;
    }
    log.info({ binary }, "using the band CLI shipped with this worker");
    const cli = new WorkerCli(binary);
    // Not awaited: the worker serves while the skills are written.
    void installSkills({ bandPath: binary })
      .then((result) => {
        for (const warning of result.warnings) log.warn({ warning }, "band skills");
      })
      .catch((err) =>
        log.warn(
          { message: err instanceof Error ? err.message : String(err) },
          "could not install the band skills",
        ),
      );
    return cli;
  }

  /** The directory to put first on PATH. */
  async dir(): Promise<string> {
    return dirname(this.binary);
  }
}
