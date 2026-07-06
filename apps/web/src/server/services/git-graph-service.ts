// Read + write git operations exposed by the Graph tab's commit-details
// panel and context menus: inspecting a single commit, diffing one of its
// files, and the handful of "essentials" actions (checkout branch, create
// branch, cherry-pick, revert). Every shell-out goes through
// `infra/git/git-client.ts::execGit` (execFile, no shell), and the workspace
// is resolved to a worktree path the same way `DiffService` does.

import { WorkspaceNotFoundError } from "../errors";
import { execGit } from "../infra/git/git-client";
import {
  workspaceService as defaultWorkspaceService,
  type WorkspaceService,
} from "./workspace-service";

// US (0x1f) field separator — subjects/bodies never contain it, so it is a
// safe delimiter for the fixed metadata fields.
const FS = "\x1f";

export interface CommitFileChange {
  path: string;
  /** git name-status code: A, M, D, R, C, T. */
  status: string;
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  authorTs: number;
  committer: string;
  committerTs: number;
  subject: string;
  body: string;
  files: CommitFileChange[];
}

/** Parse `git show --name-status` file lines into a `{path,status}` list. */
function parseNameStatus(output: string): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0];
    if (!code) continue;
    // Renames/copies emit "R100\told\tnew" — report the new path.
    if ((code === "R" || code === "C") && parts[2]) {
      files.push({ path: parts[2], status: code });
    } else if (parts[1]) {
      files.push({ path: parts[1], status: code });
    }
  }
  return files;
}

export class GitGraphService {
  constructor(private readonly workspaces: WorkspaceService = defaultWorkspaceService) {}

  private cwd(workspaceId: string): string {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    return workspace.worktree.path;
  }

  /** Full metadata + changed-file list for a single commit. */
  async getCommitDetails(workspaceId: string, sha: string): Promise<CommitDetails> {
    const cwd = this.cwd(workspaceId);

    // Body (%b) is last so it can safely contain newlines and separators.
    const fmt = ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%s", "%b"].join(FS);
    const raw = await execGit(["show", "-s", `--format=${fmt}`, sha], cwd);
    const parts = raw.split(FS);
    const [shaOut, parentsStr, author, email, authorTsStr, committer, committerTsStr, subject] =
      parts;
    const body = parts.slice(8).join(FS).replace(/\n$/, "");

    // `--first-parent` diffs a merge against its mainline parent (matches how
    // the graph shows it). For a root commit diff-tree yields nothing, so
    // `git show --name-status` naturally lists every file as added.
    const filesRaw = await execGit(
      ["show", "--first-parent", "--name-status", "--format=", sha],
      cwd,
    );

    return {
      sha: shaOut,
      parents: parentsStr ? parentsStr.split(" ").filter(Boolean) : [],
      author,
      email,
      authorTs: Number.parseInt(authorTsStr, 10) || 0,
      committer,
      committerTs: Number.parseInt(committerTsStr, 10) || 0,
      subject,
      body,
      files: parseNameStatus(filesRaw),
    };
  }

  /** Unified diff for a single file within a commit (vs its first parent). */
  async getCommitFileDiff(
    workspaceId: string,
    sha: string,
    filePath: string,
  ): Promise<{ diff: string }> {
    const cwd = this.cwd(workspaceId);
    // `--` pins filePath as a pathspec (the router already rejects a leading
    // dash); `git show` handles the root-commit case where there is no parent.
    const diff = await execGit(["show", "--first-parent", "--format=", sha, "--", filePath], cwd);
    return { diff };
  }

  /** Checkout an existing local branch. Fails (bubbles) if the tree is dirty. */
  async checkoutBranch(workspaceId: string, branch: string): Promise<{ ok: true }> {
    const cwd = this.cwd(workspaceId);
    await execGit(["checkout", branch], cwd);
    return { ok: true };
  }

  /** Create a branch at `sha`, optionally checking it out. */
  async createBranch(
    workspaceId: string,
    sha: string,
    name: string,
    checkout: boolean,
  ): Promise<{ ok: true }> {
    const cwd = this.cwd(workspaceId);
    if (checkout) {
      await execGit(["checkout", "-b", name, sha], cwd);
    } else {
      await execGit(["branch", name, sha], cwd);
    }
    return { ok: true };
  }

  /** Cherry-pick a commit onto the current branch. Conflicts bubble as errors. */
  async cherryPick(workspaceId: string, sha: string): Promise<{ ok: true }> {
    const cwd = this.cwd(workspaceId);
    await execGit(["cherry-pick", sha], cwd);
    return { ok: true };
  }

  /** Revert a commit (creates an inverse commit). Conflicts bubble as errors. */
  async revert(workspaceId: string, sha: string): Promise<{ ok: true }> {
    const cwd = this.cwd(workspaceId);
    await execGit(["revert", "--no-edit", sha], cwd);
    return { ok: true };
  }
}

export const gitGraphService = new GitGraphService();
