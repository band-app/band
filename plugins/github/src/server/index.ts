import type { ProviderContext, RepoInfo } from "@band-app/plugin-api";
import { definePlugin } from "@band-app/plugin-api/server";
import {
  parseBranchChecks,
  parseReview,
  REVIEW_QUERY,
  type ReviewQueryResponse,
} from "./checks-query";
import { ghGraphql, repoArg, runGh } from "./gh";

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

    function query(
      repo: RepoInfo,
      branch: string,
      ctx: ProviderContext,
    ): Promise<ReviewQueryResponse> {
      return ghGraphql<ReviewQueryResponse>(
        api,
        repo,
        REVIEW_QUERY,
        { owner: repo.owner, name: repo.repo, branch, ref: `refs/heads/${branch}` },
        ctx,
      );
    }

    const matches = (repo: RepoInfo) => githubHost(repo) !== null;

    api.providers.registerReviewProvider({
      id: "github",
      name: "GitHub",
      matches,
      async getReviewForBranch(repo, branch, ctx) {
        const target = normalize(repo);
        const data = await query(target, branch, ctx);
        const review = parseReview(data, branch, ctx.defaultBranch);
        if (!review) handoff.set(keyOf(target, branch), { at: Date.now(), data });
        return review;
      },
      async merge(repo, number, method, ctx) {
        await runGh(
          api,
          ["pr", "merge", String(number), `--${method}`, "--repo", repoArg(normalize(repo))],
          ctx,
        );
      },
    });

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
