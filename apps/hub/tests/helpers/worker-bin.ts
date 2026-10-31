import { join } from "node:path";

/**
 * The one definition of the `band-worker` entry point for tests. A test that
 * spawns it passes `...process.env`, which carries the process guard
 * (`scripts/test-process-guard.mjs`, set up in `tests/setup-process-guard.ts`),
 * or adds `processGuardEnv()` when it builds a clean environment.
 * `scripts/check-test-worker-spawn.sh` fails on any other mention of the path.
 */
export const WORKER_BIN = join(import.meta.dirname, "../../../worker/bin/band-worker.mjs");

/** The guard variables for a spawn whose environment is built from scratch. */
export function processGuardEnv(): Record<string, string> {
  const pick = (name: string) => (process.env[name] ? { [name]: process.env[name] as string } : {});
  return {
    ...pick("NODE_OPTIONS"),
    ...pick("TEST_PROCESS_GUARD_OWNER_PID"),
  };
}
