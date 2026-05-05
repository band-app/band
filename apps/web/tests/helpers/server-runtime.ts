// Single source of truth for spawning the production web server in tests.
// The server runs under Node and uses Node's built-in `node:sqlite` (no
// native modules to ABI-match against the host).
export const SERVER_RUNTIME = "node";
export const SERVER_SCRIPT = "dist/start-server.mjs";
