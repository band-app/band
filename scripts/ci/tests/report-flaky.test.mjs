import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectFlaky, issueTitle, parseRuns, planIssues, summary } from "../report-flaky.mjs";
import { parseQuarantine, playwrightFilter, vitestFilter } from "../flaky-quarantine.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../report-flaky.mjs");

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "flaky-report-"));
  mkdirSync(join(dir, "playwright-1"));
  writeFileSync(
    join(dir, "playwright-1", "pw.json"),
    JSON.stringify({
      suites: [
        {
          title: "chat.spec.ts",
          file: "chat.spec.ts",
          specs: [],
          suites: [
            {
              title: "composer",
              specs: [
                { title: "keeps the draft", file: "chat.spec.ts", tests: [{ projectName: "chromium", status: "flaky", results: [{}, {}] }] },
                { title: "stable", file: "chat.spec.ts", tests: [{ projectName: "chromium", status: "expected", results: [{}] }] },
                { title: "broken", file: "chat.spec.ts", tests: [{ projectName: "chromium", status: "unexpected", results: [{}, {}] }] },
              ],
            },
          ],
        },
      ],
    }),
  );
  mkdirSync(join(dir, "hub-1"));
  writeFileSync(
    join(dir, "hub-1", "vitest-hub-1.json"),
    JSON.stringify({ tool: "vitest", tests: [{ file: "apps/hub/tests/a.test.ts", name: "suite › case", retries: 1 }] }),
  );
  writeFileSync(join(dir, "hub-1", "notes.json"), "not json");
  return dir;
}

const ctx = { runUrl: "https://github.com/band-app/band/actions/runs/42", event: "merge_group", date: "2026-11-04" };

test("collects the flaky tests of both tools and ignores failures and passes", () => {
  const flaky = collectFlaky(fixtureDir());
  assert.deepEqual(
    flaky.map((t) => t.id),
    ["apps/hub/tests/a.test.ts › suite › case", "apps/web/e2e/chat.spec.ts › composer › keeps the draft"],
  );
});

test("plans one new issue per flaky test with the run link and a count", () => {
  const plan = planIssues(collectFlaky(fixtureDir()), [], ctx);
  assert.equal(plan.length, 2);
  for (const p of plan) {
    assert.equal(p.action, "create");
    assert.match(p.title, /^flaky: /);
    assert.match(p.body, /Flaked in 1 run\./);
    assert.ok(p.body.includes(ctx.runUrl));
  }
});

test("updates an open issue, counts the new run once, and leaves a repeated run alone", () => {
  const [test1] = collectFlaky(fixtureDir());
  const first = planIssues([test1], [], ctx)[0];
  const existing = [{ number: 7, title: issueTitle(test1), body: first.body }];
  const later = { ...ctx, runUrl: "https://github.com/band-app/band/actions/runs/43", date: "2026-11-05" };
  const [update] = planIssues([test1], existing, later);
  assert.equal(update.action, "update");
  assert.equal(update.number, 7);
  assert.equal(update.count, 2);
  assert.equal(parseRuns(update.body).length, 2);
  assert.equal(planIssues([test1], existing, ctx)[0].action, "none");
});

test("summary lists the tests and the run", () => {
  const text = summary(collectFlaky(fixtureDir()), ctx);
  assert.match(text, /2 tests passed only on retry/);
  assert.match(text, /composer › keeps the draft/);
  assert.equal(summary([], ctx), "No test passed only on retry in this run.\n");
});

test("the command prints the payloads in dry run and calls no API", () => {
  const out = execFileSync(process.execPath, [script, "--results", fixtureDir()], {
    encoding: "utf8",
    // gh is not on PATH, so any API call would fail the run.
    env: { PATH: "/nonexistent", GITHUB_RUN_ID: "42", GITHUB_REPOSITORY: "band-app/band" },
  });
  assert.match(out, /Dry run, no issues filed/);
  assert.match(out, /"action": "create"/);
});

test("quarantine entries become filters", () => {
  const entries = parseQuarantine("# comment\napps/web/e2e/chat.spec.ts › composer › keeps the draft  # 12\n\napps/hub/tests/a.test.ts › suite › case # 13\n");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].issue, 12);
  const pw = playwrightFilter([entries[0]], "exclude");
  assert.ok(pw.grepInvert.test("chromium e2e/chat.spec.ts composer keeps the draft"));
  assert.ok(!pw.grepInvert.test("chromium e2e/chat.spec.ts composer other"));
  assert.ok(playwrightFilter([entries[0]], "only").grep.test("chromium e2e/chat.spec.ts composer keeps the draft"));
  assert.ok(!playwrightFilter([], "only").grep.test("anything"));
  const vt = vitestFilter([{ ...entries[1], file: "tests/a.test.ts" }], "exclude");
  assert.ok(!new RegExp(vt.testNamePattern).test("suite case"));
  assert.ok(new RegExp(vt.testNamePattern).test("suite other"));
  assert.deepEqual(vitestFilter([{ ...entries[1], file: "tests/a.test.ts" }], "only").include, ["tests/a.test.ts"]);
  assert.deepEqual(vitestFilter(entries, "off"), {});
});
