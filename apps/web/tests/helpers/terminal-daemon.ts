// Teardown for the terminal daemon a test server may have launched.
//
// The daemon is detached on purpose (its shells outlive the web server), so
// the helpers' process-group kill never reaches it. Left alone, it and its
// shells keep writing into the tmp home (`.zsh_history`, the daemon log)
// while `afterAll` deletes it, which surfaces as ENOTEMPTY. It would stand
// down on its own a couple of seconds after the home disappears, but tests
// need it gone before the delete, not after.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STOP_TIMEOUT_MS = 5_000;

/**
 * Pids of the daemons serving `home`, from their pid records. Every protocol
 * version writes its own `terminal-daemon-v<N>.pid`, so match them all rather
 * than hardcode one.
 */
export function terminalDaemonPids(home: string): number[] {
  const runDir = join(home, ".band", "run");
  let names: string[];
  try {
    names = readdirSync(runDir).filter((name) => /^terminal-daemon-v\d+\.pid$/.test(name));
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    try {
      const { pid } = JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number };
      if (isTerminalDaemon(pid)) pids.push(pid);
    } catch {
      // Half-written or unreadable record: nothing to stop.
    }
  }
  return pids;
}

/**
 * SIGTERM every daemon serving `home` and wait for each to exit. A daemon
 * kills its shells and waits for them before exiting, so on return nothing
 * it ran is still writing into `home`. No-op when none runs.
 */
export async function stopTerminalDaemon(home: string): Promise<void> {
  await Promise.all(terminalDaemonPids(home).map(stopPid));
}

async function stopPid(pid: number): Promise<void> {
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
