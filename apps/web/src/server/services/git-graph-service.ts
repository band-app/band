/**
 * Read-only git history for the Changes tab's Commits panel: a paged,
 * decorated `git log` of the workspace's HEAD, a cheap signature of HEAD +
 * refs so the client can tell when to reload it, and one commit's changed
 * files and per-file diff.
 *
 * The log parsing and the commit-details / file-diff reads come from the
 * Git Graph tab prototype (PR #612); this service narrows the log to HEAD,
 * adds paging, and returns refs as structured badges.
 *
 * Every git shell-out goes through `infra/git/git-client.ts::execGit`
 * (execFile, no shell).
 */

import { createHash } from "node:crypto";
import { WorkspaceNotFoundError } from "../errors";
import { execGit } from "../infra/git/git-client";
import { assertWorktreeRelative } from "./diff-service";
import {
  workspaceService as defaultWorkspaceService,
  type WorkspaceService,
} from "./workspace-service";

// Field (US, 0x1f) and record (RS, 0x1e) separators: commit subjects and ref
// names never contain them, unlike pipes, quotes or commas.
const FS = "\x1f";
const RS = "\x1e";

const COMMIT_HISTORY_DEFAULT_LIMIT = 50;

/** A ref pointing at a commit, as the panel draws it as a pill. */
export interface CommitRef {
  /** Short name: `main`, `origin/main`, `v1.0.0`. */
  name: string;
  /** `head` is the branch HEAD is on; the rest are other refs. */
  kind: "head" | "branch" | "remote" | "tag";
}

export interface HistoryCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, unix seconds. */
  ts: number;
  subject: string;
  refs: CommitRef[];
}

export interface CommitHistoryResult {
  commits: HistoryCommit[];
  /** HEAD's SHA, or null when the repo has no commits yet. */
  head: string | null;
  /** True when older commits exist past this page. */
  hasMore: boolean;
  /** `getCommitHistorySignature` at the time this page was read. */
  signature: string;
}

