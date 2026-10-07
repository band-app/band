import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonTerminalBackend } from "@band-app/host-local/terminals/daemon/daemon-backend";
import { InProcessTerminalBackend } from "@band-app/host-local/terminals/in-process-backend";
import type { TerminalBackend } from "@band-app/host-local/terminals/terminal-backend";

/** The worker's terminal daemon keeps its socket, pid record, log and exit records here. */
export function terminalRunDir(stateDir: string): string {
  return join(stateDir, "run");
}

/**
 * Where this worker's terminals live. The terminal daemon, a detached process
 * that outlives the worker, so a shell survives a worker restart and the hub
 * reattaches to it. The daemon's files are under the worker's state dir
 * (`run/`, mode 0700, the socket 0600), and its scrollback checkpoints under
 * `terminal-history/` beside it.
 *
 * In-process (terminals die with the worker) when `daemon` is false, on Windows,
 * when `BAND_TERMINAL_DAEMON=0`, and when the daemon entry is missing.
 */
export function createWorkerTerminalBackend(
  stateDir: string,
  daemon: boolean,
): { backend: TerminalBackend; daemon: DaemonTerminalBackend | null } {
  const inProcess = { backend: new InProcessTerminalBackend(), daemon: null };
  if (!daemon || process.platform === "win32" || process.env.BAND_TERMINAL_DAEMON === "0") {
    return inProcess;
  }
  // Next to this file: `dist/` for the bundle, `src/` in a checkout, where tsx runs the `.ts`.
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [join(here, "terminal-daemon.mjs"), join(here, "terminal-daemon.ts")].find(
    (candidate) => existsSync(candidate),
  );
  if (!entry) return inProcess;
  const { size, mtimeMs } = statSync(entry);
  const backend = new DaemonTerminalBackend({
    entry,
    runDir: terminalRunDir(stateDir),
    cwd: stateDir,
    buildId: `${size}-${Math.trunc(mtimeMs)}`,
    recordExits: true,
    // A `.ts` entry needs tsx's loader in the daemon too: the worker registers it in-process, so a fork does not inherit it.
    execArgv: entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
  });
  return { backend, daemon: backend };
}

/**
 * Ends every terminal daemon of a worker state dir, and with it the shells.
 * For `uninstall-service`. Reads the pid records the daemons wrote and signals
 * a pid only when its command line is a terminal daemon, because a record can
 * outlive its process and the pid can then belong to something else.
 */
export function stopTerminalDaemons(stateDir: string): number {
  const runDir = terminalRunDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(runDir).filter((name) =>
      /^terminal-daemon-v\d+(\.retired-[0-9a-f]+)?\.pid$/.test(name),
    );
  } catch {
    return 0;
  }
  let stopped = 0;
  for (const name of names) {
    try {
      const { pid } = JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number };
      if (!Number.isInteger(pid) || pid <= 1 || !isTerminalDaemon(pid)) continue;
      process.kill(pid, "SIGTERM");
      stopped += 1;
    } catch {
      // No record, no process, or not ours to signal.
    }
  }
  return stopped;
}

function isTerminalDaemon(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return command.includes("terminal-daemon");
  } catch {
    return false;
  }
}
