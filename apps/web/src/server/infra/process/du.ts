/**
 * Raw `du -sk PATH` adapter — returns the allocated byte total reported
 * by BSD/GNU `du`. Lives in the infra tier so the `execFile` shell-out
 * stays behind a single seam; the services-tier `SystemService.duBytes`
 * wraps this with a process-wide concurrency cap (semaphore + business
 * decision on how many parallel `du` instances are acceptable from the
 * resources dashboard).
 *
 * Moved out of `services/system-service.ts` as part of issue #535,
 * follow-up 3 — `execFile`-shaped shell-outs belong in infra.
 */

import { execFile } from "node:child_process";

/** Maximum buffer size for `du` stdout. `du -sk` prints a single summary line; 10 MB is overkill but defensible. */
const MAX_DU_BUFFER = 10 * 1024 * 1024;

/** Hard wall-clock cap on a single `du` invocation. Prevents stalled NFS/CIFS mounts hanging the tRPC handler. */
const DU_TIMEOUT_MS = 30_000;

/**
 * Run `du -sk PATH` and return the allocated byte total.
 *
 * Detail: returned bytes are *allocated* (du default), not apparent file
 * sizes. They differ by < 5% for typical content. POSIX-compatible —
 * works the same on macOS BSD `du` and GNU coreutils `du`. The `-k` flag
 * forces 1024-byte block output; `-s` collapses to a single summary
 * line.
 *
 * `du` is invoked directly via `execFile` (no shell): if any descendant
 * directory is unreadable (EACCES on a `chmod 000` / vendored Docker
 * volume / mount-point owned by another user), `du` exits with a non-
 * zero code AND still writes the partial summary to stdout. The default
 * `promisify(execFile)` would reject and drop that partial line, so we
 * use the callback form and parse stdout regardless of exit status.
 */
export async function duBytes(path: string): Promise<number> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "du",
      ["-sk", path],
      { maxBuffer: MAX_DU_BUFFER, timeout: DU_TIMEOUT_MS },
      (err, out) => {
        // Permission-on-descendant: exit code 1, stderr has the
        // "permission denied" lines, stdout has the partial total.
        // Use whatever stdout we got and let the caller see a
        // (truncated) number rather than fail the whole worktree.
        if (err && !out) {
          reject(err);
          return;
        }
        resolve(out);
      },
    );
  });
  // Output: `<kb>\t<path>\n`. Split on whitespace and take the first
  // token rather than relying on the exact tab so BSD/GNU formatting
  // drift doesn't bite.
  const kbStr = stdout.trim().split(/\s+/)[0];
  const kb = Number.parseInt(kbStr, 10);
  if (!Number.isFinite(kb)) {
    throw new Error(`du output not numeric: ${JSON.stringify(stdout)}`);
  }
  return kb * 1024;
}
