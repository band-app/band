// Test helper — POSTs to the running Band web server's tRPC endpoint to set
// the in-memory "active workspace" hint. Used by the `band open` integration
// tests to exercise the active-workspace fallback path without having to
// drive the dashboard UI.
//
// Usage:
//   node set-active-workspace.mjs <band_home> <workspaceId|null>
//
// The helper reads the server port + auth token from
// <band_home>/settings.json (same place the CLI looks). Exits 0 on
// success; prints the tRPC error to stderr and exits 1 otherwise.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [, , bandHome, workspaceIdRaw] = process.argv;
if (!bandHome || workspaceIdRaw === undefined) {
  console.error("usage: node set-active-workspace.mjs <band_home> <workspaceId|null>");
  process.exit(2);
}

const workspaceId = workspaceIdRaw === "null" ? null : workspaceIdRaw;

const settings = JSON.parse(readFileSync(join(bandHome, "settings.json"), "utf-8"));
const port = settings.webServerPort;
const token = settings.tokenSecret;
if (!port || !token) {
  console.error("settings.json missing webServerPort or tokenSecret");
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/trpc/editor.setActiveWorkspace`;
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `band_token=${token}`,
  },
  body: JSON.stringify({ workspaceId }),
});

const body = await response.text();
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${body}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  console.error(`invalid JSON response: ${body}`);
  process.exit(1);
}

if (parsed.error) {
  console.error(`tRPC error: ${parsed.error.message ?? body}`);
  process.exit(1);
}

console.log(body);
