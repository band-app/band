#!/usr/bin/env node
// List all panel_states rows for a workspace as JSON on stdout. Used by
// integration tests that need to verify cleanup on workspace teardown.
//
// Usage: node list-panel-states.mjs <band_dir> <workspace_id>

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, workspaceId] = process.argv.slice(2);
if (!bandDir || !workspaceId) {
  console.error("Usage: node list-panel-states.mjs <band_dir> <workspace_id>");
  process.exit(1);
}

const db = new DatabaseSync(join(bandDir, "band.db"));
// Match by workspace_id column (covers per-panel records) AND by id-suffix
// (covers `<panel_type>_<workspace_id>` layout rows whose own
// `workspace_id` column also points at the workspace).
const rows = db
  .prepare("SELECT id, workspace_id, panel_type FROM panel_states WHERE workspace_id = ?")
  .all(workspaceId);
db.close();

process.stdout.write(`${JSON.stringify(rows)}\n`);
