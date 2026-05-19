/**
 * Pino-backed logger for the Electron main process.
 *
 * Mirrors the rest of the codebase (`apps/web/src/lib/*`) which uses
 * `@band-app/logger`'s `createLogger(name)` factory. Filters with
 * `LOG_LEVEL=debug` (or `trace`/`info`/`warn`/`error`) — same env
 * var the web server reads, so a single `LOG_LEVEL=debug pnpm dev`
 * lights up structured debug output across the whole process tree.
 *
 * Output destinations:
 *
 *   - **stderr** — same as the rest of the codebase, picked up by the
 *     dev orchestrator and shown in the Electron terminal.
 *   - **`~/.band/desktop.log`** — rotated at 5MB. Mirrors the
 *     pre-pino persistent log path so existing user docs / debug
 *     instructions ("`tail ~/.band/desktop.log`") keep working.
 *
 * The pre-pino `dashLog` / `dashDebug` / `logToFile` plain-string
 * API is intentionally gone — every callsite was migrated to a
 * per-module pino child logger (`const log = createLogger("…")`).
 * Use structured fields instead of string interpolation where it
 * carries information (e.g. `log.info({ host, fingerprint }, "msg")`).
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@band-app/logger";
import pino from "pino";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function bandHome(): string {
  return join(homedir(), ".band");
}

export function desktopLogPath(): string {
  return join(bandHome(), "desktop.log");
}

let dirEnsured = false;
function ensureDirSync(): void {
  if (dirEnsured) return;
  // Sync mkdir on first write — the file destination is itself
  // synchronous (`appendFileSync`), so a synchronous mkdir is the
  // honest match. Only set `dirEnsured` on success so a transient
  // failure (permissions race, disk full) is retried next call
  // rather than silently dropped forever.
  try {
    mkdirSync(bandHome(), { recursive: true });
    dirEnsured = true;
  } catch {
    // best-effort — don't take down the app, but leave the flag
    // unset so the next log line will retry.
  }
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
 * Custom pino destination that mirrors every log line to
 * `~/.band/desktop.log`. pino streams writes via a `write(chunk)`
 * interface; we satisfy it with an `appendFileSync` plus the same
 * 5MB rotation the pre-pino implementation used. Errors are
 * swallowed so a full disk doesn't take down the app.
 */
const fileDestination: pino.DestinationStream = {
  write(chunk: string): void {
    ensureDirSync();
    const path = desktopLogPath();
    rotateIfNeeded(path);
    try {
      appendFileSync(path, chunk);
    } catch {
      // best-effort persistent logging
    }
  },
};

/**
 * Composite stream: writes to BOTH stderr (for live development)
 * AND the rotating file. pino routes every record through both.
 * The `level` floor here is `trace` so per-logger levels take
 * precedence — `createLogger` below sets the actual filter.
 */
const multiStream = pino.multistream([
  { level: "trace", stream: process.stderr },
  { level: "trace", stream: fileDestination },
]);

/**
 * Create a named pino logger for a desktop module. Sets the level
 * from `LOG_LEVEL` (default `"info"`) and writes through the
 * stderr + file multistream above. Matches the API used by every
 * pino caller in `apps/web/src/lib/*` so log lines look identical
 * across the process tree.
 *
 * Use this at the top of each module:
 *
 *     const log = createLogger("view-manager");
 *     log.info({ host, fingerprint }, "cert exception added");
 */
export function createLogger(name: string): Logger {
  // pino's `(options, stream)` form is the canonical way to attach
  // a custom destination. `@band-app/logger`'s default factory
  // wouldn't let us inject the file-mirroring stream, so we
  // re-create the logger here with the same shape (name, env-
  // sourced level) but pointed at our multistream.
  return pino(
    {
      name,
      level: process.env.LOG_LEVEL || "info",
    },
    multiStream,
  );
}

/** Re-export the underlying type so callers don't need a separate import. */
export type { Logger };

/**
 * Shared "desktop" logger for bootstrap-level / non-namespaced
 * messages (crash handlers, the initial "dashboard starting" line,
 * etc.). Modules should prefer their own `createLogger("module-name")`
 * for filtering granularity.
 */
export const log: Logger = createLogger("desktop");
