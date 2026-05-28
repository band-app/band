import { execFile } from "node:child_process";
import { shellPath, whichBinary } from "../infra/process/path";

/**
 * Process / system utilities used across the server: resolving the user's
 * `$PATH` from a login shell, locating CLI binaries, checking host-level
 * prerequisites (cloudflared etc.), and measuring on-disk size.
 *
 * Absorbed `lib/process-utils.ts` and `lib/disk-usage.ts` as part of Phase
 * 7.5 (issue #517). The PATH-cache helpers (`shellPath`, `whichBinary`)
 * now live in `server/infra/process/path.ts` so other infra adapters
 * (tunnel-client, lsp-manager, terminal-pool) can call them without
 * crossing back into the services tier; this service tier re-exposes them
 * as instance methods for router-facing code that already speaks to the
 * service singleton. The `du` semaphore stays here because it's a
 * business-logic concern (rate-limiting the resources dashboard).
 */

/** Maximum buffer size for `du` stdout. `du -sk` prints a single summary line; 10 MB is overkill but defensible. */
const MAX_DU_BUFFER = 10 * 1024 * 1024;

/** Hard wall-clock cap on a single `du` invocation. Prevents stalled NFS/CIFS mounts hanging the tRPC handler. */
const DU_TIMEOUT_MS = 30_000;

/**
 * Process-wide cap on simultaneous `du` invocations. The client caps its
 * own fan-out at 3 projects in flight, but multiple open tabs / rapid
 * Refresh clicks could otherwise spawn dozens of `du` processes
 * concurrently and exhaust the per-process FD limit. 8 keeps the cap
 * above the client's-3 plus a safety margin for parallel callers.
 */
const DU_GLOBAL_CONCURRENCY = 8;

// Simple FIFO semaphore around `duBytes`. Inline rather than a helper
// because this is the only consumer in the package.
let duInFlight = 0;
const duWaiting: Array<() => void> = [];

function acquireDuSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      duInFlight++;
      resolve(() => {
        duInFlight--;
        const next = duWaiting.shift();
        if (next) next();
      });
    };
    if (duInFlight < DU_GLOBAL_CONCURRENCY) grant();
    else duWaiting.push(grant);
  });
}

export class SystemService {
  /**
   * Resolve the user's interactive `$PATH`. Thin pass-through to the infra
   * helper so callers that already hold the service singleton don't need a
   * second import; the cache lives in the infra module.
   */
  async shellPath(): Promise<string> {
    return shellPath();
  }

  /** Resolve a binary against the user's interactive `$PATH`, or `null` when absent. */
  async whichBinary(name: string): Promise<string | null> {
    return whichBinary(name);
  }

  /** Check host-level prerequisites (currently just cloudflared for the tunnel). */
  async checkPrereqs(): Promise<{ cloudflared: boolean }> {
    const cloudflared = await whichBinary("cloudflared");
    return { cloudflared: cloudflared !== null };
  }

  /**
   * Run `du -sk PATH` and return the allocated byte total.
   *
   * Detail: returned bytes are *allocated* (du default), not apparent file
   * sizes. They differ by < 5% for typical content. POSIX-compatible —
   * works the same on macOS BSD `du` and GNU coreutils `du`. The `-k`
   * flag forces 1024-byte block output; `-s` collapses to a single
   * summary line.
   *
   * `du` is invoked directly via `execFile` (no shell): if any
   * descendant directory is unreadable (EACCES on a `chmod 000` /
   * vendored Docker volume / mount-point owned by another user), `du`
   * exits with a non-zero code AND still writes the partial summary to
   * stdout. The default `promisify(execFile)` would reject and drop
   * that partial line, so we use the callback form and parse stdout
   * regardless of exit status.
   */
  async duBytes(path: string): Promise<number> {
    const release = await acquireDuSlot();
    try {
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
    } finally {
      release();
    }
  }
}

/**
 * Process-wide singleton consumed by infra clients (tunnel-client,
 * terminal-pool), the prereqs router, and the legacy services router.
 * Sharing one instance keeps the PATH cache and the `du` semaphore in
 * lock-step across every entry point.
 */
export const systemService = new SystemService();
