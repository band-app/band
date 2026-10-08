import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ChromiumManager } from "../src/browser/chromium";

// A fake Chromium (a node script) stands in for the binary, through BAND_CHROMIUM_BIN. Launch 1 takes the
// profile's SingletonLock and hangs without a port. A later launch hangs too while a lock is present, as a
// real Chromium does when it hands off to a dead owner, and otherwise writes DevToolsActivePort.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_STATE_DIR;
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
const n = fs.readdirSync(dir).filter((f) => f.startsWith("launch-")).length + 1;
fs.writeFileSync(path.join(dir, "launch-" + n), String(process.pid));
const lock = path.join(profile, "SingletonLock");
const hang = () => setInterval(() => {}, 1000);
if (n === 1) {
  fs.symlinkSync("fake-host-" + process.pid, lock);
  hang();
} else if (fs.existsSync(lock)) {
  hang();
} else {
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "9222\\n/devtools/browser/fake\\n");
  hang();
}
`;

describe("ChromiumManager launch retry", () => {
  let dir: string;
  const saved = { ...process.env };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "band-chromium-retry-"));
    const bin = join(dir, "fake-chromium");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    mkdirSync(join(dir, "state"));
    process.env.BAND_CHROMIUM_BIN = bin;
    process.env.BAND_CHROMIUM_START_TIMEOUT_MS = "1000";
    process.env.FAKE_STATE_DIR = join(dir, "state");
  });

  after(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills a hung first launch, clears its lock and starts on the second", async () => {
    const manager = new ChromiumManager(() => join(dir, "profiles"));
    const info = await manager.open({ worktreeId: "wt-retry", headless: true });
    assert.equal(info.port, 9222);
    const first = Number(readFileSync(join(dir, "state", "launch-1"), "utf8"));
    assert.throws(() => process.kill(first, 0), "the first browser is gone");
    assert.ok(existsSync(join(dir, "state", "launch-2")), "a second launch ran");
    assert.ok(!existsSync(join(dir, "state", "launch-3")), "and it was enough");
    assert.ok(!existsSync(join(info.profileDir, "SingletonLock")));
    await manager.close("wt-retry");
  });
});
