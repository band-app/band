#!/usr/bin/env node
// Read a saved dockview layout panel-state row (chat, terminal, or browser)
// for a workspace and emit it as JSON on stdout. Used by integration tests
// that need to assert what's persisted in a workspace's panel layout.
//
// Usage: node read-layout.mjs <band_dir> <workspace_id> <panel_type>
//   panel_type ∈ { chat_layout, terminal_layout, browser_layout }

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, workspaceId, panelType] = process.argv.slice(2);
if (!bandDir || !workspaceId || !panelType) {
  console.error("Usage: node read-layout.mjs <band_dir> <workspace_id> <panel_type>");
  process.exit(1);
}

const db = new DatabaseSync(join(bandDir, "band.db"));
const id = `${panelType}_${workspaceId}`;
const row = db.prepare("SELECT state FROM panel_states WHERE id = ?").get(id);
db.close();

if (!row) {
  process.stdout.write("null\n");
  process.exit(0);
}

// `state` is already a JSON string; re-emit verbatim so the caller can
// parse it once.
process.stdout.write(`${row.state}\n`);
