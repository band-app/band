/**
 * Sync the CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
 * `band-browser`, `band-start`, `band-loop`) into the user's global
 * coding-agent skill directory so the skills become discoverable to the agent
 * right after install / auto-update, without the user having to manually `cp`
 * each SKILL.md after every release.
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
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultAgentBinary, getInstallSkillsDir } from "@band-app/coding-agent";
import { findCliBinary } from "./cli";
import { whichBinary } from "./process-utils";
import { loadSettings } from "./state";

/** The six skills `band generate-skills` emits. */
export const BAND_SKILL_NAMES = [
  "band",
  "band-chat",
  "band-terminal",
  "band-browser",
  "band-start",
  "band-loop",
] as const;

const SKILL_FILE = "SKILL.md";

/** A single coding agent's global skills folder. */
export interface SkillTarget {
  /** Coding agent type (matches `CodingAgentConfig.type`). */
  agentType: string;
  /** Absolute path to the agent's global skills directory. */
  skillsDir: string;
}

/**
 * Coding agent identity — just the bits `resolveSkillTargets` needs. Mirrors
 * the relevant fields of `CodingAgentDefinition` from state.ts so callers can
 * pass `loadSettings().codingAgents` directly without re-shaping it.
 */
export interface SkillAgent {
  /** Stable type discriminator (e.g. `claude-code`, `codex`, `opencode`). */
  type: string;
  /**
   * Optional explicit path to the agent's executable, mirroring
   * `CodingAgentDefinition.command`. When set we trust this over the
   * adapter's default binary name — letting users with custom installs
   * (Homebrew Cellar, NixOS profiles, npm prefix overrides) keep
   * skills syncing without us re-implementing every package manager's
   * resolution rules.
   */
  command?: string;
}

/**
 * Verify a coding agent is *actually installed* on this host. Presence in
 * `settings.codingAgents` only proves the agent was detected at some past
 * setup run — the user may have uninstalled the binary since (e.g. removed
 * `claude` while keeping the entry around). Writing skills to that agent's
 * global directory after the fact would just litter the user's home dir.
 *
 *   1. If the agent definition carries an explicit `command`, check the
 *      file is executable.
 *   2. Otherwise look up the adapter's default binary name (owned by each
 *      adapter — see `packages/coding-agent/src/install-skills.ts`) and
 *      probe PATH via `whichBinary`.
 *
 * Returns `false` when neither path resolves, so callers can skip the
 * agent. Adapter types without a default binary (e.g. `cursor-cli`) also
 * return `false` — we'd have nothing to install for them anyway.
 */
export async function isAgentInstalled(agent: SkillAgent): Promise<boolean> {
  if (agent.command) {
    try {
      accessSync(agent.command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const binaryName = await getDefaultAgentBinary(agent.type);
  if (!binaryName) return false;

  const found = await whichBinary(binaryName);
  return found !== null;
}

/**
 * Resolve write targets for the *enabled* agents in the input list,
 * deduplicating destinations.
 *
 * "Enabled" here means: present in `settings.codingAgents` AND the agent's
 * binary is actually reachable on this host (see `isAgentInstalled`).
 * Stale entries — those whose binary has been uninstalled since detection
 * but whose record lingers in settings.json — are skipped so we don't
 * keep refreshing skills for a coding agent the user no longer uses.
 *
 * Each agent's skills directory comes from its adapter (see
 * `packages/coding-agent/src/install-skills.ts` and the
 * `get<Agent>InstallSkillsDir` exports next to each adapter's discovery
 * logic) — this layer only orchestrates lookup, install-check, and dedupe.
 *
 * Two configured agents can resolve to the same directory (e.g. two
 * claude-code agents with different IDs but the same `type` both map to
 * `~/.claude/skills/`). We dedupe so the (skill, target) loop doesn't write
 * the same file twice on each boot. Agent types without a documented global
 * skills directory (e.g. `cursor-cli`) are silently skipped.
 */
export async function resolveSkillTargets(
  agents: readonly SkillAgent[],
  home: string = homedir(),
): Promise<SkillTarget[]> {
  const seen = new Set<string>();
  const out: SkillTarget[] = [];
  for (const agent of agents) {
    if (!(await isAgentInstalled(agent))) continue;
    const skillsDir = await getInstallSkillsDir(agent.type, home);
    if (!skillsDir) continue;
    if (seen.has(skillsDir)) continue;
    seen.add(skillsDir);
    out.push({ agentType: agent.type, skillsDir });
  }
  return out;
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
  /**
   * Override the enabled-agents list (test-only). When omitted (the
   * production path) we read `loadSettings().codingAgents` ourselves so the
   * function is a self-contained "sync skills for the user's enabled
   * agents" — callers can't accidentally pass a stale or unfiltered list.
   *
   * We dispatch on each agent's `type`, not `id`, because users can
   * configure several agents of the same type (e.g. two `claude-code`
   * agents with different labels) and a custom `id` doesn't change the
   * on-disk skills directory layout.
   */
  agents?: readonly SkillAgent[];
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
 * Sync the CLI-shipped skills into each enabled agent's global skills dir.
 *
 * "Enabled" is sourced from `loadSettings().codingAgents` by default — that
 * array is the canonical "agents the user has turned on", populated by
 * `ensureDefaultCodingAgents` on first run and edited via the dashboard
 * settings UI. Tests can pass `opts.agents` to override.
 *
 * Steps:
 *   1. Read enabled agents from settings (or from `opts.agents`).
 *   2. Filter to those whose binary is actually reachable on this host
 *      (`isAgentInstalled` — handles stale `command` paths and missing
 *      PATH entries).
 *   3. Resolve a deduplicated list of skills directories from each
 *      remaining agent's adapter.
 *   4. Resolve a band binary — abort cleanly if none is available.
 *   5. Run `band generate-skills` into a temp dir.
 *   6. For each (skill, target), compare against the destination and write
 *      only when content differs.
 *
 * No-op (returns an empty-ish result) when no targets resolve — e.g. the
 * user has no agents enabled, or all enabled agents have been uninstalled.
 */
export async function installSkills(opts: InstallSkillsOptions = {}): Promise<InstallSkillsResult> {
  const result: InstallSkillsResult = {
    written: [],
    updated: [],
    unchanged: [],
    skipped: [],
  };

  const home = opts.home ?? homedir();
  const agents = opts.agents ?? loadSettings().codingAgents ?? [];
  const targets = await resolveSkillTargets(agents, home);

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
