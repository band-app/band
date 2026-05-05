#!/usr/bin/env node
// Read the saved chat_layout panel-state for a workspace and emit it as JSON
// on stdout. Used by integration tests that need to assert what's persisted
// in the dockview chat layout (e.g. that a chat created via the CLI lands
// in the layout, not just the chats registry).
//
// Usage: node read-chat-layout.mjs <band_dir> <workspace_id>

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, workspaceId] = process.argv.slice(2);
if (!bandDir || !workspaceId) {
  console.error("Usage: node read-chat-layout.mjs <band_dir> <workspace_id>");
  process.exit(1);
}

const db = new DatabaseSync(join(bandDir, "band.db"));
const id = `chat_layout_${workspaceId}`;
const row = db.prepare("SELECT state FROM panel_states WHERE id = ?").get(id);
db.close();

if (!row) {
  process.stdout.write("null\n");
  process.exit(0);
}

// `state` is already a JSON string; re-emit verbatim so the caller can
// parse it once.
process.stdout.write(`${row.state}\n`);
