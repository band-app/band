import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { probeCapabilities } from "../src/process/capabilities";

describe("capability probe and the login-shell PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "caps-login-"));
  const shims = join(root, "shims");
  const saved = { ...process.env };

  before(() => {
    mkdirSync(shims, { recursive: true });
    for (const [bin, v] of [
      ["claude", "1.2.3 (Claude Code)"],
      ["codex", "codex-cli 4.5.6"],
    ]) {
      const file = join(shims, bin as string);
      writeFileSync(file, `#!/bin/sh\necho "${v}"\n`);
      chmodSync(file, 0o755);
    }
    // A stand-in login shell that prints a PATH holding the shims.
    const shell = join(root, "fake-shell");
    writeFileSync(shell, `#!/bin/sh\necho "${shims}:/usr/bin:/bin"\n`);
    chmodSync(shell, 0o755);
    process.env.HOME = root;
    process.env.SHELL = shell;
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.BAND_AGENT_BIN_DIRS;
  });

  after(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("reports agents found only on the login-shell PATH as installed", async () => {
    const report = await probeCapabilities(["claude-code", "codex"]);
    const byType = Object.fromEntries(report.agents.map((a) => [a.type, a]));
    assert.equal(byType["claude-code"]?.installed, true);
    assert.equal(byType["claude-code"]?.version, "1.2.3");
    assert.equal(byType.codex?.installed, true);
    assert.equal(byType.codex?.version, "4.5.6");
  });

  it("still honours BAND_AGENT_BIN_DIRS", async () => {
    const extra = join(root, "extra");
    mkdirSync(extra);
    const file = join(extra, "opencode");
    writeFileSync(file, "#!/bin/sh\necho 7.8.9\n");
    chmodSync(file, 0o755);
    process.env.BAND_AGENT_BIN_DIRS = extra;
    const report = await probeCapabilities(["opencode"]);
    assert.equal(report.agents[0]?.installed, true);
  });
});
