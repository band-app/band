/**
 * Web server lifecycle. Direct port of
 * `apps/dashboard/src-tauri/src/commands/webserver.rs`.
 *
 *   - `ManagedProcess` wraps an optional `ChildProcess`, kills the whole
 *     process group on stop (so the orchestrating script's Node + the web
 *     server's children all exit cleanly).
 *   - `ensureWebserverRunning` is the boot-time helper: kill stale, spawn
 *     the bundled server, poll `/api/health` until ready or 15s elapses.
 *   - `webserverStart`/`webserverStop` are the IPC-callable verbs (idempotent
 *     start, kill-by-pid + kill-by-port stop).
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { bandHome, createLogger } from "./log.js";
import { killPort } from "./port.js";
import { getConfiguredPort, tryGetToken } from "./settings.js";
import { shellPath } from "./shell-path.js";

const log = createLogger("web-server");

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 3_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// ManagedProcess
// ---------------------------------------------------------------------------

export class ManagedProcess {
  private child: ChildProcess | null = null;

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  set(child: ChildProcess): void {
    this.child = child;
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;

    if (process.platform !== "win32" && typeof child.pid === "number") {
      // Negative pid signals the process group (we set detached:true on spawn,
      // which calls setsid under the hood on Unix).
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already dead, or pid is no longer a leader
      }
    } else {
      child.kill("SIGTERM");
    }

    // Give the process a moment to run shutdown hooks before SIGKILL.
    await delay(SHUTDOWN_GRACE_MS);
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

interface HealthBody {
  app?: unknown;
}

/** True when the body identifies this server as our local web server. */
export function parseLocalHealth(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as HealthBody;
    return parsed.app === "band-web-server";
  } catch {
    return false;
  }
}

/**
 * Hit `/api/health?token=...` and confirm the response identifies our
 * server. Uses Node's native `fetch` (stable in 22.x) — no shell-out to curl
 * like the Tauri version, since `fetch` with `AbortSignal.timeout` is
 * functionally equivalent and available in-process.
 */
export async function checkLocalHealth(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/health?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) return false;
    const body = await res.text();
    return parseLocalHealth(body);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server log file (append-mode, 5MB rotated to .old)
// ---------------------------------------------------------------------------

interface ServerLogFds {
  out: number;
  err: number;
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const meta = await stat(path);
    if (meta.size > MAX_LOG_BYTES) {
      await rename(path, `${path}.old`);
    }
  } catch {
    // doesn't exist — nothing to rotate
  }
}

/**
 * Open `~/.band/server.log` in append mode (rotating if >5MB) and return two
 * raw fds for stdout/stderr. Caller passes them to spawn's `stdio`.
 *
 * Mirrors `webserver.rs::server_log_stdio`.
 */
