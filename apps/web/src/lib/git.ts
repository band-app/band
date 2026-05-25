import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";

const log = createLogger("git");

export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
  isBare: boolean;
}

export interface RepoInfo {
  host: string;
  owner: string;
  repo: string;
}

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
  // ssh:// scheme: ssh://git@github.com/owner/repo.git, or the
  // userless variant ssh://github.com/owner/repo.git.
  // (`gh repo clone` emits these for repos without SCP-style aliasing;
  // before the #502 review they fell into the parse-failure branch and
  // silently flipped `hasOrigin` to false — issue #458 review feedback.)
  const sshSchemeMatch = url.match(/^ssh:\/\/(?:[\w.-]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
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
 * Get the GitHub host, owner, and repo for a git worktree by reading its origin remote URL.
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

export function gitCmd(): { command: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
  }
  return { command: "git", env };
}

const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

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
        currentBranch = await resolveDetachedBranch(currentPath);
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
      currentBranch = await resolveDetachedBranch(currentPath);
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
 * When a worktree has a detached HEAD (e.g. during rebase), try to resolve
 * the original branch name from git's rebase state files.
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
