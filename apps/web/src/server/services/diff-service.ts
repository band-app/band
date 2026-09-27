/**
 * Workspace diff service — branch listing, the Changes view's sections,
 * single-file diffs, and staging / discarding. Lifted out of `api/workspace/router.ts`
 * (issue #535, follow-up 1) so the router contains validation + delegation
 * only.
 *
 * Every git shell-out goes through `infra/git/git-client.ts::execGit` —
 * the service layer never spawns git itself.
 */

import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
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
 * workspace has no commits yet (`HEAD` doesn't resolve).
 */
const EMPTY_TREE_ARGS = ["hash-object", "-t", "tree", "/dev/null"];

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
  /** More branches matched than `limit` allowed through. */
  truncated: boolean;
}

/** Branches `listBranches` returns when the caller passes no `limit`. */
const DEFAULT_BRANCH_LIMIT = 50;

/**
 * Integration/staging branches ranked first in the diff-target picker, ahead
 * of the default branch: they're the branches a user most often diffs against
 * (#599). Matched case-insensitively on the name without its remote prefix;
 * array order is the rank.
 */
const STAGING_BRANCH_PRIORITY = [
  "develop",
  "dev",
  "development",
  "stage",
  "staging",
  "integration",
  "release",
  "qa",
  "uat",
];

interface BranchRef {
  /** Short name as git accepts it: `feature/x` or `origin/feature/x`. */
  name: string;
  /** `name` without the remote prefix; equal to `name` for local branches. */
  shortName: string;
  remote: boolean;
}

/** Parses a full refname from `for-each-ref`. Drops `refs/remotes/<r>/HEAD`,
 *  the symbolic pointer to the remote's default branch. */
function parseBranchRef(refname: string): BranchRef | null {
  if (refname.startsWith("refs/heads/")) {
    const name = refname.slice("refs/heads/".length);
    return name ? { name, shortName: name, remote: false } : null;
  }
  if (refname.startsWith("refs/remotes/")) {
    const name = refname.slice("refs/remotes/".length);
    const slash = name.indexOf("/");
    if (slash <= 0) return null;
    const shortName = name.slice(slash + 1);
    if (!shortName || shortName === "HEAD") return null;
    return { name, shortName, remote: true };
  }
  return null;
}

/**
 * Sort rank of `ref` for `query` (lower first), or `null` when it doesn't
 * match. Match quality decides first (exact, then prefix, then substring,
 * compared against both the full and the remote-less name). Within one
 * quality, staging-style branches come first, then the default branch and
 * its remote-tracking copies, then everything else.
 */
function rankBranch(ref: BranchRef, defaultBranch: string, query: string): number | null {
  const name = ref.name.toLowerCase();
  const shortName = ref.shortName.toLowerCase();
  let match = 0;
  if (query) {
    if (name === query || shortName === query) match = 0;
    else if (name.startsWith(query) || shortName.startsWith(query)) match = 1;
    else if (name.includes(query)) match = 2;
    else return null;
  }

  let pin = 100;
  const staging = STAGING_BRANCH_PRIORITY.indexOf(shortName);
  if (staging >= 0) pin = staging * 2 + (ref.remote ? 1 : 0);
  else if (ref.name === defaultBranch) pin = 50;
  else if (ref.remote && ref.shortName === defaultBranch) pin = 51;

  return match * 1000 + pin;
}

export interface DiffResult {
  diff: string;
  stats: DiffStats;
  compareBranch: string;
  defaultBranch: string;
  headBranch: string;
  fileStatuses: Record<string, string>;
}

/** A section of the Changes view — see `DiffService.getChanges`. */
export type ChangeSection = "conflicts" | "unstaged" | "staged" | "untracked" | "branch";

/** `A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied, `U`ntracked. */
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "U";

/** How the two sides of a merge conflict touched the file (`git status` XY). */
export type ConflictKind =
  | "both_modified"
  | "both_added"
  | "both_deleted"
  | "added_by_us"
  | "added_by_them"
  | "deleted_by_us"
  | "deleted_by_them";

export interface ChangeEntry {
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  status: ChangeStatus;
  /** Lines added / deleted; unset for binary files. */
  additions?: number;
  deletions?: number;
  /** Set on `conflicts` entries only. */
  conflict?: ConflictKind;
}

