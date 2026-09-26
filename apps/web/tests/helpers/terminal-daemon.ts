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
import { DaemonClient } from "@/server/infra/terminals/daemon/client";
import { launchDaemon } from "@/server/infra/terminals/daemon/launch";
import { daemonPaths } from "@/server/infra/terminals/daemon/protocol";

const STOP_TIMEOUT_MS = 5_000;

export interface TerminalDaemonRecord {
  pid: number;
  /** The socket the daemon published; may live outside the run dir. */
  socket: string;
  buildId: string;
}

/**
 * The live daemons serving `home`, from their pid records. Every protocol
 * version writes its own `terminal-daemon-v<N>.pid`, so match them all rather
 * than hardcode one. A daemon superseded by another build has its record
 * copied to `terminal-daemon-v<N>.retired-<tag>.pid`; those count too.
 */
export function terminalDaemons(home: string): TerminalDaemonRecord[] {
  const runDir = join(home, ".band", "run");
  let names: string[];
  try {
    names = readdirSync(runDir).filter((name) =>
      /^terminal-daemon-v\d+(\.retired-[0-9a-f]+)?\.pid$/.test(name),
    );
  } catch {
    return [];
  }
  const records: TerminalDaemonRecord[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(runDir, name), "utf8")) as TerminalDaemonRecord;
      if (isTerminalDaemon(record.pid)) records.push(record);
    } catch {
      // Half-written or unreadable record: nothing to stop.
    }
  }
  return records;
}

/**
 * Start a terminal daemon on `home` the way a server of build `buildId` would,
 * from `entry`, as if an older (or deleted) build had left it running. Speaks
 * the daemon's socket protocol directly, since the point is that no server of
 * this build would put a shell on it.
 */
export async function startDaemonOfBuild(
  home: string,
  { entry, buildId }: { entry: string; buildId: string },
): Promise<{ pid: number; spawnShell: (shell: ShellSpec) => Promise<number> }> {
  const bandHome = join(home, ".band");
  const paths = daemonPaths(join(bandHome, "run"));
  await launchDaemon({ entry, paths, cwd: bandHome, buildId });
  const probe = await DaemonClient.connect(paths, buildId);
  const pid = probe.pid;
  probe.close();
  return {
    pid,
    // Connects per call: the daemon may no longer own the endpoint by then,
    // and a shell must land on this daemon or fail.
    async spawnShell(shell) {
      const client = await DaemonClient.connect(paths, buildId);
      try {
        if (client.pid !== pid) throw new Error("another daemon serves the endpoint");
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value;
        }
        const entry = await client.request("spawn", { ...shell, baseEnv: env });
        return entry.pid;
      } finally {
        client.close();
      }
    },
  };
}

export interface ShellSpec {
  workspaceId: string;
  terminalId: string;
  workspaceRoot: string;
}

/** The parent pid of `pid`: for a shell, the daemon hosting it. */
export function parentPid(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

/** The daemon's log, where it records why it drains or exits. */
export function terminalDaemonLog(home: string): string {
  try {
    return readFileSync(join(home, ".band", "run", "terminal-daemon.log"), "utf8");
  } catch {
    return "";
  }
}

/**
 * SIGTERM every daemon serving `home` and wait for each to exit. A daemon
 * kills its shells and waits for them before exiting, so on return nothing
 * it ran is still writing into `home`. No-op when none runs.
 */
export async function stopTerminalDaemon(home: string): Promise<void> {
  await Promise.all(terminalDaemons(home).map((daemon) => stopPid(daemon.pid)));
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
    // `-o command=` suppresses the header on macOS and procps-ng; trim guards
    // against a variant that pads an empty result.
    const trimmed = command.trim();
    return trimmed.length > 0 && trimmed.includes("terminal-daemon");
  } catch {
    return false;
  }
}
