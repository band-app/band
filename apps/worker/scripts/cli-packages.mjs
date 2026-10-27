#!/usr/bin/env node
// Writes the per-platform npm packages that carry the `band` CLI, and pins them as
// optionalDependencies of @band-app/worker and @band-app/server (the esbuild pattern: npm installs only the
// package whose `os` and `cpu` match the machine).
//
//   node scripts/cli-packages.mjs --version 1.2.3 --out <dir> \
//     --binary darwin-arm64=<path> --binary linux-x64=<path> --binary linux-arm64=<path> [--pin]
//
// The packages are generated and never committed: a committed optionalDependency on a
// version that is not on npm would break `pnpm install` in the workspace. With --pin the
// script also rewrites apps/worker/package.json and apps/hub/package.json, so run it in the release checkout only.
// The package names must match `cliPackageName` in src/cli.ts.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let version;
let out;
let pin = false;
const binaries = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i];
  else if (args[i] === "--out") out = resolve(args[++i]);
  else if (args[i] === "--pin") pin = true;
  else if (args[i] === "--binary") {
    const [key, path] = args[++i].split("=");
    if (!PLATFORMS[key]) fail(`unknown platform ${key}, expected one of ${Object.keys(PLATFORMS)}`);
    binaries[key] = resolve(path);
  } else fail(`unknown argument ${args[i]}`);
}
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version must be semver");
if (!out) fail("--out is required");
if (Object.keys(binaries).length === 0) fail("at least one --binary is required");
if (pin) {
  const missing = Object.keys(PLATFORMS).filter((k) => !binaries[k]);
  if (missing.length > 0) fail(`--pin needs a binary for every platform, missing ${missing}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

for (const [key, binary] of Object.entries(binaries)) {
  const { os, cpu } = PLATFORMS[key];
  const dir = join(out, `worker-cli-${key}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(binary, join(dir, "bin", "band"));
  chmodSync(join(dir, "bin", "band"), 0o755);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `@band-app/worker-cli-${key}`,
        version,
        description: `The band CLI for ${os} ${cpu}, used by @band-app/worker.`,
        license: "MIT",
        os: [os],
        cpu: [cpu],
        files: ["bin"],
        repository: { type: "git", url: "git+https://github.com/band-app/band.git" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# @band-app/worker-cli-${key}\n\nThe \`band\` CLI binary for ${os} ${cpu}. It is an optional dependency of \`@band-app/worker\`. Install that package, not this one.\n`,
  );
  console.log(dir);
}

if (pin) {
  for (const file of [join(root, "package.json"), join(root, "..", "hub", "package.json")]) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.optionalDependencies = Object.fromEntries(
      Object.keys(PLATFORMS).map((k) => [`@band-app/worker-cli-${k}`, version]),
    );
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`pinned optionalDependencies to ${version} in ${file}`);
  }
}
