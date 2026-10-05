#!/usr/bin/env node
// List all panel_states rows for a worktree as JSON on stdout. Used by
// integration tests that need to verify cleanup on worktree teardown.
//
// Usage: node list-panel-states.mjs <band_dir> <worktree_id>

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, worktreeId] = process.argv.slice(2);
if (!bandDir || !worktreeId) {
  console.error("Usage: node list-panel-states.mjs <band_dir> <worktree_id>");
  process.exit(1);
}

const db = new DatabaseSync(join(bandDir, "band.db"));
// Match by worktree_id column (covers per-panel records) AND by id-suffix
// (covers `<panel_type>_<worktree_id>` layout rows whose own
// `worktree_id` column also points at the worktree).
const rows = db
  .prepare("SELECT id, worktree_id, panel_type FROM panel_states WHERE worktree_id = ?")
  .all(worktreeId);
db.close();

process.stdout.write(`${JSON.stringify(rows)}\n`);
