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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Starts the hub detached in its own process group and resolves with its port. */
function boot({ home, port, adminToken }) {
  const entry = join(HUB_ROOT, "dist/start-server.mjs");
  if (!existsSync(entry)) {
    throw new Error(`No hub build at ${entry}. Run \`pnpm build:web\` from the repo root first.`);
  }
  const log = join(home, "hub.log");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: HUB_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        BAND_ADMIN_TOKEN: adminToken,
        BAND_TEST_ACP_AGENT: join(HUB_ROOT, "tests/fixtures/acp-stub-agent.mjs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    const timer = setTimeout(() => {
      fail(new Error(`The hub did not start within 30 s. Log: ${log}`));
    }, 30_000);
    const fail = (err) => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      reject(err);
    };
    const onData = (chunk) => {
      out += chunk.toString();
      writeFileSync(log, out);
      const bound = BANNER.exec(out)?.[1];
      if (bound) {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve({ pid: child.pid, port: Number(bound) });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => fail(new Error(`The hub exited with code ${code}. Log: ${log}`)));
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

async function start() {
  await stop();
  const previous = readState();
  if (previous?.home) rmSync(previous.home, { recursive: true, force: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "band-mobile-verify-")));
  mkdirSync(join(home, ".band"), { recursive: true });
  const adminToken = `band_${randomBytes(24).toString("hex")}`;
  const { pid, port } = await boot({ home, port: await freePort(), adminToken });
  const url = `http://127.0.0.1:${port}`;
  const deviceToken = await createDeviceToken(url, adminToken);
  const state = { url, port, home, pid, adminToken, deviceToken };
  writeState(state);
  return state;
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
  if (state?.home) rmSync(state.home, { recursive: true, force: true });
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
