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
 * doesn't keep the process alive, and is recreated if it dies. If a worker
 * can't be created at all, calls fall back to `execFile` on this thread.
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
// in the server bundle.
const WORKER_SOURCE = `
const { execFile } = require("node:child_process");
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, command, args, options }) => {
  execFile(command, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
    parentPort.postMessage({ id, stdout: stdout ?? "", stderr: stderr ?? "", error: err ? err.message : null });
  });
});
`;

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, (result: ExecFileResult) => void>();

function failPending(message: string): void {
  for (const resolve of pending.values()) resolve({ stdout: "", stderr: "", error: message });
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker || workerUnavailable) return worker;
  try {
    const created = new Worker(WORKER_SOURCE, { eval: true });
    created.unref();
    created.on("message", (response: Response) => {
      const resolve = pending.get(response.id);
      pending.delete(response.id);
      resolve?.(response);
    });
    created.on("error", (err) => {
      log.warn("exec-file worker failed: %s", err);
    });
    created.on("exit", (code) => {
      if (worker === created) worker = null;
      failPending(`exec-file worker exited (code ${code})`);
    });
    worker = created;
  } catch (err) {
    workerUnavailable = true;
    log.warn("exec-file worker unavailable, spawning on the main thread: %s", err);
  }
  return worker;
}

/** `execFile(command, args, options)`, with the process started from the worker thread. */
export function execFileOffThread(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  const target = getWorker();
  if (!target) {
    return new Promise((resolve) => {
      execFile(command, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ stdout, stderr, error: err ? err.message : null });
      });
    });
  }
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    // A process.env copy is plain strings, so it survives structured clone.
    const request: Request = {
      id,
      command,
      args,
      options: { ...options, env: { ...options.env } },
    };
    target.postMessage(request);
  });
}
