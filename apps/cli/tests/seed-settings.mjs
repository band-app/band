#!/usr/bin/env node
// Seed only settings into the SQLite database.
// Usage: node seed-settings.mjs <band_dir> <settings_json>
//
// Creates band.db with Drizzle migrations applied and a settings row.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [bandDir, settingsJson] = process.argv.slice(2);
if (!bandDir || !settingsJson) {
  console.error("Usage: node seed-settings.mjs <band_dir> <settings_json>");
  process.exit(1);
}

mkdirSync(bandDir, { recursive: true });

const migrationsDir = resolve(
  import.meta.dirname,
  "../../web/src/lib/db/migrations"
);

// Use better-sqlite3 from the web app's node_modules
const Database = (
  await import(
    resolve(
      import.meta.dirname,
      "../../web/node_modules/better-sqlite3/lib/index.js"
    )
  )
).default;

const db = new Database(join(bandDir, "band.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create the Drizzle migrations journal table
db.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)`);

// Read journal metadata
const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf-8")
);

// Apply each migration SQL file and register in journal
const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of sqlFiles) {
  const content = readFileSync(join(migrationsDir, file), "utf-8");
  const statements = content.split("--> statement-breakpoint");
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const tag = file.replace(".sql", "");
  const entry = journal.entries.find((e) => e.tag === tag);
  if (entry) {
    db.prepare(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)'
    ).run(hash, entry.when);
  }
}

// Seed settings
db.prepare("INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)").run(
  settingsJson
);

db.close();