export interface CommitFileChange {
  path: string;
  /** git name-status code: A, M, D, R, C, T. */
  status: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
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

/**
 * Parse a `%D` decoration list printed with `--decorate=full`, e.g.
 * `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`.
 * Full names are what tell a local branch `feat/x` apart from a remote
 * branch `origin/x`. Symbolic refs (`HEAD`, `origin/HEAD`) and the stash
 * are dropped.
 */
function parseDecorations(raw: string): CommitRef[] {
  const refs: CommitRef[] = [];
  for (const part of raw.split(",")) {
    const ref = part.trim();
    if (!ref || ref === "HEAD") continue;
    if (ref.startsWith("HEAD -> refs/heads/")) {
      refs.push({ name: ref.slice("HEAD -> refs/heads/".length), kind: "head" });
    } else if (ref.startsWith("refs/heads/")) {
      refs.push({ name: ref.slice("refs/heads/".length), kind: "branch" });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) refs.push({ name, kind: "remote" });
    } else if (ref.startsWith("tag: refs/tags/")) {
      refs.push({ name: ref.slice("tag: refs/tags/".length), kind: "tag" });
    }
  }
  const order = { head: 0, branch: 1, remote: 2, tag: 3 };
  return refs.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/**
 * Parse `git show --name-status -z` output into a `{path,status}` list.
 * `-z` separates fields with NUL and leaves paths unquoted, so non-ASCII
 * names come back as-is and work as pathspecs.
 */
function parseNameStatus(output: string): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  const fields = output.replace(/^\n+/, "").split("\0");
  let i = 0;
  while (i < fields.length) {
    const code = fields[i]?.[0];
    if (!code) {
      i++;
      continue;
    }
    // Renames/copies carry two paths, old then new: report the new one.
    if (code === "R" || code === "C") {
      files.push({ path: fields[i + 2], status: code, oldPath: fields[i + 1] });
      i += 3;
    } else {
      files.push({ path: fields[i + 1], status: code });
      i += 2;
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

  /**
   * A hash of HEAD and every ref's target. It changes on a commit, checkout,
   * reset, fetch, branch or tag change, so the client polls it and reloads
   * the history only when it moves. Empty for a repo with no commits.
   */
  async getCommitHistorySignature(workspaceId: string): Promise<string> {
    return this.signature(this.cwd(workspaceId));
  }

  private async signature(cwd: string): Promise<string> {
    let out = "";
    try {
      // `--head` includes HEAD itself; show-ref exits 1 when there are no refs.
      out = await execGit(["show-ref", "--head"], cwd);
    } catch {
      return "";
    }
    return createHash("sha1").update(out).digest("hex");
  }

  /**
   * One page of HEAD's history, newest first in topological order, so every
   * commit is listed before its parents and the client can lay out lanes
   * over the concatenated pages. Returns an empty history, rather than
   * throwing, for a repo with no commits.
   */
  async getCommitHistory(
    workspaceId: string,
    options: { skip?: number; limit?: number } = {},
  ): Promise<CommitHistoryResult> {
    const cwd = this.cwd(workspaceId);
    const skip = options.skip ?? 0;
    const limit = options.limit ?? COMMIT_HISTORY_DEFAULT_LIMIT;

    // Read the signature first: if refs move while the log runs, the client
    // sees a newer signature on its next poll and reloads.
    const signature = await this.signature(cwd);

    let head: string | null = null;
    try {
      head = (await execGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
    } catch {
      return { commits: [], head: null, hasMore: false, signature };
    }

    const fmt = `${["%H", "%P", "%an", "%ae", "%at", "%s", "%D"].join(FS)}${RS}`;
    const stdout = await execGit(
      [
        "log",
        "--topo-order",
        "--decorate=full",
        `--skip=${skip}`,
        // One extra record tells us whether another page exists.
        `--max-count=${limit + 1}`,
        `--pretty=format:${fmt}`,
        head,
      ],
      cwd,
    );

    const commits: HistoryCommit[] = [];
    for (const raw of stdout.split(RS)) {
      const rec = raw.replace(/^\n/, "");
      if (!rec) continue;
      const parts = rec.split(FS);
      if (parts.length < 7) continue;
      const [sha, parentsStr, author, email, tsStr, subject, refsStr] = parts;
      commits.push({
        sha,
        parents: parentsStr ? parentsStr.split(" ").filter(Boolean) : [],
        author,
        email,
        ts: Number.parseInt(tsStr, 10) || 0,
        subject,
        refs: parseDecorations(refsStr),
      });
    }

    const hasMore = commits.length > limit;
    return { commits: commits.slice(0, limit), head, hasMore, signature };
  }

  /** Full metadata and changed-file list for a single commit. */
  async getCommitDetails(workspaceId: string, sha: string): Promise<CommitDetails> {
    const cwd = this.cwd(workspaceId);

    // Body (%b) is last so it can safely contain newlines and separators.
    const fmt = ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%s", "%b"].join(FS);
    const raw = await execGit(["show", "-s", `--format=${fmt}`, sha], cwd);
    const parts = raw.split(FS);
    const [shaOut, parentsStr, author, email, authorTsStr, committer, committerTsStr, subject] =
      parts;
    const body = parts.slice(8).join(FS).replace(/\n$/, "");

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
      files: await this.commitFiles(cwd, sha),
    };
  }

  /**
   * `--first-parent` diffs a merge against its mainline parent, the side
   * the graph draws it on. For a root commit `git show` lists every file as
   * added. `-M` reports renames as one entry instead of a delete + add.
   */
  private async commitFiles(cwd: string, sha: string): Promise<CommitFileChange[]> {
    const out = await execGit(
      ["show", "--first-parent", "-M", "--name-status", "-z", "--format=", sha],
      cwd,
    );
    return parseNameStatus(out);
  }

  /**
   * Unified diff of one file within a commit, against its first parent.
   * A renamed file is diffed against its old path, so the diff shows the
   * edit rather than a whole-file add.
   */
  async getCommitFileDiff(
    workspaceId: string,
    sha: string,
    filePath: string,
    options: { contextLines?: number } = {},
  ): Promise<{ diff: string }> {
    const cwd = this.cwd(workspaceId);
    assertWorktreeRelative(cwd, filePath);
    const oldPath = (await this.commitFiles(cwd, sha)).find((f) => f.path === filePath)?.oldPath;
    const args = ["show", "--first-parent", "-M", "--format="];
    if (options.contextLines !== undefined) args.push(`-U${options.contextLines}`);
    // `--` pins the paths as pathspecs, never flags.
    args.push(sha, "--", ...(oldPath ? [oldPath, filePath] : [filePath]));
    const diff = await execGit(args, cwd);
    return { diff };
  }
}

export const gitGraphService = new GitGraphService();
