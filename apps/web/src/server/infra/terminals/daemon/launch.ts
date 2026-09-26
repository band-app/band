import { fork } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { retireDaemon } from "./client";
import { type EndpointIdentity, ensurePrivateDir } from "./endpoint";
import {
  type DaemonPaths,
  daemonPaths,
  EXIT_ENDPOINT_OCCUPIED,
  PROTOCOL_VERSION,
} from "./protocol";

const READY_TIMEOUT_MS = 10_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_TAIL_BYTES = 4096;

export interface LaunchOptions {
  /** `dist/terminal-daemon.mjs`, or `terminal-daemon.ts` under tsx in dev. */
  entry: string;
  paths: DaemonPaths;
  /** The daemon's working directory: `~/.band`, never a worktree, since worktrees get deleted. */
  cwd: string;
  buildId: string;
  /** Take the endpoint from the live daemon of another build at this entry. */
  supersede?: EndpointIdentity;
}

/**
 * Start a detached daemon and wait until it serves the endpoint. Resolves
 * `occupied` when another daemon won the race to publish; connect to that one.
 *
 * The child runs as plain Node via the server's own runtime
 * (`process.execPath`), so node-pty's native ABI matches: under the desktop
 * app that is Electron with `ELECTRON_RUN_AS_NODE=1`, which also keeps
 * Electron's display init away from node-pty's `posix_spawn`. Its stdout and
 * stderr are an append-mode log file, not pipes: a live pipe would keep this
 * process's event loop alive, and the file still captures a startup crash.
 */
export async function launchDaemon(options: LaunchOptions): Promise<"launched" | "occupied"> {
  const { entry, paths, cwd, buildId, supersede } = options;
  ensurePrivateDir(paths.runDir);
  rotateLog(paths.log);
  const logFd = openSync(paths.log, "a", 0o600);
  let logSize = 0;
  try {
    logSize = statSync(paths.log).size;
  } catch {
    // Only used to find this launch's output in the log.
  }

  const child = (() => {
    try {
      const args = ["--run-dir", paths.runDir, "--build-id", buildId];
      if (supersede) args.push("--supersede", `${supersede.dev}:${supersede.ino}`);
      return fork(entry, args, {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd, "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    } finally {
      closeSync(logFd);
    }
  })();
  // The daemon drops the IPC channel as soon as it is ready, which can race
  // our own `disconnect()` below. A ChildProcess `error` with no listener
  // would crash this server, and nothing about it is actionable.
  child.on("error", () => {});

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "launched" | "occupied" | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (child.connected) child.disconnect();
      child.unref();
      if (outcome instanceof Error) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        const tail = readLogTail(paths.log, logSize);
        reject(tail ? new Error(`${outcome.message}\nDaemon log:\n${tail}`) : outcome);
      } else {
        resolve(outcome);
      }
    };
    const onMessage = (message: unknown) => {
      if ((message as { type?: unknown })?.type === "ready") finish("launched");
    };
    const onExit = (code: number | null) => {
      finish(
        code === EXIT_ENDPOINT_OCCUPIED
          ? "occupied"
          : new Error(`Terminal daemon exited during startup with code ${code}`),
      );
    };
    const onError = (err: Error) => finish(err);
    const timer = setTimeout(
      () => finish(new Error("Terminal daemon did not become ready in time")),
      READY_TIMEOUT_MS,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/**
 * Ask daemons of older protocol versions on this home to exit before
 * launching ours. Their sessions are lost on that upgrade; keeping them
 * attachable is a follow-up. Uses the hello / mismatch / shutdown exchange,
 * the one part of the protocol that never changes.
 */
export async function retireOlderDaemons(runDir: string, buildId: string): Promise<void> {
  for (let version = 1; version < PROTOCOL_VERSION; version++) {
    try {
      await retireDaemon(daemonPaths(runDir, version), buildId);
    } catch {
      // Nothing running there, or nothing we may touch.
    }
  }
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
}

function readLogTail(path: string, from: number): string {
  try {
    const content = readFileSync(path, "utf8").slice(from);
    return content.slice(-LOG_TAIL_BYTES).trim();
  } catch {
    return "";
  }
}
