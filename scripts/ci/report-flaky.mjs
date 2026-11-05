#!/usr/bin/env node
// Collects the tests that failed and then passed on a CI retry and reports them.
//
//   node scripts/ci/report-flaky.mjs --results <dir> [--apply]
//
// Reads every .json file under <dir>: Playwright JSON reports (a spec with status "flaky")
// and the files scripts/ci/vitest-flaky-reporter.mjs writes. Prints a summary (and appends
// it to $GITHUB_STEP_SUMMARY). Without --apply it also prints the issue payloads and calls no
// API. With --apply it files or updates one GitHub issue per flaky test through `gh`.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SEPARATOR = " › ";
export const LABEL = "flaky";
const WEB_E2E_PREFIX = "apps/web/e2e/";

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...jsonFiles(path));
    else if (name.endsWith(".json")) out.push(path);
  }
  return out;
}

function playwrightFlaky(report) {
  const found = [];
  const walk = (suite, titles, file) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== "flaky") continue;
        found.push({
          file: `${WEB_E2E_PREFIX}${spec.file ?? file}`,
          name: [...titles, spec.title].join(SEPARATOR),
          retries: Math.max(0, (test.results?.length ?? 2) - 1),
          project: test.projectName,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title], file);
  };
  for (const top of report.suites ?? []) {
    // A top-level suite is the spec file; its title is the file name, not a describe block.
    for (const spec of top.specs ?? []) walk({ specs: [spec] }, [], top.file ?? top.title);
    for (const child of top.suites ?? []) walk(child, [child.title], top.file ?? top.title);
  }
  return found;
}

/** Every flaky test found under `dir`, one entry per test id with the number of times it was seen. */
export function collectFlaky(dir) {
  const byId = new Map();
  for (const path of jsonFiles(dir)) {
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const tests = Array.isArray(data.tests) ? data.tests : Array.isArray(data.suites) ? playwrightFlaky(data) : [];
    for (const t of tests) {
      const id = `${t.file}${SEPARATOR}${t.name}`;
      const entry = byId.get(id) ?? { id, file: t.file, name: t.name, seen: 0, projects: [] };
      entry.seen += 1;
      if (t.project && !entry.projects.includes(t.project)) entry.projects.push(t.project);
      byId.set(id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const issueTitle = (test) => `flaky: ${test.id}`;

const RUN_LINE = /^- (\d{4}-\d{2}-\d{2}) (https?:\/\/\S+)/;

/** The run lines of an existing issue body, oldest first. */
export function parseRuns(body) {
  return (body ?? "")
    .split("\n")
    .map((line) => line.match(RUN_LINE))
    .filter(Boolean)
    .map((m) => ({ date: m[1], url: m[2], line: m[0] }));
}

export function issueBody(test, runs) {
  return [
    "This test failed and then passed on its retry in CI, so it did not block a merge.",
    "A retried pass is a bug: fix the race (see TEST-36 to TEST-45 in `.claude/testing-criteria.md`) and close this issue.",
    "A test that flakes 3 or more times in 7 days goes on `.github/flaky-quarantine.txt` with this issue number.",
    "",
    `Test: \`${test.id}\``,
    `Flaked in ${runs.length} run${runs.length === 1 ? "" : "s"}.`,
    "",
    "Runs:",
    ...runs.map((r) => r.line),
    "",
  ].join("\n");
}

/**
 * What to do for each flaky test. `existing` is the list of open issues with the flaky label
 * ({ number, title, body }). A run that is already in an issue's list is not added twice.
 */
export function planIssues(flaky, existing, ctx) {
  const date = ctx.date ?? new Date().toISOString().slice(0, 10);
  const label = ctx.event ? ` (${ctx.event})` : "";
  const line = `- ${date} ${ctx.runUrl}${label}`;
  return flaky.map((test) => {
    const title = issueTitle(test);
    const issue = existing.find((e) => e.title === title);
    const runs = issue ? parseRuns(issue.body) : [];
    if (runs.some((r) => r.url === ctx.runUrl)) {
      return { action: "none", title, number: issue.number, body: issue.body };
    }
    runs.push({ date, url: ctx.runUrl, line });
    const body = issueBody(test, runs);
    return issue
      ? { action: "update", title, number: issue.number, body, count: runs.length }
      : { action: "create", title, body, count: runs.length, labels: [LABEL] };
  });
}

export function summary(flaky, ctx) {
  if (!flaky.length) return "No test passed only on retry in this run.\n";
  return [
    `${flaky.length} test${flaky.length === 1 ? "" : "s"} passed only on retry in [this run](${ctx.runUrl}):`,
    "",
    ...flaky.map((t) => `- \`${t.id}\`${t.projects.length ? ` (${t.projects.join(", ")})` : ""}`),
    "",
  ].join("\n");
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
}

function applyPlan(plan) {
  gh(["label", "create", LABEL, "--color", "fbca04", "--description", "Test that passed only on retry in CI", "--force"]);
  for (const p of plan) {
    if (p.action === "create") {
      gh(["issue", "create", "--title", p.title, "--label", LABEL, "--body-file", "-"], p.body);
    } else if (p.action === "update") {
      gh(["issue", "edit", String(p.number), "--body-file", "-"], p.body);
    }
  }
}

function main(argv) {
  const dirIndex = argv.indexOf("--results");
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : "flaky-results";
  const apply = argv.includes("--apply");
  const env = process.env;
  const runUrl =
    env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : "(local run)";
  const ctx = { runUrl, event: env.GITHUB_EVENT_NAME };
  const flaky = collectFlaky(dir);
  const text = summary(flaky, ctx);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Flaky tests\n\n${text}`);
  if (!flaky.length) return;

  const existing = apply
    ? JSON.parse(gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "500", "--json", "number,title,body"]))
    : [];
  const plan = planIssues(flaky, existing, ctx);
  if (!apply) {
    console.log("Dry run, no issues filed. Payloads:");
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  applyPlan(plan);
  for (const p of plan) console.log(`${p.action}: ${p.title}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
