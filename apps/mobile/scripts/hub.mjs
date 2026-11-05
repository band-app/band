#!/usr/bin/env node
/**
 * A throwaway Band hub for mobile-verify: `node scripts/hub.mjs start | stop | restart | clean | status`.
 *
 * `start` boots the hub's production bundle (`apps/hub/dist/start-server.mjs`) on a free port
 * with a temp HOME (so a temp BAND_HOME), a known admin token and the scripted ACP stub agent,
 * the way the web e2e specs do. It then creates a device token through `tokens.createDevice`
 * and writes everything to `build/verify/hub.json`. `restart` boots the same home on the same
 * port. Never touches the real HOME or ~/.band.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO } from "./seed.mjs";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_ROOT = join(APP_ROOT, "../hub");
const STATE_FILE = join(APP_ROOT, "build/verify/hub.json");
const BANNER = /Web server listening on http:\/\/[^\s:]+:(\d+)/;

function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The caller's environment without `BAND_*`, so a BAND_HOME or token in the shell can't leak in. */
export function cleanEnv(env = process.env) {
  // CLAUDE_CONFIG_DIR and CODEX_HOME would point the hub's usage readers at a real login.
  // The GIT_CONFIG_* entries, askpass helpers and credential socket are a Band worker's git
  // credential helper: a test hub must never run the real worker's helper.
  const drop = new Set([
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GH_TOKEN",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !k.startsWith("BAND_") && !drop.has(k) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k),
    ),
  );
}

/** Pids named by the `*.pid` files in the hub's run dir (its terminal daemon), never found by pattern. */
function homePids(home) {
  const dir = join(home, ".band", "run");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".pid"));
  } catch {}
  const pids = [];
  for (const name of names) {
    try {
      const raw = readFileSync(join(dir, name), "utf8").trim();
      const pid = Number.parseInt(raw.startsWith("{") ? JSON.parse(raw).pid : raw, 10);
      if (Number.isInteger(pid) && pid > 1 && alive(pid)) pids.push(pid);
    } catch {}
  }
  return pids;
}

/** The scripted agent's turns (`seed.mjs`), written into the home so a restart keeps them. */
function scenarioFile(home) {
  const file = join(home, "acp-scenario.json");
  writeFileSync(file, JSON.stringify(SCENARIO));
  return file;
}

/**
 * Starts the hub detached in its own process group, with its output appended to `hub.log` in
 * the temp home, and resolves with its port once the log shows the listening banner.
 */
function boot({ home, port, adminToken, env: extraEnv = {} }) {
  const entry = join(HUB_ROOT, "dist/start-server.mjs");
  if (!existsSync(entry)) {
    throw new Error(`No hub build at ${entry}. Run \`pnpm build:web\` from the repo root first.`);
  }
  const log = join(home, "hub.log");
  const logStart = existsSync(log) ? statSync(log).size : 0;
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: HUB_ROOT,
    env: {
      ...cleanEnv(),
      HOME: home,
      // Terminals start $SHELL; bash in a bare home gives a plain prompt, zsh runs its first-run wizard.
      SHELL: "/bin/bash",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
      BAND_HOME: join(home, ".band"),
      PORT: String(port),
      NODE_ENV: "production",
      BAND_ADMIN_TOKEN: adminToken,
      BAND_TEST_ACP_AGENT: join(HUB_ROOT, "tests/fixtures/acp-stub-agent.mjs"),
      BAND_TEST_ACP_SCENARIO: scenarioFile(home),
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-requests.jsonl"),
      ...extraEnv,
    },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  return new Promise((resolve, reject) => {
    let exited = null;
    child.on("exit", (code, signal) => {
      exited = code ?? signal;
    });
    const deadline = Date.now() + 30_000;
    const poll = () => {
      const bound = BANNER.exec(readFileSync(log).subarray(logStart).toString())?.[1];
      if (bound) {
        child.removeAllListeners("exit");
        child.unref();
        resolve({ pid: child.pid, port: Number(bound) });
        return;
      }
      if (exited !== null) {
        reject(new Error(`The hub exited (${exited}). Log: ${log}`));
        return;
      }
      if (Date.now() > deadline) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        reject(new Error(`The hub did not start within 30 s. Log: ${log}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function createDeviceToken(url, adminToken) {
  const res = await fetch(`${url}/trpc/tokens.createDevice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "mobile-verify" }),
  });
  if (!res.ok) throw new Error(`tokens.createDevice answered HTTP ${res.status}`);
  const body = await res.json();
  return body.result.data.token;
}

async function stop() {
  const state = readState();
  if (!state?.pid || !alive(state.pid)) return state;
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 50 && alive(state.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {}
  }
  writeState({ ...state, pid: null });
  return state;
}

/** `env` is added to the hub's environment, and kept for `restart` (verify.mjs passes the fake `gh`). */
async function start(env = {}) {
  await stop();
  const previous = readState();
  if (previous?.home) rmSync(previous.home, { recursive: true, force: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "band-mobile-verify-")));
  mkdirSync(join(home, ".band"), { recursive: true });
  const adminToken = `band_${randomBytes(24).toString("hex")}`;
  let pid = null;
  try {
    const booted = await boot({ home, port: await freePort(), adminToken, env });
    pid = booted.pid;
    const url = `http://127.0.0.1:${booted.port}`;
    const deviceToken = await createDeviceToken(url, adminToken);
    const state = { url, port: booted.port, home, pid, adminToken, deviceToken, env };
    writeState(state);
    return state;
  } catch (err) {
    // No state file names this home yet, so `clean` could not find it.
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    throw err;
  }
}

async function restart() {
  const state = await stop();
  if (!state?.home) throw new Error("No hub to restart. Run `start` first.");
  const { pid } = await boot(state);
  const next = { ...state, pid };
  writeState(next);
  return next;
}

/** The state without secrets, for printing. */
function view(state) {
  if (!state) return { running: false };
  return { url: state.url, home: state.home, running: Boolean(state.pid && alive(state.pid)), stateFile: STATE_FILE };
}

/** Stops the hub and deletes its temp home and the state file. */
async function clean() {
  const state = await stop();
  for (const pid of state?.home ? homePids(state.home) : []) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  // The hub's terminal daemon can still be writing its run dir as the hub stops (ENOTEMPTY).
  if (state?.home) rmSync(state.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  rmSync(STATE_FILE, { force: true });
  return null;
}

const commands = { start, stop, restart, clean, status: async () => readState() };

// Exported for verify.mjs, which drives the hub during the Maestro run.
export { clean as cleanHub, restart as restartHub, start as startHub, stop as stopHub };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.error("Usage: node scripts/hub.mjs start | stop | restart | clean | status");
    process.exit(2);
  }
  command()
    .then((state) => console.log(JSON.stringify(view(state), null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
