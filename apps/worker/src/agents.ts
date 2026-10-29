import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHolder } from "@band-app/host-local/agents/daemon/holder";
import { agentRunDir } from "@band-app/host-local/agents/daemon/protocol";

/**
 * The worker's connection to its agent daemon (`agent-daemon.ts`), the detached process that
 * holds chat agents so they survive a worker restart. The daemon's files are under the worker's
 * state dir (`run/agents/`, mode 0700, the socket 0600).
 *
 * None (agents are the worker's children and die with it) when `persistent` is false, on
 * Windows, when `BAND_AGENT_DAEMON=0`, and when the daemon entry is missing.
 */
export function createWorkerAgentHolder(stateDir: string, persistent: boolean): AgentHolder | null {
  if (!persistent || process.platform === "win32" || process.env.BAND_AGENT_DAEMON === "0") {
    return null;
  }
  // Next to this file: `dist/` for the bundle, `src/` in a checkout, where tsx runs the `.ts`.
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [join(here, "agent-daemon.mjs"), join(here, "agent-daemon.ts")].find((candidate) =>
    existsSync(candidate),
  );
  if (!entry) return null;
  const { size, mtimeMs } = statSync(entry);
  return new AgentHolder({
    entry,
    runDir: agentRunDir(stateDir),
    cwd: stateDir,
    buildId: `${size}-${Math.trunc(mtimeMs)}`,
    // A `.ts` entry needs tsx's loader in the daemon too: the worker registers it in-process, so a fork does not inherit it.
    execArgv: entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
  });
}

/**
 * Ends every agent daemon of a worker state dir, and with it the agents. For `uninstall-service`.
 * Signals a pid only when its command line is an agent daemon, because a pid record can outlive
 * its process and the pid can then belong to something else.
 */
export function stopAgentDaemons(stateDir: string): number {
  const runDir = agentRunDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(runDir).filter((name) =>
      /^agent-daemon-v\d+(\.retired-[0-9a-f]+)?\.pid$/.test(name),
    );
  } catch {
    return 0;
  }
  let stopped = 0;
  for (const name of names) {
    try {
      const { pid } = JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number };
      if (!Number.isInteger(pid) || pid <= 1 || !isAgentDaemon(pid)) continue;
      process.kill(pid, "SIGTERM");
      stopped += 1;
    } catch {
      // No record, no process, or not ours to signal.
    }
  }
  return stopped;
}

function isAgentDaemon(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return command.includes("agent-daemon");
  } catch {
    return false;
  }
}
