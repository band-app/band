import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";

/**
 * Git infrastructure client — Phase 2 of the 3-tier refactor
 * (`docs/web-architecture.md`).
 *
 * Wraps every shell-out to `git` that the web server needs so the rest of
 * the codebase (services, routers, sync loops) can depend on a typed,
 * single-purpose adapter instead of scattered `execGit` calls. The legacy
 * `lib/git.ts` re-exports these symbols as thin pass-throughs during the
 * migration so callers that still import from there keep compiling.
 *
 * Infra-tier rules:
 *   - knows nothing about services, routers, or the database
 *   - only depends on Node primitives + the shared logger
 *   - returns plain data (string, structured objects) — no business
 *     decisions about what to do with it
 */

const log = createLogger("git");

/**
 * One git worktree as reported by `git worktree list --porcelain`.
 *
 * `branch` is always non-empty for non-bare worktrees: detached-HEAD
 * states fall back to either `resolveDetachedBranch` (if mid-rebase) or
 * `detachedShaLabel` (a `detached-<short-sha>` synthetic label). See the
 * `WorkspaceCard` chain in `detachedShaLabel` below for the invariants
 * the rest of the app relies on.
 */
export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
  isBare: boolean;
}

/**
 * Host + owner + repo extracted from a git remote URL.
 *
 * Used to key GitHub GraphQL CI queries and `gh --hostname` invocations.
 * Returned by `parseGitRemoteUrl` and `getRepoInfo`.
 */
export interface RepoInfo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Prefix used by `detachedShaLabel`. Exported so callers that need to
 * recognise the synthetic label (e.g. `workspaces.remove` skipping
 * `git branch -D` for a non-real ref) can do so without re-spelling
 * the literal `"detached-"` in two places.
 */
export const DETACHED_BRANCH_PREFIX = "detached-";

const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

/**
 * Parse a git remote URL into host, owner, and repo components.
 * Supports SCP-style SSH (git@host:owner/repo.git), `ssh://` URLs
 * (ssh://git@host/owner/repo.git), and HTTPS (https://host/owner/repo.git).
 */
export function parseGitRemoteUrl(url: string): RepoInfo | null {
  // SCP-style SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^[\w.-]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }
  // ssh:// scheme, all of:
  //   ssh://git@github.com/owner/repo.git           (with user)
  //   ssh://github.com/owner/repo.git               (userless)
  //   ssh://git@github.com:22/owner/repo.git        (explicit port)
  //   ssh://github.com:2222/owner/repo.git          (userless + port)
  // The `(?::\d+)?` strips the port from the host capture — without it
  // the bare `[^/]+` host group eats the colon and we'd persist a host
  // like `"github.com:22"`, which then mismatches the gh CLI's
  // `--hostname` and breaks the GraphQL query. (`gh repo clone` emits
  // these for repos without SCP-style aliasing; before #502 review the
  // whole `ssh://` shape fell through and silently flipped `hasOrigin`
  // to false — issue #458 review feedback.)
  const sshSchemeMatch = url.match(
    /^ssh:\/\/(?:[\w.-]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (sshSchemeMatch) {
    return {
      host: sshSchemeMatch[1],
      owner: sshSchemeMatch[2],
      repo: sshSchemeMatch[3],
    };
  }
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };
  }
  return null;
}

