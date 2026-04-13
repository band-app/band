#!/usr/bin/env node

/**
 * Starts the web dev server (vite), detects the actual port it bound to,
 * then launches the Tauri app pointed at that port.
 *
 * This handles the case where port 3456 is already taken (e.g. another
 * Band instance is running) — vite auto-picks the next available port
 * and we forward it to Tauri via --config override.
 *
 * The vite process is spawned in its own process group (detached) so we
 * can reliably kill the entire tree (pnpm → node → vite) on cleanup.
 * The tauri process is NOT detached so Node.js receives its exit event.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Kill an entire process group. Falls back to single-process kill. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (child.detached) {
    try {
      // Negative PID sends the signal to the entire process group
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
// 1. Start the vite dev server in its own process group
// ---------------------------------------------------------------------------

const vite = spawn("pnpm", ["dev:web"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
// Tag so killTree knows to use group kill
vite.detached = true;

// Forward stderr (vite warnings, HMR logs, etc.)
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));

// ---------------------------------------------------------------------------
// 2. Parse the actual port from vite's stdout
// ---------------------------------------------------------------------------

const rl = createInterface({ input: vite.stdout });
let tauriProcess = null;

rl.on("line", (line) => {
  // Always forward vite output
  process.stdout.write(line + "\n");

  if (tauriProcess) return;

  // Vite prints:  ➜  Local:   http://localhost:3456/
  const match = line.match(/Local:\s+https?:\/\/localhost:(\d+)/);
  if (!match) return;

  const port = match[1];
  console.log(
    `\n[dev-dashboard] Web server ready on port ${port}, starting Tauri...\n`,
  );

  // -----------------------------------------------------------------
  // 3. Start Tauri with the detected port, skip beforeDevCommand
  //    (we already started vite ourselves).
  //    NOT detached — so Node.js receives its exit event when the
  //    Tauri window is closed.
  // -----------------------------------------------------------------

  const configOverride = JSON.stringify({
    build: {
      devUrl: `http://localhost:${port}`,
      beforeDevCommand: "",
    },
  });

  tauriProcess = spawn(
    "pnpm",
    [
      "--filter",
      "@band-app/dashboard",
      "tauri",
      "dev",
      "--config",
      configOverride,
    ],
    { stdio: "inherit" },
  );

  tauriProcess.on("exit", (code) => {
    killTree(vite);
    process.exit(code ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  killTree(tauriProcess);
  killTree(vite);
}

vite.on("exit", () => {
  killTree(tauriProcess);
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
