import type { ProviderContext, RepoInfo, ReviewAction, ReviewInfo } from "@band-app/plugin-api";
import { definePlugin } from "@band-app/plugin-api/server";
import { ghArgsFor } from "./actions";
import {
  buildBranchStatusQuery,
  buildParentStatusQuery,
  type GraphQLRepoResponse,
  parseBranchStatusResponse,
  parseParentStatusResponse,
} from "./branch-query";
import {
  parseBranchChecks,
  parseReview,
  type ReviewQueryResponse,
  reviewQuery,
} from "./checks-query";
import { ghGraphql, repoArg, runGh } from "./gh";
import { isUnknownMergeQueueField } from "./merge-queue";
import { createSubscriptionSource } from "./subscriptions";

// github.com accepts these as aliases of itself: `www.` over HTTPS and
// `ssh.github.com` for SSH over port 443.
const GITHUB_COM_ALIASES = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/**
 * github.com, GitHub Enterprise Cloud (`<name>.ghe.com`) and GitHub
 * Enterprise Server on the conventional `github.<company>.<tld>` name. The
 * same rule as the repo avatar lookup.
 */
function githubHost(repo: RepoInfo): string | null {
  const host = repo.host.toLowerCase();
  if (GITHUB_COM_ALIASES.has(host)) return "github.com";
  if (host.startsWith("github.") || host.endsWith(".ghe.com")) return host;
  return null;
}

function normalize(repo: RepoInfo): RepoInfo {
  return { ...repo, host: githubHost(repo) ?? repo.host };
}

// The core asks for the review and then, when there is none, for the branch
// checks. Both come from one query, so the review lookup leaves its response
// for the checks lookup that follows it. A lookup never reads an older
// response, so Refresh always runs `gh`.
const HANDOFF_TTL_MS = 10_000;

