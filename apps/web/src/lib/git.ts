import { execFile } from "node:child_process";

export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
  isBare: boolean;
}

export function gitCmd(): { command: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
  }
  return { command: "git", env };
}

function execGit(args: string[], cwd: string): Promise<string> {
  const { command, env } = gitCmd();
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env }, (err, stdout, stderr) => {
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
    worktrees.push({
      branch: currentBranch,
      path: currentPath,
      head: currentHead,
      isBare,
    });
  }

  return worktrees;
}
