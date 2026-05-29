/**
 * Sync the CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
 * `band-browser`, `band-start`, `band-loop`) into a single canonical,
 * agent-agnostic skills directory (`~/.agents/skills/<name>/SKILL.md`), then
 * link each detected coding-agent's skills directory to that shared root so
 * the skills become discoverable to every agent on the host without
 * duplicating content.
 *
 * The skills are not shipped as loose files in the packaged Electron build —
 * they're baked into the Rust `band` binary via `include_str!` (see
 * `apps/cli/src/skills.rs::SKILL_TEMPLATES`) and rendered against the live
 * CLI schema by `band generate-skills`. We invoke that subcommand at runtime,
 * write the produced `<name>/SKILL.md` files into `~/.agents/skills/`, and
 * then for each supported coding agent that's installed on this machine
 * create a directory-level symlink at `<agent>/skills/<name>` pointing back
 * to the shared `~/.agents/skills/<name>`.
 *
 * Idempotency:
 *   - Shared SKILL.md: only rewritten when its bytes differ from the
 *     freshly generated content.
 *   - Per-agent symlink: created on first run; on subsequent runs we verify
 *     it still points at the correct shared location. If it points
 *     somewhere else, or is a real directory, we *do not* overwrite — we
 *     log a conflict and skip, so user customizations aren't silently
 *     blown away.
 *
 * Layout:
 *
 *   ~/.agents/skills/band/SKILL.md            ← canonical (written once)
 *   ~/.agents/skills/band-chat/SKILL.md
 *   ~/.claude/skills/band       → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.codex/skills/band        → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.gemini/skills/band       → ~/.agents/skills/band     (symlink, absolute target)
 *   ~/.config/opencode/skills/band → ~/.agents/skills/band  (symlink, absolute target)
 *
 * The link target is an absolute path (`symlinkSync(target, link, "dir")`
 * where `target` is `join(sharedDir, name)`). Absolute keeps the link
 * valid regardless of where it lives in the agent's directory tree, at
 * the cost of breaking if `$HOME` ever moves — acceptable for per-user
 * installs.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentConfigDir,
  getInstallSkillsDir,
  getSharedSkillsDir,
  SUPPORTED_AGENT_TYPES,
} from "@band-app/coding-agent";
import { findCliBinary } from "./cli-service";
import { systemService } from "./system-service";

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
 * Resolve write targets for all supported coding agents that are
 * detected on this host, deduplicating destinations.
 *
 * "Detected" is filesystem-based: the agent's parent config directory
 * (e.g. `~/.claude/`) must already exist. We treat the presence of a
 * config dir as evidence that the user has used the agent on this host
 * at least once — at which point linking skills into its skills/
 * subdirectory is safe and useful. We deliberately do *not* probe
 * `$PATH` for the binary: the user may have installed the agent via a
 * method that doesn't put a binary on PATH for the Electron app's
 * environment (npm prefix overrides, Nix profiles, etc.). The config
 * dir is a stronger signal of "this agent is set up here".
 *
 * Each agent's skills directory comes from its adapter (see
 * `packages/coding-agent/src/install-skills.ts` and the
 * `get<Agent>InstallSkillsDir` exports next to each adapter's discovery
 * logic) — this layer only orchestrates detection, lookup, and dedupe.
 *
 * Dedupe is still applied across agent types in case two map to the same
 * directory in the future, so the (skill, target) loop doesn't try to
 * create the same symlink twice on each boot. Agent types without a
 * documented global skills directory (e.g. `cursor-cli`) are silently
 * skipped at the `SUPPORTED_AGENT_TYPES` level.
 */
