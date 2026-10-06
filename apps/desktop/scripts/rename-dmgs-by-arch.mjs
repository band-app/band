#!/usr/bin/env node

/**
 * Rename the macOS DMG artifact produced by electron-builder so the
 * architecture is spelled out in user-facing terms:
 *
 *   Band-<version>-arm64.dmg    →  Band-<version>-apple-silicon.dmg
 *
 * Band ships Apple Silicon builds only. Intel Macs are no longer supported.
 *
 * Scope: DMGs only. electron-updater's MacUpdater picks the arm64 build
 * by literal substring match on `arm64` in the URL pathname, so the `.zip`
 * filenames referenced from `latest-mac.yml` stay untouched. DMG entries in
 * the manifest are informational, but the script rewrites them so the URLs
 * match the files in the GitHub release.
 *
 * Companion files renamed alongside the .dmg:
 *   - <name>.dmg.blockmap (delta-update block map).
 *
 * Idempotent: running twice is a no-op once the apple-silicon name exists.
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

const renames = new Map(); // old basename → new basename

for (const name of entries) {
  const armMatch = name.match(/^(Band-[\d.]+)-arm64\.dmg(\.blockmap)?$/);
  if (armMatch) {
    const [, prefix, blockmapExt = ""] = armMatch;
    renames.set(name, `${prefix}-apple-silicon.dmg${blockmapExt}`);
  }
}

if (renames.size === 0) {
  console.log("No DMG files matched the arm64 pattern — nothing to rename.");
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
