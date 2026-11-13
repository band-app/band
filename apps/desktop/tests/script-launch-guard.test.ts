import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptLaunchRefusal } from "../src/main/services/script-launch-guard.ts";

const band = "/Applications/Band.app/Contents/MacOS/Band";
const script = "/Applications/Band.app/Contents/Resources/worker/band-worker.mjs";

test("refuses a packaged launch whose first argument is a script", () => {
  assert.match(scriptLaunchRefusal([band, script, "status", "--json"], true, {}) ?? "", /refusing/);
});

test("allows normal launches", () => {
  assert.equal(scriptLaunchRefusal([band], true, {}), null);
  assert.equal(scriptLaunchRefusal([band, "/tmp/some.txt"], true, {}), null);
  assert.equal(scriptLaunchRefusal([band, "--flag"], true, {}), null);
});

test("allows an unpackaged launch and a run-as-node launch", () => {
  assert.equal(scriptLaunchRefusal(["electron", "dist/main/index.js"], false, {}), null);
  assert.equal(scriptLaunchRefusal([band, script], true, { ELECTRON_RUN_AS_NODE: "1" }), null);
});
