/**
 * Sync the CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
 * `band-browser`, `band-start`, `band-loop`) into a single canonical,
 * agent-agnostic skills directory (`~/.agents/skills/<name>/SKILL.md`) and
 * link each detected coding-agent's skills directory to that shared root so
 * the skills become discoverable to every agent on the host without
 * duplicating content.
 *
 * The skills are not shipped as loose files in the packaged Electron build —
 * each `SKILL.md` is baked into the Rust `band` binary via `include_str!`
 * (see `apps/cli/src/skills.rs::SKILL_TEMPLATES`). The binary is the single
 * source of truth for both the content and the install/symlink behaviour:
 * this module shells out to `band skills install --home <home>` and reports
 * what the CLI did. (There is no longer a `band generate-skills` step — the
 * SKILL.md files are authored directly, not rendered from the CLI schema.)
 *
 * Idempotency (enforced by the CLI):
 *   - Shared SKILL.md: only rewritten when its bytes differ from the
 *     shipped content.
 *   - Per-agent symlink: created on first run; on subsequent runs the CLI
 *     verifies it still points at the correct shared location. If it points
 *     somewhere else, or is a real directory, it is *not* overwritten — the
 *     CLI reports a conflict and skips, so user customizations aren't
 *     silently blown away.
 *
 * Layout:
 *
 *   ~/.agents/skills/band/SKILL.md            ← canonical (written once)
 *   ~/.agents/skills/band-chat/SKILL.md
 *   ~/.claude/skills/band       → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.codex/skills/band        → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.gemini/skills/band       → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.config/opencode/skills/band → ~/.agents/skills/band  (symlink, absolute target)
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSharedSkillsDir } from "@band-app/coding-agent";
import { findCliBinary } from "./cli-service";
import { systemService } from "./system-service";

/** The six skills the `band` CLI installs. */
export const BAND_SKILL_NAMES = [
  "band",
  "band-chat",
  "band-terminal",
  "band-browser",
  "band-start",
  "band-loop",
] as const;

const SKILL_FILE = "SKILL.md";

/**
 * Locate a band CLI binary we can shell out to. Mirrors the resolution order
 * used by `installHooks` (hooks.ts):
 *   1. `/usr/local/bin/band` symlink (created by `ensureCliInstalled` on the
 *      previous setup step), trusted shortcut.
 *   2. `whichBinary("band")` via the user's login shell PATH.
 *   3. `findCliBinary()` — the dev-mode / Electron-sidecar resolver in
 *      apps/web/src/server/services/cli.ts. Catches the case where the symlink
 *      couldn't be installed (e.g. /usr/local/bin not writable, no admin
 *      prompt) but a usable binary still ships with the desktop app.
 *
 * Returns `null` when no binary can be found — callers should treat that as
 * a non-fatal skip rather than a hard error (consistent with the rest of the
 * idempotent setup pipeline).
 */
export async function findBandBinary(): Promise<string | null> {
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

  const onPath = await systemService.whichBinary("band");
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
 * Result of `installSkills`. Counts are split between the canonical
 * (shared) write path and the per-agent symlink path so callers can log
 * each phase independently.
 */
export interface InstallSkillsResult {
  /** Canonical SKILL.md paths that didn't exist before this run. */
  written: string[];
  /** Canonical SKILL.md paths that existed but had different content (overwritten). */
  updated: string[];
  /** Canonical SKILL.md paths whose existing content already matched. */
  unchanged: string[];
  /** Symlink paths that were newly created (one entry per (agent, skill)). */
  linked: string[];
  /** Symlink paths that already pointed at the correct shared dir. */
  alreadyLinked: string[];
  /**
   * Per-agent skill paths where an existing file/dir/symlink got in our
   * way and we declined to overwrite it. Each entry is human-readable —
   * "path: reason" — so the warning log line is self-contained.
   */
  conflicts: string[];
  /**
   * Shared-directory SKILL.md paths that were skipped because the install
   * couldn't run at all — typically because no band binary could be located
   * on this host, or the `band skills install` invocation failed. Always one
   * entry per skill in `BAND_SKILL_NAMES` (i.e. exactly 6 today) — *not* one
   * entry per (agent × skill) pair, because the shared layout means there is
   * one canonical path regardless of how many agents would have been linked.
   */
  skipped: string[];
}

interface InstallSkillsOptions {
  /** Override $HOME (test-only — production callers should leave unset). */
  home?: string;
  /**
   * Optional logger for visibility into write/update/skip decisions. Pino-
   * compatible signature so we can pass `createLogger(...)` from setup.ts
   * without an adapter.
   */
  log?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
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
 * Returns an all-skipped result (and logs a warn) when no band binary is
 * available or the subprocess fails — non-fatal, matching the rest of the
 * idempotent setup pipeline.
 */
export async function installSkills(opts: InstallSkillsOptions = {}): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = {
    written: [],
    updated: [],
    unchanged: [],
    linked: [],
    alreadyLinked: [],
    conflicts: [],
    skipped: [],
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
    opts.log?.warn(
      "Skipping CLI skills sync — band binary not found (no symlink, not on PATH, no bundled sidecar)",
    );
    markAllSkipped();
    return result;
  }

  let raw: string;
  try {
    raw = await runBandSkillsInstall(bandPath, home);
  } catch (err) {
    opts.log?.warn(
      "Skipping CLI skills sync — `band skills install` failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    markAllSkipped();
    return result;
  }

  let parsed: BandSkillsInstallJson;
  try {
    parsed = JSON.parse(raw) as BandSkillsInstallJson;
  } catch (err) {
    opts.log?.warn(
      "Skipping CLI skills sync — `band skills install` returned invalid JSON: %s",
      err instanceof Error ? err.message : String(err),
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

  for (const path of result.written) opts.log?.info("Installed skill at %s", path);
  for (const path of result.updated) {
    opts.log?.info("Updated skill at %s (content differed — shipped version reinstalled)", path);
  }
  for (const conflict of result.conflicts) {
    opts.log?.warn(
      "Skill symlink conflict — %s (left as-is; remove it manually to re-link)",
      conflict,
    );
  }

  return result;
}
