/**
 * Sync the CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
 * `band-browser`) into the user's global coding-agent skill directory so the
 * skills become discoverable to the agent right after install / auto-update,
 * without the user having to manually `cp` each SKILL.md after every release.
 *
 * The skills are not shipped as loose files in the packaged Electron build —
 * they're baked into the Rust `band` binary via `include_str!` (see
 * `apps/cli/src/skills.rs::SKILL_TEMPLATES`) and rendered against the live
 * CLI schema by `band generate-skills`. We invoke that subcommand at runtime
 * and copy the produced `<name>/SKILL.md` files into each detected agent's
 * known skills directory.
 *
 * Idempotency: the destination is only rewritten when its bytes differ from
 * the freshly generated content. Missing destinations are written, identical
 * destinations are skipped, and content drift (user edits or older shipped
 * versions) results in an overwrite + warning log — matching the
 * "blast-and-replace with a log" policy used by `installHooks` and
 * `installCli` (see hooks.ts / cli.ts).
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findCliBinary } from "./cli";
import { whichBinary } from "./process-utils";

/** The four skills `band generate-skills` emits. */
export const BAND_SKILL_NAMES = ["band", "band-chat", "band-terminal", "band-browser"] as const;

const SKILL_FILE = "SKILL.md";

/** A single coding agent's global skills folder. */
export interface SkillTarget {
  /** Coding agent ID (matches AGENT_CHECKS in setup.ts). */
  agentId: string;
  /** Absolute path to the agent's global skills directory. */
  skillsDir: string;
}

/**
 * Map a detected coding agent to the global skills directory we ship into.
 *
 * Returns `null` when the agent has no stable global skills convention we're
 * comfortable writing to yet — those land as a TODO so the install/update
 * sync stays Claude-only for now (per the open question in the issue spec).
 *
 *   - `claude-code` → `~/.claude/skills/` (matches discoverClaudeSkills in
 *     packages/coding-agent/src/adapters/claude-code.ts).
 *   - `codex` / `opencode` → TODO. Both adapters scan multiple directories
 *     (`~/.codex/skills/` for Codex; a 6-tier resolution order including
 *     `~/.config/opencode/skills/` for OpenCode), and we'd rather wait until
 *     someone validates an end-to-end flow than guess at the canonical
 *     "shipped skills" home for those agents.
 */
export function resolveSkillTarget(agentId: string, home: string = homedir()): SkillTarget | null {
  switch (agentId) {
    case "claude-code":
      return { agentId, skillsDir: join(home, ".claude", "skills") };
    default:
      return null;
  }
}

/**
 * Locate a band CLI binary we can shell out to. Mirrors the resolution order
 * used by `installHooks` (hooks.ts):
 *   1. `/usr/local/bin/band` symlink (created by `ensureCliInstalled` on the
 *      previous setup step), trusted shortcut.
 *   2. `whichBinary("band")` via the user's login shell PATH.
 *   3. `findCliBinary()` — the dev-mode / Electron-sidecar resolver in
 *      apps/web/src/lib/cli.ts. Catches the case where the symlink couldn't
 *      be installed (e.g. /usr/local/bin not writable, no admin prompt) but
 *      a usable binary still ships with the desktop app.
 *
 * Returns `null` when no binary can be found — callers should treat that as
 * a non-fatal skip rather than a hard error (consistent with the rest of the
 * idempotent setup pipeline).
 */
export async function findBandBinary(): Promise<string | null> {
  try {
    const stat = statSync("/usr/local/bin/band");
    if (stat) return "/usr/local/bin/band";
  } catch {
    // Fall through to `which`.
  }

  const onPath = await whichBinary("band");
  if (onPath) return onPath;

  return findCliBinary();
}

/**
 * Run `band generate-skills --output-dir <dir>` and return the path to the
 * (now-populated) directory. The caller owns cleanup.
 */
async function generateSkills(bandPath: string, outputDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      bandPath,
      ["generate-skills", "--output-dir", outputDir],
      { timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = stderr?.toString().trim();
          reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Result of `installSkills`. Counts each (skill × target) cell once, so
 * syncing 4 skills into 1 target produces up to 4 entries across the three
 * fields combined.
 */
export interface InstallSkillsResult {
  /** Destination paths that didn't exist before this run. */
  written: string[];
  /** Destination paths that existed but had different content (overwritten). */
  updated: string[];
  /** Destination paths whose existing content already matched. */
  unchanged: string[];
  /** Targets that were skipped because no band binary could be located. */
  skipped: string[];
}

interface InstallSkillsOptions {
  /** Override $HOME (test-only — production callers should leave unset). */
  home?: string;
  /** Detected coding agent IDs. Filters which target dirs we write to. */
  agentIds: readonly string[];
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
 * Sync the CLI-shipped skills into each detected agent's global skills dir.
 *
 * Steps:
 *   1. Resolve a band binary — abort cleanly if none is available.
 *   2. Build the list of write targets from the detected agents.
 *   3. Run `band generate-skills` into a temp dir.
 *   4. For each (skill, target), compare against the destination and write
 *      only when content differs.
 *
 * No-op (returns an empty-ish result) when no targets resolve — that's the
 * intended behavior when only Codex / OpenCode are installed today, since
 * we haven't wired their destinations yet.
 */
export async function installSkills(opts: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = {
    written: [],
    updated: [],
    unchanged: [],
    skipped: [],
  };

  const home = opts.home ?? homedir();
  const targets = opts.agentIds
    .map((id) => resolveSkillTarget(id, home))
    .filter((t): t is SkillTarget => t !== null);

  if (targets.length === 0) {
    return result;
  }

  const bandPath = await findBandBinary();
  if (!bandPath) {
    opts.log?.warn(
      "Skipping CLI skills sync — band binary not found (no symlink, not on PATH, no bundled sidecar)",
    );
    for (const target of targets) {
      for (const name of BAND_SKILL_NAMES) {
        result.skipped.push(join(target.skillsDir, name, SKILL_FILE));
      }
    }
    return result;
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "band-skills-"));
  try {
    await generateSkills(bandPath, stagingDir);

    for (const target of targets) {
      for (const name of BAND_SKILL_NAMES) {
        const sourcePath = join(stagingDir, name, SKILL_FILE);
        const destPath = join(target.skillsDir, name, SKILL_FILE);

        if (!existsSync(sourcePath)) {
          // Generator didn't emit this skill. Could happen if the templates
          // diverge from BAND_SKILL_NAMES — log and move on rather than
          // crashing the whole boot path.
          opts.log?.warn("Generated skill missing from staging dir: %s (skipping)", sourcePath);
          continue;
        }

        const sourceContent = readFileSync(sourcePath);

        let existingContent: Buffer | null = null;
        try {
          existingContent = readFileSync(destPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            opts.log?.warn(
              "Failed to read existing skill at %s: %s — overwriting",
              destPath,
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        if (existingContent?.equals(sourceContent)) {
          result.unchanged.push(destPath);
          continue;
        }

        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, sourceContent);

        if (existingContent) {
          result.updated.push(destPath);
          opts.log?.info(
            "Updated %s skill at %s (content differed — local edits, if any, were overwritten)",
            name,
            destPath,
          );
        } else {
          result.written.push(destPath);
          opts.log?.info("Installed %s skill at %s", name, destPath);
        }
      }
    }
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort.
    }
  }

  return result;
}
