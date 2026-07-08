/**
 * Integration tests for scripts/generate-homebrew-cask.mjs.
 *
 * Black-box: the script is a CLI that validates its args and prints a
 * Homebrew cask definition to stdout (the release workflow redirects that
 * into a clone of band-app/homebrew-band and pushes it). We exercise it as
 * a child process — the same way the workflow invokes it — and assert on
 * exit code, stdout, and stderr. A regression in argument validation or the
 * Ruby template would otherwise silently push a malformed cask to the tap.
 *
 * The script lives in the repo-root scripts/ dir; its test lives here
 * because apps/desktop is the workspace package whose `test` script globs
 * tests/**\/*.test.mjs and runs under CI's `pnpm test`.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/generate-homebrew-cask.mjs", import.meta.url),
);

const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);

/** Run the generator with the given argv array; return { status, stdout, stderr }. */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  return result;
}

const VALID_ARGS = [
  "--version",
  "0.26.1",
  "--arm-sha",
  ARM_SHA,
  "--intel-sha",
  INTEL_SHA,
];

describe("generate-homebrew-cask", () => {
  test("valid args render a cask containing version, shas, and urls", () => {
    const { status, stdout } = run(VALID_ARGS);
    assert.equal(status, 0);

    // Version, both arch shas, and both download URLs are interpolated.
    assert.match(stdout, /cask "band" do/);
    assert.match(stdout, /version "0\.26\.1"/);
    assert.ok(stdout.includes(`sha256 "${ARM_SHA}"`), "arm sha present");
    assert.ok(stdout.includes(`sha256 "${INTEL_SHA}"`), "intel sha present");
    assert.ok(
      stdout.includes("Band-#{version}-apple-silicon.dmg"),
      "arm url present",
    );
    assert.ok(stdout.includes("Band-#{version}-intel.dmg"), "intel url present");

    // Fix [1]: the app self-updates via Squirrel, so `auto_updates true` owns
    // upgrades and there is no (redundant, contradictory) livecheck block.
    assert.ok(stdout.includes("auto_updates true"), "auto_updates retained");
    assert.equal(
      stdout.includes("livecheck do"),
      false,
      "unexpected livecheck block in output",
    );
  });

  test("missing --version exits 1 with a meaningful message", () => {
    const { status, stderr } = run([
      "--arm-sha",
      ARM_SHA,
      "--intel-sha",
      INTEL_SHA,
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /version/i);
  });

  test("malformed --version exits 1", () => {
    const { status, stderr } = run([
      "--version",
      "not-semver",
      "--arm-sha",
      ARM_SHA,
      "--intel-sha",
      INTEL_SHA,
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /version/i);
  });

  test("missing --arm-sha exits 1", () => {
    const { status, stderr } = run(["--version", "0.26.1", "--intel-sha", INTEL_SHA]);
    assert.equal(status, 1);
    assert.match(stderr, /sha/i);
  });

  test("missing --intel-sha exits 1", () => {
    const { status, stderr } = run(["--version", "0.26.1", "--arm-sha", ARM_SHA]);
    assert.equal(status, 1);
    assert.match(stderr, /sha/i);
  });

  // Both sha flags share one validation path, but exercise each independently
  // so a regression touching only one branch can't hide behind the other.
  // One test() per bad shape so the first failure doesn't mask the rest.
  const BAD_SHAS = {
    "too short": "abc",
    uppercase: "A".repeat(64),
    "non-hex char": `${"a".repeat(63)}g`,
    "too long": "a".repeat(65),
  };
  for (const flag of ["--arm-sha", "--intel-sha"]) {
    for (const [shape, bad] of Object.entries(BAD_SHAS)) {
      test(`${flag} that is ${shape} exits 1`, () => {
        const otherFlag = flag === "--arm-sha" ? "--intel-sha" : "--arm-sha";
        const good = flag === "--arm-sha" ? INTEL_SHA : ARM_SHA;
        const { status, stderr } = run([
          "--version",
          "0.26.1",
          flag,
          bad,
          otherFlag,
          good,
        ]);
        assert.equal(status, 1);
        assert.match(stderr, /sha/i);
      });
    }
  }

  test("a flag with no following value exits 1 with a requires-a-value message", () => {
    const { status, stderr } = run([
      "--arm-sha",
      ARM_SHA,
      "--intel-sha",
      INTEL_SHA,
      "--version",
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /--version requires a value/);
  });

  test("an unknown argument exits 1", () => {
    const { status, stderr } = run([...VALID_ARGS, "--bogus"]);
    assert.equal(status, 1);
    assert.match(stderr, /unknown argument/i);
  });
});
