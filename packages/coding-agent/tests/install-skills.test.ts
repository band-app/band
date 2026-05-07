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

import { getDefaultAgentBinary, getInstallSkillsDir } from "../src/install-skills.ts";

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

  it("resolves openai-codex to $CODEX_HOME/skills (same as codex)", async () => {
    const dir = await getInstallSkillsDir("openai-codex", HOME);
    assert.equal(dir, "/tmp/band-test-home/.codex/skills");
  });

  it("honours $CODEX_HOME for codex", async () => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/custom/codex/dir";
    const dir = await getInstallSkillsDir("codex", HOME);
    assert.equal(dir, "/custom/codex/dir/skills");
  });

  it("honours $CODEX_HOME for openai-codex", async () => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/custom/codex/dir";
    const dir = await getInstallSkillsDir("openai-codex", HOME);
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

  it("resolves openai-codex to 'codex' (same binary as the CLI Codex adapter)", async () => {
    assert.equal(await getDefaultAgentBinary("openai-codex"), "codex");
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