/**
 * Why the `branch` section is empty when it isn't `ready`: the compare
 * branch doesn't resolve (`invalid-base`), it shares no history with HEAD
 * (`no-merge-base`), or there are no commits yet (`unborn-head`).
 */
export type BranchCompareStatus = "ready" | "invalid-base" | "no-merge-base" | "unborn-head";

export interface ChangesResult {
  headBranch: string;
  defaultBranch: string;
  /** The branch the `branch` section compares against. */
  compareBranch: string;
  /** Where HEAD forked from `compareBranch`; null unless `branchStatus` is ready. */
  mergeBase: string | null;
  branchStatus: BranchCompareStatus;
  conflicts: ChangeEntry[];
  unstaged: ChangeEntry[];
  staged: ChangeEntry[];
  untracked: ChangeEntry[];
  branch: ChangeEntry[];
}

/**
 * Resolves the `(headBranch, mergeBase, compareBranch)` triple for
 * `getDiff`. Falls back to the empty
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
 * `stageFiles`, `discardChanges`, …) that takes a caller-supplied string, so we enforce the
 * same `FilesService.resolveInside` guard at the entry points rather
 * than trusting the caller. Throws `Error("Invalid path")` consistent
 * with the existing files-service contract — the router maps it to a
 * 500 for the same wire shape as the rest of this router.
 */
export function assertWorktreeRelative(cwd: string, filePath: string): string {
  const target = resolve(join(cwd, filePath));
  // Demand a separator after the root prefix so a sibling directory
  // with the same prefix can't sneak through.
  if (target !== cwd && !target.startsWith(cwd + sep)) {
    throw new Error("Invalid path");
  }
  // Reject `target === cwd` (the worktree root itself) — callers pass
  // single-file paths; `"."` would otherwise let `discardChanges` issue
  // `git restore -- .`, silently reverting the whole worktree.
  // This same check also covers `filePath === ""` (empty string)
  // because `resolve(join(cwd, ""))` is `cwd`.
  if (target === cwd) {
    throw new Error("Invalid path");
  }
  const relative = target.slice(cwd.length + 1);
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

const CONFLICT_KINDS: Record<string, ConflictKind> = {
  UU: "both_modified",
  AA: "both_added",
  DD: "both_deleted",
  AU: "added_by_us",
  UA: "added_by_them",
  DU: "deleted_by_us",
  UD: "deleted_by_them",
};

/** Maps a `git status` / `git diff --name-status` letter to a ChangeStatus.
 *  Type changes (`T`) and anything unexpected read as modified. */
function toChangeStatus(code: string): ChangeStatus {
  switch (code) {
    case "A":
    case "D":
    case "R":
    case "C":
      return code;
    default:
      return "M";
  }
}

/** Splits the first `count` space-separated fields off `record`; the rest
 *  (a path, which may itself contain spaces) is the last element. */
function splitFields(record: string, count: number): string[] {
  const fields: string[] = [];
  let rest = record;
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(" ");
    if (space < 0) break;
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  fields.push(rest);
  return fields;
}

/**
 * Parses `git status --porcelain=v2 -z` into the uncommitted sections.
 * An ordinary (`1`) or rename (`2`) record lands in `staged` when its X
 * column is set and in `unstaged` when its Y column is set.
 */
function parseStatusV2(output: string): {
  conflicts: ChangeEntry[];
  unstaged: ChangeEntry[];
  staged: ChangeEntry[];
  untracked: ChangeEntry[];
} {
  const result = {
    conflicts: [] as ChangeEntry[],
    unstaged: [] as ChangeEntry[],
    staged: [] as ChangeEntry[],
    untracked: [] as ChangeEntry[],
  };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const type = record[0];
    if (type === "?") {
      result.untracked.push({ path: record.slice(2), status: "U" });
    } else if (type === "1" || type === "2") {
      // `1 XY sub mH mI mW hH hI path`; `2` adds a score field and is
      // followed by the original path as its own record.
      const fields = splitFields(record, type === "1" ? 8 : 9);
      const xy = fields[1];
      const path = fields[fields.length - 1];
      const oldPath = type === "2" ? records[++i] : undefined;
      if (xy[0] !== ".") {
        result.staged.push({ path, status: toChangeStatus(xy[0]), ...(oldPath && { oldPath }) });
      }
      if (xy[1] !== ".") {
        result.unstaged.push({ path, status: toChangeStatus(xy[1]) });
      }
    } else if (type === "u") {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
      const fields = splitFields(record, 10);
      const path = fields[fields.length - 1];
      result.conflicts.push({
        path,
        status: "M",
        conflict: CONFLICT_KINDS[fields[1]] ?? "both_modified",
      });
    }
  }
  return result;
}

