// Teardown for the terminal daemon a test server may have launched.
//
// The daemon is detached on purpose (its shells outlive the web server), so
// the helpers' process-group kill never reaches it. Left alone, it and its
// shells keep writing into the tmp home (`.zsh_history`, the daemon log)
// while `afterAll` deletes it, which surfaces as ENOTEMPTY. It would stand
// down on its own a couple of seconds after the home disappears, but tests
// need it gone before the delete, not after.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STOP_TIMEOUT_MS = 5_000;

/** Pid of the daemon serving `home`, from its pid record, or `null` if none runs. */
export function terminalDaemonPid(home: string): number | null {
  let pid: number;
  try {
    const record = JSON.parse(
      readFileSync(join(home, ".band", "run", "terminal-daemon-v1.pid"), "utf8"),
    ) as { pid: number };
    pid = record.pid;
  } catch {
    return null;
  }
  return isTerminalDaemon(pid) ? pid : null;
}

/**
 * SIGTERM the daemon serving `home` and wait for it to exit. The daemon kills
 * its shells and waits for them before exiting, so on return nothing it ran
 * is still writing into `home`. No-op when no daemon runs.
 */
export async function stopTerminalDaemon(home: string): Promise<void> {
  const pid = terminalDaemonPid(home);
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the last check and the kill.
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guards against a stale pid record whose pid now belongs to an unrelated
 * process: only signal something that is actually a terminal daemon.
 */
function isTerminalDaemon(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return command.includes("terminal-daemon");
  } catch {
    return false;
  }
}
