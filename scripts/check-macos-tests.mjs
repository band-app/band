#!/usr/bin/env node
// Fails when a hub, worker or host-local test uses a platform-specific facility but is in neither
// list of scripts/macos-tests.json, or when a listed file no longer exists. See CLAUDE.md (Testing Strategy).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const PLATFORM =
  /process\.platform|darwin|launchd|launchctl|pmset|xcrun|node-pty|terminal-daemon|DaemonTerminalBackend|TerminalPool/;
const testDirs = ["apps/hub/tests", "apps/worker/tests", "packages/host-local/tests"];

const { subset, notPlatformSpecific } = JSON.parse(readFileSync(join(root, "scripts/macos-tests.json"), "utf8"));
const problems = [];

for (const dir of testDirs) {
  for (const name of readdirSync(join(root, dir))) {
    if (!name.endsWith(".test.ts")) continue;
    const file = `${dir}/${name}`;
    if (subset[file] || notPlatformSpecific[file]) continue;
    if (PLATFORM.test(readFileSync(join(root, file), "utf8"))) {
      problems.push(`${file} uses a platform-specific facility but is not in scripts/macos-tests.json`);
    }
  }
}
for (const [list, entries] of Object.entries({ subset, notPlatformSpecific })) {
  for (const [file, reason] of Object.entries(entries)) {
    if (!existsSync(join(root, file))) problems.push(`${list}: ${file} does not exist`);
    if (!reason) problems.push(`${list}: ${file} has no reason`);
  }
  for (const file of Object.keys(entries)) {
    if (list === "subset" && notPlatformSpecific[file]) problems.push(`${file} is in both lists`);
  }
}

if (problems.length > 0) {
  console.error(`macOS test subset check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  console.error(
    "Add the file to \"subset\" (behaviour depends on the OS) or \"notPlatformSpecific\" with a reason.",
  );
  process.exit(1);
}