/**
 * Parses `git diff --numstat -z` into `path -> counts`. A rename's record
 * is `added\tdeleted\t` followed by the old and new paths as their own
 * records; a binary file reports `-` for both counts.
 */
function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number }> {
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (path === "") {
      i++; // old path
      path = records[++i] ?? "";
    }
    counts.set(path, {
      additions: added === "-" ? undefined : Number(added),
      deletions: deleted === "-" ? undefined : Number(deleted),
    });
  }
  return counts;
}

/** Parses `git diff --name-status -z` (with `-M`) into entries. */
function parseNameStatus(output: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const code = records[i];
    if (!code) continue;
    const status = toChangeStatus(code[0]);
    if (status === "R" || status === "C") {
      const oldPath = records[++i];
      const path = records[++i];
      if (path) entries.push({ path, oldPath, status });
    } else {
      const path = records[++i];
      if (path) entries.push({ path, status });
    }
  }
  return entries;
}

function applyLineCounts(
  entries: ChangeEntry[],
  counts: Map<string, { additions?: number; deletions?: number }>,
): void {
  for (const entry of entries) {
    const c = counts.get(entry.path);
    if (!c) continue;
    entry.additions = c.additions;
    entry.deletions = c.deletions;
  }
}

function sortEntries(entries: ChangeEntry[]): ChangeEntry[] {
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Untracked files larger than this show no line count (reading them on
 *  every poll would be wasteful). */
const MAX_COUNTED_FILE_BYTES = 1024 * 1024;

/** Line count of an untracked file, or null for a binary, large or
 *  unreadable one. */
async function countUntrackedLines(absPath: string): Promise<number | null> {
  try {
    const info = await stat(absPath);
    if (!info.isFile() || info.size > MAX_COUNTED_FILE_BYTES) return null;
    const content = await readFile(absPath);
    if (content.includes(0)) return null;
    if (content.length === 0) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 10) lines++;
    // A last line without a trailing newline still counts.
    return content[content.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return null;
  }
}

/**
 * The `branch` section: files changed by the commits on HEAD since it forked
 * from `compareBranch`. Diffs two commits, so staged, unstaged and untracked
 * work never shows up here.
 */
async function compareWithBase(
  cwd: string,
  compareBranch: string,
): Promise<{ status: BranchCompareStatus; mergeBase: string | null; entries: ChangeEntry[] }> {
  const verify = (ref: string) =>
    execGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd)
      .then((out) => out.trim())
      .catch(() => null);
  const [headOid, baseOid] = await Promise.all([verify("HEAD"), verify(compareBranch)]);
  if (!headOid) return { status: "unborn-head", mergeBase: null, entries: [] };
  if (!baseOid) return { status: "invalid-base", mergeBase: null, entries: [] };

  let mergeBase: string;
  try {
    mergeBase = (await execGit(["merge-base", baseOid, headOid], cwd)).trim();
  } catch {
    return { status: "no-merge-base", mergeBase: null, entries: [] };
  }

  const [nameStatus, numstat] = await Promise.all([
    execGit(["diff", "--name-status", "-z", "-M", mergeBase, headOid], cwd),
    execGit(["diff", "--numstat", "-z", "-M", mergeBase, headOid], cwd),
  ]);
  const entries = parseNameStatus(nameStatus);
  applyLineCounts(entries, parseNumstat(numstat));
  return { status: "ready", mergeBase, entries };
}

/** A `git diff`-style hunk that adds every line of a new file. */
function synthesizeAddedFileDiff(filePath: string, lines: string[]): string {
  let diff = `diff --git a/${filePath} b/${filePath}\n`;
  diff += "new file mode 100644\n";
  diff += "--- /dev/null\n";
  diff += `+++ b/${filePath}\n`;
  diff += `@@ -0,0 +1,${lines.length} @@\n`;
  diff += lines.map((l) => `+${l}`).join("\n");
  diff += "\n";
  return diff;
}

