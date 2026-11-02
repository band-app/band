import type { ProviderContext, RepoInfo } from "@band-app/plugin-api";
import { definePlugin } from "@band-app/plugin-api/server";
import { ghArgsFor } from "./actions";
import {
  buildBranchStatusQuery,
  type GraphQLRepoResponse,
  parseBranchStatusResponse,
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
        return parseBranchStatusResponse(data, branches);
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
        if (!review) handoff.set(keyOf(target, branch), { at: Date.now(), data });
        return review;
      },
      async runAction(repo, number, actionId, args, ctx) {
        const ghArgs = ghArgsFor(number, actionId, args);
        await runGh(api, [...ghArgs, "--repo", repoArg(normalize(repo))], ctx);
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
