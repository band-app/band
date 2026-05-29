/**
 * Workspace diff service — branch listing, `git diff` aggregation, single-
 * file diffs, and the revert-file flow. Lifted out of `api/workspace/router.ts`
 * (issue #535, follow-up 1) so the router contains validation + delegation
 * only.
 *
 * Every git shell-out goes through `infra/git/git-client.ts::execGit` —
 * the service layer never spawns git itself.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import { WorkspaceNotFoundError } from "../errors";
import { execGit } from "../infra/git/git-client";
import {
  workspaceService as defaultWorkspaceService,
  type WorkspaceService,
} from "./workspace-service";

const log = createLogger("diff-service");

/**
 * Args for `git hash-object -t tree /dev/null` — yields the canonical
 * empty-tree SHA at runtime, used as the fallback `mergeBase` when the
 * workspace has no commits yet (`HEAD` doesn't resolve). The hard-coded
 * `EMPTY_TREE_SHA` below is the same value, exposed as a constant for
 * call sites (plain-project short-circuit, return shapes) that need a
 * SHA string without paying for the subprocess.
 */
const EMPTY_TREE_ARGS = ["hash-object", "-t", "tree", "/dev/null"];

/**
 * The canonical SHA of git's empty *tree* object — built into git itself
 * (every git version exposes this hash whether or not any objects have
 * been created locally). We use it as the `mergeBase` sentinel for non-git
 * workspaces so the field always carries a real 40-char SHA shape, which a
 * downstream consumer that does string validation (length / hex check) on
 * `mergeBase` won't choke on.
 *
 * Note this is a tree, not a commit — `git diff` accepts either, but
 * callers that strictly expect a commit-ish (e.g. `git merge-base
 * <sha> HEAD`) will reject it. The DiffView guards against ever
 * passing this through for a plain project via its `isPlain` check;
 * other potential consumers should treat this as "empty diff,
 * intentionally" rather than a usable commit reference.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type DiffMode = "uncommitted" | "branch";

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface DiffContext {
  /** Resolved compare branch — defaults to project default. */
  compareBranch: string;
  /** Current branch name, or `defaultBranch` if HEAD is detached / unborn. */
  headBranch: string;
  /** Commit/tree to diff against. */
  mergeBase: string;
}

export interface ListBranchesResult {
  branches: string[];
  defaultBranch: string;
  headBranch: string;
}

export interface DiffResult {
  diff: string;
  stats: DiffStats;
  compareBranch: string;
  defaultBranch: string;
  headBranch: string;
  fileStatuses: Record<string, string>;
}

export interface DiffSummaryResult {
  stats: DiffStats;
  compareBranch: string;
  defaultBranch: string;
  headBranch: string;
  fileStatuses: Record<string, string>;
  mergeBase: string;
}

/**
 * Resolves the `(headBranch, mergeBase, compareBranch)` triple shared by
 * `getDiff`, `getDiffSummary`, and `revertFile`. Falls back to the empty
 * tree when the workspace has no commits yet (so brand-new repos don't 500).
 */
