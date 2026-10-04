/**
 * `execFile` run from a worker thread, so starting the process never blocks
 * the server's event loop.
 *
 * Node creates a child process synchronously on the thread that asks for it
 * (libuv's `uv_spawn` calls `posix_spawn` inline), and only the child's run
 * is asynchronous. On macOS each spawn from the server holds its thread for
 * ~2-7 ms, more as the heap grows, so a burst of git calls froze the
 * terminal WebSocket's keystroke echo (200 spawns: a 579 ms stall on the main
 * thread, 1 ms when a worker spawns them). A worker thread has its own event
 * loop, so the spawn blocks only the worker.
 *
 * One long-lived worker serves every call. It is created on first use,
 * keeps the process alive only while a call is pending, and is recreated if
 * it dies. If workers can't start, calls fall back to `execFile` on this
 * thread.
 */

import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createLogger } from "@band-app/logger";

const log = createLogger("exec-file-worker");

export interface ExecFileOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  /** Set when the command failed to start or exited non-zero (`execFile`'s error message). */
  error: string | null;
}

interface Request {
  id: number;
  command: string;
  args: string[];
  options: ExecFileOptions;
}

interface Response extends ExecFileResult {
  id: number;
}

// CommonJS, evaluated as the worker's entry, so it needs no file of its own
// in the server bundle. A synchronous throw (a NUL byte in an argument) fails
// only its own request instead of killing the worker.
const WORKER_SOURCE = `
const { execFile } = require("node:child_process");
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, command, args, options }) => {
  try {
    execFile(command, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      parentPort.postMessage({ id, stdout: stdout ?? "", stderr: stderr ?? "", error: err ? err.message : null });
    });
  } catch (err) {
    parentPort.postMessage({ id, stdout: "", stderr: "", error: err.message });
  }
});
`;

/** Workers that may exit before running any code before this module stops creating them. */
const MAX_START_FAILURES = 2;

interface Pending {
  request: Request;
  resolve: (result: ExecFileResult) => void;
}

let worker: Worker | null = null;
let workerUnavailable = false;
let startFailures = 0;
let nextId = 1;
const pending = new Map<number, Pending>();

function execOnThisThread({ command, args, options }: Request): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ stdout, stderr, error: err ? err.message : null });
      });
    } catch (err) {
      resolve({ stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function getWorker(): Worker | null {
  if (worker || workerUnavailable) return worker;
  let created: Worker;
  try {
    created = new Worker(WORKER_SOURCE, { eval: true });
  } catch (err) {
    workerUnavailable = true;
    log.warn("exec-file worker unavailable, spawning on the main thread: %s", err);
    return null;
  }
  // Referenced only while a request is pending, so an idle worker never
  // keeps the process alive and a pending one always settles.
  created.unref();
  let started = false;
  created.on("online", () => {
    started = true;
  });
  created.on("message", (response: Response) => {
    const entry = pending.get(response.id);
    pending.delete(response.id);
    if (pending.size === 0) created.unref();
    entry?.resolve(response);
  });
  created.on("error", (err) => {
    log.warn("exec-file worker failed: %s", err);
  });
  created.on("exit", (code) => {
    if (worker === created) worker = null;
    const orphaned = [...pending.values()];
    pending.clear();
    if (!started) {
      // The worker never ran, so none of its requests did: run them here.
      startFailures += 1;
      if (startFailures >= MAX_START_FAILURES) {
        workerUnavailable = true;
        log.warn("exec-file worker won't start, spawning on the main thread");
      }
      for (const { request, resolve } of orphaned) void execOnThisThread(request).then(resolve);
      return;
    }
    // It may have started any of them, so none is retried.
    for (const { resolve } of orphaned) {
      resolve({ stdout: "", stderr: "", error: `exec-file worker exited (code ${code})` });
    }
  });
  worker = created;
  return created;
}

/** `execFile(command, args, options)`, with the process started from the worker thread. */
export function execFileOffThread(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  // A process.env copy is plain strings, so it survives structured clone.
  const request: Request = {
    id: nextId++,
    command,
    args,
    options: { ...options, env: { ...options.env } },
  };
  const target = getWorker();
  if (!target) return execOnThisThread(request);
  return new Promise((resolve) => {
    pending.set(request.id, { request, resolve });
    if (pending.size === 1) target.ref();
    target.postMessage(request);
  });
}
