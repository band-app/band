import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

const WORKER_BIN = join(import.meta.dirname, "../../../worker/bin/band-worker.mjs");

export interface WorkerHandle {
  child: ChildProcess;
  /** Everything the worker wrote to stdout and stderr so far. */
  output(): string;
  /** Kills the process without a goodbye, as a crash or a closed laptop does. */
  kill(): Promise<void>;
}

/**
 * Starts the real `band-worker` binary against a hub. `env` is the worker's
 * environment (`BAND_HUB_URL`, `BAND_BOOTSTRAP_TOKEN`, `BAND_WORKER_ID` as the
 * Hosts screen prints them). `home` is a temp dir: the worker gets it as
 * `HOME` and `BAND_HOME`, so it never touches the real `~/.band`.
 */
export function startWorker(opts: {
  env: Record<string, string>;
  root: string;
  stateDir: string;
  home: string;
}): WorkerHandle {
  const child = spawn(process.execPath, [WORKER_BIN, "--root", opts.root], {
    env: {
      ...process.env,
      HOME: opts.home,
      BAND_HOME: join(opts.home, ".band"),
      BAND_WORKER_STATE_DIR: opts.stateDir,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => {
    output += d;
  });
  child.stderr?.on("data", (d) => {
    output += d;
  });
  return {
    child,
    output: () => output,
    kill: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

/** Reads `KEY=value` pairs off the command line the Hosts screen prints (`A=1 B=2 band-worker`). */
export function parseWorkerCommand(command: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of command.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return env;
}
