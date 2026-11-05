import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { helperCommand } from "../src/git-credentials.ts";

// A stand-in for the Band.app binary: it "boots the app" (exit 3) unless ELECTRON_RUN_AS_NODE is set.
function fakeElectron(): string {
  const dir = mkdtempSync(join(tmpdir(), "band-helper-"));
  const bin = join(dir, "Band");
  writeFileSync(bin, '#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 3\necho ok "$@"\n');
  chmodSync(bin, 0o755);
  return bin;
}

const run = (command: string) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return execFileSync("sh", ["-c", command.slice(1)], { env, encoding: "utf8" });
};

test("under Electron the helper sets ELECTRON_RUN_AS_NODE itself", () => {
  const bin = fakeElectron();
  assert.equal(
    run(helperCommand(bin, "/w/band-worker.mjs", true)),
    "ok /w/band-worker.mjs git-credential\n",
  );
});

test("a plain Node worker's command is unchanged", () => {
  assert.equal(
    helperCommand("/usr/bin/node", "/w/x.mjs", false),
    "!'/usr/bin/node' '/w/x.mjs' git-credential",
  );
});
