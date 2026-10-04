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
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Maximum buffer size for `du` stdout. `du -sk` prints a single summary line; 10 MB is overkill but defensible. */
const MAX_DU_BUFFER = 10 * 1024 * 1024;

/** Hard wall-clock cap on a single `du` invocation. Prevents stalled NFS/CIFS mounts hanging the tRPC handler. */
const DU_TIMEOUT_MS = 30_000;

/**
 * Windows has no `du`. Walk the tree with Node and sum apparent file
 * sizes — the same "close enough" contract as `du` (BSD/GNU `du` reports
 * *allocated* size, which differs from apparent by < 5% for typical
 * content; see the `duBytes` docstring).
 *
 * Mirrors `du`'s tolerance for unreadable descendants: a directory that
 * can't be read (permission denied, a symlink loop, a vanished entry) is
 * skipped rather than aborting the whole measurement, so the caller sees a
 * possibly-truncated total instead of a hard failure. `readdir` with
 * `withFileTypes` reports symlinks as their own kind, so they are never
 * followed — avoiding both double-counting a file reachable two ways and
 * infinite loops on a symlink cycle.
 *
 * Bounded like the POSIX path: a `DU_TIMEOUT_MS` deadline caps the
 * wall-clock so a pathological tree or a stalled network mount can't pin
 * the caller's `du` semaphore slot indefinitely — the partial total is
 * returned, mirroring `du`'s partial-output-on-timeout behaviour. Per-file
 * `stat`s run concurrently but in bounded chunks (`STAT_CHUNK`) so a single
 * huge directory (a big `node_modules`) can't queue tens of thousands of
 * pending stats against the small libuv threadpool at once; the deadline is
 * re-checked between chunks.
 */
const STAT_CHUNK = 256;

async function duBytesNodeWalk(path: string): Promise<number> {
  const deadline = Date.now() + DU_TIMEOUT_MS;
  let total = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    if (Date.now() > deadline) break; // return the partial total, like `du` on timeout
    const dir = stack.pop() as string;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const filePaths: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          stack.push(join(dir, entry.name));
        } else if (entry.isFile()) {
          filePaths.push(join(dir, entry.name));
        }
        // Symlinks (and other special entries) are not followed or counted.
      }
      for (let i = 0; i < filePaths.length; i += STAT_CHUNK) {
        if (Date.now() > deadline) break;
        const sizes = await Promise.all(
          filePaths.slice(i, i + STAT_CHUNK).map((p) =>
            stat(p).then(
              (s) => s.size,
              () => 0, // vanished between readdir and stat — count as 0
            ),
          ),
        );
        for (const size of sizes) total += size;
      }
    } catch {
      // Unreadable directory — skip, like `du` does on EACCES.
    }
  }
  return total;
}

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
  // Windows has no `du` — fall back to a Node walk. POSIX keeps the fast
  // single-fork `du` path below.
  if (process.platform === "win32") {
    return duBytesNodeWalk(path);
  }
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
