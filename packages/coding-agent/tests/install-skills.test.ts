/**
 * Tests for the agent → install-skills-dir dispatcher
 * (`packages/coding-agent/src/install-skills.ts`).
 *
 * Run with the package's standard `pnpm test` setup (node:test + the loader
 * that redirects optional adapter SDK imports to local mocks). We deliberately
 * use a synthetic temp `home` so the assertions don't depend on the real
 * filesystem — and so the `CODEX_HOME` env override is exercised in a way
 * that doesn't pollute the developer's actual config.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getAgentConfigDir,
  getDefaultAgentBinary,
  getInstallSkillsDir,
  getSharedSkillsDir,
  SUPPORTED_AGENT_TYPES,
} from "../src/install-skills.ts";

const HOME = "/tmp/band-test-home";

describe("getInstallSkillsDir", () => {
  let originalCodexHome: string | undefined;

  afterEach(() => {
    if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
    else delete process.env.CODEX_HOME;
    originalCodexHome = undefined;
  });

  it("resolves claude-code to ~/.claude/skills", async () => {
    const dir = await getInstallSkillsDir("claude-code", HOME);
    assert.equal(dir, "/tmp/band-test-home/.claude/skills");
  });

  it("resolves codex to $CODEX_HOME/skills (default ~/.codex/skills)", async () => {
    const dir = await getInstallSkillsDir("codex", HOME);
    assert.equal(dir, "/tmp/band-test-home/.codex/skills");
  });

  it("honours $CODEX_HOME for codex", async () => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/custom/codex/dir";
    const dir = await getInstallSkillsDir("codex", HOME);
    assert.equal(dir, "/custom/codex/dir/skills");
  });

  it("resolves gemini-cli to ~/.gemini/skills", async () => {
    const dir = await getInstallSkillsDir("gemini-cli", HOME);
    assert.equal(dir, "/tmp/band-test-home/.gemini/skills");
  });

  it("resolves opencode to ~/.config/opencode/skills (highest-priority global)", async () => {
    const dir = await getInstallSkillsDir("opencode", HOME);
    assert.equal(dir, "/tmp/band-test-home/.config/opencode/skills");
  });

  it("returns null for cursor-cli (no documented global skills dir)", async () => {
    const dir = await getInstallSkillsDir("cursor-cli", HOME);
    assert.equal(dir, null);
  });

  it("returns null for an unknown agent type without throwing", async () => {
    const dir = await getInstallSkillsDir("future-agent-9000", HOME);
    assert.equal(dir, null);
  });
});

describe("getDefaultAgentBinary", () => {
  it("resolves claude-code to 'claude'", async () => {
    assert.equal(await getDefaultAgentBinary("claude-code"), "claude");
  });

  it("resolves codex to 'codex'", async () => {
    assert.equal(await getDefaultAgentBinary("codex"), "codex");
  });

  it("resolves gemini-cli to 'gemini'", async () => {
    assert.equal(await getDefaultAgentBinary("gemini-cli"), "gemini");
  });

  it("resolves opencode to 'opencode'", async () => {
    assert.equal(await getDefaultAgentBinary("opencode"), "opencode");
  });

  it("returns null for cursor-cli (no defined binary in this dispatcher yet)", async () => {
    assert.equal(await getDefaultAgentBinary("cursor-cli"), null);
  });

  it("returns null for an unknown agent type without throwing", async () => {
    assert.equal(await getDefaultAgentBinary("future-agent-9000"), null);
  });
});

describe("getSharedSkillsDir", () => {
  it("returns ~/.agents/skills under the provided home", () => {
    assert.equal(getSharedSkillsDir(HOME), "/tmp/band-test-home/.agents/skills");
  });
});

describe("getAgentConfigDir", () => {
  let originalCodexHome: string | undefined;

  afterEach(() => {
    if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
    else delete process.env.CODEX_HOME;
    originalCodexHome = undefined;
  });

  it("resolves claude-code to ~/.claude", () => {
    assert.equal(getAgentConfigDir("claude-code", HOME), "/tmp/band-test-home/.claude");
  });

  it("resolves codex to ~/.codex (default, no env override)", () => {
    delete process.env.CODEX_HOME;
    assert.equal(getAgentConfigDir("codex", HOME), "/tmp/band-test-home/.codex");
  });

  it("honours $CODEX_HOME for codex", () => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/custom/codex";
    assert.equal(getAgentConfigDir("codex", HOME), "/custom/codex");
  });

  it("resolves gemini-cli to ~/.gemini", () => {
    assert.equal(getAgentConfigDir("gemini-cli", HOME), "/tmp/band-test-home/.gemini");
  });

  it("resolves opencode to ~/.config/opencode", () => {
    assert.equal(getAgentConfigDir("opencode", HOME), "/tmp/band-test-home/.config/opencode");
  });

  it("returns null for cursor-cli (no documented config dir wired up)", () => {
    assert.equal(getAgentConfigDir("cursor-cli", HOME), null);
  });

  it("returns null for an unknown type without throwing", () => {
    assert.equal(getAgentConfigDir("future-agent-9000", HOME), null);
  });
});

describe("SUPPORTED_AGENT_TYPES", () => {
  /**
   * Drift guard: this list and the Rust `SUPPORTED_AGENTS` in
   * `apps/cli/src/skills.rs` must stay identical. The web server's
   * boot-time install and the CLI's `band skills install` both read
   * their own copy; if a new agent is added to one side and not the
   * other, the two install paths silently disagree.
   *
   * Mirrored on the Rust side by a matching `#[test]` in skills.rs.
   * Touching one list without the other now fails *that side's* test
   * suite, which CI gates on. Order matters: the value below is also
   * the iteration order both dispatchers use for stable agent-detection
   * priority.
   */
  it("matches the canonical list (mirrored in Rust SUPPORTED_AGENTS)", () => {
    assert.deepEqual(
      [...SUPPORTED_AGENT_TYPES],
      ["claude-code", "codex", "gemini-cli", "opencode"],
      "TS SUPPORTED_AGENT_TYPES drifted from the canonical list; update both this " +
        "tuple and apps/cli/src/skills.rs::SUPPORTED_AGENTS (plus the matching test on " +
        "each side) when adding/removing an agent",
    );
  });

  it("only lists agent types that have a documented install-skills dir", async () => {
    for (const type of SUPPORTED_AGENT_TYPES) {
      const dir = await getInstallSkillsDir(type, HOME);
      assert.ok(
        dir,
        `expected SUPPORTED_AGENT_TYPES entry '${type}' to have an install-skills dir`,
      );
    }
  });

  it("excludes cursor-cli (no skills dir today)", () => {
    assert.ok(!SUPPORTED_AGENT_TYPES.includes("cursor-cli" as never));
  });
});
