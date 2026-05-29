import { duBytes as duBytesRaw } from "../infra/process/du";
import { brewInstall } from "../infra/process/install";
import { shellPath, whichBinary } from "../infra/process/path";

/**
 * Process / system orchestration: resolving the user's `$PATH` from a
 * login shell, locating CLI binaries, checking host-level prerequisites
 * (cloudflared etc.), running brew installs, and rate-limiting on-disk
 * size measurements.
 *
 * Every shell-out / raw `execFile` lives in the infra tier (`infra/
 * process/{path,du,install}.ts`). This class is purely the business-
 * logic layer over those adapters:
 *
 *   - `checkPrereqs()` decides which binaries qualify as host
 *     prerequisites.
 *   - `installCloudflared()` resolves the shell PATH first, then
 *     delegates to `brewInstall`.
 *   - `duBytes()` rate-limits parallel `du` invocations across all
 *     dashboard callers — the semaphore is a business decision (how many
 *     parallel `du` instances we'll tolerate), not an infra concern.
 *
 * Reorganised in issue #535, follow-up 3 — the `execFile` callouts that
 * previously lived inline here moved into `server/infra/process/`.
 */

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
   * Install the cloudflared binary via Homebrew. Used by the dashboard's
   * "Install Tunnel" button. The caller supplies the user's interactive
   * `$PATH` (typically via `shellPath()`) so `brew` itself is locatable
   * even when the Node process inherited a stripped-down PATH from
   * launchd / Electron.
   */
  async installCloudflared(resolvedPath: string): Promise<void> {
    await brewInstall("cloudflared", resolvedPath);
  }

  /**
   * Run `du -sk PATH` and return the allocated byte total, gated by the
   * process-wide concurrency cap above. The shell-out itself lives in
   * `infra/process/du.ts`; this method is just the rate-limit wrapper.
   */
  async duBytes(path: string): Promise<number> {
    const release = await acquireDuSlot();
    try {
      return await duBytesRaw(path);
    } finally {
      release();
    }
  }
}

/**
 * Process-wide singleton consumed by the prereqs router, the system
 * router, and a handful of services (setup, cli-skills, hooks). Sharing
 * one instance keeps the `du` semaphore in lock-step across every entry
 * point.
 */
export const systemService = new SystemService();
