#!/usr/bin/env node

/**
 * Rename the macOS DMG artifacts produced by electron-builder so the
 * architecture is spelled out in user-facing terms:
 *
 *   Band-<version>.dmg          →  Band-<version>-intel.dmg            (x64)
 *   Band-<version>-arm64.dmg    →  Band-<version>-apple-silicon.dmg    (arm64)
 *
 * Why: electron-builder's default macOS naming uses no suffix for the x64
 * DMG and only suffixes arm64. Users have downloaded the wrong build
 * because "Band-0.16.4.dmg" reads like "the latest one" rather than
 * "the Intel one". Renaming both DMGs gives them symmetric, unambiguous
 * names that match how Apple and every major Mac app (Docker, Slack, VS
 * Code, Zoom) label these downloads: "Intel" and "Apple Silicon".
 *
 * Scope — DMGs only:
 *   The auto-update flow downloads the `.zip` artifacts referenced from
 *   `latest-mac.yml`, and electron-updater's MacUpdater
 *   (node_modules/electron-updater/out/MacUpdater.js) picks the arm64
 *   build by literal substring match on `arm64` in the URL pathname. If
 *   we renamed `Band-<version>-arm64-mac.zip` → `Band-<version>-arm-mac.zip`,
 *   every ARM Mac in the field would silently download the Intel zip on
 *   the next update tick. So `.zip` filenames stay untouched.
 *
 *   DMG entries in `latest-mac.yml` are informational — MacUpdater
 *   explicitly excludes the `dmg` extension when picking update files
 *   (`findFile(files, "zip", ["pkg", "dmg"])`). Renaming them is safe,
 *   but we still rewrite the manifest so the URLs match the actual files
 *   in the GitHub release (and any tooling that inspects the manifest
 *   doesn't end up with dangling references).
 *
 * Companion files renamed alongside each .dmg:
 *   - <name>.dmg.blockmap (delta-update block map; renaming keeps the
 *     `<dmg-url>.blockmap` discovery convention working).
 *
 * Idempotent: running twice is a no-op once the intel/arm names exist.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBuilder = resolve(__dirname, "..", "dist-builder");

if (!existsSync(distBuilder)) {
  console.error(`dist-builder directory not found at ${distBuilder}`);
  process.exit(1);
}

const entries = readdirSync(distBuilder);

/**
 * Build the (old → new) DMG rename map. We detect the version-bearing
 * Intel DMG by matching `Band-<version>.dmg` exactly (no arch suffix),
 * and the arm64 one by `Band-<version>-arm64.dmg`. Anything that already
 * matches the renamed pattern (`-intel.dmg` / `-apple-silicon.dmg`) is
 * skipped so the script stays idempotent.
 */
const renames = new Map(); // old basename → new basename

for (const name of entries) {
  // Match "Band-<version>.dmg" (intel) — no arch suffix.
  const intelMatch = name.match(/^(Band-[\d.]+)\.dmg(\.blockmap)?$/);
  if (intelMatch) {
    const [, prefix, blockmapExt = ""] = intelMatch;
    renames.set(name, `${prefix}-intel.dmg${blockmapExt}`);
    continue;
  }
  // Match "Band-<version>-arm64.dmg" (arm64 / Apple Silicon).
  const armMatch = name.match(/^(Band-[\d.]+)-arm64\.dmg(\.blockmap)?$/);
  if (armMatch) {
    const [, prefix, blockmapExt = ""] = armMatch;
    renames.set(name, `${prefix}-apple-silicon.dmg${blockmapExt}`);
  }
}

if (renames.size === 0) {
  console.log("No DMG files matched the intel/arm64 pattern — nothing to rename.");
  process.exit(0);
}

console.log("Renaming DMG artifacts:");
for (const [oldName, newName] of renames) {
  const oldPath = resolve(distBuilder, oldName);
  const newPath = resolve(distBuilder, newName);
  console.log(`  ${oldName}  →  ${newName}`);
  renameSync(oldPath, newPath);
}

// Update latest-mac.yml so its DMG URLs match the renamed files. The
// manifest is YAML but the only fields we touch are `url:` lines whose
// values are bare strings — a line-level string replace is sufficient
// and avoids pulling in a yaml dependency for two substitutions.
const manifestPath = resolve(distBuilder, "latest-mac.yml");
if (existsSync(manifestPath)) {
  let manifest = readFileSync(manifestPath, "utf8");
  let changed = false;
  for (const [oldName, newName] of renames) {
    if (oldName.endsWith(".blockmap")) continue; // blockmaps aren't referenced in the manifest
    if (manifest.includes(oldName)) {
      manifest = manifest.split(oldName).join(newName);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifestPath, manifest);
    console.log("Updated DMG URLs in latest-mac.yml");
  } else {
    console.log("latest-mac.yml had no DMG URLs to update (unexpected — please verify).");
  }
} else {
  console.log("latest-mac.yml not found — skipping manifest update.");
}

console.log("Done.");
