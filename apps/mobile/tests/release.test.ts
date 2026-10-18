import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildUrls,
  detect,
  previousTag,
  setVersion,
  ship,
  submissionUrls,
} from "../scripts/release.mjs";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A repo with tag v1.0.0, then a commit touching `changed`, then tag v1.1.0. */
function repoWithTwoTags(changed: string): string {
  const repo = mkdtempSync(join(tmpdir(), "release-test-"));
  git(repo, "init", "-q");
  mkdirSync(join(repo, "apps/hub"), { recursive: true });
  writeFileSync(join(repo, "apps/hub/a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");
  git(repo, "tag", "v1.0.0");
  mkdirSync(join(repo, changed, ".."), { recursive: true });
  writeFileSync(join(repo, changed), "b");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "two");
  git(repo, "tag", "v1.1.0");
  return repo;
}

describe("detect", () => {
  it("ships on always and skips on skip", () => {
    const repo = repoWithTwoTags("apps/hub/b.txt");
    assert.equal(detect({ mode: "always", tag: "v1.1.0", repo }).ship, true);
    assert.equal(detect({ mode: "skip", tag: "v1.1.0", repo }).ship, false);
  });

  it("auto ships when mobile code changed since the previous tag", () => {
    for (const file of [
      "apps/mobile/src/x.ts",
      "packages/client/x.ts",
      "packages/shared/x.ts",
      "pnpm-lock.yaml",
    ]) {
      const repo = repoWithTwoTags(file);
      const decision = detect({ mode: "auto", tag: "v1.1.0", repo });
      assert.equal(decision.ship, true, file);
      assert.match(decision.reason, /v1\.0\.0/);
    }
  });

  it("auto skips and says why when nothing mobile changed", () => {
    const repo = repoWithTwoTags("apps/hub/b.txt");
    const decision = detect({ mode: "auto", tag: "v1.1.0", repo });
    assert.equal(decision.ship, false);
    assert.match(decision.reason, /no mobile changes between v1\.0\.0 and v1\.1\.0/);
  });

  it("auto ships when there is no earlier tag", () => {
    const repo = repoWithTwoTags("apps/hub/b.txt");
    assert.equal(previousTag(repo, "v1.0.0"), null);
    assert.equal(detect({ mode: "auto", tag: "v1.0.0", repo }).ship, true);
  });

  it("rejects an unknown mode", () => {
    const repo = repoWithTwoTags("apps/hub/b.txt");
    assert.throws(() => detect({ mode: "nope", tag: "v1.1.0", repo }));
  });
});

describe("setVersion", () => {
  it("writes expo.version and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-test-"));
    const file = join(dir, "app.json");
    writeFileSync(file, JSON.stringify({ expo: { name: "Band", version: "0.1.0" } }));
    setVersion(file, "2.3.4");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      expo: { name: "Band", version: "2.3.4" },
    });
    assert.throws(() => setVersion(file, "2.3"));
  });
});

describe("ship", () => {
  /** An executable `eas` that logs its arguments and fails for the platform in FAIL_PLATFORM. */
  function stubEas(dir: string): string {
    const bin = join(dir, "eas-stub.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.EAS_LOG, args.join(" ") + "\\n");
const platform = args[args.indexOf("--platform") + 1];
if (platform === process.env.FAIL_PLATFORM) { console.error("build failed"); process.exit(1); }
const base = "https://expo.dev/accounts/band/projects/band/";
console.error("See logs: " + base + "builds/b-" + platform);
if (platform === "ios") console.error("Submission details: " + base + "submissions/s-ios");
console.log("Build [production] queued\\n" + JSON.stringify([{ buildDetailsPageUrl: base + "builds/b-" + platform }], null, 2));
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "release-test-"));
    writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { version: "0.1.0" } }));
    process.env.EAS_BIN = stubEas(dir);
    process.env.EAS_LOG = join(dir, "eas.log");
    return dir;
  }

  it("sets the version, builds both platforms and collects the run URLs", async () => {
    const dir = setup();
    delete process.env.FAIL_PLATFORM;
    const result = await ship({ version: "1.2.3", appDir: dir });
    assert.equal(result.ok, true);
    const base = "https://expo.dev/accounts/band/projects/band/";
    assert.deepEqual(result.urls, [
      `[iOS](${base}builds/b-ios)`,
      `[iOS-TestFlight-submission](${base}submissions/s-ios)`,
      `[Android](${base}builds/b-android)`,
    ]);
    assert.match(result.lines[0], /builds\/b-ios .*submissions\/s-ios/);
    assert.equal(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")).expo.version, "1.2.3");
    const log = readFileSync(process.env.EAS_LOG as string, "utf8");
    assert.match(
      log,
      /build --platform ios --profile production --auto-submit --non-interactive --json/,
    );
    assert.match(log, /build --platform android --profile preview --non-interactive --json/);
  });

  it("fails when a build fails and still lists the other run", async () => {
    const dir = setup();
    process.env.FAIL_PLATFORM = "ios";
    const result = await ship({ version: "1.2.3", appDir: dir });
    delete process.env.FAIL_PLATFORM;
    assert.equal(result.ok, false);
    assert.match(result.lines[0], /^FAILED iOS/);
    assert.match(result.lines[1], /^ok Android.*android/);
  });
});

