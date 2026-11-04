#!/usr/bin/env node
// Repeats the test files a branch added or changed, to catch flakes before they reach CI.
// Usage: node scripts/flake-guard.mjs [--pre-push] [--repeat <n>] [--files <glob...>]
//                                     [--base <ref>] [--max-minutes <n>]
//
// --pre-push uses the push budget: e2e 5 repeats, other tests 3 runs, 15 minute cap
// (the cap stops the guard and exits 0, it never blocks a push). With no flags it runs
// the fuller loop: e2e 20, others 10, no cap. A failed run exits 1. Anything the guard
// cannot run here (a missing browser, a failed build, the wrong Node) is reported and skipped.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, matchesGlob, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubWorkerEnv } from "./test-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const startedAt = Date.now();

function parseArgs(argv) {
  const opts = { prePush: false, repeat: null, files: null, base: "origin/main", maxMinutes: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pre-push") opts.prePush = true;
    else if (arg === "--repeat") opts.repeat = Number(argv[++i]);
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--max-minutes") opts.maxMinutes = Number(argv[++i]);
    else if (arg === "--files") {
      opts.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.files.push(argv[++i]);
    } else {
      console.error(`flake-guard: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  for (const [name, value] of [
    ["--repeat", opts.repeat],
    ["--max-minutes", opts.maxMinutes],
  ]) {
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      console.error(`flake-guard: ${name} needs a positive number`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// The hook must block a push only for a failed test run. A bug in the guard itself is
// reported and lets the push through.
process.on("uncaughtException", (err) => {
  console.error(`flake-guard: internal error, nothing was checked: ${err?.stack ?? err}`);
  process.exit(opts.prePush ? 0 : 1);
});
const e2eRepeats = opts.repeat ?? (opts.prePush ? 5 : 20);
const otherRuns = opts.repeat ?? (opts.prePush ? 3 : 10);
const maxMinutes = opts.maxMinutes ?? (opts.prePush ? 15 : null);
const deadline = maxMinutes === null ? Number.POSITIVE_INFINITY : startedAt + maxMinutes * 60_000;

function git(...args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

function changedFiles() {
  const mergeBase = git("merge-base", opts.base, "HEAD");
  if (mergeBase === null) {
    console.log(`flake-guard: cannot find a merge base with ${opts.base}, skipping`);
    return null;
  }
  // The diff against the merge base holds committed changes and staged or unstaged edits.
  const diff = git("diff", "--name-only", "--diff-filter=AMR", mergeBase) ?? "";
  const untracked = git("ls-files", "--others", "--exclude-standard") ?? "";
  return [...new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean))];
}

function allTestFiles(globs) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
      if (entry.isDirectory()) walk(path);
      else if (globs.some((glob) => matchesGlob(path, glob))) out.push(path);
    }
  };
  for (const top of ["apps", "packages"]) if (existsSync(join(root, top))) walk(top);
  return out;
}

function classify(files) {
  const plan = { e2e: [], hub: [], webUnit: [], node: new Map(), skipped: [] };
  for (const file of files) {
    let m;
    if (file.startsWith("apps/web/e2e-desktop/")) {
      plan.skipped.push([file, "needs the desktop app on macOS"]);
    } else if (/simulator/.test(file) && /\.(spec|test)\.ts$/.test(file) && /\/(e2e|tests)\//.test(file)) {
      plan.skipped.push([file, "needs Xcode and a simulator"]);
    } else if (/^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(file)) plan.e2e.push(file);
    else if (/^apps\/hub\/tests\/.+\.test\.ts$/.test(file)) plan.hub.push(file);
    else if (/^apps\/web\/tests\/.+\.test\.ts$/.test(file)) plan.webUnit.push(file);
    else if ((m = file.match(/^(packages\/[^/]+)\/tests\/.+\.test\.ts$/))) {
      plan.node.set(m[1], [...(plan.node.get(m[1]) ?? []), file]);
    } else if (/(^|\/)(e2e|tests)\/.+\.(spec|test)\.ts$/.test(file)) {
      plan.skipped.push([file, "no runner for this location"]);
    }
  }
  return plan;
}

const files = opts.files
  ? allTestFiles(opts.files.map((g) => g.replace(/^\.\//, "")))
  : changedFiles();
if (files === null) process.exit(0);
const plan = classify(files);
const runnable =
  plan.e2e.length + plan.hub.length + plan.webUnit.length + [...plan.node.values()].flat().length;
for (const [file, why] of plan.skipped) console.log(`flake-guard: skipped ${file} (${why})`);
if (runnable === 0) {
  console.log(`flake-guard: no test file changed against ${opts.base}, nothing to repeat`);
  process.exit(0);
}

// Environment: Node 24, no Band worker identity, a throwaway HOME. The caches that live
// under the real HOME are pointed at explicitly, so a temp HOME does not make tools
// download them again.
function findNode24Bin() {
  if (process.versions.node.startsWith("24.")) return null;
  const dir = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(dir)) return undefined;
  const versions = readdirSync(dir)
    .filter((v) => v.startsWith("v24."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? join(dir, versions.at(-1), "bin") : undefined;
}
const nodeBin = findNode24Bin();
if (nodeBin === undefined) {
  console.log(
    `flake-guard: skipped, Node 24 is required (this is ${process.versions.node}). Install it with nvm.`,
  );
  process.exit(0);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "flake-guard-"));
const tmpHome = join(tmpRoot, "home");
mkdirSync(tmpHome);
const logDir = join(tmpRoot, "logs");
mkdirSync(logDir);
let keepLogs = false;

const realHome = homedir();
const guardUrl = new URL("./test-process-guard.mjs", import.meta.url).href;
const baseEnv = scrubWorkerEnv({ ...process.env });
// Git exports these to hooks (the guard runs from .husky/pre-push). A test that runs `git init`
// or `git config` in a scratch folder would otherwise act on the repository being pushed, and
// once set core.bare=true in the shared config of every worktree. They are removed here, not in
// scrubWorkerEnv, which the desktop e2e also uses. GIT_CONFIG_* is left alone.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
]) {
  delete baseEnv[name];
}
if (nodeBin) baseEnv.PATH = `${nodeBin}:${baseEnv.PATH}`;
const cacheHome = baseEnv.XDG_CACHE_HOME ?? join(realHome, ".cache");
const testEnv = {
  ...baseEnv,
  HOME: tmpHome,
  XDG_CACHE_HOME: cacheHome,
  COREPACK_HOME: baseEnv.COREPACK_HOME ?? join(cacheHome, "node", "corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  // The guard runs the changed tests whether or not they are on the CI quarantine list.
  BAND_FLAKY_QUARANTINE: "off",
  CARGO_HOME: baseEnv.CARGO_HOME ?? join(realHome, ".cargo"),
  RUSTUP_HOME: baseEnv.RUSTUP_HOME ?? join(realHome, ".rustup"),
  PLAYWRIGHT_BROWSERS_PATH:
    baseEnv.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(realHome, "Library", "Caches", "ms-playwright")
      : join(cacheHome, "ms-playwright")),
  // Every node process a test starts exits when this guard process is gone.
  TEST_PROCESS_GUARD_OWNER_PID: String(process.pid),
  NODE_OPTIONS: `--no-warnings=ExperimentalWarning --import ${guardUrl}`,
};
const buildEnv = { ...baseEnv, NODE_OPTIONS: "--no-warnings=ExperimentalWarning" };

// Child processes run in their own group so a cap, Ctrl-C or SIGTERM stops all of them.
const live = new Set();
function signalAll(signal) {
  for (const pid of live) {
    try {
      process.kill(-pid, signal);
    } catch {
      // group already gone
    }
  }
}
function cleanupAndExit(code) {
  signalAll("SIGKILL");
  if (!keepLogs) rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    signalAll("SIGTERM");
    cleanupAndExit(128);
  });
}

// Runs a command to completion, or until the deadline. Output goes to a log file.
function run({ cmd, args, cwd = root, env, log }) {
  return new Promise((resolve) => {
    const out = join(logDir, log);
    const logFd = openSync(out, "a");
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    live.add(child.pid);
    let capped = false;
    const remaining = deadline - Date.now();
    const timer = setTimeout(
      () => {
        capped = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 5000).unref();
      },
      Math.max(remaining, 0),
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      live.delete(child.pid);
      writeFileSync(out, `${err.message}\n`, { flag: "a" });
      resolve({ code: 127, capped: false, log: out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The leader is gone, so stop whatever it left in the group.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      live.delete(child.pid);
      resolve({ code: code ?? 1, capped, log: out });
    });
  });
}

const failures = [];
const notCovered = [];
const envSkips = [];
const summary = [];

function readLog(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
const ENV_PROBLEM = /Executable doesn't exist|browserType\.launch|playwright install/;

function recordFailure(file, title, runNumber, log) {
  failures.push({ file, title, runNumber, log });
  keepLogs = true;
}

function expired() {
  return Date.now() >= deadline;
}

const builds = new Map();
function build(label, args) {
  if (!builds.has(label)) builds.set(label, runBuild(label, args));
  return builds.get(label);
}
async function runBuild(label, args) {
  console.log(`flake-guard: building ${label}`);
  const result = await run({ cmd: "pnpm", args, env: buildEnv, log: `build-${label}.log` });
  if (result.capped) return "capped";
  if (result.code !== 0) {
    console.log(
      `flake-guard: build of ${label} failed (exit ${result.code}), skipping the tests that need it. Log: ${result.log}`,
    );
    keepLogs = true;
    return "failed";
  }
  return "ok";
}

function addSummary(file, passed, total) {
  summary.push({ file, passed, total });
}

// Playwright: one invocation with --repeat-each, results from the JSON reporter.
async function runE2e(specs) {
  const needsBuild = await build("web-and-hub", ["build:web"]);
  if (needsBuild !== "ok") {
    for (const f of specs) {
      if (needsBuild === "capped") notCovered.push(`${f} (e2e x${e2eRepeats})`);
      else envSkips.push(`${f} (build failed)`);
    }
    return;
  }
  const mobile = specs.filter((f) => /mobile-document-scroll\.spec\.ts$/.test(f));
  const desktop = specs.filter((f) => !mobile.includes(f));
  for (const [group, project] of [
    [desktop, "chromium"],
    [mobile, "webkit-iphone"],
  ]) {
    if (!group.length) continue;
    if (expired()) {
      for (const f of group) notCovered.push(`${f} (e2e x${e2eRepeats})`);
      continue;
    }
    const jsonOut = join(logDir, `e2e-${project}.json`);
    const result = await run({
      cmd: "pnpm",
      args: [
        "--filter",
        "@band-app/web",
        "exec",
        "playwright",
        "test",
        ...group.map((f) => relative("apps/web", f)),
        "--repeat-each",
        String(e2eRepeats),
        // CI retries a failed spec once. The guard must see every failure, so it never does.
        "--retries",
        "0",
        "--workers",
        "1",
        "--project",
        project,
        "--reporter=json",
      ],
      env: { ...testEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
      log: `e2e-${project}.log`,
    });
    if (result.capped) {
      for (const f of group) notCovered.push(`${f} (e2e x${e2eRepeats}, stopped at the cap)`);
      continue;
    }
    const counts = new Map(group.map((f) => [f, { passed: 0, total: 0 }]));
    let parsed = false;
    // The JSON report lists each repeat as its own spec entry, in repeat order, with no
    // repeat index, so the run number is how many times the test has been seen.
    const seen = new Map();
    if (existsSync(jsonOut)) {
      try {
        const report = JSON.parse(readFileSync(jsonOut, "utf8"));
        parsed = true;
        const walk = (suite, titles) => {
          for (const spec of suite.specs ?? []) {
            for (const test of spec.tests ?? []) {
              for (const r of test.results ?? []) {
                const file = `apps/web/e2e/${spec.file}`;
                const c = counts.get(file) ?? { passed: 0, total: 0 };
                counts.set(file, c);
                c.total++;
                const title = [...titles, spec.title].join(" > ");
                const key = `${file}\n${title}`;
                const runNumber = (seen.get(key) ?? 0) + 1;
                seen.set(key, runNumber);
                if (r.status === "passed") c.passed++;
                else if (r.status !== "skipped") {
                  recordFailure(file, title, runNumber, result.log);
                }
              }
            }
          }
          for (const child of suite.suites ?? []) walk(child, [...titles, child.title].filter(Boolean));
        };
        for (const suite of report.suites ?? []) walk(suite, []);
      } catch {
        parsed = false;
      }
    }
    if (result.code !== 0 && ENV_PROBLEM.test(readLog(result.log) + readLog(jsonOut))) {
      for (const f of group) envSkips.push(`${f} (${project} browser is not installed)`);
      continue;
    }
    if (!parsed || (result.code !== 0 && ![...counts.values()].some((c) => c.total > c.passed))) {
      if (result.code !== 0) {
        for (const f of group) recordFailure(f, `playwright exited with ${result.code} before reporting`, 1, result.log);
        continue;
      }
    }
    for (const [file, c] of counts) addSummary(file, c.passed, c.total || e2eRepeats);
  }
}

// vitest (hub and web): N separate runs of just the changed files.
async function runVitest(label, filter, group) {
  if (label === "hub") {
    const built = await build("web-and-hub", ["build:web"]);
    if (built !== "ok") {
      for (const f of group) {
        if (built === "capped") notCovered.push(`${f} (${label} x${otherRuns})`);
        else envSkips.push(`${f} (build failed)`);
      }
      return;
    }
  }
  const counts = new Map(group.map((f) => [f, { passed: 0, total: 0 }]));
  const pkgDir = label === "hub" ? "apps/hub" : "apps/web";
  for (let i = 1; i <= otherRuns; i++) {
    if (expired()) {
      for (const f of group) notCovered.push(`${f} (${label}: runs ${i}-${otherRuns} of ${otherRuns})`);
      return finishVitest(counts);
    }
    const jsonOut = join(logDir, `${label}-run${i}.json`);
    const result = await run({
      cmd: "pnpm",
      args: [
        "--filter",
        filter,
        "exec",
        "vitest",
        "run",
        ...group.map((f) => relative(pkgDir, f)),
        // CI retries a failed test once. The guard must see every failure, so it never does.
        "--retry",
        "0",
        "--reporter=json",
        `--outputFile=${jsonOut}`,
      ],
      env: testEnv,
      log: `${label}-run${i}.log`,
    });
    if (result.capped) {
      for (const f of group) notCovered.push(`${f} (${label}: run ${i} stopped at the cap, ${otherRuns - i} more not started)`);
      return finishVitest(counts);
    }
    const failedFiles = new Set();
    if (existsSync(jsonOut)) {
      try {
        const report = JSON.parse(readFileSync(jsonOut, "utf8"));
        for (const tf of report.testResults ?? []) {
          const file = relative(root, tf.name);
          const c = counts.get(file) ?? { passed: 0, total: 0 };
          counts.set(file, c);
          const bad = (tf.assertionResults ?? []).filter((a) => a.status === "failed");
          for (const a of bad) recordFailure(file, a.fullName ?? a.title, i, result.log);
          if (!bad.length && tf.status === "failed") {
            recordFailure(file, tf.message?.split("\n")[0] || "test file failed to run", i, result.log);
          }
          if (tf.status === "failed" || bad.length) failedFiles.add(file);
        }
      } catch {}
    }
    if (result.code !== 0 && failedFiles.size === 0) {
      for (const f of group) recordFailure(f, `vitest exited with ${result.code} before reporting`, i, result.log);
      for (const f of group) failedFiles.add(f);
    }
    for (const f of group) {
      const c = counts.get(f);
      c.total++;
      if (!failedFiles.has(f)) c.passed++;
    }
  }
  finishVitest(counts);
}
function finishVitest(counts) {
  for (const [file, c] of counts) if (c.total) addSummary(file, c.passed, c.total);
}

// node:test packages: N runs using the package's own test command with the files swapped in.
async function runNodeTest(pkg, group) {
  const manifest = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8"));
  const script = manifest.scripts?.test?.replace(/\s+tests\/\S+$/, "");
  if (!script) {
    for (const f of group) envSkips.push(`${f} (${pkg} has no test script)`);
    return;
  }
  const counts = new Map(group.map((f) => [f, { passed: 0, total: 0 }]));
  for (let i = 1; i <= otherRuns; i++) {
    if (expired()) {
      for (const f of group) notCovered.push(`${f} (node:test: runs ${i}-${otherRuns} of ${otherRuns})`);
      break;
    }
    const result = await run({
      cmd: "sh",
      args: [
        "-c",
        `${script} --test-reporter=tap ${group.map((f) => relative(pkg, f)).join(" ")}`,
      ],
      cwd: join(root, pkg),
      env: testEnv,
      log: `${pkg.replace("/", "-")}-run${i}.log`,
    });
    if (result.capped) {
      for (const f of group) notCovered.push(`${f} (node:test: run ${i} stopped at the cap)`);
      break;
    }
    const failedTitles = [...readLog(result.log).matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]);
    const failedAny = result.code !== 0;
    for (const f of group) {
      const c = counts.get(f);
      c.total++;
      if (!failedAny) c.passed++;
    }
    if (failedAny) {
      // node:test's TAP output names tests, not files; with several files, name them all.
      const title = failedTitles.length ? failedTitles.join("; ") : `exit ${result.code}`;
      recordFailure(group.length === 1 ? group[0] : group.join(", "), title, i, result.log);
    }
  }
  finishVitest(counts);
}

if (plan.e2e.length) await runE2e(plan.e2e);
if (plan.hub.length) await runVitest("hub", "@band-app/server", plan.hub);
if (plan.webUnit.length) await runVitest("web", "@band-app/web", plan.webUnit);
for (const [pkg, group] of plan.node) await runNodeTest(pkg, group);

const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log("");
for (const { file, passed, total } of summary) {
  console.log(`flake-guard: ${file}: ${passed}/${total} runs passed`);
}
for (const item of envSkips) console.log(`flake-guard: skipped ${item}`);

if (failures.length) {
  console.log("");
  console.log("flake-guard: FAILED");
  for (const f of failures) {
    console.log(`  ${f.file}: "${f.title}" failed on run ${f.runNumber}. Log: ${f.log}`);
  }
  console.log("A test that fails when repeated is flaky. See .claude/testing-criteria.md TEST-36 to TEST-45.");
  console.log(`flake-guard: logs are kept in ${logDir}`);
  rmSync(tmpHome, { recursive: true, force: true });
  process.exit(1);
}

if (notCovered.length) {
  console.log("");
  console.log(`flake-guard: stopped at the ${maxMinutes} minute cap after ${minutes} minutes. Not covered:`);
  for (const item of notCovered) console.log(`  ${item}`);
  console.log("This does not block the push. Run `pnpm flake-guard` to cover them.");
} else {
  console.log(`flake-guard: all runs passed (${minutes} minutes)`);
}
cleanupAndExit(0);
