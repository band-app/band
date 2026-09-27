import type { RepoInfo } from "@band-app/plugin-api";
import type { BandServerApi } from "@band-app/plugin-api/server";

const GH_TIMEOUT_MS = 30_000;

/**
 * The `gh` executable. `BAND_GH_BIN` overrides it, read on every call so a
 * user with `gh` outside `PATH` (and the integration tests' stub) can point
 * the plugin at another binary without a restart.
 */
function ghBin(): string {
  return process.env.BAND_GH_BIN || "gh";
}

/** `gh` without prompts: a prompt would hang a server-side call forever. */
export async function runGh(api: BandServerApi, args: string[], cwd: string): Promise<string> {
  const { stdout } = await api.exec(ghBin(), args, {
    cwd,
    timeoutMs: GH_TIMEOUT_MS,
    env: { GH_PROMPT_DISABLED: "1" },
  });
  return stdout;
}

/** `gh api graphql` against the repository's host. Throws on GraphQL errors. */
export async function ghGraphql<T>(
  api: BandServerApi,
  repo: RepoInfo,
  query: string,
  variables: Record<string, string>,
  cwd: string,
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-f", `${key}=${value}`);
  }
  if (repo.host !== "github.com") args.push("--hostname", repo.host);
  const output = await runGh(api, args, cwd);
  const parsed = JSON.parse(output) as { data?: T; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  }
  if (!parsed.data) throw new Error("gh api graphql returned no data");
  return parsed.data;
}

/** `HOST/OWNER/REPO`, the form `gh --repo` accepts for any host. */
export function repoArg(repo: RepoInfo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}
