/**
 * Starts ACP agent processes for `LocalHost.acp.spawn` and stops them again.
 *
 * Agents run detached, in their own process group, so `kill()` also stops
 * what the agent started (Codex runs a separate app-server).
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AcpLaunch, AgentStdio } from "@band-app/host-api";

/**
 * Every agent process started and not yet exited, including one still
 * starting up. Agents run in their own process group, so nothing else stops
 * them when the server exits.
 */
const liveChildren = new Set<ChildProcess>();

/** How long `stopAllAgentProcesses` waits after SIGTERM before SIGKILL. */
const STOP_TIMEOUT_MS = 3_000;

export async function spawnAgentProcess(launch: AcpLaunch, cwd: string): Promise<AgentStdio> {
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  child.once("error", () => {
    if (child.pid === undefined) liveChildren.delete(child);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (err) {
    liveChildren.delete(child);
    throw err;
  }
  const { stdin, stdout, stderr } = child;
  // An agent that exits early closes its stdin; the exit event reports it.
  stdin?.on("error", () => undefined);
  return {
    pid: child.pid,
    stdin: {
      write: (chunk) => void stdin?.write(chunk),
      end: () => stdin?.end(),
    },
    stdout: stdout as AsyncIterable<Uint8Array>,
    stderr: stderr as AsyncIterable<Uint8Array>,
    exit: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    kill: (signal = "SIGTERM") => killTree(child, signal),
  };
}

/**
 * Stops every agent process of this server that is still running, with its
 * whole process group, and resolves once they have exited. For server
 * shutdown: a detached agent would otherwise outlive the server, and a Codex
 * agent's app-server with it. An agent that already exited is no longer
 * tracked, so anything it left behind in its group is not reached.
 */
export async function stopAllAgentProcesses(): Promise<void> {
  // An agent a turn was still launching when shutdown began joins the set
  // after the first pass, so go on until nothing is tracked.
  while (liveChildren.size > 0) {
    await Promise.all([...liveChildren].map(stopAgentProcess));
  }
}

async function stopAgentProcess(child: ChildProcess): Promise<void> {
  // Spawned an instant ago: wait for its pid, or for the spawn to fail.
  if (child.pid === undefined) {
    await new Promise<void>((resolve) => {
      child.once("spawn", () => resolve());
      child.once("error", () => resolve());
    });
  }
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  // The whole group, not only the agent: a process it started can outlive
  // it or ignore SIGTERM.
  const running = () => {
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  killTree(child, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (running() && Date.now() < deadline) await delay(20);
  if (running()) signalGroup(child, pid, "SIGKILL");
  // Bounded, so shutdown can't hang on a process that never exits. The group
  // must be gone too, not only the agent: a member still alive can write to
  // the files the caller is about to remove.
  const killedAt = Date.now();
  await Promise.race([exited, delay(1_000)]);
  while (running() && Date.now() - killedAt < 1_000) await delay(20);
  liveChildren.delete(child);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
