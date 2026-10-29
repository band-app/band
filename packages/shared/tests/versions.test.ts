import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  compatibilityProblem,
  hubUpdateCommand,
  isStrictSemver,
  parseInstallMethod,
  relationToHub,
  workerVersionOf,
} from "../src/versions.ts";

test("only plain MAJOR.MINOR.PATCH is strict semver", () => {
  for (const ok of ["0.50.0", "1.2.3", "10.0.11"]) assert.equal(isStrictSemver(ok), true, ok);
  for (const bad of ["v1.2.3", "1.2", "1.2.3-rc.1", "01.2.3", "1.2.3; rm -rf /", "$(id)", "", 5]) {
    assert.equal(isStrictSemver(bad), false, String(bad));
  }
});

test("versions compare numerically, not as text", () => {
  assert.ok((compareVersions("0.9.0", "0.50.0") as number) < 0);
  assert.equal(compareVersions("0.50.0", "v0.50.0"), 0);
  assert.equal(compareVersions("nonsense", "0.50.0"), null);
});

test("a worker within one minor of the hub connects, further is refused with a reason", () => {
  assert.equal(compatibilityProblem("0.49.7", "0.50.0"), null);
  assert.equal(compatibilityProblem("0.51.0", "0.50.0"), null);
  assert.equal(compatibilityProblem("0.50.3", "0.50.0"), null);
  assert.equal(
    compatibilityProblem("0.47.0", "0.50.0"),
    "worker 0.47.0 is too old for hub 0.50.0, update it to 0.50.0",
  );
  assert.match(compatibilityProblem("0.53.0", "0.50.0") ?? "", /too new for hub 0\.50\.0/);
  assert.match(compatibilityProblem("0.50.0", "1.0.0") ?? "", /too old/);
});

test("an unknown version is never refused", () => {
  assert.equal(compatibilityProblem(null, "0.50.0"), null);
  assert.equal(compatibilityProblem("0.1.0", "dev"), null);
});

test("the worker version comes from the field, else from the build id", () => {
  assert.equal(workerVersionOf({ version: "0.50.0", buildId: "x" }), "0.50.0");
  assert.equal(workerVersionOf({ buildId: "band-worker@0.48.1" }), "0.48.1");
  assert.equal(workerVersionOf({ buildId: "test-build" }), null);
});

test("relation to the hub", () => {
  assert.equal(relationToHub("0.49.0", "0.50.0"), "behind");
  assert.equal(relationToHub("0.50.0", "0.50.0"), "current");
  assert.equal(relationToHub("0.51.0", "0.50.0"), "ahead");
  assert.equal(relationToHub(null, "0.50.0"), "unknown");
});

test("the update command follows the install method", () => {
  assert.match(hubUpdateCommand("compose", "0.51.0"), /docker compose pull/);
  assert.match(hubUpdateCommand("compose", "0.51.0"), /BAND_VERSION=0\.51\.0/);
  assert.equal(
    hubUpdateCommand("npm", "0.51.0"),
    "npm i -g @band-app/server@0.51.0 && systemctl --user restart band-hub",
  );
  assert.match(hubUpdateCommand("helm", "0.51.0"), /helm upgrade .*--set image\.tag=0\.51\.0/);
  assert.match(hubUpdateCommand("k8s", "0.51.0"), /kubectl set image .*band-hub:0\.51\.0/);
  assert.match(
    hubUpdateCommand("docker", "0.51.0"),
    /docker pull ghcr\.io\/band-app\/band-hub:0\.51\.0/,
  );
  assert.equal(
    hubUpdateCommand(null, "0.51.0"),
    "Pull ghcr.io/band-app/band-hub:0.51.0 and recreate the container.",
  );
});

test("install methods parse case-insensitively and reject the unknown", () => {
  assert.equal(parseInstallMethod("Compose"), "compose");
  assert.equal(parseInstallMethod("nope"), null);
  assert.equal(parseInstallMethod(undefined), null);
});
