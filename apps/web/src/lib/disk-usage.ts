import { execFile } from "node:child_process";

/**
 * Maximum buffer size for `du` stdout. `du -sk` prints a single
 * summary line (kilobytes + path), so 10 MB is overkill — but
 * defensible against pathological paths.
 */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Hard wall-clock cap on a single `du` invocation. The procedure
 * fanout already runs worktrees in parallel, so on a healthy disk
 * each `du` finishes in single-digit seconds; if any one call
 * exceeds this it almost certainly means a stalled NFS / CIFS
 * mount, and we'd rather surface "error" in one row than hang the
 * tRPC handler forever. `execFile`'s `timeout` option sends
 * `SIGTERM` to the child after this elapses, which surfaces as a
 * rejected promise.
 */
const DU_TIMEOUT_MS = 30_000;

/**
 * Process-wide cap on simultaneous `du` invocations. The client
 * caps its own fan-out at 3 projects in flight, but multiple open
 * tabs or rapid Refresh clicks could otherwise spawn dozens of
 * `du` processes concurrently and exhaust the per-process FD
 * limit. 8 keeps the cap above the client's-3 plus a safety
 * margin for parallel callers, while bounding worst-case process
 * count when usage spikes.
 */
const DU_GLOBAL_CONCURRENCY = 8;

// Simple FIFO semaphore around `duBytes`. Inline rather than a
// helper because this is the only consumer in the package.
let inFlight = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      inFlight++;
      resolve(() => {
        inFlight--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (inFlight < DU_GLOBAL_CONCURRENCY) grant();
    else waiting.push(grant);
  });
}

/**
 * Run `du -sk PATH` and return the allocated byte total. We tried a
 * Node-side recursive `opendir` + `stat` walker first and a
 * "parallelised" variant on top of that, but both were unusably
 * slow on real worktree trees (~2 minutes for 33 GB). `du` is the
 * optimised native answer the OS already ships — single-digit
 * seconds on the same input, and even better when run as multiple
 * concurrent processes because each is its own scheduler slot.
 *
 * Returned bytes are *allocated* (du default), not apparent file
 * sizes. They differ by < 5% for typical content. POSIX-compatible
 * — works the same on macOS BSD `du` and GNU coreutils `du`. The
 * `-k` flag forces 1024-byte block output; `-s` collapses to a
 * single summary line.
 *
 * `du` is invoked directly via `execFile` (no shell): if any
 * descendant directory is unreadable (EACCES on a `chmod 000` /
 * vendored Docker volume / mount-point owned by another user), `du`
 * exits with a non-zero code AND still writes the partial summary
 * to stdout. The default `promisify(execFile)` would reject and
 * drop that partial line, so we use the callback form and parse
 * stdout regardless of exit status. The total then represents
 * everything we *could* see — strictly better than returning 0
 * because one subtree was off-limits.
 */
export async function duBytes(path: string): Promise<number> {
  const release = await acquireSlot();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "du",
        ["-sk", path],
        { maxBuffer: MAX_BUFFER, timeout: DU_TIMEOUT_MS },
        (err, out) => {
          // Permission-on-descendant: exit code 1, stderr has the
          // "permission denied" lines, stdout has the partial
          // total. Use whatever stdout we got and let the caller
          // see a (truncated) number rather than fail the whole
          // worktree.
          if (err && !out) {
            reject(err);
            return;
          }
          resolve(out);
        },
      );
    });
    // Output: `<kb>\t<path>\n`. Split on whitespace and take the
    // first token rather than relying on the exact tab so BSD/GNU
    // formatting drift doesn't bite.
    const kbStr = stdout.trim().split(/\s+/)[0];
    const kb = Number.parseInt(kbStr, 10);
    if (!Number.isFinite(kb)) {
      throw new Error(`du output not numeric: ${JSON.stringify(stdout)}`);
    }
    return kb * 1024;
  } finally {
    release();
  }
}