export async function resolveSkillTargets(home: string = homedir()): Promise<SkillTarget[]> {
  const seen = new Set<string>();
  const out: SkillTarget[] = [];
  for (const type of SUPPORTED_AGENT_TYPES) {
    const configDir = getAgentConfigDir(type, home);
    if (!configDir) continue;
    try {
      const stat = statSync(configDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const skillsDir = await getInstallSkillsDir(type, home);
    if (!skillsDir) continue;
    if (seen.has(skillsDir)) continue;
    seen.add(skillsDir);
    out.push({ agentType: type, skillsDir });
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
 *      apps/web/src/server/services/cli.ts. Catches the case where the symlink
 *      couldn't be installed (e.g. /usr/local/bin not writable, no admin
 *      prompt) but a usable binary still ships with the desktop app.
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

  const onPath = await systemService.whichBinary("band");
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
   * Shared-directory SKILL.md paths that were skipped because no band
   * binary could be located on this host (so the install can't run at
   * all). Always one entry per skill in `BAND_SKILL_NAMES` (i.e. exactly
   * 6 today) — *not* one entry per (agent × skill) pair, because the
   * shared layout means there is one canonical path regardless of how
   * many agents would have been linked.
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
 * Steps:
 *   1. Resolve a band binary — abort cleanly if none is available.
 *   2. Run `band generate-skills` into a temp dir.
 *   3. For each skill, compare against `~/.agents/skills/<name>/SKILL.md`
 *      and write only when content differs.
 *   4. Detect which supported agents are installed on this host
 *      (`detectInstalledAgents` via the filesystem config-dir check).
 *   5. For each (agent, skill), create a directory-level symlink at
 *      `<agent-skills-dir>/<name>` → `~/.agents/skills/<name>`. Skip
 *      idempotently if the symlink already points to the right place.
 *      Surface a clear conflict log if it points elsewhere or is a real
 *      directory.
 *
 * No-op (returns an empty-ish result) when no targets resolve.
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
  const targets = await resolveSkillTargets(home);

  const bandPath = await findBandBinary();
  if (!bandPath) {
    opts.log?.warn(
      "Skipping CLI skills sync — band binary not found (no symlink, not on PATH, no bundled sidecar)",
    );
    for (const name of BAND_SKILL_NAMES) {
      result.skipped.push(join(sharedDir, name, SKILL_FILE));
    }
    return result;
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "band-skills-"));
  try {
    await generateSkills(bandPath, stagingDir);

    // -------------------------------------------------------------
    // Step 1: write the canonical SKILL.md files into ~/.agents/skills/.
    // -------------------------------------------------------------
    for (const name of BAND_SKILL_NAMES) {
      const sourcePath = join(stagingDir, name, SKILL_FILE);
      const destPath = join(sharedDir, name, SKILL_FILE);

      if (!existsSync(sourcePath)) {
        // Generator didn't emit this skill. Could happen if the templates
        // diverge from BAND_SKILL_NAMES — log and move on rather than
        // crashing the whole boot path. Track the shared destination as
        // `skipped` so the boot-time `setup.ts` log counter reflects
        // the gap instead of silently dropping to zero.
        opts.log?.warn("Generated skill missing from staging dir: %s (skipping)", sourcePath);
        result.skipped.push(destPath);
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
            "Failed to read existing shared skill at %s: %s — overwriting",
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

    // -------------------------------------------------------------
    // Step 2: link each agent's per-name skill dir back to the shared one.
    // -------------------------------------------------------------
    if (targets.length === 0) {
      opts.log?.info(
        "No supported coding agents detected on host — skills installed to %s but no agent symlinks created",
        sharedDir,
      );
      return result;
    }

    for (const target of targets) {
      for (const name of BAND_SKILL_NAMES) {
        const shared = join(sharedDir, name);
        const link = join(target.skillsDir, name);

        // Skip if the shared dir for this skill isn't actually there
        // (could happen if the generator failed to emit it above).
        // Track each missed (agent, skill) pair in `result.skipped`
        // so the `setup.ts` info-log counter reflects the gap; a
        // silent `continue` here would make the booted process look
        // healthier than it is when the shared-write phase warned.
        if (!existsSync(shared)) {
          result.skipped.push(link);
          continue;
        }

        const outcome = ensureSymlink({ link, target: shared, log: opts.log });
        switch (outcome.kind) {
          case "created":
            result.linked.push(link);
            // Log the absolute target — that's what `ensureSymlinkInner`
            // actually writes to disk (`symlinkSync(target, link, "dir")`
            // with `target = shared`). Logging a relative path here would
            // disagree with what `ls -la <link>` shows.
            opts.log?.info("Linked %s skills/%s → %s", target.agentType, name, shared);
            break;
          case "already":
            result.alreadyLinked.push(link);
            break;
          case "conflict":
            result.conflicts.push(`${link}: ${outcome.reason}`);
            opts.log?.warn(
              "Skill symlink conflict at %s — %s (leaving as-is; remove it manually to re-link)",
              link,
              outcome.reason,
            );
            break;
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

interface EnsureSymlinkArgs {
  link: string;
  target: string;
  log?: InstallSkillsOptions["log"];
}

type EnsureSymlinkOutcome =
  | { kind: "created" }
  | { kind: "already" }
  | { kind: "conflict"; reason: string };

/**
 * Create a symlink at `link` pointing to `target`, idempotently.
 *
 *   - No file at `link`: create the symlink. (`created`)
 *   - Symlink at `link` already pointing at `target` (after realpath
 *     normalisation): leave it alone. (`already`)
 *   - Symlink pointing somewhere else: refuse to overwrite — surface a
 *     conflict so the user can decide. (`conflict`)
 *   - Real file or directory: refuse to overwrite — likely user data.
 *     (`conflict`)
 *
 * We never blindly `rm -rf` or `unlink` the existing path: this function
 * runs on every server boot, and a misconfigured detection step could
 * otherwise destroy a real `~/.claude/skills/foo/` the user is
 * intentionally maintaining. "Refuse and log" is the safe default.
 */
function ensureSymlink(args: EnsureSymlinkArgs): EnsureSymlinkOutcome {
  // `_retried` is a private recursion guard set only by this function
  // when the EEXIST recovery branch re-enters. Kept off the public
  // `EnsureSymlinkArgs` interface so external callers can't supply it.
  return ensureSymlinkInner(args, false);
}

function ensureSymlinkInner(args: EnsureSymlinkArgs, retried: boolean): EnsureSymlinkOutcome {
  const { link, target } = args;

  // Ensure the parent directory of the link exists. Creating it is
  // safe: it's always inside an agent-owned dir (e.g. ~/.claude/skills/),
  // and the agent itself would create it on first use anyway.
  mkdirSync(dirname(link), { recursive: true });

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(link);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        kind: "conflict",
        reason: `lstat failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (existing === null) {
    try {
      symlinkSync(target, link, "dir");
      return { kind: "created" };
    } catch (err) {
      // Tight TOCTOU race: between the `lstatSync` above and this
      // `symlinkSync`, another process (concurrent server boot, a shell
      // command, `band skills install` invoked manually) could have
      // created something at `link`. Re-enter the function so the
      // newly-created entry is classified as `already`/`conflict` via
      // the lstat path above. Any non-EEXIST error is propagated as a
      // conflict, matching the lstat-failure branch.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        if (retried) {
          // Second EEXIST in a row means the filesystem is reporting
          // contradictory state (lstat says ENOENT, symlink says EEXIST).
          // Bail out rather than recurse indefinitely on the boot path.
          return {
            kind: "conflict",
            reason: "EEXIST after retry — filesystem state is inconsistent",
          };
        }
        return ensureSymlinkInner(args, true);
      }
      return {
        kind: "conflict",
        reason: `failed to create symlink: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (existing.isSymbolicLink()) {
    let pointsAt: string;
    try {
      pointsAt = realpathSync(link);
    } catch (err) {
      return {
        kind: "conflict",
        reason: `existing symlink is broken (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    let targetReal: string;
    try {
      targetReal = realpathSync(target);
    } catch (err) {
      // Shared target unreadable — caller already created it, so this
      // would be unusual. Treat as a conflict so we don't silently
      // overwrite a (correct) link.
      return {
        kind: "conflict",
        reason: `target unreadable (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    if (pointsAt === targetReal) {
      return { kind: "already" };
    }
    return {
      kind: "conflict",
      reason: `symlink points to ${readlinkSafe(link)} (expected ${target})`,
    };
  }

  if (existing.isDirectory()) {
    return {
      kind: "conflict",
      reason: "path is a real directory (not a symlink)",
    };
  }

  return {
    kind: "conflict",
    reason: "path is a regular file (not a directory or symlink)",
  };
}

function readlinkSafe(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "<unreadable>";
  }
}
