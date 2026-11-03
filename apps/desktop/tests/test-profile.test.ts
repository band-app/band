import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTestProfile } from "../src/main/services/test-profile.ts";

function fakeApp() {
  const paths: Record<string, string> = {};
  return {
    paths,
    setPath(name: string, path: string) {
      paths[name] = path;
    },
  };
}

test("does nothing when the variable is unset or blank", () => {
  const app = fakeApp();
  assert.equal(applyTestProfile(app, {}), null);
  assert.equal(applyTestProfile(app, { BAND_DESKTOP_USER_DATA_DIR: "  " }), null);
  assert.deepEqual(app.paths, {});
});

test("moves userData, sessionData, logs and crash dumps under the directory", () => {
  const app = fakeApp();
  assert.equal(
    applyTestProfile(app, { BAND_DESKTOP_USER_DATA_DIR: "/tmp/x/profile" }),
    "/tmp/x/profile",
  );
  assert.deepEqual(app.paths, {
    userData: "/tmp/x/profile",
    sessionData: "/tmp/x/profile/session",
    logs: "/tmp/x/profile/logs",
    crashDumps: "/tmp/x/profile/crashDumps",
  });
});

test("refuses a relative path", () => {
  assert.throws(
    () => applyTestProfile(fakeApp(), { BAND_DESKTOP_USER_DATA_DIR: "rel" }),
    /absolute/,
  );
});
