import { DETACHED_BRANCH_PREFIX, getRepoInfo } from "@band-app/host-local/git/git-client";
import { gitRunner } from "@band-app/host-local/git-run";
import { createLogger } from "@band-app/logger";
import type {
  MergeMethod,
  ProviderContext,
  RepoInfo,
  ReviewInfo,
  ReviewProvider,
  WorkspaceReview,
} from "@band-app/plugin-api";
import { WorkspaceNotFoundError } from "../errors";
import { type PluginHost, pluginHost } from "./plugin-host-service";
import { type WorkspaceService, workspaceService } from "./workspace-service";

const log = createLogger("review-service");

/** Thrown by `merge` when the workspace's branch has no open review to merge. */
export class NoOpenReviewError extends Error {
  constructor(workspaceId: string) {
    super(`No open review to merge for workspace ${workspaceId}`);
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
  | { ok: false; result: WorkspaceReview };

/**
 * The code review and checks for a workspace's branch, from whichever plugin
 * provides reviews for the project's `origin` host. The core knows nothing
 * about the forge; it resolves the workspace and asks the provider.
 */
export class ReviewService {
  constructor(
    private readonly host: PluginHost,
    private readonly workspaces: WorkspaceService,
  ) {}

  async forWorkspace(workspaceId: string): Promise<WorkspaceReview> {
    const target = await this.resolve(workspaceId);
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
      log.warn("Review lookup failed for %s (%s): %s", workspaceId, provider.id, message);
      return { status: "error", message };
    }
  }

  async merge(workspaceId: string, method: MergeMethod): Promise<void> {
    const target = await this.resolve(workspaceId);
    if (!target.ok) throw new NoOpenReviewError(workspaceId);
    const { repo, branch, ctx, provider } = target;
    if (!provider.merge) throw new NoOpenReviewError(workspaceId);

    let review: ReviewInfo | null;
    try {
      review = await provider.getReviewForBranch(repo, branch, ctx);
    } catch (err) {
      throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
    }
    if (!review || (review.state !== "open" && review.state !== "draft")) {
      throw new NoOpenReviewError(workspaceId);
    }
    try {
      await provider.merge(repo, review.number, method, ctx);
    } catch (err) {
      throw new ReviewProviderError(err instanceof Error ? err.message : String(err));
    }
  }

  private async resolve(workspaceId: string): Promise<Target> {
    const resolved = this.workspaces.resolve(workspaceId);
    if (!resolved) throw new WorkspaceNotFoundError(workspaceId);
    const { project, worktree, host } = resolved;

    if (project.kind === "plain") {
      return unavailable("plain-project", "This project is not a git repository.");
    }
    if (worktree.branch.startsWith(DETACHED_BRANCH_PREFIX)) {
      return unavailable("detached-head", "The workspace is not on a branch.");
    }
    const repo = await getRepoInfo(project.path, gitRunner(host));
    if (!repo) {
      return unavailable("no-remote", "The project has no origin remote.");
    }
    const provider = await this.host.reviewProviderFor(repo);
    if (!provider) {
      return unavailable("no-provider", `No enabled plugin handles ${repo.host}.`);
    }
    return {
      ok: true,
      repo,
      branch: worktree.branch,
      ctx: { cwd: worktree.path, defaultBranch: project.defaultBranch },
      provider,
    };
  }
}

function unavailable(
  reason: Extract<WorkspaceReview, { status: "unavailable" }>["reason"],
  message: string,
): Target {
  return { ok: false, result: { status: "unavailable", reason, message } };
}

export const reviewService = new ReviewService(pluginHost, workspaceService);
