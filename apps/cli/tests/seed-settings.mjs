#!/usr/bin/env node
// Seed only settings into settings.json.
// Usage: node seed-settings.mjs <band_dir> <settings_json>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [bandDir, settingsJson] = process.argv.slice(2);
if (!bandDir || !settingsJson) {
  console.error("Usage: node seed-settings.mjs <band_dir> <settings_json>");
  process.exit(1);
}

mkdirSync(bandDir, { recursive: true });
writeFileSync(join(bandDir, "settings.json"), settingsJson, "utf-8");
