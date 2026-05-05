#!/usr/bin/env node
// Seed a chat layout (dockview tree) directly into the panel_states table.
// Used by integration tests that exercise the default-chat-panel resolution.
//
// Usage: node seed-chat-layout.mjs <band_dir> <workspace_id> <layout_json>
//
// Mirrors the schema used by `chatLayout.save` so the running server picks
// up the layout the next time `getChatLayout(workspaceId)` is called (every
// call reads from DB).

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [bandDir, workspaceId, layoutJson] = process.argv.slice(2);
if (!bandDir || !workspaceId || !layoutJson) {
  console.error(
    "Usage: node seed-chat-layout.mjs <band_dir> <workspace_id> <layout_json>",
  );
  process.exit(1);
}

const db = new DatabaseSync(join(bandDir, "band.db"));
const id = `chat_layout_${workspaceId}`;
const now = Date.now();
db.prepare(
  `INSERT OR REPLACE INTO panel_states
     (id, workspace_id, panel_type, state, created_at, updated_at)
   VALUES (?, ?, 'chat_layout', ?, ?, ?)`,
).run(id, workspaceId, layoutJson, now, now);
db.close();
