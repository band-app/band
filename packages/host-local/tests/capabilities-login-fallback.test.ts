import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { probeCapabilities } from "../src/process/capabilities";

describe("capability probe when the login shell fails", () => {
  const root = mkdtempSync(join(tmpdir(), "caps-fallback-"));
  const saved = { ...process.env };
  after(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the process PATH and BAND_AGENT_BIN_DIRS", async () => {
    const shell = join(root, "bad-shell");
    writeFileSync(shell, "#!/bin/sh\nexit 1\n");
    chmodSync(shell, 0o755);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\necho 9.9.9\n");
    chmodSync(claude, 0o755);
    process.env.HOME = root;
    process.env.SHELL = shell;
    process.env.PATH = "/usr/bin:/bin";
    process.env.BAND_AGENT_BIN_DIRS = bin;
    const report = await probeCapabilities(["claude-code", "codex"]);
    assert.equal(report.agents.find((a) => a.type === "claude-code")?.installed, true);
    assert.equal(report.agents.find((a) => a.type === "codex")?.installed, false);
  });
});
