import { tmpdir } from "node:os";
import { gitRunner } from "@band-app/host-api";
import { DETACHED_BRANCH_PREFIX, getRepoInfo } from "@band-app/host-local/git/git-client";
import { createLogger } from "@band-app/logger";
import type {
  MergeMethod,
  ProviderContext,
  RepoInfo,
  ReviewInfo,
  ReviewProvider,
  WorktreeReview,
} from "@band-app/plugin-api";
import { WorktreeNotFoundError } from "../errors";
import { hostRegistry } from "../infra/host/registry";
import { type PluginHost, pluginHost } from "./plugin-host-service";
import { type WorktreeService, worktreeService } from "./worktree-service";

const log = createLogger("review-service");

/** Thrown by `merge` when the worktree's branch has no open review to merge. */
export class NoOpenReviewError extends Error {
  constructor(worktreeId: string) {
    super(`No open review to merge for worktree ${worktreeId}`);
    this.name = "NoOpenReviewError";
  }
}

/** Thrown by `merge` when a provider call fails, carrying the forge's message. */
export class ReviewProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewProviderError";
  }
}

type Target =
  | { ok: true; repo: RepoInfo; branch: string; ctx: ProviderContext; provider: ReviewProvider }
  | { ok: false; result: WorktreeReview };

/**
 * The code review and checks for a worktree's branch, from whichever plugin
 * provides reviews for the repo's `origin` host. The core knows nothing
 * about the forge; it resolves the worktree and asks the provider.
 */
export class ReviewService {
  constructor(
    private readonly host: PluginHost,
    private readonly worktrees: WorktreeService,
  ) {}

  async forWorktree(worktreeId: string): Promise<WorktreeReview> {
    const target = await this.resolve(worktreeId);
    if (!target.ok) return target.result;
    const { repo, branch, ctx, provider } = target;

    try {
      const review = await provider.getReviewForBranch(repo, branch, ctx);
      let checks = review?.checks;
      if (!checks) {
        const checksProvider = await this.host.checksProviderFor(repo);
        checks = checksProvider
          ? await checksProvider.getChecksForRef(repo, branch, ctx)
          : { state: "none", headSha: null, checks: [] };
      }
      return {
        status: "ok",
        provider: { id: provider.id, name: provider.name },
        repo,
        branch,
        review,
        checks,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Review lookup failed for %s (%s): %s", worktreeId, provider.id, message);
      return { status: "error", message };
    }
  }

  async merge(worktreeId: string, method: MergeMethod): Promise<void> {
    const target = await this.resolve(worktreeId);
    if (!target.ok) throw new NoOpenReviewError(worktreeId);
    const { repo, branch, ctx, provider } = target;
    if (!provider.merge) throw new NoOpenReviewError(worktreeId);

    let review: ReviewInfo | null;
    try {
      review = await provider.getReviewForBranch(repo, branch, ctx);
    } catch (err) {
      throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
    }
    if (!review || (review.state !== "open" && review.state !== "draft")) {
      throw new NoOpenReviewError(worktreeId);
    }
    try {
      await provider.merge(repo, review.number, method, ctx);
    } catch (err) {
      throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
    }
  }

  private async resolve(worktreeId: string): Promise<Target> {
    const resolved = this.worktrees.resolve(worktreeId);
    if (!resolved) throw new WorktreeNotFoundError(worktreeId);
    const { repo, worktree, host } = resolved;

    if (repo.kind === "plain") {
      return unavailable("plain-repo", "This repo is not a git repository.");
    }
    if (worktree.branch.startsWith(DETACHED_BRANCH_PREFIX)) {
      return unavailable("detached-head", "The worktree is not on a branch.");
    }
    // A remote worktree's repository is the worker's checkout, not the hub's copy.
    const checkout = hostRegistry.repoPathOn(repo.name, host.id, repo.path);
    const repoInfo = await getRepoInfo(checkout ?? worktree.path, gitRunner(host));
    if (!repoInfo) {
      return unavailable("no-remote", "The repo has no origin remote.");
    }
    const provider = await this.host.reviewProviderFor(repoInfo);
    if (!provider) {
      return unavailable("no-provider", `No enabled plugin handles ${repoInfo.host}.`);
    }
    return {
      ok: true,
      repo: repoInfo,
      branch: worktree.branch,
      // The provider's `gh` calls name the repository, so they need no checkout. They
      // run on the hub, where a remote worktree's path does not exist.
      ctx: {
        cwd: host.id === hostRegistry.local.id ? worktree.path : tmpdir(),
        defaultBranch: repo.defaultBranch,
      },
      provider,
    };
  }
}

function unavailable(
  reason: Extract<WorktreeReview, { status: "unavailable" }>["reason"],
  message: string,
): Target {
  return { ok: false, result: { status: "unavailable", reason, message } };
}

export const reviewService = new ReviewService(pluginHost, worktreeService);
