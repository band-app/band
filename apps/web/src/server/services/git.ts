// Back-compat shim around the new `server/infra/git/git-client.ts`
// (issue #313, Phase 2 of the 3-tier refactor). Existing callers
// (branch-status-poller, sync-state, github-graphql, the legacy tRPC
// router) keep importing from `lib/git`; the real implementation lives
// in the Infra tier so the service / DB layers can depend on it
// without crossing into `lib/`. Later refactor phases will rewrite
// each caller to import from the infra module directly and this file
// will be deleted.

export type { RepoInfo, WorktreeInfo } from "../infra/git/git-client";
export {
  DETACHED_BRANCH_PREFIX,
  execGh,
  execGit,
  GitClient,
  getRepoInfo,
  gitCmd,
  listWorktrees,
  parseGitRemoteUrl,
} from "../infra/git/git-client";
