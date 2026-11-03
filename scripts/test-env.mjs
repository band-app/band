// A Band worker puts its own identity in the environment of every agent and
// terminal it starts (BAND_WORKER_ID, BAND_TOKEN, a git credential helper in
// GIT_CONFIG_*, and so on). A test that spawns a hub, a band-worker or the CLI
// inherits those and talks to the real hub, or has the hub refuse its bootstrap
// token (HTTP 401) because the worker id belongs to another worker.
// Test configs call this once, before any test process starts, so everything
// they fork sees a clean environment.
const AGENT_VARS = new Set([
  "BAND_DISPATCH",
  "BAND_SERVER_URL",
  "BAND_TOKEN",
  "BAND_HUB_URL",
  "BAND_WORKTREE_ID",
  "BAND_CHAT_ID",
  "BAND_TERMINAL_ID",
  "BAND_CDP_PORT_FILE",
  "BAND_GIT_CREDENTIAL_SOCK",
  "BAND_HOME",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GH_TOKEN",
]);

export function scrubWorkerEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (
      AGENT_VARS.has(key) ||
      key.startsWith("BAND_WORKER_") ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}