/**
 * Build a fallback "branch" label for a detached HEAD that isn't mid-rebase
 * (e.g. a checked-out tag, a raw commit SHA, or a post-rebase/post-bisect
 * state). The label must be:
 *
 *   1. **Non-empty** — `WorkspaceCard` renders `worktree.branch` as-is, so an
 *      empty string shows as a blank label next to the branch icon and the
 *      dirty-tree "M" badge.
 *   2. **Unique per worktree** — workspace IDs are derived from
 *      `${projectName}-${branch}` via `toWorkspaceId`. Two detached worktrees
 *      with the empty string collide to the same ID, which breaks selection,
 *      pinning, and the `data-testid` hook on `WorkspaceCard`. Embedding the
 *      short commit SHA disambiguates them.
 *   3. **Filesystem- and URL-safe** — `workspaceId` is used as a path
 *      component in `workspace-prompts/<id>.json` and `shared/<id>/...`, and
 *      as a URL segment via `encodeURIComponent`. We stick to `[a-z0-9-]` so
 *      no encoding surprises leak through. (Bug surfaced when a user had
 *      ~9 worktrees in detached-HEAD states — see the WorkspaceCard chain
 *      starting at the empty-branch return below.)
 *
 * If the porcelain `HEAD` line was missing (extremely unusual — git emits it
 * for every worktree, including bare ones), we fall back to a non-empty
 * generic marker so the label still renders and the caller's ID derivation
 * doesn't collapse to `${projectName}-`. Different worktrees in that state
 * would still collide, but git doesn't actually produce empty `HEAD` lines
 * in practice — the marker is defensive, not load-bearing.
 */
function detachedShaLabel(head: string): string {
  const sha = head.trim().slice(0, 7);
  return sha ? `${DETACHED_BRANCH_PREFIX}${sha}` : "detached";
}

/**
 * When a worktree has a detached HEAD mid-rebase, try to resolve the
 * original branch name from git's rebase state files. Returns the empty
 * string for any other detached state (checked-out tag, raw SHA, finished/
 * aborted rebase) — callers must fall back to `detachedShaLabel` in that
 * case, otherwise the empty string flows into `toWorkspaceId` and produces
 * colliding workspace IDs (see `detachedShaLabel` for the full chain).
 */
async function resolveDetachedBranch(worktreePath: string): Promise<string> {
  const dotGit = join(worktreePath, ".git");
  let gitdir: string;

  try {
    const st = await stat(dotGit);
    if (st.isDirectory()) {
      // Main worktree — .git is a directory
      gitdir = dotGit;
    } else {
      // Linked worktree — .git is a file with "gitdir: <path>"
      const gitContent = await readFile(dotGit, "utf-8");
      const match = gitContent.match(/^gitdir:\s*(.+)/);
      if (!match) return "";
      gitdir = match[1].trim();
    }
  } catch {
    return "";
  }

  // Check interactive rebase (rebase-merge) then regular rebase (rebase-apply)
  for (const rebaseDir of ["rebase-merge", "rebase-apply"]) {
    try {
      const headName = await readFile(join(gitdir, rebaseDir, "head-name"), "utf-8");
      const name = headName.trim();
      return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
    } catch {}
  }
  return "";
}

/**
 * Build the `{ command, env }` pair used to invoke git. Prepends Homebrew
 * paths to `PATH` so a desktop launch (which inherits a barebones PATH on
 * macOS) still finds the system `git` binary.
 */
export function gitCmd(): { command: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
  }
  return { command: "git", env };
}

/**
 * Run `git ARGS` in `cwd` and return stdout. Rejects with stderr (or the
 * underlying error message) on a non-zero exit. The 50 MB buffer cap is
 * intentionally generous — `git diff` against a large worktree can produce
 * hundreds of kilobytes of output and the default 1 MB ceiling truncates
 * silently.
 */
export function execGit(args: string[], cwd: string): Promise<string> {
  const { command, env } = gitCmd();
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Same shape as `execGit` but shells out to the GitHub CLI (`gh`). Lives
 * here rather than a dedicated `gh-client.ts` because the only callers
 * today are git/CI-adjacent (CI status polling, PR lookup), and the
 * subprocess + PATH boilerplate is the same.
 */
export function execGh(args: string[], cwd: string): Promise<string> {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
  }
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, env, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse `git worktree list --porcelain` into structured `WorktreeInfo`
 * records. Applies the detached-HEAD → `detached-<short-sha>` fallback so
 * every non-bare worktree has a non-empty, collision-safe branch label.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoPath);
  const worktrees: WorktreeInfo[] = [];
  let currentPath = "";
  let currentHead = "";
  let currentBranch = "";
  let isBare = false;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      currentHead = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const branchRef = line.slice("branch ".length);
      currentBranch = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
    } else if (line === "bare") {
      isBare = true;
    } else if (line === "" && currentPath) {
      if (!currentBranch && !isBare) {
        currentBranch = (await resolveDetachedBranch(currentPath)) || detachedShaLabel(currentHead);
      }
      worktrees.push({
        branch: currentBranch,
        path: currentPath,
        head: currentHead,
        isBare,
      });
      currentPath = "";
      currentHead = "";
      currentBranch = "";
      isBare = false;
    }
  }

  // Push last entry
  if (currentPath) {
    if (!currentBranch && !isBare) {
      currentBranch = (await resolveDetachedBranch(currentPath)) || detachedShaLabel(currentHead);
    }
    worktrees.push({
      branch: currentBranch,
      path: currentPath,
      head: currentHead,
      isBare,
    });
  }

  return worktrees;
}