/**
 * Paths per git invocation for the stage / unstage / discard mutations, so a
 * "Stage all" on a section of thousands of files stays under the OS argv
 * limit.
 */
const PATHS_PER_GIT_CALL = 500;

/**
 * Runs `git <args> -- <paths>` in batches. `--literal-pathspecs` makes git
 * take each path as a file name, not a glob or magic pathspec: without it,
 * `*` or `:/` would widen a single-file discard to the whole worktree, and a
 * file named `app/[slug]/page.tsx` would also match `app/s/page.tsx`.
 */
async function execGitOnPaths(args: string[], paths: string[], cwd: string): Promise<void> {
  for (let i = 0; i < paths.length; i += PATHS_PER_GIT_CALL) {
    await execGit(
      ["--literal-pathspecs", ...args, "--", ...paths.slice(i, i + PATHS_PER_GIT_CALL)],
      cwd,
    );
  }
}

/** Whether the repo has a commit checked out (false before the first one). */
async function hasHead(cwd: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

export class DiffService {
  constructor(private readonly workspaces: WorkspaceService = defaultWorkspaceService) {}

  /**
   * Search the workspace's local and remote-tracking branches for the
   * Changes view's diff-target picker. Repos can have thousands of
   * branches, so the filter runs here and only the top `limit` matches
   * travel to the client.
   *
   * The current branch is dropped (you don't compare against yourself), and
   * so is the default branch while it is checked out. `rankBranch` orders
   * the matches; ties keep git's order, most recent commit first.
   */
  async listBranches(
    workspaceId: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<ListBranchesResult> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    const defaultBranch = workspace.project.defaultBranch;
    const limit = options.limit ?? DEFAULT_BRANCH_LIMIT;
    const query = options.query?.trim().toLowerCase() ?? "";

    let headBranch: string | null = null;
    try {
      headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    } catch {
      // No commits yet — leave headBranch null
    }

    let refs: BranchRef[] = [];
    try {
      const output = await execGit(
        [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname)",
          "refs/heads/",
          "refs/remotes/",
        ],
        cwd,
      );
      refs = output
        .split("\n")
        .map((line) => parseBranchRef(line.trim()))
        .filter((ref): ref is BranchRef => ref !== null);
    } catch (err) {
      log.error(
        `listBranches: for-each-ref failed for ${cwd}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const ranked: Array<{ name: string; rank: number; order: number }> = [];
    refs.forEach((ref, order) => {
      if (ref.name === headBranch) return;
      // When you're on the default branch, comparing main↔main is a no-op
      // and confusing, so it isn't offered.
      if (ref.name === defaultBranch && defaultBranch === headBranch) return;
      const rank = rankBranch(ref, defaultBranch, query);
      if (rank !== null) ranked.push({ name: ref.name, rank, order });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);

    return {
      branches: ranked.slice(0, limit).map((b) => b.name),
      defaultBranch,
      headBranch: headBranch ?? defaultBranch,
      truncated: ranked.length > limit,
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

    // Run the four independent git invocations in parallel — none has a
    // data dependency on another. On a large worktree this roughly halves
    // the wall-clock time of the Changes view's initial paint.
    const [diffResult, statOutput, nameStatusOutput, untrackedOutput] = await Promise.all([
      execGit(diffArgs, cwd),
      execGit(["diff", "--stat", mergeBase], cwd),
      execGit(["diff", "--name-status", mergeBase], cwd),
      execGit(["ls-files", "--others", "--exclude-standard"], cwd),
    ]);
    let diff = diffResult;
    const stats = parseDiffStatSummary(statOutput);
    const fileStatuses = parseFileStatuses(nameStatusOutput);
    const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

    // Read every untracked file in parallel — same hot-path motivation
    // as the parallelised git calls above. Result-ordering preserved by
    // pairing back with the original `untrackedFiles` array.
    const untrackedLines = await Promise.all(
      untrackedFiles.map((file) => readUntrackedFileLines(cwd, file)),
    );

    for (let i = 0; i < untrackedFiles.length; i++) {
      const file = untrackedFiles[i];
      const lines = untrackedLines[i];
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
   * The Changes view's sections, as in orca's source control panel:
   *
   *   - `conflicts`: unmerged paths (`u` records of `git status`).
   *   - `unstaged`: working tree vs index (the Y column of `git status`).
   *   - `staged`: index vs HEAD (the X column). A file can be in both.
   *   - `untracked`: files git doesn't track and doesn't ignore.
   *   - `branch`: commits on HEAD since it forked from `compareBranch`
   *     (`git diff <merge-base> HEAD`), so it never includes uncommitted work.
   *
   * Line counts come from `--numstat` per section; untracked files count
   * their lines. Binary files carry no counts.
   *
   * Short-circuits to empty sections for plain (non-git) projects, and when
   * the worktree's `.git` is missing on disk regardless of the recorded
   * kind — the kind field can lag reality (see #427), and running git there
   * would surface as a raw error in the Changes view.
   */
  async getChanges(
    workspaceId: string,
    options: { compareBranch?: string } = {},
  ): Promise<ChangesResult> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const defaultBranch = workspace.project.defaultBranch;
    const compareBranch = options.compareBranch ?? defaultBranch;
    const cwd = workspace.worktree.path;
    const hasGit = existsSync(join(cwd, ".git"));
    if (workspace.project.kind === "plain" || !hasGit) {
      return {
        headBranch: defaultBranch,
        defaultBranch,
        compareBranch,
        mergeBase: null,
        branchStatus: "ready",
        conflicts: [],
        unstaged: [],
        staged: [],
        untracked: [],
        branch: [],
      };
    }

    // Every git call below is independent of the others except the branch
    // compare, which needs HEAD and the base resolved first. `--no-optional-
    // locks` on the calls that read the index keeps this poll from taking
    // `index.lock` (and failing a concurrent `git commit` in a terminal).
    const [statusOutput, unstagedNumstat, stagedNumstat, headBranch, branchCompare] =
      await Promise.all([
        execGit(
          ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
          cwd,
        ),
        execGit(["--no-optional-locks", "diff", "--numstat", "-z", "-M"], cwd),
        execGit(["--no-optional-locks", "diff", "--cached", "--numstat", "-z", "-M"], cwd).catch(
          () => "",
        ),
        execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
          .then((out) => out.trim())
          .catch(() => defaultBranch),
        compareWithBase(cwd, compareBranch),
      ]);

    const status = parseStatusV2(statusOutput);
    applyLineCounts(status.unstaged, parseNumstat(unstagedNumstat));
    applyLineCounts(status.staged, parseNumstat(stagedNumstat));
    await Promise.all(
      status.untracked.map(async (entry) => {
        const lines = await countUntrackedLines(join(cwd, entry.path));
        if (lines !== null) {
          entry.additions = lines;
          entry.deletions = 0;
        }
      }),
    );

    return {
      headBranch,
      defaultBranch,
      compareBranch,
      mergeBase: branchCompare.mergeBase,
      branchStatus: branchCompare.status,
      conflicts: sortEntries(status.conflicts),
      unstaged: sortEntries(status.unstaged),
      staged: sortEntries(status.staged),
      untracked: sortEntries(status.untracked),
      branch: sortEntries(branchCompare.entries),
    };
  }

  /**
   * The diff text for one file in one section of the Changes view:
   *
   *   - `unstaged`: index → working tree (`git diff -- <path>`).
   *   - `staged`: HEAD → index (`git diff --cached -- <path>`).
   *   - `untracked`: the whole file as added lines.
   *   - `conflicts`: HEAD → working tree, conflict markers included.
   *   - `branch`: merge base → HEAD. The caller passes the `mergeBase`
   *     `getChanges` returned, so the diff matches the list it came from.
   */
  async getFileDiff(
    workspaceId: string,
    options: {
      filePath: string;
      section: ChangeSection;
      mergeBase?: string;
      oldPath?: string;
      contextLines?: number;
    },
  ): Promise<{ diff: string }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    // Enforce path-traversal + .git guard at the public entry — git's
    // own output is repo-internal by definition, but the caller hands
    // us this string and we don't trust it.
    assertWorktreeRelative(cwd, options.filePath);
    if (options.oldPath) assertWorktreeRelative(cwd, options.oldPath);

    if (options.section === "untracked") {
      const lines = await readUntrackedFileLines(cwd, options.filePath);
      if (lines === null) return { diff: "" };
      return { diff: synthesizeAddedFileDiff(options.filePath, lines) };
    }

    // Literal pathspecs: the path is a file name, not a glob.
    const args = ["--literal-pathspecs", "diff"];
    if (options.contextLines !== undefined) args.push(`-U${options.contextLines}`);
    switch (options.section) {
      case "unstaged":
        break;
      case "staged":
        args.push("--cached", "-M");
        break;
      case "conflicts":
        args.push("HEAD");
        break;
      case "branch":
        if (!options.mergeBase) throw new Error("mergeBase is required for the branch section");
        args.push("-M", options.mergeBase, "HEAD");
        break;
    }
    // A rename only pairs up when both sides are in the pathspec.
    args.push("--", options.filePath);
    if (options.oldPath && options.oldPath !== options.filePath) args.push(options.oldPath);
    return { diff: await execGit(args, cwd) };
  }

  /** `git add` the paths — stage all of an unstaged/untracked/conflicted
   *  file's changes (for a conflict this marks it resolved). */
  async stageFiles(workspaceId: string, paths: string[]): Promise<{ ok: true }> {
    const cwd = this.worktreeFor(workspaceId, paths);
    await execGitOnPaths(["add", "-A"], paths, cwd);
    return { ok: true };
  }

  /** Move the paths' staged changes back to the working tree. */
  async unstageFiles(workspaceId: string, paths: string[]): Promise<{ ok: true }> {
    const cwd = this.worktreeFor(workspaceId, paths);
    if (await hasHead(cwd)) {
      await execGitOnPaths(["restore", "--staged"], paths, cwd);
    } else {
      // No commits yet: there is nothing to restore from, so drop the paths
      // from the index instead.
      await execGitOnPaths(["rm", "--cached", "-r", "-q"], paths, cwd);
    }
    return { ok: true };
  }

  /**
   * Throw away the paths' changes in one section:
   *
   *   - `unstaged`: restore the working tree from the index, keeping what's
   *     staged.
   *   - `staged`: restore index and working tree from HEAD (a file added in
   *     the index is deleted).
   *   - `untracked`: delete the files.
   */
  async discardChanges(
    workspaceId: string,
    options: { paths: string[]; section: "unstaged" | "staged" | "untracked" },
  ): Promise<{ ok: true }> {
    const { paths, section } = options;
    const cwd = this.worktreeFor(workspaceId, paths);
    switch (section) {
      case "unstaged":
        await execGitOnPaths(["restore", "--worktree"], paths, cwd);
        break;
      case "staged":
        if (await hasHead(cwd)) {
          await execGitOnPaths(["restore", "--staged", "--worktree", "--source=HEAD"], paths, cwd);
        } else {
          // No commits yet, so every staged file is new: drop it from the
          // index and delete it, as restoring from HEAD would.
          await execGitOnPaths(["rm", "--cached", "-r", "-q"], paths, cwd);
          await Promise.all(paths.map((p) => rm(assertWorktreeRelative(cwd, p), { force: true })));
        }
        break;
      case "untracked": {
        // Only delete a requested path that git itself reports as untracked,
        // so a stale client list can never remove a tracked file.
        const requested = new Set(paths);
        const untracked: string[] = [];
        for (let i = 0; i < paths.length; i += PATHS_PER_GIT_CALL) {
          const output = await execGit(
            [
              "--literal-pathspecs",
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
              "--",
              ...paths.slice(i, i + PATHS_PER_GIT_CALL),
            ],
            cwd,
          );
          untracked.push(...output.split("\0").filter((p) => requested.has(p)));
        }
        await Promise.all(
          untracked.map((p) => rm(assertWorktreeRelative(cwd, p), { force: true })),
        );
        break;
      }
    }
    return { ok: true };
  }

  /** Resolve the workspace's worktree and check every path stays inside it. */
  private worktreeFor(workspaceId: string, paths: string[]): string {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    const cwd = workspace.worktree.path;
    for (const p of paths) assertWorktreeRelative(cwd, p);
    return cwd;
  }
}

export const diffService = new DiffService();
