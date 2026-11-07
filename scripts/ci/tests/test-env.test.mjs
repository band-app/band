import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureSimulatorTestPrefix,
  scrubWorkerEnv,
  testDevicesIn,
} from "../../test-env.mjs";

const D = "–";
const list = (names) => ({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": names.map((name, i) => ({
      udid: `U${i}`,
      name,
    })),
  },
});

test("scrubWorkerEnv gives a run a band-test prefix and keeps one that is set", () => {
  const env = {};
  scrubWorkerEnv(env);
  assert.match(env.BAND_SIMULATOR_NAME_PREFIX, /^band-test-[0-9a-z]+-\d+$/);
  const first = env.BAND_SIMULATOR_NAME_PREFIX;
  ensureSimulatorTestPrefix(env);
  assert.equal(env.BAND_SIMULATOR_NAME_PREFIX, first);
  const own = { BAND_SIMULATOR_NAME_PREFIX: "mine" };
  scrubWorkerEnv(own);
  assert.equal(own.BAND_SIMULATOR_NAME_PREFIX, "mine");
});

test("testDevicesIn returns only band-test devices, filtered by run prefix or age", () => {
  const now = 1_800_000_000_000;
  const stamp = (ms) => Math.floor(ms / 1000).toString(36);
  const fresh = `band-test-${stamp(now - 60_000)}-11`;
  const old = `band-test-${stamp(now - 5 * 3600_000)}-22`;
  const json = list([
    `${fresh} ${D} wt-a`,
    `${fresh} ${D} base`,
    `${old} ${D} wt-b`,
    `Band ${D} wt-real`,
    "My iPhone",
    `band-test-zz-1 no dash`,
  ]);
  const names = (r) => r.map((d) => d.name);
  assert.deepEqual(names(testDevicesIn(json, { prefix: fresh })), [
    `${fresh} ${D} wt-a`,
    `${fresh} ${D} base`,
  ]);
  assert.deepEqual(names(testDevicesIn(json, { olderThanMs: 3 * 3600_000, now })), [
    `${old} ${D} wt-b`,
  ]);
  assert.equal(testDevicesIn(json, { prefix: "Band" }).length, 0);
});