/**
 * Get the GitHub host, owner, and repo for a git worktree by reading its origin remote URL.
 *
 * Best-effort: returns `null` cleanly when the directory isn't a git
 * checkout, has no `origin` remote, or the URL format isn't recognised.
 * See issue #458 for why these are debug-level rather than error-level.
 */
export async function getRepoInfo(worktreePath: string): Promise<RepoInfo | null> {
  try {
    const remoteUrl = (await execGit(["remote", "get-url", "origin"], worktreePath)).trim();
    const parsed = parseGitRemoteUrl(remoteUrl);
    if (!parsed) {
      // Steady-state condition (e.g. self-hosted remote with an unusual URL
      // shape) — debug-level, not error-level. The caller decides whether the
      // absent metadata is actually a problem.
      log.debug('getRepoInfo: failed to parse remote URL "%s" for %s', remoteUrl, worktreePath);
    }
    return parsed;
  } catch (err) {
    // `getRepoInfo` is best-effort metadata: a project directory may legitimately
    // not be a git checkout, or may lack an `origin` remote. Those are expected
    // steady states, not error paths — log at debug so the server log isn't
    // spammed every CI poll tick. See issue #458.
    log.debug(
      "getRepoInfo: failed for %s: %s",
      worktreePath,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Typed wrapper around the git CLI. Group related operations on this class
 * so services can depend on `git: GitClient = new GitClient()` instead of
 * importing a bag of loose functions.
 *
 * Methods are thin wrappers over the existing functional API so the
 * back-compat shim in `lib/git.ts` and the in-flight refactor (issue #313)
 * can co-exist while callers migrate one at a time. Once every caller goes
 * through the class, the standalone exports will be removed from this
 * module and `lib/git.ts` retired.
 */
export class GitClient {
  /**
   * Run `git init` (optionally with `-b <branch>`) in `cwd`. Idempotent —
   * if the directory is already a git repo, git itself reports a no-op
   * rather than failing.
   */
  async init(cwd: string, branch?: string): Promise<void> {
    const args = ["init"];
    if (branch) args.push("-b", branch);
    await execGit(args, cwd);
  }

  /**
   * `listWorktrees` instance method — parses
   * `git worktree list --porcelain` into structured `WorktreeInfo` records.
   * See the module-level export for full semantics.
   */
  listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    return listWorktrees(repoPath);
  }

  /**
   * Resolve the local HEAD's short symbolic ref (the current branch name).
   * Returns `null` when HEAD is detached or any other failure mode — the
   * caller should fall back to a sensible default (`"main"`).
   */
  async currentBranch(cwd: string): Promise<string | null> {
    try {
      const output = (await execGit(["symbolic-ref", "--short", "HEAD"], cwd)).trim();
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * `getRepoInfo` instance method — extracts host/owner/repo from the
   * `origin` remote URL. Returns `null` cleanly when the directory isn't
   * a git checkout, has no `origin` remote, or the URL format isn't
   * recognised. See the module-level export for full semantics.
   */
  getRepoInfo(worktreePath: string): Promise<RepoInfo | null> {
    return getRepoInfo(worktreePath);
  }

  /**
   * Run `git ARGS` in `cwd` and return stdout. See the module-level
   * `execGit` for full semantics.
   */
  exec(args: string[], cwd: string): Promise<string> {
    return execGit(args, cwd);
  }
}
