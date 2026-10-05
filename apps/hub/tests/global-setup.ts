// Runs once before the hub suite. Tests that drive the band CLI (remote-relay,
// cli-skills, relay-cli-skills-drift) need a CLI built from this checkout, and
// a fresh worktree has none. Build it here, or stop with one clear message,
// instead of letting each of those tests skip or fail on its own.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CLI_DIR = resolve(import.meta.dirname, "..", "..", "cli");
const EXE = process.platform === "win32" ? "band.exe" : "band";

/** Newest mtime of anything that goes into the CLI binary. */
function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  for (const dir of ["src", "skills"]) walk(join(CLI_DIR, dir));
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    newest = Math.max(newest, statSync(join(CLI_DIR, file)).mtimeMs);
  }
  return newest;
}

/** The freshest built CLI, or null when none exists or every one is older than its sources. */
function freshBuiltCli(sourceMtime: number): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const profile of ["release", "debug"]) {
    const path = join(CLI_DIR, "target", profile, EXE);
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtimeMs;
    if (mtime >= sourceMtime && (!best || mtime > best.mtime)) best = { path, mtime };
  }
  return best?.path ?? null;
}

export default function setup(): void {
  // An explicit binary is the caller's choice (Docker image, packaged app).
  if (process.env.BAND_CLI_PATH && existsSync(process.env.BAND_CLI_PATH)) return;

  if (freshBuiltCli(newestSourceMtime())) return;

  // `findCliBinary` prefers a release build over a debug one, so rebuild the
  // profile that is already there (a stale release would shadow a new debug).
  const profile = existsSync(join(CLI_DIR, "target", "release", EXE)) ? "release" : "debug";
  console.log(`[hub tests] building the band CLI (cargo build, ${profile})...`);
  const build = spawnSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      join(CLI_DIR, "Cargo.toml"),
      "--bin",
      "band",
      ...(profile === "release" ? ["--release"] : []),
    ],
    { stdio: "inherit" },
  );
  if (build.error || build.status !== 0 || !existsSync(join(CLI_DIR, "target", profile, EXE))) {
    throw new Error(
      "The hub suite needs the band CLI and could not build it" +
        (build.error ? ` (${build.error.message})` : "") +
        ".\nInstall Rust (https://rustup.rs), then run:\n" +
        "  cargo build --manifest-path apps/cli/Cargo.toml\n" +
        "or point BAND_CLI_PATH at a built `band` binary.",
    );
  }
}
