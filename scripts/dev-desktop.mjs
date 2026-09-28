#!/usr/bin/env node

/**
 * Dev orchestrator for the Electron desktop shell. Runs all of:
 *
 *   1. **`pnpm dev:web`** — `tsx watch start-server.ts` with
 *      `NODE_ENV=development`. The unified start-server.ts mounts Vite as
 *      middleware inside its own http server (see #477), so the renderer
 *      hot-reloads on save *and* the dev process exposes the same
 *      cronjob / cleanup / tunnel surface as the packaged DMG. No
 *      Electron restart needed for renderer-side changes.
 *
 *   2. **`tsc --watch`** for `apps/desktop/src/main` and `src/preload` —
 *      incrementally re-emits the compiled main / preload bundles to
 *      `apps/desktop/dist` whenever the source changes.
 *
 *   3. **Electron**, launched once `apps/desktop/dist/main/main/index.js`
 *      exists. Auto-**restarted** whenever any file under `apps/desktop/dist/`
 *      changes — i.e. after every successful tsc emit.
 *
 *   4. The web-server port is auto-detected from its stdout (PORT defaults
 *      to 3456 but a busy port is rare in dev; if `start-server.ts` ever
 *      adds fallback logic, this regex picks up whatever it picks) and
 *      forwarded to Electron via the `BAND_DEV_WEB_URL` env var.
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
// 1. Spawn the dev web server (color-free so port detection works
//    regardless of pnpm's forced TTY colorization). Pre-#477 this was
//    `vite dev`; now it's `tsx watch start-server.ts` (same npm script
//    name, `pnpm dev:web`, so this orchestrator didn't need to change).
// ---------------------------------------------------------------------------

const webServer = spawn("pnpm", ["dev:web"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
});
// Mirror the spawn option onto the ChildProcess instance so `killTree`
// (below) can see it and do a process-group kill (`process.kill(-pid,
// "SIGTERM")`). Node's `spawn({ detached: true })` does NOT copy the
// option onto the returned `child.detached`; verified empirically —
// without this assignment we'd fall back to single-process kill and
// orphan pnpm's grandchildren (`tsx`, the actual web server).
webServer.detached = true;
webServer.stderr.on("data", (chunk) => process.stderr.write(chunk));

let detectedPort = null;
const rl = createInterface({ input: webServer.stdout });
rl.on("line", (rawLine) => {
  const line = stripAnsi(rawLine);
  process.stdout.write(line + "\n");
  if (detectedPort) return;
  // Match the `Web server listening on http://0.0.0.0:<port>` line emitted
  // by `start-server.ts` (both dev and prod modes use the same banner).
  // Pre-#477 this regex matched Vite's `Local: http://localhost:<port>`
  // banner instead.
  const match = line.match(/Web server listening on https?:\/\/[^:]+:(\d+)/);
  if (match) {
    detectedPort = match[1];
    console.log(
      `\n[dev-desktop] web server bound to port ${detectedPort} → BAND_DEV_WEB_URL=http://localhost:${detectedPort}\n`,
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
  // Strip `ELECTRON_RUN_AS_NODE` from the inherited env. When that var is
  // truthy, the Electron binary runs as plain Node.js: it skips its
  // browser-process bootstrap, doesn't register `"electron"` as a
  // built-in module, and `require("electron")` falls through to the npm
  // wrapper (which exports the binary path as a string). The user code
  // then crashes with `TypeError: Cannot read properties of undefined
  // (reading 'whenReady')` — or, with ESM main, an NPE deep in Node's
  // CJS-from-ESM preparser. Same root cause as electron/electron#8200
  // (2016) and the closing comment on #49018 / #49034. The env var is
  // set by some agent / IDE shells (notably Claude Code's runtime) for
  // their own use of Electron's bundled Node; we don't want that
  // leaking into the dev launch here.
  const { ELECTRON_RUN_AS_NODE: _eran, ...envWithoutRunAsNode } = process.env;
  electronProc = spawn("pnpm", ["exec", "electron", "."], {
    cwd: desktopDir,
    stdio: "inherit",
    env: { ...envWithoutRunAsNode, BAND_DEV_WEB_URL: `http://localhost:${detectedPort}` },
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
  killTree(webServer);
}

webServer.on("exit", () => {
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