async function resolveDiffContext(
  cwd: string,
  defaultBranch: string,
  diffMode: DiffMode,
  compareBranchInput: string | undefined,
): Promise<DiffContext> {
  const compareBranch =
    diffMode === "uncommitted" ? defaultBranch : (compareBranchInput ?? defaultBranch);

  let headBranch: string;
  try {
    headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
  } catch {
    headBranch = defaultBranch;
  }

  let mergeBase: string;
  if (diffMode === "uncommitted") {
    try {
      mergeBase = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  } else {
    try {
      mergeBase = (await execGit(["merge-base", compareBranch, "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  }

  return { compareBranch, headBranch, mergeBase };
}

/** Parses the trailing summary line of `git diff --stat`. */
function parseDiffStatSummary(statOutput: string): DiffStats {
  const statLines = statOutput.trim().split("\n");
  const summaryLine = statLines[statLines.length - 1] || "";

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
  };
}

/** Builds the `path -> status code` map from `git diff --name-status`. */
function parseFileStatuses(nameStatusOutput: string): Record<string, string> {
  const fileStatuses: Record<string, string> = {};
  for (const line of nameStatusOutput.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const statusCode = parts[0][0];
    if (statusCode === "R" && parts[2]) {
      fileStatuses[parts[2]] = "R";
    } else if (parts[1]) {
      fileStatuses[parts[1]] = statusCode;
    }
  }
  return fileStatuses;
}

/**
 * Resolve a workspace-relative file path against a worktree root and
 * reject anything that escapes the root or targets `.git` internals.
 *
 * Today the only producers of `filePath` are `git diff --name-status` /
 * `git ls-files --others`, which git guarantees to be repo-internal —
 * but this service exposes a public API surface (`getFileDiff`,
 * `revertFile`) that takes a caller-supplied string, so we enforce the
 * same `FilesService.resolveInside` guard at the entry points rather
 * than trusting the caller. Throws `Error("Invalid path")` consistent
 * with the existing files-service contract — the router maps it to a
 * 500 for the same wire shape as the rest of this router.
 */
function assertWorktreeRelative(cwd: string, filePath: string): string {
  const target = resolve(join(cwd, filePath));
  // Demand a separator after the root prefix so a sibling directory
  // with the same prefix can't sneak through.
  if (target !== cwd && !target.startsWith(cwd + sep)) {
    throw new Error("Invalid path");
  }
  const relative = target === cwd ? "" : target.slice(cwd.length + 1);
  if (relative === ".git" || relative.startsWith(`.git${sep}`) || relative.startsWith(".git/")) {
    throw new Error("Refusing to touch .git internals");
  }
  return target;
}

/** Reads an untracked file as the lines that would appear in a synthesized diff. */
async function readUntrackedFileLines(cwd: string, file: string): Promise<string[] | null> {
  try {
    const content = await readFile(join(cwd, file), "utf-8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  } catch {
    // Skip binary or unreadable files
    return null;
  }
}

export class DiffService {
  constructor(private readonly workspaces: WorkspaceService = defaultWorkspaceService) {}

  /**
   * List local branches in this workspace, with the project's default
   * branch pinned to the front (when it isn't the current branch) and the
   * current branch dropped — you don't compare against yourself.
   */
  async listBranches(workspaceId: string): Promise<ListBranchesResult> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    const defaultBranch = workspace.project.defaultBranch;

    let headBranch: string | null = null;
    try {
      headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    } catch {
      // No commits yet — leave headBranch null
    }

    let branches: string[] = [];
    try {
      const output = await execGit(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        cwd,
      );
      branches = output
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
    } catch (err) {
      log.error(
        `listBranches: for-each-ref failed for ${cwd}: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Drop the current branch (you don't compare against yourself) and pin
    // the default branch to the front. When you're on the default branch,
    // skip the re-add — comparing main↔main is a no-op and confusing.
    const filtered = branches.filter((b) => b !== headBranch);
    if (defaultBranch !== headBranch) {
      const idx = filtered.indexOf(defaultBranch);
      if (idx >= 0) {
        filtered.splice(idx, 1);
      }
      filtered.unshift(defaultBranch);
    }

    return {
      branches: filtered,
      defaultBranch,
      headBranch: headBranch ?? defaultBranch,
    };
  }

  /**
   * Compute the full text diff + summary stats + per-file status map for
   * the workspace, optionally against a non-default compare branch.
   * Synthesises diff entries for untracked files so the UI sees them next
   * to tracked changes.
   */
  async getDiff(
    workspaceId: string,
    options: {
      contextLines?: number;
      diffMode?: DiffMode;
      compareBranch?: string;
    },
  ): Promise<DiffResult> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    const defaultBranch = workspace.project.defaultBranch;
    const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
      cwd,
      defaultBranch,
      options.diffMode ?? "branch",
      options.compareBranch,
    );

    const diffArgs = ["diff"];
    if (options.contextLines !== undefined) {
      diffArgs.push(`-U${options.contextLines}`);
    }
    diffArgs.push(mergeBase);
    let diff = await execGit(diffArgs, cwd);

    const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
    const stats = parseDiffStatSummary(statOutput);

    const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
    const fileStatuses = parseFileStatuses(nameStatusOutput);

    const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    for (const file of untrackedFiles) {
      const lines = await readUntrackedFileLines(cwd, file);
      if (lines === null) continue;
      diff += `diff --git a/${file} b/${file}\n`;
      diff += "new file mode 100644\n";
      diff += "--- /dev/null\n";
      diff += `+++ b/${file}\n`;
      diff += `@@ -0,0 +1,${lines.length} @@\n`;
      diff += lines.map((l) => `+${l}`).join("\n");
      diff += "\n";
      stats.filesChanged++;
      stats.insertions += lines.length;
      fileStatuses[file] = "U";
    }

    return {
      diff,
      stats,
      // `compareBranch` is the branch we diffed against (the user's pick, or
      // the project default). `defaultBranch` is the project default. They
      // diverge once a non-default branch is picked.
      compareBranch,
      defaultBranch,
      headBranch,
      fileStatuses,
    };
  }

  /**
   * Like `getDiff` but skips the heavy diff text — returns only the
   * stats + per-file status map + the resolved merge base.
   *
   * Short-circuits to an empty summary for plain (non-git) projects so the
   * UI can show a calm message rather than a raw git error — see #427.
   * Also short-circuits when the worktree's `.git` is missing on disk
   * regardless of the recorded kind: the kind field can lag reality (e.g.
   * a project added before the migration shipped, or a folder whose `.git`
   * was deleted from a terminal), in which case running git would surface
   * as a raw error in the Changes view. The next `projects.list` self-
   * heals kind, but until then we still want a graceful empty diff.
   */
  async getDiffSummary(
    workspaceId: string,
    options: {
      diffMode?: DiffMode;
      compareBranch?: string;
    },
  ): Promise<DiffSummaryResult> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const hasGit = existsSync(join(workspace.worktree.path, ".git"));
    if (workspace.project.kind === "plain" || !hasGit) {
      const defaultBranch = workspace.project.defaultBranch;
      return {
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        compareBranch: defaultBranch,
        defaultBranch,
        headBranch: defaultBranch,
        fileStatuses: {},
        mergeBase: EMPTY_TREE_SHA,
      };
    }

    const cwd = workspace.worktree.path;
    const defaultBranch = workspace.project.defaultBranch;
    const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
      cwd,
      defaultBranch,
      options.diffMode ?? "branch",
      options.compareBranch,
    );

    const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
    const stats = parseDiffStatSummary(statOutput);

    const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
    const fileStatuses = parseFileStatuses(nameStatusOutput);

    const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    for (const file of untrackedFiles) {
      const lines = await readUntrackedFileLines(cwd, file);
      if (lines === null) continue;
      stats.filesChanged++;
      stats.insertions += lines.length;
      fileStatuses[file] = "U";
    }

    return {
      stats,
      compareBranch,
      defaultBranch,
      headBranch,
      fileStatuses,
      mergeBase,
    };
  }

  /**
   * Compute the diff text for a single file (tracked or untracked).
   * The caller supplies the `mergeBase` previously returned by
   * `getDiffSummary` so the per-file view stays consistent with the
   * Changes summary.
   */
  async getFileDiff(
    workspaceId: string,
    options: { filePath: string; mergeBase: string; contextLines?: number },
  ): Promise<{ diff: string }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    // Enforce path-traversal + .git guard at the public entry — git's
    // own output is repo-internal by definition, but the caller hands
    // us this string and we don't trust it.
    const targetAbs = assertWorktreeRelative(cwd, options.filePath);

    // Check if file is untracked
    const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    if (untrackedFiles.includes(options.filePath)) {
      // Synthesize diff for untracked file
      try {
        const content = await readFile(targetAbs, "utf-8");
        const lines = content.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        let diff = `diff --git a/${options.filePath} b/${options.filePath}\n`;
        diff += "new file mode 100644\n";
        diff += "--- /dev/null\n";
        diff += `+++ b/${options.filePath}\n`;
        diff += `@@ -0,0 +1,${lines.length} @@\n`;
        diff += lines.map((l) => `+${l}`).join("\n");
        diff += "\n";
        return { diff };
      } catch {
        return { diff: "" };
      }
    }

    // Tracked file — get diff for this single file
    const fileDiffArgs = ["diff"];
    if (options.contextLines !== undefined) {
      fileDiffArgs.push(`-U${options.contextLines}`);
    }
    fileDiffArgs.push(options.mergeBase, "--", options.filePath);
    const diff = await execGit(fileDiffArgs, cwd);
    return { diff };
  }

  /**
   * Revert a single file to its state at the merge base implied by
   * `(diffMode, compareBranch)`. Untracked files are deleted; added
   * (staged) files are dropped from the index *and* the working tree;
   * modified/deleted/renamed files are `git checkout`-ed.
   */
  async revertFile(
    workspaceId: string,
    options: {
      filePath: string;
      diffMode: DiffMode;
      compareBranch?: string;
    },
  ): Promise<{ ok: true }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    const { filePath, diffMode } = options;
    // Enforce path-traversal + .git guard. Critical here because
    // `revertFile` mutates the working tree (rm / checkout / git rm).
    const targetAbs = assertWorktreeRelative(cwd, filePath);

    // Determine the file status server-side
    const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    if (untrackedFiles.includes(filePath)) {
      // Untracked file — just delete it
      await rm(targetAbs, { force: true });
      return { ok: true };
    }

    // Reuse the shared resolver so the reference commit matches what
    // getDiff/getDiffSummary computed — otherwise revert can drift.
    const { mergeBase: ref } = await resolveDiffContext(
      cwd,
      workspace.project.defaultBranch,
      diffMode,
      options.compareBranch,
    );

    // Determine the tracked file status from the diff
    const nameStatusOutput = await execGit(["diff", "--name-status", ref, "--", filePath], cwd);
    const statusLine = nameStatusOutput.trim().split("\n").filter(Boolean)[0];
    const fileStatus = statusLine ? statusLine[0] : null;

    if (fileStatus === "A") {
      // Added (staged) file — remove from index and delete from working tree
      await execGit(["rm", "-f", "--", filePath], cwd);
    } else {
      // Modified, Deleted, or Renamed — restore to the reference commit
      await execGit(["checkout", ref, "--", filePath], cwd);
    }

    return { ok: true };
  }
}

export const diffService = new DiffService();
