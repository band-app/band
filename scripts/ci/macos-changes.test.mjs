// Run: node --test scripts/ci/macos-changes.test.mjs
// Feeds changed-file lists to scripts/ci/macos-changes.sh and checks which
// macOS jobs it turns on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./macos-changes.sh", import.meta.url));
const NAMES = [
  "cli",
  "macos-machine",
  "simulator",
  "desktop",
  "desktop-package",
  "mobile",
  "docker",
  "full-suite",
];

// Changed-file lists of real PRs (gh pr diff <n> --repo band-app/band --name-only).
function fixture(n) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pr-${n}.txt`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);
}

function run(eventName, files, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "macos-changes-"));
  try {
    const list = join(dir, "changed.txt");
    writeFileSync(list, `${files.join("\n")}\n`);
    const env = { PATH: process.env.PATH, EVENT_NAME: eventName, CHANGED_FILES: list, ...extraEnv };
    const result = spawnSync("bash", [script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function on(outputs) {
  return NAMES.filter((n) => outputs[n] === "true");
}

test("every output is always printed", () => {
  assert.deepEqual(Object.keys(run("merge_group", ["README.md"])).sort(), [...NAMES].sort());
});

test("S1: mobile-only change (#1091) sets only mobile", () => {
  const out = run("merge_group", fixture(1091));
  assert.deepEqual(on(out).filter((n) => n !== "docker"), ["mobile"]);
});

test("S1: web UI-only change (#1096) sets no macOS job", () => {
  const out = run("merge_group", fixture(1096));
  assert.deepEqual(on(out).filter((n) => n !== "docker"), []);
});

test("S1: change touching apps/desktop (#1094) sets desktop", () => {
  const out = run("merge_group", fixture(1094));
  assert.equal(out.desktop, "true");
  assert.equal(out["full-suite"], "false");
  assert.equal(out.simulator, "false");
  assert.equal(out.cli, "false");
  assert.equal(out.mobile, "false");
});

test("S1: terminals in host-local set macos-machine", () => {
  const out = run("pull_request", ["packages/host-local/src/terminals/terminal-pool.ts"]);
  assert.equal(out["macos-machine"], "true");
  assert.equal(out.desktop, "false");
  assert.equal(out["full-suite"], "false");
});

test("macos-machine also follows the listed hub tests", () => {
  assert.equal(run("merge_group", ["apps/hub/tests/terminal-ws.test.ts"])["macos-machine"], "true");
  assert.equal(run("merge_group", ["apps/hub/tests/vault.test.ts"])["macos-machine"], "false");
});

test("S1: plugins/simulator sets simulator", () => {
  const out = run("merge_group", ["plugins/simulator/src/worker/stream.ts"]);
  assert.equal(out.simulator, "true");
  assert.equal(out["macos-machine"], "false");
});

test("S1: apps/cli/src sets cli", () => {
  const out = run("merge_group", ["apps/cli/src/main.rs"]);
  assert.equal(out.cli, "true");
  assert.equal(out.desktop, "false");
});

test("S1: the workflow file sets everything", () => {
  const out = run("merge_group", [".github/workflows/ci.yml"]);
  assert.deepEqual(on(out), NAMES);
});

test("S4: schedule and workflow_dispatch set everything", () => {
  assert.deepEqual(on(run("schedule", [])), NAMES);
  assert.deepEqual(on(run("workflow_dispatch", ["README.md"])), NAMES);
});

test("S3: a push to main sets nothing", () => {
  assert.deepEqual(on(run("push", [".github/workflows/ci.yml", "apps/cli/src/main.rs"])), []);
});

test("an empty diff fails open", () => {
  assert.deepEqual(on(run("merge_group", [])), NAMES);
});

test("a missing base fails open", () => {
  const result = spawnSync("bash", [script], {
    env: { PATH: process.env.PATH, EVENT_NAME: "merge_group", BASE: "", HEAD: "abc" },
    encoding: "utf8",
  });
  assert.match(result.stdout, /full-suite=true/);
});
