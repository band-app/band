import type { RepoInfo } from "@band-app/plugin-api";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { emit } from "../infra/events/status-event-bus";
import { loadState } from "./state";

/** Changes that arrive within this window go out as one `review-changed` event. */
const COALESCE_MS = 1000;

export interface ReviewChange {
  repo: RepoInfo;
  branch?: string;
  number?: number;
}

/**
 * A forge told the hub a review changed. Maps the change to the worktrees on that repo and
 * branch and sends one `review-changed` status event, so an open Checks panel refetches
 * without waiting for its polling timer.
 */
export class ReviewSignalService {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  changed({ repo, branch }: ReviewChange): void {
    const key = [repo.host, repo.owner, repo.repo].join("/").toLowerCase();
    for (const state of loadState().repos) {
      if (state.remoteKey !== key) continue;
      for (const worktree of state.worktrees) {
        if (branch && worktree.branch !== branch) continue;
        this.pending.add(toWorktreeId(state.name, worktree.name, worktree.hostId));
      }
    }
    if (this.pending.size === 0 || this.timer) return;
    this.timer = setTimeout(() => this.flush(), COALESCE_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    const worktreeIds = [...this.pending];
    this.pending.clear();
    if (worktreeIds.length > 0) emit({ kind: "review-changed", worktreeIds });
  }
}

export const reviewSignalService = new ReviewSignalService();
