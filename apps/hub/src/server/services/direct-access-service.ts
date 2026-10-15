/**
 * Issues tokens for the local direct path. The desktop app on a worker's own
 * machine asks for one per worktree and then calls the worker on `127.0.0.1`
 * for terminals, files, diff and search. The hub decides who may: the caller already passed the device-token check, and
 * the token it gets is good for one worktree for a few minutes.
 */

import { createLogger } from "@band-app/logger";
import type { DirectAccess } from "@band-app/shared/direct-access";
import { WorktreeNotFoundError } from "../errors";
import { LOCAL_HOST_ID } from "./local-host-policy";
import {
  worktreeService as defaultWorktreeService,
  type WorktreeService,
} from "./worktree-service";

const log = createLogger("direct-access");

/** How long a token lasts. The client renews it before then. */
const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

/** `BAND_DIRECT_TOKEN_TTL_MS` replaces the lifetime, read on every token. */
function tokenTtlMs(): number {
  const ms = Number(process.env.BAND_DIRECT_TOKEN_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TOKEN_TTL_MS;
}

export class DirectAccessService {
  constructor(private readonly worktrees: WorktreeService = defaultWorktreeService) {}

  /**
   * A token for `worktreeId` on the caller's own worker `hostId`, or null when
   * the direct path does not apply: the worktree is on another host or the
   * hub's own machine, the worker is offline, or it has no listener (a worker
   * from before the direct path). The caller then uses the hub.
   */
  async issue(worktreeId: string, hostId: string): Promise<DirectAccess | null> {
    const resolved = this.worktrees.resolve(worktreeId);
    if (!resolved) throw new WorktreeNotFoundError(worktreeId);
    const worktreeHost = resolved.worktree.hostId ?? LOCAL_HOST_ID;
    if (worktreeHost !== hostId || worktreeHost === LOCAL_HOST_ID) return null;
    const direct = resolved.host.direct;
    if (!direct) return null;
    try {
      const grant = await direct.issue(
        {
          worktreeId,
          path: resolved.worktree.path,
          defaultBranch: resolved.repo.defaultBranch,
          repoKind: resolved.repo.kind,
        },
        tokenTtlMs(),
      );
      return { hostId, ...grant };
    } catch (err) {
      log.debug(
        { hostId, worktreeId, message: err instanceof Error ? err.message : String(err) },
        "no direct path to the worker",
      );
      return null;
    }
  }
}

export const directAccessService = new DirectAccessService();
