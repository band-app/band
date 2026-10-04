import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSharedSkillsDir } from "@band-app/coding-agent";
import type { InstallSkillsResult } from "@band-app/host-api";
import { findCliBinary } from "../process/cli-binary";
import { whichBinary } from "../process/path";

/** The seven skills the `band` CLI installs. */
export const BAND_SKILL_NAMES = [
  "band",
  "band-chat",
  "band-terminal",
  "band-browser",
  "band-start",
  "band-loop",
  "band-subscribe",
] as const;

const SKILL_FILE = "SKILL.md";

/**
 * Locate a band CLI binary we can shell out to. Mirrors the resolution order
 * used by `installHooks` (hooks.ts):
 *   0. `$BAND_CLI_BIN`, when set and present.
 *   1. `/usr/local/bin/band` symlink (created by `ensureCliInstalled` on the
 *      previous setup step), trusted shortcut.
 *   2. `whichBinary("band")` via the user's login shell PATH.
 *   3. `findCliBinary()` — the dev-mode / Electron-sidecar resolver in
 *      apps/hub/src/server/services/cli.ts. Catches the case where the symlink
 *      couldn't be installed (e.g. /usr/local/bin not writable, no admin
 *      prompt) but a usable binary still ships with the desktop app.
 *
 * Returns `null` when no binary can be found — callers should treat that as
 * a non-fatal skip rather than a hard error (consistent with the rest of the
 * idempotent setup pipeline).
 */
export async function findBandBinary(): Promise<string | null> {
  // Explicit override, read on every call. Tests point it at the CLI build
  // under test so a globally installed (older) `band` is never picked up.
  const override = process.env.BAND_CLI_BIN;
  if (override) {
    try {
      statSync(override);
      return override;
    } catch {
      // A bad override falls through to normal resolution.
    }
  }

  // The `/usr/local/bin/band` symlink is POSIX-only. On Windows the CLI
  // install is a `band.cmd` shim (which `execFile` can't invoke directly
  // anyway), so skip this shortcut and rely on `where band` / the bundled
  // sidecar resolver below, both of which return a directly-executable
  // path.
  if (process.platform !== "win32") {
    try {
      // `statSync` throws when the symlink is absent (caught below); a
      // successful return means it exists, so no truthiness check is needed.
      statSync("/usr/local/bin/band");
      return "/usr/local/bin/band";
    } catch {
      // Fall through to `which`.
    }
  }

  const onPath = await whichBinary("band");
  if (onPath) return onPath;

  return findCliBinary();
}

/**
 * Shape of the JSON emitted by `band --output json skills install`. Only the
 * fields this module consumes are typed; the CLI emits more (`home`,
 * `sharedDir`, `agents`, `skills`).
 */
interface BandSkillsInstallJson {
  shared?: {
    written?: string[];
    updated?: string[];
    unchanged?: string[];
  };
  symlinks?: {
    linked?: string[];
    alreadyLinked?: string[];
    conflicts?: { path: string; agentType?: string; reason: string }[];
  };
}

/**
 * Run `band --output json skills install --home <home>` and return its raw
 * stdout. The CLI owns the writing and symlinking; this is the single
 * install seam shared by the boot-time sync and the manual subcommand.
 */
async function runBandSkillsInstall(bandPath: string, home: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      bandPath,
      ["--output", "json", "skills", "install", "--home", home],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr?.toString().trim();
          reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

/**
 * Sync the CLI-shipped skills into the shared `~/.agents/skills/` root and
 * create per-agent symlinks for every supported coding agent that's
 * detected on this host.
 *
 * Delegates the actual work to `band skills install`, which is the single
 * source of both the skill content (baked into the binary) and the
 * install/symlink logic. This function resolves a band binary, runs it, and
 * maps its JSON report onto `InstallSkillsResult` so callers (boot-time
 * `setup.ts`) get the same per-phase counts they always have.
 *
 * Returns an all-skipped result, with the reason in `warnings`, when no band binary is
 * available or the subprocess fails — non-fatal, matching the rest of the
 * idempotent setup pipeline.
 */
export async function installSkills(opts: { home?: string } = {}): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = {
    written: [],
    updated: [],
    unchanged: [],
    linked: [],
    alreadyLinked: [],
    conflicts: [],
    skipped: [],
    warnings: [],
  };

  const home = opts.home ?? homedir();
  const sharedDir = getSharedSkillsDir(home);

  const markAllSkipped = () => {
    for (const name of BAND_SKILL_NAMES) {
      result.skipped.push(join(sharedDir, name, SKILL_FILE));
    }
  };

  const bandPath = await findBandBinary();
  if (!bandPath) {
    result.warnings.push(
      "Skipping CLI skills sync — band binary not found (no symlink, not on PATH, no bundled sidecar)",
    );
    markAllSkipped();
    return result;
  }

  let raw: string;
  try {
    raw = await runBandSkillsInstall(bandPath, home);
  } catch (err) {
    result.warnings.push(
      `Skipping CLI skills sync — \`band skills install\` failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    markAllSkipped();
    return result;
  }

  let parsed: BandSkillsInstallJson;
  try {
    parsed = JSON.parse(raw) as BandSkillsInstallJson;
  } catch (err) {
    result.warnings.push(
      `Skipping CLI skills sync — \`band skills install\` returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    markAllSkipped();
    return result;
  }

  result.written = parsed.shared?.written ?? [];
  result.updated = parsed.shared?.updated ?? [];
  result.unchanged = parsed.shared?.unchanged ?? [];
  result.linked = parsed.symlinks?.linked ?? [];
  result.alreadyLinked = parsed.symlinks?.alreadyLinked ?? [];
  // The CLI reports each conflict as a structured object; flatten to the
  // "path: reason" string shape the boot-time log line and callers expect.
  result.conflicts = (parsed.symlinks?.conflicts ?? []).map((c) => `${c.path}: ${c.reason}`);

  return result;
}
