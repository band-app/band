/**
 * Kill any process listening on the given port.
 *
 * Direct port of `apps/dashboard/src-tauri/src/commands/webserver.rs::kill_port_sync`.
 * The Rust version uses `lsof -ti:PORT` + libc::kill on Unix. Electron runs on
 * macOS/Linux/Windows; we shell out to platform-specific helpers.
 */

import { spawn, spawnSync } from "node:child_process";

const SETTLE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SIGTERM any pids bound to `port`. Best-effort: silently ignores failures
 * (e.g., port wasn't in use). Returns once we've sent the signal and waited
 * a short settle period for the OS to actually free the socket.
 */
export async function killPort(port: number): Promise<void> {
  if (process.platform === "win32") {
    await killPortWindows(port);
  } else {
    killPortUnix(port);
  }
  await sleep(SETTLE_MS);
}

function killPortUnix(port: number): void {
  const result = spawnSync("lsof", [`-ti:${port}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return;
  const pids = (result.stdout ?? "")
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead — ignore
    }
  }
}

async function killPortWindows(port: number): Promise<void> {
  // `netstat -ano | findstr :PORT` would work but parsing it is awkward.
  // PowerShell `Get-NetTCPConnection` is cleaner; fall back to taskkill.
  await new Promise<void>((resolve) => {
    const proc = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore" },
    );
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });
}
