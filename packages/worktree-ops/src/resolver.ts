import type { Host } from "@band-app/host-api";

/** What the worktree services need to know about one worktree. */
export interface OpsWorktree {
  repo: { defaultBranch: string; kind?: string };
  worktree: { path: string };
  /** The machine the worktree lives on. */
  host: Host;
}

/**
 * Where the services look a worktree up. The hub resolves from its database
 * and its host registry. A worker's direct listener resolves from the scope
 * of the token the hub registered, with a host that applies its path policy.
 */
export interface WorktreeResolver {
  resolve(worktreeId: string): OpsWorktree | null | undefined;
  /** Wakes a sleeping worktree before a file call. Absent where nothing sleeps. */
  ensureAwake?(worktreeId: string): Promise<void>;
}

/**
 * Thrown when a worktree can't be resolved. The hub's `errors.ts` re-exports
 * this class, so `instanceof` matches across the hub and this package.
 */
export class WorktreeNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Worktree not found: ${identifier}`);
    this.name = "WorktreeNotFoundError";
  }
}
