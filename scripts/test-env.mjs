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

import { spawnSync } from "node:child_process";

// Simulator devices live in the account's default device set whatever HOME a test sets, so a
// test that boots one with the real prefix ("Band") leaves a device in the person's own
// Simulator. Every test process gets a prefix of its own instead: `band-test-<seconds in base 36>-<pid>`.
// The time is in the name so a later run can tell a crashed run's leftovers from a live run's.
const PREFIX_VAR = "BAND_SIMULATOR_NAME_PREFIX";
const TEST_PREFIX = /^band-test-([0-9a-z]+)-\d+$/;

/** Sets the simulator name prefix of this run unless the caller already chose one. */
export function ensureSimulatorTestPrefix(env = process.env, now = Date.now()) {
  if (!env[PREFIX_VAR]?.trim()) {
    env[PREFIX_VAR] = `band-test-${Math.floor(now / 1000).toString(36)}-${process.pid}`;
  }
  return env[PREFIX_VAR];
}

/**
 * The devices that belong to a test prefix, from `simctl list devices -j` output: only a name that
 * starts with `band-test-<time>-<pid> – `. `olderThanMs` keeps those from a run that started
 * longer ago; `prefix` keeps one run's devices. A device of a person's never matches.
 */
export function testDevicesIn(listJson, { prefix, olderThanMs, now = Date.now() } = {}) {
  const out = [];
  for (const list of Object.values(listJson?.devices ?? {})) {
    for (const d of list) {
      const m = /^(band-test-([0-9a-z]+)-\d+) \u2013 /.exec(d.name ?? "");
      if (!m) continue;
      if (prefix !== undefined && m[1] !== prefix) continue;
      if (olderThanMs !== undefined && now - Number.parseInt(m[2], 36) * 1000 < olderThanMs) continue;
      out.push({ udid: d.udid, name: d.name });
    }
  }
  return out;
}

const simctl = (args) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 120_000 });

/** Device names starting with `startsWith` ("Band " + en dash, for the desktop guard). Null when xcrun is missing. */
export function listSimulatorNames(startsWith) {
  const r = simctl(["list", "devices", "-j"]);
  if (r.error || r.status !== 0) return null;
  try {
    const names = [];
    for (const list of Object.values(JSON.parse(r.stdout).devices ?? {})) {
      for (const d of list) if (d.name?.startsWith(startsWith)) names.push(d.name);
    }
    return names.sort();
  } catch {
    return null;
  }
}

/**
 * Deletes this run's test devices (`prefix`) and any `band-test-*` device older than `olderThanMs`
 * (a crashed run's). Never touches a device whose name does not start with a test prefix.
 * Returns the names it deleted. Does nothing when xcrun is missing.
 */
export function sweepSimulatorTestDevices({ prefix, olderThanMs = 3 * 3600_000 } = {}) {
  const r = simctl(["list", "devices", "-j"]);
  if (r.error || r.status !== 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const mine = prefix ? testDevicesIn(parsed, { prefix }) : [];
  const stale = testDevicesIn(parsed, { olderThanMs });
  const seen = new Set();
  const deleted = [];
  for (const d of [...mine, ...stale]) {
    if (seen.has(d.udid)) continue;
    seen.add(d.udid);
    simctl(["shutdown", d.udid]);
    if (simctl(["delete", d.udid]).status === 0) deleted.push(d.name);
  }
  return deleted;
}

export function scrubWorkerEnv(env = process.env) {
  ensureSimulatorTestPrefix(env);
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
