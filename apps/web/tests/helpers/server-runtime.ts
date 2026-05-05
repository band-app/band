// Single source of truth for spawning the production web server in tests.
// The server requires Bun (bun:sqlite). When the suite migrates to `bun test`
// these tests can drop the spawn entirely.
export const SERVER_RUNTIME = "bun";
export const SERVER_SCRIPT = "dist/start-server.mjs";
