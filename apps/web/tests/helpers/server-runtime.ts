// Single source of truth for spawning the production web server in tests.
// The server runs under Node — better-sqlite3 is a Node-ABI native module
// loaded at startup.
export const SERVER_RUNTIME = "node";
export const SERVER_SCRIPT = "dist/start-server.mjs";
