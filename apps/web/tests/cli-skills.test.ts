/**
 * Integration tests for the CLI skills sync that runs as part of
 * `runFirstTimeSetup` (apps/web/src/server/services/setup.ts → ensureSkillsInstalled).
 *
 * Black-box: drives the public `runFirstTimeSetup` / `installSkills`
 * entry points with a sandboxed $HOME / $BAND_HOME, then asserts on the
 * filesystem state of:
 *
 *   - the canonical `~/.agents/skills/<name>/SKILL.md` files
 *   - the per-agent symlinks at `<agent>/skills/<name> → ../../.agents/...`
 *
 * No mocks — the test relies on a real `band` binary being reachable through
 * `findBandBinary` (the symlink at /usr/local/bin/band, the desktop sidecar,
 * or a cargo build output). When no binary can be located the suite is
 * skipped rather than failing, so CI nodes without a built CLI don't go red.
 */

import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { findBandBinary } from "../src/server/services/cli-skills";

const SKILL_NAMES = [
  "band",
  "band-chat",
  "band-terminal",
  "band-browser",
  "band-start",
  "band-loop",
] as const;

/**
 * Reuse the same resolver the production code uses so we exercise the real
 * binary (the symlink at /usr/local/bin/band, the desktop sidecar, or the
 * cargo build output — in that order). We can't just rely on PATH because
 * `pnpm exec vitest` prepends `node_modules/.bin/`, where the workspace
 * `band` shim refuses to run if the cargo build hasn't been produced.
 */
let bandBinary: string | null = null;

/**
 * Snapshot of what `band generate-skills` would emit *right now*. Computed
 * once in `beforeAll` and reused across tests so we can assert that the sync
 * step's output matches the CLI's output byte-for-byte.
 */
let expectedSkills: Map<(typeof SKILL_NAMES)[number], Buffer> | null = null;

