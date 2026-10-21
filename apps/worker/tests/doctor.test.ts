import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { formatHostWarnings, hostWarnings, readLinuxHostSettings } from "../src/host-checks.ts";
import { cleanup, tmpDir, WORKER_BIN } from "./helpers.ts";

/** A stub CLI that prints a version and answers its login command with `loginExit`. */
function stubCli(dir: string, name: string, version: string, loginArgs: string, loginExit: number) {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${name} ${version}"; exit 0; fi
if [ "$*" = "${loginArgs}" ]; then exit ${loginExit}; fi
exit 0
`,
  );
  chmodSync(file, 0o755);
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = tmpDir(prefix);
  dirs.push(dir);
  return dir;
}

function doctor(bin: string) {
  const home = tempDir("band-doctor-home-");
  return spawnSync(process.execPath, [WORKER_BIN, "doctor"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      BAND_HOME: join(home, ".band"),
      BAND_AGENT_BIN_DIRS: bin,
      // Keys that would count as a login must not leak in from the machine running the test.
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      OPENAI_API_KEY: "",
      BAND_WORKER_TOKEN: "",
    },
  });
}

describe("band-worker doctor", () => {
  after(() => cleanup(...dirs));

  it("prints installed and logged in per agent, with a fix command for each gap", () => {
    const bin = tempDir("band-doctor-bin-");
    mkdirSync(bin, { recursive: true });
    stubCli(bin, "claude", "2.4.1", "auth status", 0);
    stubCli(bin, "codex", "0.9.0", "login status", 1);
    const run = doctor(bin);
    const lines = run.stdout.split("\n");
    const claude = lines.find((l) => l.includes("claude-code"));
    assert.match(claude ?? "", /^ok\s+claude-code\s+2\.4\.1\s+installed, logged in/);
    const codex = lines.findIndex((l) => l.includes("codex"));
    assert.match(lines[codex], /^FAIL\s+codex\s+0\.9\.0\s+installed, not logged in/);
    assert.match(lines[codex + 1], /fix: codex login/);
  });

  it("shows the login fix when the stub agent is not logged in", () => {
    const bin = tempDir("band-doctor-bin-");
    stubCli(bin, "claude", "2.4.1", "auth status", 1);
    const run = doctor(bin);
    assert.match(run.stdout, /fix: claude auth login/);
  });

  it("ends with the host warnings for this machine and exits 0 with a usable agent", () => {
    const bin = tempDir("band-doctor-bin-");
    stubCli(bin, "claude", "2.4.1", "auth status", 0);
    const run = doctor(bin);
    // The machine running the test decides which warnings apply, so the expected block is read
    // from its /proc. On a host with swap and a high watch limit (GitHub's runners) the block is
    // empty and only its absence is checked. Fake values are covered in host-checks.test.ts.
    const expected =
      platform() === "linux" ? formatHostWarnings(hostWarnings(readLinuxHostSettings())) : "";
    if (expected) assert.ok(run.stdout.endsWith(expected), run.stdout);
    else assert.doesNotMatch(run.stdout, /^WARN worker/m);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
