import { tmpdir } from "node:os";
import { gitRunner } from "@band-app/host-api";
import { DETACHED_BRANCH_PREFIX, getRepoInfo } from "@band-app/host-local/git/git-client";
import { createLogger } from "@band-app/logger";
import {
  type MergeMethod,
  type ProviderContext,
  REVIEW_ACTION_MERGE,
  REVIEW_ACTION_RERUN_FAILED,
  REVIEW_ACTION_RERUN_JOB,
  type RepoInfo,
  type RerunTarget,
  type ReviewActionArgs,
  type ReviewInfo,
  type ReviewProvider,
  type WorktreeReview,
} from "@band-app/plugin-api";
import { WorktreeNotFoundError } from "../errors";
import { hostRegistry } from "../infra/host/registry";
import { requestCIRefresh } from "./_utils/ci-refresh-request";
import { ciSummaryFromChecks } from "./_utils/ci-summary";
import { worktreeGh } from "./_utils/worktree-gh";
import { applyCIStatus } from "./branch-status-poller";
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

const RERUN_ACTIONS = new Set([REVIEW_ACTION_RERUN_JOB, REVIEW_ACTION_RERUN_FAILED]);

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
      // The sidebar shows the same state the panel just read. A change also
      // makes the other worktrees' next tick worth taking now.
      if (applyCIStatus(worktreeId, ciSummaryFromChecks(checks, review))) requestCIRefresh();
      return {
        status: "ok",
        provider: { id: provider.id, name: provider.name, fixHint: provider.fixHint },
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

  /** The provider that serves the worktree's repo. Runs no forge command. */
  async providerFor(
    worktreeId: string,
  ): Promise<{ id: string; name: string; fixHint: string } | null> {
    const target = await this.resolve(worktreeId);
    if (!target.ok) return null;
    const { id, name, fixHint } = target.provider;
    return { id, name, fixHint };
  }

  /**
   * Run one of the actions the provider offered on the worktree's open review. Rejects with
   * `NoOpenReviewError` when there is no open review, `ReviewProviderError` with the forge's message
   * when the provider refuses.
   */
  async runAction(worktreeId: string, actionId: string, args: ReviewActionArgs): Promise<void> {
    const target = await this.resolve(worktreeId);
    if (!target.ok) throw new NoOpenReviewError(worktreeId);
    const { repo, branch, ctx, provider } = target;

    // Re-running CI jobs needs no review: a branch with no pull request has jobs too. The re-run
    // actions do not read the review number.
    let number = 0;
    if (!RERUN_ACTIONS.has(actionId)) {
      let review: ReviewInfo | null;
      try {
        review = await provider.getReviewForBranch(repo, branch, ctx);
      } catch (err) {
        throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
      }
      if (!review || (review.state !== "open" && review.state !== "draft")) {
        throw new NoOpenReviewError(worktreeId);
      }
      number = review.number;
    }
    try {
      await provider.runAction(repo, number, actionId, args, ctx);
    } catch (err) {
      throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
    }
  }

  /** `reviews.merge`, kept for the mobile app: the `merge` action with the chosen method. */
  merge(worktreeId: string, method: MergeMethod): Promise<void> {
    return this.runAction(worktreeId, REVIEW_ACTION_MERGE, { method });
  }

  /** `reviews.rerunChecks`, kept for the mobile app: one action per target, stopping at the first refusal. */
  async rerunChecks(worktreeId: string, targets: RerunTarget[]): Promise<void> {
    for (const item of targets) {
      if (item.failedOnly) {
        await this.runAction(worktreeId, REVIEW_ACTION_RERUN_FAILED, { runId: item.runId });
      } else if (item.jobId) {
        await this.runAction(worktreeId, REVIEW_ACTION_RERUN_JOB, {
          runId: item.runId,
          jobId: item.jobId,
        });
      } else {
        throw new ReviewProviderError("Name a job to run again, or ask for the failed jobs.");
      }
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
    let repoInfo = await getRepoInfo(checkout ?? worktree.path, gitRunner(host));
    // With the worker offline its checkout cannot answer. The hub's own copy of the repo names
    // the same origin, so the hub's `gh` can still serve the panel.
    if (!repoInfo && host.id !== hostRegistry.local.id && repo.path) {
      repoInfo = await getRepoInfo(repo.path, gitRunner(hostRegistry.local));
    }
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
      // The provider's `gh` calls run on the worktree's host, falling back to the hub's
      // `gh`. They name the repository, so the fallback needs no checkout.
      ctx: {
        cwd: host.id === hostRegistry.local.id ? worktree.path : tmpdir(),
        defaultBranch: repo.defaultBranch,
        gh: worktreeGh(host, hostRegistry.local.id, worktree.path),
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