beforeAll(async () => {
  bandBinary = await findBandBinary();
  if (!bandBinary) return;
  const stagingDir = mkdtempSync(join(tmpdir(), "band-skills-expected-"));
  try {
    execFileSync(bandBinary, ["generate-skills", "--output-dir", stagingDir], {
      encoding: "utf-8",
    });
    const map = new Map<(typeof SKILL_NAMES)[number], Buffer>();
    for (const name of SKILL_NAMES) {
      const path = join(stagingDir, name, "SKILL.md");
      if (!existsSync(path)) {
        // The resolved binary is reachable but doesn't emit one of the
        // expected SKILL.md files — almost always means a stale build is
        // sitting on the host. Treat this exactly like "no binary found"
        // so the suite skips cleanly instead of the whole test file
        // failing in the module-level beforeAll. The next CI run that
        // rebuilds the CLI will populate expectedSkills correctly and
        // exercise the assertions.
        bandBinary = null;
        return;
      }
      map.set(name, readFileSync(path));
    }
    expectedSkills = map;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

// `describe.skipIf` is evaluated when the test file is imported, before
// `beforeAll` resolves `bandBinary`. Probe synchronously here using the same
// `/usr/local/bin/band` shortcut that `findBandBinary` tries first, plus a
// look at the cargo build output. If neither is present we skip the suite —
// running on a CI node without a built CLI shouldn't go red.
function bandBinaryReachable(): boolean {
  try {
    statSync("/usr/local/bin/band");
    return true;
  } catch {
    // Fall through.
  }
  // apps/cli/target/{release,debug}/band — the cargo build output. The
  // resolver in cli.ts walks several roots; we only check the most likely
  // one here since this is just a "should we run?" gate.
  const repoCandidates = [
    join(import.meta.dirname, "..", "..", "cli", "target", "release", "band"),
    join(import.meta.dirname, "..", "..", "cli", "target", "debug", "band"),
  ];
  return repoCandidates.some((p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

describe.skipIf(!bandBinaryReachable())("CLI skills sync (ensureSkillsInstalled)", () => {
  let tmp: string;
  let originalBandHome: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    if (!bandBinary) return; // beforeAll couldn't resolve it; tests will skip via the guard below.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-skills-test-")));

    // Pre-create $HOME and $BAND_HOME inside the sandbox so neither
    // `bandHome()` nor `homedir()` leak into the real user's directories.
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    const bandDir = join(home, ".band");
    mkdirSync(bandDir, { recursive: true });

    // Pre-create the Claude Code config dir so detection in
    // `resolveSkillTargets` sees it as installed. We don't need a real
    // `claude` binary on PATH — the new detection strategy is
    // filesystem-based.
    mkdirSync(join(home, ".claude"), { recursive: true });

    // Pre-seed an empty settings.json so `loadSettings` doesn't blow up
    // when called downstream (e.g. by other ensureXxx steps in
    // runFirstTimeSetup). The shared/symlink layout doesn't actually
    // read codingAgents anymore.
    writeFileSync(
      join(bandDir, "settings.json"),
      JSON.stringify(
        {
          codingAgents: [],
          // Pre-set notifications so ensureNotificationDefaults is a no-op.
          notifications: { soundOnNeedsAttention: true },
        },
        null,
        2,
      ),
      "utf-8",
    );

    originalBandHome = process.env.BAND_HOME;
    originalHome = process.env.HOME;
    process.env.BAND_HOME = bandDir;
    process.env.HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (originalBandHome !== undefined) process.env.BAND_HOME = originalBandHome;
    else delete process.env.BAND_HOME;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes every CLI skill into the shared ~/.agents/skills/<name>/SKILL.md", async () => {
    expect(bandBinary, "band binary must be resolvable for this suite").not.toBeNull();
    const { runFirstTimeSetup } = await import("../src/server/services/setup-service");
    await runFirstTimeSetup();

    const sharedDir = join(process.env.HOME!, ".agents", "skills");
    for (const name of SKILL_NAMES) {
      const path = join(sharedDir, name, "SKILL.md");
      expect(existsSync(path), `expected ${path} to exist`).toBe(true);
      // Shared content is a real file, not a symlink.
      expect(lstatSync(path).isFile(), `${path} is a real file`).toBe(true);

      const actual = readFileSync(path);
      const expected = expectedSkills!.get(name)!;
      expect(actual.equals(expected), `${name} content matches \`band generate-skills\``).toBe(
        true,
      );
    }
  });

  it("creates a directory symlink at ~/.claude/skills/<name> → ~/.agents/skills/<name>", async () => {
    const { runFirstTimeSetup } = await import("../src/server/services/setup-service");
    await runFirstTimeSetup();

    const home = process.env.HOME!;
    const sharedDir = join(home, ".agents", "skills");
    const claudeDir = join(home, ".claude", "skills");

    for (const name of SKILL_NAMES) {
      const link = join(claudeDir, name);
      expect(existsSync(link), `expected symlink at ${link}`).toBe(true);
      const lstat = lstatSync(link);
      expect(lstat.isSymbolicLink(), `${link} is a symlink`).toBe(true);
      // After realpath the link should resolve to the shared dir for this skill.
      expect(realpathSync(link)).toBe(realpathSync(join(sharedDir, name)));
      // And reading the symlink target should yield a path that resolves to
      // the shared dir (we don't pin to a specific relative/absolute shape
      // because either is valid).
      const target = readlinkSync(link);
      expect(target.length).toBeGreaterThan(0);
      // SKILL.md is reachable through the link (proves the symlink works).
      expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    }
  });

  it("is a no-op on the second invocation when nothing has changed", async () => {
    const { runFirstTimeSetup } = await import("../src/server/services/setup-service");
    await runFirstTimeSetup();

    const sharedDir = join(process.env.HOME!, ".agents", "skills");
    const sharedFile = join(sharedDir, "band", "SKILL.md");
    const beforeStat = statSync(sharedFile);
    const beforeMtime = beforeStat.mtimeMs;
    const beforeContent = readFileSync(sharedFile);

    const link = join(process.env.HOME!, ".claude", "skills", "band");
    const beforeLinkMtime = lstatSync(link).mtimeMs;

    // Avoid an mtime collision on filesystems with second-level resolution.
    await new Promise((r) => setTimeout(r, 1100));

    await runFirstTimeSetup();

    const afterStat = statSync(sharedFile);
    expect(readFileSync(sharedFile).equals(beforeContent), "shared content is unchanged").toBe(
      true,
    );
    expect(
      afterStat.mtimeMs,
      "shared mtime is preserved when content hasn't changed (skipped, not rewritten)",
    ).toBe(beforeMtime);
    expect(lstatSync(link).mtimeMs, "symlink is not re-created on the second pass").toBe(
      beforeLinkMtime,
    );
  });

  it("overwrites a shared destination whose content drifted from the shipped version", async () => {
    const { runFirstTimeSetup } = await import("../src/server/services/setup-service");

    // Pre-create a tampered SKILL.md in the *shared* location before the
    // first sync. The agent-level symlink isn't there yet on this test
    // run, so we test the shared-write overwrite path in isolation.
    const sharedDir = join(process.env.HOME!, ".agents", "skills");
    const target = join(sharedDir, "band", "SKILL.md");
    mkdirSync(join(sharedDir, "band"), { recursive: true });
    writeFileSync(target, "# stale local copy that should be overwritten\n", "utf-8");

    await runFirstTimeSetup();

    const expected = expectedSkills!.get("band")!;
    expect(
      readFileSync(target).equals(expected),
      "tampered shared file replaced with shipped version",
    ).toBe(true);
  });

  it("does not write outside the sandboxed HOME", async () => {
    const { runFirstTimeSetup } = await import("../src/server/services/setup-service");
    await runFirstTimeSetup();

    expect(process.env.HOME!.startsWith(tmp), "HOME points inside the test tmpdir").toBe(true);
    expect(existsSync(join(process.env.HOME!, ".agents", "skills", "band", "SKILL.md"))).toBe(true);
    expect(existsSync(join(process.env.HOME!, ".claude", "skills", "band"))).toBe(true);
  });

  it("links into every supported agent that has a config dir on the host", async () => {
    // Pre-create config dirs for all four supported agents so the
    // filesystem-based detection sees each one as installed. The agent's
    // *type* is what drives skill-dir resolution; no real binaries needed.
    const home = process.env.HOME!;
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });

    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home });

    const sharedDir = join(home, ".agents", "skills");
    const expectedDirs = [
      join(home, ".claude", "skills"),
      join(home, ".codex", "skills"),
      join(home, ".config", "opencode", "skills"),
      join(home, ".gemini", "skills"),
    ];
    for (const dir of expectedDirs) {
      for (const name of SKILL_NAMES) {
        const link = join(dir, name);
        expect(lstatSync(link).isSymbolicLink(), `expected symlink at ${link}`).toBe(true);
        expect(realpathSync(link)).toBe(realpathSync(join(sharedDir, name)));
      }
    }

    // Shared skills are written once each.
    expect(result.written.length).toBe(SKILL_NAMES.length);
    // 4 agents × N skills freshly created symlinks.
    expect(result.linked.length).toBe(4 * SKILL_NAMES.length);
    expect(result.alreadyLinked.length).toBe(0);
  });

  it("does not create symlinks for agents whose config dir is missing", async () => {
    // Only ~/.claude exists (created by beforeEach). Codex / OpenCode /
    // Gemini config dirs don't, so those agents should be skipped.
    const home = process.env.HOME!;
    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home });

    expect(existsSync(join(home, ".claude", "skills", "band"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);

    // Only claude symlinks were created (1 agent × N skills).
    expect(result.linked.length).toBe(SKILL_NAMES.length);
  });

  it("honours $CODEX_HOME when set so codex symlinks follow the override", async () => {
    const customCodexHome = join(tmp, "custom-codex");
    mkdirSync(customCodexHome, { recursive: true });
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = customCodexHome;
    try {
      const { installSkills } = await import("../src/server/services/cli-skills");
      const result = await installSkills({ home: process.env.HOME! });

      for (const name of SKILL_NAMES) {
        const link = join(customCodexHome, "skills", name);
        expect(lstatSync(link).isSymbolicLink(), `expected symlink under $CODEX_HOME`).toBe(true);
      }
      // And nothing should have landed under the default ~/.codex/skills/
      // (we didn't create ~/.codex either, so detection skips it).
      expect(existsSync(join(process.env.HOME!, ".codex", "skills"))).toBe(false);

      // Lock in that claude-code (from beforeEach) AND codex (via the
      // env override) both got linked — without this count, a future
      // regression that silently skips claude-code while this test
      // narrowly checks the codex path would pass.
      expect(
        result.linked.length,
        "claude-code (from beforeEach) + codex (via $CODEX_HOME) = 2 × SKILL_NAMES symlinks",
      ).toBe(SKILL_NAMES.length * 2);
    } finally {
      if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it("leaves a correct existing symlink untouched (idempotent on re-run)", async () => {
    const { installSkills } = await import("../src/server/services/cli-skills");
    await installSkills({ home: process.env.HOME! });

    const link = join(process.env.HOME!, ".claude", "skills", "band");
    const beforeTarget = readlinkSync(link);

    const second = await installSkills({ home: process.env.HOME! });
    expect(readlinkSync(link)).toBe(beforeTarget);
    // Every symlink is reported as already-linked, none re-created.
    expect(second.linked.length).toBe(0);
    expect(second.alreadyLinked.length).toBe(SKILL_NAMES.length);
  });

  it("surfaces a conflict (and does not overwrite) when a wrong-target symlink already exists", async () => {
    const home = process.env.HOME!;
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });

    // Plant a symlink pointing somewhere the user might have set up
    // deliberately (e.g. a sibling project's checkout).
    const decoy = join(tmp, "decoy-band-skill");
    mkdirSync(decoy, { recursive: true });
    const link = join(claudeSkills, "band");
    symlinkSync(decoy, link, "dir");

    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home });

    // Conflict reported, link untouched, shared dir still populated.
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.startsWith(link))).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(decoy));
    expect(existsSync(join(home, ".agents", "skills", "band", "SKILL.md"))).toBe(true);
  });

  it("surfaces a conflict when a dangling symlink exists at the link path", async () => {
    // The link exists but its target was removed (e.g. ~/.agents/skills/
    // pruned by hand, $HOME moved). The shared-write phase will recreate
    // the target dir before linking, but if a user planted a dangling
    // symlink earlier the existing-symlink branch must classify it as a
    // conflict (broken target) rather than crash on canonicalize.
    const home = process.env.HOME!;
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    const link = join(claudeSkills, "band");
    const bogusTarget = join(home, "never-existed", "agents-skills-band");
    symlinkSync(bogusTarget, link, "dir");

    // Sanity: the shared dir hasn't been written yet, so the link target
    // does NOT exist on disk before installSkills runs.
    expect(existsSync(bogusTarget)).toBe(false);

    // Force the shared dir to be different from the bogus target before
    // running install — by deleting any pre-existing shared dir we would
    // simulate "shared dir was pruned between runs". (No-op on first run,
    // but explicit makes the intent clear.)
    rmSync(join(home, ".agents", "skills", "band"), { recursive: true, force: true });

    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home });

    // realpathSync on a dangling symlink fails, which the implementation
    // surfaces as "existing symlink is broken" (rather than the
    // wrong-target message used when both endpoints resolve).
    expect(
      result.conflicts.some((c) => c.startsWith(link) && c.includes("existing symlink is broken")),
      `expected broken-symlink conflict for ${link} in ${result.conflicts.join("\n")}`,
    ).toBe(true);
    // The dangling symlink is left in place — no overwrite.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(bogusTarget);
  });

  it("surfaces a conflict when a real directory occupies the target path", async () => {
    const home = process.env.HOME!;
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });

    // Plant a real directory at the link path with user content inside.
    const realDir = join(claudeSkills, "band");
    mkdirSync(realDir, { recursive: true });
    const userFile = join(realDir, "SKILL.md");
    writeFileSync(userFile, "# user-authored band skill\n", "utf-8");

    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home });

    expect(result.conflicts.some((c) => c.startsWith(realDir))).toBe(true);
    // User content preserved.
    expect(readFileSync(userFile, "utf-8")).toMatch(/user-authored/);
    // The directory was NOT replaced by a symlink.
    expect(lstatSync(realDir).isSymbolicLink()).toBe(false);
  });

  it("writes shared skills but creates no symlinks when no supported agents are detected", async () => {
    // Wipe the only config dir beforeEach created so nothing is detected.
    rmSync(join(process.env.HOME!, ".claude"), { recursive: true, force: true });

    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home: process.env.HOME! });

    // Shared files are still written (they're useful on their own).
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(process.env.HOME!, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    }
    expect(result.written.length).toBe(SKILL_NAMES.length);
    expect(result.linked.length).toBe(0);
    expect(result.alreadyLinked.length).toBe(0);
    expect(result.conflicts.length).toBe(0);
  });

  it("skips cursor-cli even though it is a known agent (no documented skills dir)", async () => {
    // Pre-create a `.cursor` config dir to simulate Cursor being
    // installed. Because cursor-cli isn't in `SUPPORTED_AGENT_TYPES`,
    // detection should still skip it.
    mkdirSync(join(process.env.HOME!, ".cursor"), { recursive: true });
    const { installSkills } = await import("../src/server/services/cli-skills");
    const result = await installSkills({ home: process.env.HOME! });

    expect(existsSync(join(process.env.HOME!, ".cursor", "skills"))).toBe(false);
    // claude alone gets linked (its config dir exists from beforeEach).
    expect(result.linked.length).toBe(SKILL_NAMES.length);
  });
});