describe("ship through the CLI", () => {
  it("writes urls to GITHUB_OUTPUT and names them in the summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-test-"));
    const bin = join(dir, "eas-stub.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const platform = process.argv[process.argv.indexOf("--platform") + 1];
const base = "https://expo.dev/accounts/band/projects/band/";
console.error("See logs: " + base + "builds/b-" + platform);
if (platform === "ios") console.error("Submission details: " + base + "submissions/s-ios");
console.log("Build [production] queued\\n[" + JSON.stringify({ buildDetailsPageUrl: base + "builds/b-" + platform }) + "]");
`,
    );
    chmodSync(bin, 0o755);
    const out = join(dir, "output");
    const sum = join(dir, "summary");
    // The script rewrites apps/mobile/app.json, so restore it afterwards.
    const appJson = join(import.meta.dirname, "..", "app.json");
    const original = readFileSync(appJson, "utf8");
    try {
      execFileSync(
        process.execPath,
        [join(import.meta.dirname, "..", "scripts", "release.mjs"), "ship", "--version", "1.2.3"],
        {
          env: { ...process.env, EAS_BIN: bin, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum },
          stdio: "ignore",
        },
      );
    } finally {
      writeFileSync(appJson, original);
    }
    const base = "https://expo.dev/accounts/band/projects/band/";
    const urls = readFileSync(out, "utf8").trim();
    assert.equal(
      urls,
      `urls=[iOS](${base}builds/b-ios) [iOS-TestFlight-submission](${base}submissions/s-ios) [Android](${base}builds/b-android)`,
    );
    const summary = readFileSync(sum, "utf8");
    assert.match(summary, /builds\/b-ios/);
    assert.match(summary, /submissions\/s-ios/);
    assert.match(summary, /builds\/b-android/);
  });
});

describe("buildUrls", () => {
  const base = "https://expo.dev/accounts/band/projects/band/builds/abc-123";

  it("parses the JSON array that follows log text containing brackets", () => {
    const stdout = `Build [production] queued, see [docs]\n[{"buildDetailsPageUrl":"${base}"}]\n`;
    assert.deepEqual(buildUrls(stdout), [base]);
  });

  it("parses a pretty-printed array after bracketed log text", () => {
    const stdout = `[eas] uploading\n${JSON.stringify([{ buildDetailsPageUrl: base }], null, 2)}\n`;
    assert.deepEqual(buildUrls(stdout), [base]);
  });

  it("falls back to the See logs lines in stderr", () => {
    const stderr = `Build in progress...\nSee logs: ${base}\n`;
    assert.deepEqual(buildUrls("not json [", stderr), [base]);
  });

  it("finds submission URLs", () => {
    const sub = "https://expo.dev/accounts/band/projects/band/submissions/s-1";
    assert.deepEqual(submissionUrls("", `Submission details: ${sub}\n`), [sub]);
  });

  it("reads URLs and tolerates other output", () => {
    assert.deepEqual(buildUrls('noise\n[{"buildDetailsPageUrl":"https://x"}]'), ["https://x"]);
    assert.deepEqual(buildUrls("not json"), []);
  });
});
