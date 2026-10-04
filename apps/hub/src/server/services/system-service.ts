import type { WorktreeInfo } from "@band-app/host-api";
import { brewInstall } from "@band-app/host-local/process/install";
import { shellPath, whichBinary } from "@band-app/host-local/process/path";
import { hostRegistry } from "../infra/host/registry";

export type { WorktreeInfo };

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
 * previously lived inline here moved into `packages/host-local/src/process/`.
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
   *
   * Homebrew is macOS-only here: a stock Linux or Windows host has no
   * `brew`, so shelling out to it would fail with an opaque ENOENT. Guard
   * on `darwin` and surface a platform-appropriate hint everywhere else —
   * the message bubbles up to the dashboard's install flow as a normal
   * error instead of a crash.
   */
  async installCloudflared(resolvedPath: string): Promise<void> {
    if (process.platform !== "darwin") {
      const hint =
        process.platform === "win32"
          ? "On Windows, install it with `winget install --id Cloudflare.cloudflared` " +
            "(or `choco install cloudflared`)"
          : "On Linux, install it with your package manager " +
            "(e.g. `sudo apt install cloudflared` or `sudo dnf install cloudflared`)";
      throw new Error(
        "Automatic cloudflared install is only supported on macOS (via Homebrew). " +
          `${hint} ` +
          "or download it from " +
          "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ " +
          "and re-open the tunnel.",
      );
    }
    await brewInstall("cloudflared", resolvedPath);
  }

  /**
   * Enumerate git worktrees for a project: the local checkout's, then those on
   * each remote host that has a checkout of it. Each entry says which host it
   * is on (`hostId` is absent for local ones). A host that cannot answer, for
   * example an offline worker, adds nothing.
   */
  async listWorktrees(
    project: string,
    repoPath: string,
  ): Promise<Array<WorktreeInfo & { hostId?: string }>> {
    const local = await hostRegistry.hostForProject(project).worktree.list(repoPath);
    const remote = await Promise.all(
      hostRegistry
        .all()
        .filter((host) => host.id !== hostRegistry.local.id)
        .map(async (host) => {
          const path = hostRegistry.projectPathOn(project, host.id, repoPath);
          if (!path) return [];
          try {
            const list = await host.worktree.list(path);
            return list.map((wt) => ({ ...wt, hostId: host.id }));
          } catch {
            return [];
          }
        }),
    );
    return [...local, ...remote.flat()];
  }

  /**
   * Run `du -sk PATH` and return the allocated byte total, gated by the
   * process-wide concurrency cap above. The shell-out runs on the host the
   * path is on (`host.fs.du`), the project's own host unless `hostId` names
   * another; this method is just the rate-limit wrapper.
   */
  async duBytes(project: string, path: string, hostId?: string): Promise<number> {
    const host = hostId ? hostRegistry.hostById(hostId) : hostRegistry.hostForProject(project);
    const release = await acquireDuSlot();
    try {
      return await host.fs.du(path);
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
