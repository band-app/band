#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const JSON_FILES = [
  "package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "packages/ui/package.json",
  "packages/dashboard-core/package.json",
  "packages/coding-agent/package.json",
  "packages/logger/package.json",
];

const TOML_FILES = [
  "apps/cli/Cargo.toml",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, version: null, bump: null, fromCommits: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--version":
        opts.version = args[++i];
        break;
      case "--bump":
        opts.bump = args[++i];
        break;
      case "--from-commits":
        opts.fromCommits = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  const modes = [opts.version, opts.bump, opts.fromCommits].filter(Boolean);
  if (modes.length === 0) {
    console.error(
      "Must specify one of: --version <ver>, --bump <patch|minor|major>, --from-commits"
    );
    process.exit(1);
  }
  if (modes.length > 1) {
    console.error(
      "Specify only one of: --version, --bump, or --from-commits"
    );
    process.exit(1);
  }

  if (opts.bump && !["patch", "minor", "major"].includes(opts.bump)) {
    console.error(`Invalid bump type: ${opts.bump}. Use patch, minor, or major`);
    process.exit(1);
  }

  return opts;
}

function getCurrentVersion() {
  // Prefer the latest git tag as the source of truth: the release workflow
  // bumps package.json files only on the runner and never commits them back
  // to main, so the in-repo package.json versions can lag behind the actual
  // released versions. Fall back to package.json only when no tags exist.
  //
  // `--match 'v[0-9]*'` filters out non-version tags like the rolling
  // `nightly` tag created by .github/workflows/nightly.yml — without it
  // `git describe` happily returns `nightly` and bumpVersion produces
  // `NaN.undefined.NaN` (see run 25483248796 for the exact failure).
  try {
    const tag = execSync("git describe --tags --abbrev=0 --match 'v[0-9]*'", {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    return tag.replace(/^v/, "");
  } catch {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    return pkg.version;
  }
}

function bumpVersion(current, type) {
  const parts = current.split(".").map(Number);
  switch (type) {
    case "major":
      return `${parts[0] + 1}.0.0`;
    case "minor":
      return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch":
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

function getLastTag() {
  try {
    return execSync("git describe --tags --abbrev=0", {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function determineBumpFromCommits() {
  const lastTag = getLastTag();
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  let log;
  try {
    log = execSync(`git log ${range} --pretty=format:"%s%n%b"`, {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch {
    return "patch";
  }

  if (!log.trim()) return "patch";

  const lines = log.split("\n");
  let bump = "patch";

  for (const line of lines) {
    if (line.includes("BREAKING CHANGE") || line.includes("BREAKING-CHANGE")) {
      return "major";
    }
    // Check for breaking change indicator with ! before :
    if (/^[a-z]+(\(.+\))?!:/.test(line)) {
      return "major";
    }
    if (/^feat(\(.+\))?:/.test(line)) {
      bump = "minor";
    }
  }

  return bump;
}

function updateJsonFile(filePath, newVersion, dryRun) {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf8");
  const json = JSON.parse(content);
  const oldVersion = json.version;
  if (!dryRun) {
    // Use string replacement to preserve the original formatting (avoids
    // JSON.stringify reformatting that breaks biome's style expectations).
    const updated = content.replace(
      `"version": "${oldVersion}"`,
      `"version": "${newVersion}"`
    );
    writeFileSync(fullPath, updated);
  }
  console.log(`  ${filePath}: ${oldVersion} → ${newVersion}`);
}

function updateTomlFile(filePath, newVersion, dryRun) {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf8");
  const versionRegex = /^(version\s*=\s*")([^"]+)(")/m;
  const match = content.match(versionRegex);
  if (!match) {
    console.error(`  ${filePath}: could not find version field`);
    process.exit(1);
  }
  const oldVersion = match[2];
  const updated = content.replace(versionRegex, `$1${newVersion}$3`);
  if (!dryRun) {
    writeFileSync(fullPath, updated);
  }
  console.log(`  ${filePath}: ${oldVersion} → ${newVersion}`);
}

function updateCargoLock(dryRun) {
  if (dryRun) return;
  for (const toml of TOML_FILES) {
    const dir = resolve(ROOT, dirname(toml));
    // Use `cargo generate-lockfile` instead of `cargo check` so we don't
    // accidentally execute crate build scripts during the release pipeline.
    console.log(`  Updating Cargo.lock in ${dirname(toml)}...`);
    execSync("cargo generate-lockfile", { cwd: dir, stdio: "inherit" });
  }
}

const opts = parseArgs();
const currentVersion = getCurrentVersion();

let newVersion;
if (opts.version) {
  if (!/^\d+\.\d+\.\d+$/.test(opts.version)) {
    console.error(`Invalid version format: ${opts.version}. Use X.Y.Z`);
    process.exit(1);
  }
  newVersion = opts.version;
} else if (opts.bump) {
  newVersion = bumpVersion(currentVersion, opts.bump);
} else {
  const bumpType = determineBumpFromCommits();
  console.log(`Detected bump type from commits: ${bumpType}`);
  newVersion = bumpVersion(currentVersion, bumpType);
}

console.log(`\nVersion: ${currentVersion} → ${newVersion}`);

if (opts.dryRun) {
  console.log("\n[dry-run] No files will be modified.\n");
  console.log("Files that would be updated:");
}

console.log("\nJSON files:");
for (const file of JSON_FILES) {
  updateJsonFile(file, newVersion, opts.dryRun);
}

console.log("\nCargo.toml files:");
for (const file of TOML_FILES) {
  updateTomlFile(file, newVersion, opts.dryRun);
}

if (!opts.dryRun) {
  console.log("\nUpdating Cargo.lock files...");
  updateCargoLock(opts.dryRun);
}

console.log(`\nDone! Version bumped to ${newVersion}`);