export async function openServerLog(): Promise<ServerLogFds> {
  await mkdir(bandHome(), { recursive: true });
  const path = join(bandHome(), "server.log");
  await rotateIfNeeded(path);
  const out = openSync(path, "a");
  const err = openSync(path, "a");
  return { out, err };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnWebServerOptions {
  webDir: string;
  port: number;
  /**
   * `app.isPackaged` from the caller. Used to set `BAND_PACKAGED=1` in the
   * spawned web server's env so it can pick a packaged-vs-dev error
   * message when the bundled CLI sidecar isn't found. Defaults to false so
   * tests don't have to fake an Electron app.
   */
  isPackaged?: boolean;
}

function makeSpawnOptions(
  webDir: string,
  port: number,
  fds: ServerLogFds,
  isPackaged: boolean,
): SpawnOptions {
  return {
    cwd: webDir,
    env: {
      ...process.env,
      // The web server is spawned via `process.execPath` (the Electron
      // binary). `ELECTRON_RUN_AS_NODE=1` tells Electron to act as a plain
      // Node.js interpreter — no Chromium, no app lifecycle — so we get the
      // bundled Node runtime (22.x for Electron 35+, with `node:sqlite` as
      // a built-in) without requiring users to install Node themselves.
      //
      // Note: this var inherits into every grandchild the web server forks.
      // Harmless for the current stack (Rust CLIs, git, etc. ignore it) but
      // *not* harmless for any Electron-based binary in the call chain. The
      // most concrete example is the VS Code `code` CLI (Electron) — if the
      // web server ever shells out to it to open a file or run a task, it
      // would launch as a plain Node interpreter instead of the editor. If
      // we ever add such a call site, scrub this var from that spawn's env.
      ELECTRON_RUN_AS_NODE: "1",
      // Signal to the bundled web server that it's running inside a
      // packaged Electron app (not a dev `pnpm dev:desktop` run). Used by
      // `apps/web/src/server/services/cli.ts::installCli` to pick the right error
      // message when the sidecar can't be found: ".dmg user, try
      // reinstalling" vs. "developer, run cargo build first". Set only
      // when truly packaged so dev-electron stays on the dev message.
      ...(isPackaged ? { BAND_PACKAGED: "1" } : {}),
      // Repopulate PATH from the user's login shell. Even though we no
      // longer need a system `node` on PATH (spawn target is
      // `process.execPath`), the web server's *own* children — `claude`,
      // `band`, `git`, etc. living in `/opt/homebrew/bin` or
      // `~/.cargo/bin` — inherit this env and rely on it to find their
      // binaries when the app is launched from Finder/Spotlight (macOS
      // gives GUI launches only a sparse `/usr/bin:/bin:/usr/sbin:/sbin`).
      PATH: shellPath(),
      PORT: String(port),
      // Silence the `node:sqlite` ExperimentalWarning. Node 22.x still
      // emits it; drop this once the bundled Node hits 24.x where the
      // module is marked Stable.
      //
      // Append (not replace) so we don't clobber any NODE_OPTIONS the
      // parent already had — e.g. `--max-old-space-size=…` from a dev's
      // shell profile, or a `--require` loader. Node parses
      // space-separated flags in this var.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-warnings=ExperimentalWarning"]
        .filter(Boolean)
        .join(" "),
    },
    stdio: ["ignore", fds.out, fds.err],
    // Detached on Unix puts the spawn into its own process group so
    // `process.kill(-pid)` later can take down the whole tree.
    detached: process.platform !== "win32",
  };
}

/**
 * Spawn the bundled web server in `webDir`, using Electron's embedded Node
 * runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`). Returns the child
 * handle; caller is responsible for tracking it (typically via
 * `ManagedProcess`).
 *
 * Using the embedded Node — rather than `spawn("node", ...)` — means the app
 * works even when the user has no system Node installed (or has the wrong
 * version, or a sparse `PATH` from a Finder/Spotlight launch). It also
 * guarantees the runtime ships `node:sqlite` as a built-in, which our
 * `apps/web/src/server/infra/db/connection.ts` relies on.
 */
export async function spawnWebServer(opts: SpawnWebServerOptions): Promise<ChildProcess> {
  const startScript = join(opts.webDir, "dist/start-server.mjs");
  const fds = await openServerLog();
  const child = spawn(
    process.execPath,
    [startScript],
    makeSpawnOptions(opts.webDir, opts.port, fds, opts.isPackaged ?? false),
  );
  if (process.platform !== "win32") {
    // Don't let the parent process wait on the child; we manage its lifetime.
    child.unref();
  }
  child.on("error", (err) => {
    // After moving to the embedded Node runtime, ENOENT on the spawn
    // *binary* is effectively impossible — `process.execPath` is the
    // running interpreter, bundled with the .app. ENOENT on the *start
    // script* can still happen if the web bundle is missing or
    // corrupted, hence `script=` in the diagnostic below. Either way,
    // we no longer tell users to install Node.
    log.error(
      {
        err: err.message,
        execPath: process.execPath,
        cwd: opts.webDir,
        script: startScript,
      },
      "failed to start web server",
    );
  });
  return child;
}

// ---------------------------------------------------------------------------
// Boot helper: kill stale → spawn → poll until healthy
// ---------------------------------------------------------------------------

export interface EnsureWebserverOptions {
  webDir: string;
  managed: ManagedProcess;
  /** Override the configured port (defaults to settings.json / 3456). */
  port?: number;
  /** Forwarded to `spawnWebServer` — see SpawnWebServerOptions.isPackaged. */
  isPackaged?: boolean;
}

export interface EnsureWebserverResult {
  port: number;
  token: string;
}

/**
 * Boot path: kill any process on the configured port, spawn the bundled
 * web server, poll `/api/health` until it responds with `app === "band-web-server"`,
 * and return `{ port, token }` ready to embed in the dashboard URL.
 *
 * Mirrors `webserver.rs::ensure_webserver_running`.
 */
export async function ensureWebserverRunning(
  opts: EnsureWebserverOptions,
): Promise<EnsureWebserverResult> {
  const port = opts.port ?? getConfiguredPort();
  await killPort(port);

  const child = await spawnWebServer({ webDir: opts.webDir, port, isPackaged: opts.isPackaged });
  opts.managed.set(child);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(HEALTH_POLL_INTERVAL_MS);
    const token = tryGetToken();
    if (token && (await checkLocalHealth(port, token))) {
      return { port, token };
    }
  }

  throw new Error("Web server did not become healthy within 15 seconds");
}

// ---------------------------------------------------------------------------
// IPC verbs (Phase 1 commands)
// ---------------------------------------------------------------------------

export interface WebserverIpcContext {
  webDir: string;
  managed: ManagedProcess;
  /** Forwarded to `spawnWebServer` — see SpawnWebServerOptions.isPackaged. */
  isPackaged?: boolean;
}

/**
 * `webserver_start` — idempotent. If the managed process is already running,
 * or an external server is responding healthy, no-op. Otherwise spawn.
 */
export async function webserverStart(ctx: WebserverIpcContext): Promise<void> {
  if (ctx.managed.isRunning()) return;

  const port = getConfiguredPort();
  const token = tryGetToken();
  if (token && (await checkLocalHealth(port, token))) return;

  const child = await spawnWebServer({ webDir: ctx.webDir, port, isPackaged: ctx.isPackaged });
  ctx.managed.set(child);
}

/**
 * `webserver_stop` — kills the managed process AND any process listening on
 * the configured port (handles externally-started servers).
 */
export async function webserverStop(ctx: WebserverIpcContext): Promise<void> {
  await ctx.managed.kill();
  await killPort(getConfiguredPort());
}
