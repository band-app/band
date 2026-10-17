#!/usr/bin/env node
// Ships the mobile app as part of a Band release (.github/workflows/release.yml, job `mobile`).
//
//   node scripts/release.mjs detect --mode auto|always|skip --tag v1.2.3
//   node scripts/release.mjs set-version --version 1.2.3
//   node scripts/release.mjs ship --version 1.2.3
//
// `detect` decides whether to ship and says why. `ship` writes the release version into app.json,
// starts the iOS production build with auto-submit to TestFlight and the Android preview build,
// waits for both, and exits non-zero if either fails. EAS keeps numbering builds remotely
// (`appVersionSource: remote`), so only the marketing version is set here.
//
// `EAS_BIN` replaces the `eas` binary and is read on every call (tests point it at a stub).
// `EXPO_TOKEN` reaches eas through the environment only and is never printed.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Paths whose change since the previous release makes `auto` ship the app. */
export const MOBILE_PATHS = [
  "apps/mobile/",
  "packages/client/",
  "packages/shared/",
  "pnpm-lock.yaml",
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The newest `v*` tag reachable from the parent of `tag`, or null when there is none. */
export function previousTag(repo, tag) {
  try {
    return git(repo, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${tag}^`) || null;
  } catch {
    return null;
  }
}

/**
 * Decides whether a release ships the mobile app.
 * @returns {{ ship: boolean, reason: string }}
 */
export function detect({ mode, tag, repo }) {
  if (mode === "skip") return { ship: false, reason: "mobile is set to skip" };
  if (mode === "always") return { ship: true, reason: "mobile is set to always" };
  if (mode !== "auto") throw new Error(`Unknown mobile mode: ${mode}`);
  const previous = previousTag(repo, tag);
  if (!previous) return { ship: true, reason: `no release tag before ${tag}` };
  const changed = git(repo, "diff", "--name-only", `${previous}..${tag}`)
    .split("\n")
    .filter((file) =>
      MOBILE_PATHS.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
    );
  if (changed.length === 0) {
    return { ship: false, reason: `no mobile changes between ${previous} and ${tag}` };
  }
  return {
    ship: true,
    reason: `${changed.length} mobile file(s) changed between ${previous} and ${tag}, for example ${changed[0]}`,
  };
}

/** Writes the release version into app.json as the app's marketing version. */
export function setVersion(appJsonPath, version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Not a plain semver: ${version}`);
  const json = JSON.parse(readFileSync(appJsonPath, "utf8"));
  json.expo.version = version;
  writeFileSync(appJsonPath, `${JSON.stringify(json, null, 2)}\n`);
}

/** Runs one eas build to the end and returns its exit code, output and the build page URLs. */
function runBuild(args, cwd) {
  const bin = process.env.EAS_BIN || "eas";
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => done({ code: 1, urls: [], output: String(error) }));
    child.on("close", (code) => done({ code: code ?? 1, urls: buildUrls(stdout), output: stdout }));
  });
}

/** Reads the `--json` output of `eas build`: an array of builds, each with a details page URL. */
export function buildUrls(stdout) {
  try {
    const start = stdout.indexOf("[");
    const builds = JSON.parse(stdout.slice(start));
    return builds.map((build) => build.buildDetailsPageUrl).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Builds both platforms. iOS submits to TestFlight when its build finishes.
 * @returns {Promise<{ ok: boolean, lines: string[], urls: string[] }>}
 */
export async function ship({ version, appDir = APP_DIR }) {
  setVersion(resolve(appDir, "app.json"), version);
  const common = ["--non-interactive", "--json"];
  const [ios, android] = await Promise.all([
    runBuild(
      ["build", "--platform", "ios", "--profile", "production", "--auto-submit", ...common],
      appDir,
    ),
    runBuild(["build", "--platform", "android", "--profile", "preview", ...common], appDir),
  ]);
  const line = (label, result) =>
    `${result.code === 0 ? "ok" : "FAILED"} ${label}: ${result.urls.join(" ") || "no run URL in the eas output"}`;
  return {
    ok: ios.code === 0 && android.code === 0,
    lines: [
      line("iOS production build and TestFlight submit", ios),
      line("Android preview build", android),
    ],
    urls: [...ios.urls, ...android.urls],
  };
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "detect") {
    const repo = resolve(APP_DIR, "../..");
    const decision = detect({
      mode: flag(args, "--mode") ?? "auto",
      tag: flag(args, "--tag") ?? "",
      repo,
    });
    output("ship", String(decision.ship));
    summary(`### Mobile app\n\n${decision.ship ? "Shipping" : "Skipping"}: ${decision.reason}.`);
    return 0;
  }
  if (command === "set-version") {
    setVersion(resolve(APP_DIR, "app.json"), flag(args, "--version") ?? "");
    return 0;
  }
  if (command === "ship") {
    const result = await ship({ version: flag(args, "--version") ?? "" });
    summary(`### Mobile app builds\n\n${result.lines.map((line) => `- ${line}`).join("\n")}`);
    output("urls", result.urls.join(" "));
    return result.ok ? 0 : 1;
  }
  console.error(
    "Usage: release.mjs detect --mode <auto|always|skip> --tag <vX.Y.Z> | ship --version <X.Y.Z>",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
