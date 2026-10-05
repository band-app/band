/**
 * Reads and writes files in a context's bare repo without a working tree (plan
 * step 5.4). Search runs `git grep` against the default branch, so it sees a
 * push the moment it lands and needs no index. A write builds a commit from a
 * temporary index and moves the branch with a compare-and-swap, so a worker's
 * push that lands first makes the write retry instead of being overwritten.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextGitEnv, contextRepoPath, contextService, git, runGit } from "./context-service";

const MAX_TERMS = 8;
const MAX_FILES_SCANNED = 5000;
const SNIPPETS_PER_FILE = 3;
const SNIPPET_CHARS = 200;
const WRITE_ATTEMPTS = 5;

export interface SearchHit {
  path: string;
  /** Whether the file name matches every term. */
  nameMatch: boolean;
  /** Lines of the file that match any term. */
  matches: number;
  snippets: Array<{ line: number; text: string }>;
}

export interface FileEdit {
  path: string;
  /** Appended to the file, which is created with `initial` first when it does not exist. */
  append: string;
  initial?: string;
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
}

/** The commit `HEAD` points at, or undefined for a repo with no commits. */
async function headCommit(repo: string): Promise<string | undefined> {
  const r = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repo });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Files whose name or text matches every term, filename matches first, then by match count. */
export async function searchContext(name: string, query: string, limit = 10): Promise<SearchHit[]> {
  const words = terms(query);
  if (words.length === 0) return [];
  const repo = contextRepoPath(name);
  if (!(await headCommit(repo))) return [];

  const hits = new Map<string, SearchHit>();
  const hit = (path: string): SearchHit => {
    let h = hits.get(path);
    if (!h) {
      h = { path, nameMatch: false, matches: 0, snippets: [] };
      hits.set(path, h);
    }
    return h;
  };

  const listing = await git(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo });
  for (const path of listing.split("\n").slice(0, MAX_FILES_SCANNED)) {
    if (!path || path.endsWith(".gitkeep")) continue;
    const lower = path.toLowerCase();
    if (words.every((w) => lower.includes(w))) hit(path).nameMatch = true;
  }

  // `--all-match` with several patterns keeps files that contain every term.
  const args = ["grep", "-I", "-i", "-F", "-n", "--all-match", "--no-color", "--max-count=200"];
  for (const w of words) args.push("-e", w);
  args.push("HEAD", "--");
  const grep = await runGit(args, { cwd: repo });
  if (grep.code === 0) {
    for (const row of grep.stdout.split("\n")) {
      const m = /^HEAD:(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      const [, path, line, text] = m;
      if (path.endsWith(".gitkeep")) continue;
      const h = hit(path);
      h.matches += 1;
      if (h.snippets.length < SNIPPETS_PER_FILE) {
        h.snippets.push({ line: Number(line), text: text.trim().slice(0, SNIPPET_CHARS) });
      }
    }
  }

  return [...hits.values()]
    .sort(
      (a, b) =>
        Number(b.nameMatch) - Number(a.nameMatch) ||
        b.matches - a.matches ||
        a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

/** Appends to files in one commit on the default branch, then schedules a mirror to the remote. */
export async function commitAppends(
  name: string,
  edits: FileEdit[],
  message: string,
): Promise<string> {
  const repo = contextRepoPath(name);
  const sha = await contextService.withLock(name, async () => {
    let lastError = "";
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const dir = mkdtempSync(join(tmpdir(), "band-context-"));
      try {
        const headRef = (await git(["symbolic-ref", "-q", "HEAD"], { cwd: repo })).trim();
        const parent = await headCommit(repo);
        const env = contextGitEnv({ GIT_INDEX_FILE: join(dir, "index") });
        if (parent) await git(["read-tree", parent], { cwd: repo, env });
        for (const edit of edits) {
          let current = "";
          if (parent) {
            const r = await runGit(["cat-file", "blob", `${parent}:${edit.path}`], { cwd: repo });
            if (r.code === 0) current = r.stdout;
          }
          const body = (current === "" ? (edit.initial ?? "") : current) + edit.append;
          const blob = (
            await git(["hash-object", "-w", "--stdin"], { cwd: repo, env, input: body })
          ).trim();
          await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${edit.path}`], {
            cwd: repo,
            env,
          });
        }
        const tree = (await git(["write-tree"], { cwd: repo, env })).trim();
        const commitArgs = ["commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : [])];
        const commit = (await git(commitArgs, { cwd: repo, env })).trim();
        const update = await runGit(["update-ref", headRef, commit, parent ?? ""], { cwd: repo });
        if (update.code === 0) return commit;
        lastError = update.stderr.trim();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw new Error(`The context moved while writing: ${lastError.slice(0, 200)}`);
  });
  contextService.syncSoon(name);
  return sha;
}
