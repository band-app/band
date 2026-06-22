#!/usr/bin/env node
// Seed the SQLite database for CLI integration tests.
// Usage: node seed-db.mjs <band_dir> <project_name> <project_path> <default_branch> [settings_json]
//
// Creates band.db with Drizzle migrations applied, a single project row,
// and optionally writes settings to settings.json.
//
// Uses Node's built-in `node:sqlite` (Stability 1.2 RC, available unflagged
// since Node 22.13). No native module dep on the web app's node_modules.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, projectName, projectPath, defaultBranch, settingsJson] =
  process.argv.slice(2);
if (!bandDir || !projectName || !projectPath || !defaultBranch) {
  console.error(
    "Usage: node seed-db.mjs <band_dir> <project_name> <project_path> <default_branch> [settings_json]"
  );
  process.exit(1);
}

mkdirSync(bandDir, { recursive: true });

const migrationsDir = resolve(
  import.meta.dirname,
  "../../web/src/server/infra/db/migrations"
);

const db = new DatabaseSync(join(bandDir, "band.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Drizzle 1.0's `__drizzle_migrations` v1 schema (hash, created_at, name,
// applied_at). Writing it directly skips the v0 → v1 upgrader path.
db.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id INTEGER PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric,
  name text,
  applied_at TEXT
)`);

// Drizzle 1.0 migrations live in per-migration folders named
// <14-char-timestamp>_<slug>/, each containing a migration.sql.
function folderMillis(folderName) {
  const ds = folderName.slice(0, 14);
  const year = parseInt(ds.slice(0, 4), 10);
  const month = parseInt(ds.slice(4, 6), 10) - 1;
  const day = parseInt(ds.slice(6, 8), 10);
  const hour = parseInt(ds.slice(8, 10), 10);
  const minute = parseInt(ds.slice(10, 12), 10);
  const second = parseInt(ds.slice(12, 14), 10);
  return Date.UTC(year, month, day, hour, minute, second);
}

const migrationFolders = readdirSync(migrationsDir)
  .filter((f) => {
    try {
      return statSync(join(migrationsDir, f)).isDirectory();
    } catch {
      return false;
    }
  })
  .filter((f) => /^\d{14}_/.test(f))
  .sort();

for (const folder of migrationFolders) {
  const sqlPath = join(migrationsDir, folder, "migration.sql");
  const content = readFileSync(sqlPath, "utf-8");

  for (const stmt of content.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const appliedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO "__drizzle_migrations" (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)'
  ).run(hash, folderMillis(folder), folder, appliedAt);
}

// Seed the test project and its default worktree.
db.prepare(
  "INSERT INTO projects (name, path, default_branch, sort_order) VALUES (?, ?, ?, 0)"
).run(projectName, projectPath, defaultBranch);

// `workspace_id` is the worktree's stable, frozen identity (minted once at
// creation in production). Seed it with the historical derived value
// (`name-branch`, slashes → dashes) so resolve/findIdentity return the id the
// tests expect (e.g. `my-project-main`).
const workspaceId = `${projectName}-${defaultBranch.replace(/\//g, "-")}`;
db.prepare(
  "INSERT INTO worktrees (project_name, branch, path, workspace_id) VALUES (?, ?, ?, ?)"
).run(projectName, defaultBranch, projectPath, workspaceId);

db.close();

// Seed settings to settings.json if provided.
if (settingsJson) {
  writeFileSync(join(bandDir, "settings.json"), settingsJson, "utf-8");
}
