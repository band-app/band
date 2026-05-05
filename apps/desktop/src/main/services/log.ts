/**
 * Lightweight logger that writes to `~/.band/desktop.log` with 5MB rotation.
 *
 * Mirrors `apps/dashboard/src-tauri/src/lib.rs::log_to_file` and the
 * `dash_log!` macro. Used by the panic/uncaughtException handler and any
 * service that wants persistent logs across app launches.
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function bandHome(): string {
  return join(homedir(), ".band");
}

export function desktopLogPath(): string {
  return join(bandHome(), "desktop.log");
}

let dirEnsured = false;
async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(bandHome(), { recursive: true });
  dirEnsured = true;
}

function rotateIfNeeded(path: string): void {
  try {
    const meta = statSync(path);
    if (meta.size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.old`);
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

/**
 * Append a single log line. Best-effort: silently swallows errors so a full
 * disk doesn't take down the app.
 */
export function logToFile(msg: string): void {
  void ensureDir().catch(() => undefined);
  const path = desktopLogPath();
  rotateIfNeeded(path);
  const stamp = new Date().toISOString();
  try {
    appendFileSync(path, `[${stamp}] ${msg}\n`);
  } catch {
    // ignore — best-effort persistent logging
  }
}

/** Mirror of Tauri's `dash_log!` macro: log to stderr AND the rotating file. */
export function dashLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
  logToFile(msg);
}