export default definePlugin({
  activate(api) {
    const handoff = new Map<string, { at: number; data: ReviewQueryResponse }>();
    const keyOf = (repo: RepoInfo, branch: string) => `${repoArg(repo)}#${branch}`;

    // Hosts that refused the merge queue fields (an older GitHub Enterprise Server). They are
    // asked without them from then on, so the extra attempt happens once per host.
    const noMergeQueue = new Set<string>();

    // The repo each fork was made from, or null for a repo that is not a fork. A repo's parent
    // does not change, so it is read once, from the `parent` field of the queries that run anyway.
    const parents = new Map<string, RepoInfo | null>();
    // The parent repo a fork's PR lives in, by `<origin>#<number>`, for actions on that PR.
    const prRepos = new Map<string, RepoInfo>();

    function rememberParent(
      origin: RepoInfo,
      node: { name: string; owner: { login: string } } | null | undefined,
    ): RepoInfo | null {
      const parent = node ? { host: origin.host, owner: node.owner.login, repo: node.name } : null;
      parents.set(repoArg(origin), parent);
      return parent;
    }

    /** Tag the re-run actions of a parent-repo review, so they run against the parent. */
    function inRepo(review: ReviewInfo, parent: RepoInfo): ReviewInfo {
      const tag = (actions: ReviewAction[] = []) =>
        actions.map((a) =>
          a.id.startsWith("rerun") ? { ...a, args: { ...a.args, repo: repoArg(parent) } } : a,
        );
      return {
        ...review,
        actions: tag(review.actions),
        checks: { ...review.checks, actions: tag(review.checks.actions) },
      };
    }

    async function withMergeQueueFallback<T>(
      repo: RepoInfo,
      run: (mergeQueue: boolean) => Promise<T>,
    ): Promise<T> {
      if (noMergeQueue.has(repo.host)) return run(false);
      try {
        return await run(true);
      } catch (error) {
        if (!isUnknownMergeQueueField(error)) throw error;
        noMergeQueue.add(repo.host);
        return run(false);
      }
    }

    function query(
      repo: RepoInfo,
      branch: string,
      ctx: ProviderContext,
    ): Promise<ReviewQueryResponse> {
      return withMergeQueueFallback(repo, (mergeQueue) =>
        ghGraphql<ReviewQueryResponse>(
          api,
          repo,
          reviewQuery({ mergeQueue }),
          { owner: repo.owner, name: repo.repo, branch, ref: `refs/heads/${branch}` },
          ctx,
        ),
      );
    }

    api.providers.registerBranchStatusProvider({
      id: "github",
      matches: (repo) => githubHost(repo) !== null,
      async getBranchStatuses(repo, branches, ctx) {
        const target = normalize(repo);
        const names = branches.map((b) => b.branch);
        const data = await withMergeQueueFallback(target, async (mergeQueue) => {
          const args = [
            "api",
            "graphql",
            "-f",
            `query=${buildBranchStatusQuery(target, names, { mergeQueue })}`,
          ];
          if (target.host !== "github.com") args.push("--hostname", target.host);
          const output = await runGh(api, args, ctx);
          const parsed = JSON.parse(output) as {
            data?: Record<string, GraphQLRepoResponse | null>;
            errors?: Array<{ message: string }>;
          };
          // A host without the fields answers with errors and no data.
          if (!parsed.data && parsed.errors?.length) {
            throw new Error(parsed.errors.map((e) => e.message).join("; "));
          }
          return parsed.data ?? {};
        });
        const results = parseBranchStatusResponse(data, branches);

        const first = Object.values(data).find((r) => r != null);
        if (first && first.parent !== undefined) rememberParent(target, first.parent);
        const parent = parents.get(repoArg(target));
        const forkOwner = first?.owner?.login ?? target.owner;
        // Only a fork's branches that have no PR in the fork itself are asked of the parent.
        const open = branches.filter((b) => !b.isDefaultBranch && !results[b.branch]?.review);
        if (parent && open.length > 0) {
          // A parent the token cannot read must not lose the fork's own statuses.
          const parentData = await withMergeQueueFallback(parent, async (mergeQueue) => {
            const args = [
              "api",
              "graphql",
              "-f",
              `query=${buildParentStatusQuery(
                parent,
                open.map((b) => b.branch),
                { mergeQueue },
              )}`,
            ];
            if (parent.host !== "github.com") args.push("--hostname", parent.host);
            const parsed = JSON.parse(await runGh(api, args, ctx)) as {
              data?: Record<string, GraphQLRepoResponse | null>;
              errors?: Array<{ message: string }>;
            };
            if (!parsed.data && parsed.errors?.length) {
              throw new Error(parsed.errors.map((e) => e.message).join("; "));
            }
            return parsed.data ?? {};
          }).catch(() => ({}) as Record<string, GraphQLRepoResponse | null>);
          Object.assign(results, parseParentStatusResponse(parentData, open, forkOwner));
        }
        return results;
      },
    });

    const matches = (repo: RepoInfo) => githubHost(repo) !== null;

    api.providers.registerReviewProvider({
      id: "github",
      name: "GitHub",
      fixHint: "for example with `gh run view <run-id> --log-failed`",
      matches,
      async getReviewForBranch(repo, branch, ctx) {
        const target = normalize(repo);
        const data = await query(target, branch, ctx);
        const review = parseReview(data, branch, ctx.defaultBranch);
        if (review) return review;
        handoff.set(keyOf(target, branch), { at: Date.now(), data });

        if (data.repository && data.repository.parent !== undefined) {
          rememberParent(target, data.repository.parent);
        }
        const parent = parents.get(repoArg(target));
        if (!parent || branch === ctx.defaultBranch) return null;
        const parentData = await query(parent, branch, ctx);
        const parentReview = parseReview(parentData, branch, ctx.defaultBranch, target.owner);
        if (!parentReview) return null;
        prRepos.set(`${repoArg(target)}#${parentReview.number}`, parent);
        return inRepo(parentReview, parent);
      },
      async runAction(repo, number, actionId, args, ctx) {
        const ghArgs = ghArgsFor(number, actionId, args);
        const origin = normalize(repo);
        const parent = parents.get(repoArg(origin));
        // A fork's PR lives in the parent. Re-runs carry the repo in their args; the others find it
        // by number from the review lookup that came just before.
        const target =
          parent && args.repo === repoArg(parent)
            ? parent
            : (prRepos.get(`${repoArg(origin)}#${number}`) ?? origin);
        await runGh(api, [...ghArgs, "--repo", repoArg(target)], ctx);
      },
    });

    api.providers.registerSubscriptionSourceProvider(createSubscriptionSource(api));

    api.providers.registerChecksProvider({
      id: "github",
      matches,
      async getChecksForRef(repo, ref, ctx) {
        const target = normalize(repo);
        const key = keyOf(target, ref);
        const left = handoff.get(key);
        handoff.delete(key);
        const fresh = left && Date.now() - left.at < HANDOFF_TTL_MS;
        return parseBranchChecks(fresh ? left.data : await query(target, ref, ctx));
      },
    });
  },
});
