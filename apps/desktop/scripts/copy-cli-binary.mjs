#!/usr/bin/env node

/**
 * Copy the host-built Band CLI binary into `apps/desktop/binaries/band` so
 * `electron-builder` can ship it as an `extraResource` (mirrors the Tauri
 * `externalBin: ["binaries/band"]` pattern in `apps/dashboard/src-tauri/
 * tauri.conf.json`).
 *
 * Phase 7 of the Tauri → Electron migration (issue #364). Phase 8 (electron-
 * builder packaging) will invoke this from the build pipeline; in the meantime
 * the root `build:cli:desktop` script calls it after `cargo build --release`.
 *
 * Resolution order for the source binary:
 *   1. `apps/cli/target/release/band` — preferred (matches `pnpm build:cli`).
 *   2. `apps/cli/target/debug/band`   — fallback (matches `pnpm build:cli:dev`).
 *
 * On Windows, `band.exe` is used. On every platform a single binary is copied
 * (the host triple is implied by the build that produced it). This is
 * deliberately simpler than the Tauri sidecar's per-triple naming convention
 * because `electron-builder` resolves resources by relative path at runtime,
 * not by host triple at packaging time.
 *
 * Exits non-zero if no source binary is found, so the caller (e.g. CI) can
 * surface the missing-build error before electron-builder runs.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

const exe = process.platform === "win32" ? "band.exe" : "band";
const candidates = [
  resolve(repoRoot, "apps/cli/target/release", exe),
  resolve(repoRoot, "apps/cli/target/debug", exe),
];

const source = candidates.find((p) => existsSync(p));
if (!source) {
  console.error(
    `[copy-cli-binary] No CLI binary found. Build it first with:\n` +
      `  pnpm --filter @band-app/cli build       # release\n` +
      `  pnpm --filter @band-app/cli build:dev   # debug\n\n` +
      `Searched:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
  );
  process.exit(1);
}

const destDir = resolve(__dirname, "..", "binaries");
const dest = resolve(destDir, exe);
mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.log(`[copy-cli-binary] ${source} → ${dest}`);
