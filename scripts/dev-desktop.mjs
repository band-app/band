#!/usr/bin/env node

/**
 * Dev orchestrator for the Electron desktop shell. Runs all of:
 *
 *   1. **Vite** (`pnpm dev:web`) — serves the renderer with HMR. The
 *      renderer (apps/web, packages/dashboard-core) hot-reloads on save;
 *      no Electron restart needed for renderer-side changes.
 *
 *   2. **`tsc --watch`** for `apps/desktop/src/main` and `src/preload` —
 *      incrementally re-emits the compiled main / preload bundles to
 *      `apps/desktop/dist` whenever the source changes.
 *
 *   3. **Electron**, launched once `apps/desktop/dist/main/main/index.js`
 *      exists. Auto-**restarted** whenever any file under `apps/desktop/dist/`
 *      changes — i.e. after every successful tsc emit.
 *
 *   4. The vite port is auto-detected from its stdout (vite falls back to
 *      the next free port if 3456 is taken) and forwarded to Electron via
 *      the `BAND_DEV_WEB_URL` env var.
 *
 * Cleanup: SIGTERM all children on exit (via process-group kill on Unix).
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = resolve(repoRoot, "apps", "desktop");
const distDir = resolve(desktopDir, "dist");
const mainEntry = resolve(distDir, "main", "main", "index.js");

/** Strip ANSI escape sequences (color, cursor, etc) from a line. */
function stripAnsi(s) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI requires control chars.
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Kill an entire process group. Falls back to single-process kill. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (child.detached) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // fall through
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already dead
  }
}

// ---------------------------------------------------------------------------
// 1. Spawn vite (color-free so port detection works regardless of pnpm's
//    forced TTY colorization).
// ---------------------------------------------------------------------------

const vite = spawn("pnpm", ["dev:web"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
});
vite.detached = true;
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));

let detectedPort = null;
const rl = createInterface({ input: vite.stdout });
rl.on("line", (rawLine) => {
  const line = stripAnsi(rawLine);
  process.stdout.write(line + "\n");
  if (detectedPort) return;
  const match = line.match(/Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
  if (match) {
    detectedPort = match[1];
    console.log(
      `\n[dev-desktop] vite bound to port ${detectedPort} → BAND_DEV_WEB_URL=http://localhost:${detectedPort}\n`,
    );
    maybeStartElectron();
  }
});

// ---------------------------------------------------------------------------
// 2. tsc --watch for main + preload, with `--preserveWatchOutput` so the
//    "File change detected" lines don't clear the terminal between rebuilds.
// ---------------------------------------------------------------------------

function spawnTscWatch(label, configFile) {
  const proc = spawn(
    "pnpm",
    ["exec", "tsc", "-p", configFile, "--watch", "--preserveWatchOutput"],
    {
      cwd: desktopDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout.on("data", (chunk) => process.stdout.write(`[tsc:${label}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[tsc:${label}] ${chunk}`));
  return proc;
}

const tscMain = spawnTscWatch("main", "tsconfig.main.json");
const tscPreload = spawnTscWatch("preload", "tsconfig.preload.json");

// ---------------------------------------------------------------------------
// 3. Electron — launched after the first build emits `main/index.js`, then
//    restarted on every dist change.
// ---------------------------------------------------------------------------

let electronProc = null;
let restartTimer = null;

function startElectron() {
  if (!detectedPort) return;
  if (!existsSync(mainEntry)) return;
  if (electronProc) return;
  electronProc = spawn("pnpm", ["exec", "electron", "."], {
    cwd: desktopDir,
    stdio: "inherit",
    env: { ...process.env, BAND_DEV_WEB_URL: `http://localhost:${detectedPort}` },
  });
  electronProc.on("exit", (code) => {
    electronProc = null;
    // If Electron exits cleanly (user closed the window), tear everything
    // down. If the user is hitting Cmd+Q during a hot-reload window we
    // re-launch from the dist watcher below.
    if (code === 0 || code === null) {
      cleanup();
      process.exit(0);
    }
  });
}

function maybeStartElectron() {
  startElectron();
}

function restartElectron() {
  if (!electronProc) {
    // Not yet started (first build still in progress) — start when ready.
    startElectron();
    return;
  }
  console.log("[dev-desktop] dist changed, restarting Electron…");
  electronProc.removeAllListeners("exit");
  electronProc.once("exit", () => {
    electronProc = null;
    startElectron();
  });
  killTree(electronProc);
}

// Watch dist/ recursively. Debounce the burst of fs events tsc emits during
// a single compile.
if (existsSync(distDir)) startElectron();
const distWatcher = watch(distDir, { recursive: true }, () => {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (existsSync(mainEntry)) restartElectron();
  }, 250);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  try {
    distWatcher.close();
  } catch {
    // already closed
  }
  killTree(electronProc);
  killTree(tscMain);
  killTree(tscPreload);
  killTree(vite);
}

vite.on("exit", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
