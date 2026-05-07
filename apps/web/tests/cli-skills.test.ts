/**
 * Integration tests for the CLI skills sync that runs as part of
 * `runFirstTimeSetup` (apps/web/src/lib/setup.ts → ensureSkillsInstalled).
 *
 * Black-box: drives the public `runFirstTimeSetup` entry point with a
 * sandboxed $HOME / $BAND_HOME, then asserts on the filesystem state of
 * `~/.claude/skills/<name>/SKILL.md`. No mocks — the test relies on a real
 * `band` binary being reachable through `findBandBinary` (the symlink at
 * /usr/local/bin/band, the desktop sidecar, or a cargo build output). When
 * no binary can be located the suite is skipped rather than failing, so CI
 * nodes without a built CLI don't go red.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findBandBinary } from "../src/lib/cli-skills";
import { closeDb } from "../src/lib/db/connection";

const SKILL_NAMES = ["band", "band-chat", "band-terminal", "band-browser"] as const;

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

    // Pre-seed settings.json with `claude-code` already in `codingAgents`
    // so `ensureDefaultCodingAgents` doesn't try to detect via `whichBinary`
    // (which would depend on the host) and so `ensureSkillsInstalled` has a
    // target agent to write to.
    writeFileSync(
      join(bandDir, "settings.json"),
      JSON.stringify(
        {
          codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
          defaultCodingAgent: "claude-code",
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

  it("writes all four CLI skills into ~/.claude/skills/<name>/SKILL.md on first run", async () => {
    expect(bandBinary, "band binary must be resolvable for this suite").not.toBeNull();
    const { runFirstTimeSetup } = await import("../src/lib/setup");
    await runFirstTimeSetup();

    const skillsDir = join(process.env.HOME!, ".claude", "skills");
    for (const name of SKILL_NAMES) {
      const path = join(skillsDir, name, "SKILL.md");
      expect(existsSync(path), `expected ${path} to exist`).toBe(true);

      const actual = readFileSync(path);
      const expected = expectedSkills!.get(name)!;
      expect(actual.equals(expected), `${name} content matches \`band generate-skills\``).toBe(
        true,
      );
    }
  });

  it("is a no-op on the second invocation when nothing has changed", async () => {
    const { runFirstTimeSetup } = await import("../src/lib/setup");
    await runFirstTimeSetup();

    const skillsDir = join(process.env.HOME!, ".claude", "skills");
    const path = join(skillsDir, "band", "SKILL.md");
    const beforeStat = statSync(path);
    const beforeMtime = beforeStat.mtimeMs;
    const beforeContent = readFileSync(path);

    // Avoid an mtime collision on filesystems with second-level resolution.
    await new Promise((r) => setTimeout(r, 1100));

    await runFirstTimeSetup();

    const afterStat = statSync(path);
    expect(readFileSync(path).equals(beforeContent), "content is unchanged").toBe(true);
    expect(
      afterStat.mtimeMs,
      "mtime is preserved when content hasn't changed (skipped, not rewritten)",
    ).toBe(beforeMtime);
  });

  it("overwrites a destination whose content drifted from the shipped version", async () => {
    const { runFirstTimeSetup } = await import("../src/lib/setup");

    // Pre-create a tampered SKILL.md before the first sync.
    const skillsDir = join(process.env.HOME!, ".claude", "skills");
    const target = join(skillsDir, "band", "SKILL.md");
    mkdirSync(join(skillsDir, "band"), { recursive: true });
    writeFileSync(target, "# stale local copy that should be overwritten\n", "utf-8");

    await runFirstTimeSetup();

    const expected = expectedSkills!.get("band")!;
    expect(
      readFileSync(target).equals(expected),
      "tampered file replaced with shipped version",
    ).toBe(true);
  });

  it("does not write outside the sandboxed HOME", async () => {
    // Structural guard: if HOME ever stopped pointing at the test tmpdir we
    // could pollute the developer's real ~/.claude/skills. We can't safely
    // inspect the user's HOME from inside the test, so we instead pin the
    // override and verify the destination lands under it.
    const { runFirstTimeSetup } = await import("../src/lib/setup");
    await runFirstTimeSetup();

    expect(process.env.HOME!.startsWith(tmp), "HOME points inside the test tmpdir").toBe(true);
    const path = join(process.env.HOME!, ".claude", "skills", "band", "SKILL.md");
    expect(existsSync(path)).toBe(true);
  });

  it("installs into every enabled agent's global skills dir (claude, codex, opencode, gemini)", async () => {
    // Re-seed settings with all four agent types enabled. We bypass
    // runFirstTimeSetup's CLI / hooks side-effects here and call installSkills
    // directly so the test focuses on the multi-target fan-out — those side
    // effects are exercised by the suite's other cases.
    const { installSkills } = await import("../src/lib/cli-skills");
    const result = await installSkills({
      home: process.env.HOME!,
      agents: [
        { type: "claude-code" },
        { type: "codex" },
        { type: "opencode" },
        { type: "gemini-cli" },
      ],
    });

    const home = process.env.HOME!;
    const expectedDirs = [
      join(home, ".claude", "skills"),
      join(home, ".codex", "skills"),
      join(home, ".config", "opencode", "skills"),
      join(home, ".gemini", "skills"),
    ];
    for (const dir of expectedDirs) {
      for (const name of SKILL_NAMES) {
        const path = join(dir, name, "SKILL.md");
        expect(existsSync(path), `expected ${path} to exist`).toBe(true);
        expect(readFileSync(path).equals(expectedSkills!.get(name)!)).toBe(true);
      }
    }

    // 4 agents × 4 skills = 16 freshly written files (each test gets a new
    // tmp HOME via beforeEach, so nothing should already exist).
    expect(result.written.length).toBe(16);
    expect(result.unchanged.length).toBe(0);
  });

  it("dedupes destinations when multiple agents resolve to the same dir", async () => {
    const { installSkills } = await import("../src/lib/cli-skills");
    const result = await installSkills({
      home: process.env.HOME!,
      // Two claude-code agents (e.g. user has personal + work setups) both
      // point at ~/.claude/skills — we should only write once per skill, not
      // twice.
      agents: [{ type: "claude-code" }, { type: "claude-code" }],
    });

    expect(result.written.length).toBe(SKILL_NAMES.length);
  });

  it("honours $CODEX_HOME when set so codex skills follow the override", async () => {
    const customCodexHome = join(tmp, "custom-codex");
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = customCodexHome;
    try {
      const { installSkills } = await import("../src/lib/cli-skills");
      await installSkills({
        home: process.env.HOME!,
        agents: [{ type: "codex" }],
      });

      for (const name of SKILL_NAMES) {
        const path = join(customCodexHome, "skills", name, "SKILL.md");
        expect(existsSync(path), `expected ${path} to exist under $CODEX_HOME`).toBe(true);
      }
      // And nothing should have landed under the default ~/.codex/skills/.
      expect(existsSync(join(process.env.HOME!, ".codex", "skills", "band", "SKILL.md"))).toBe(
        false,
      );
    } finally {
      if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it("returns no targets for agent types without a known skills dir (cursor-cli)", async () => {
    const { installSkills } = await import("../src/lib/cli-skills");
    const result = await installSkills({
      home: process.env.HOME!,
      agents: [{ type: "cursor-cli" }],
    });

    expect(result.written).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
