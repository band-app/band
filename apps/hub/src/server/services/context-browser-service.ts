/**
 * Reads and edits the files of a context repo for the context browser (plan
 * step 5.5). The hub holds each context as a bare repo and never checks a
 * working tree out, so reads use `ls-tree`, `cat-file`, `log` and `show`, and
 * a write builds its commit in a temporary index, then moves the branch with a
 * compare-and-swap `update-ref`. The result is the same as an agent's commit
 * and push, and the linked remote mirrors it through `syncSoon`.
 *
 * A conflict file is a copy named `<base>.conflict-<tag><ext>` next to the file
 * it conflicts with (`notes.conflict-ab12.md` for `notes.md`). Resolving keeps
 * one version at the original path and deletes the copy, in one commit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextInputError } from "../errors";
import { scanForSecrets } from "./_utils/context-redaction";
import { contextGitEnv, contextRepoPath, contextService, git, runGit } from "./context-service";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;
const MAX_MESSAGE = 200;
const LOG_LIMIT = 200;
const CONFLICT = /^(.*?)\.conflict-([A-Za-z0-9]+)((?:\.[^/.]+)?)$/;

export interface TreeEntry {
  path: string;
  size: number;
  /** The path this file is a conflict copy of, when it is one. */
  conflictOf: string | null;
}

export interface CommitInfo {
  sha: string;
  author: string;
  at: number;
  subject: string;
}

export interface RecentEntry {
  path: string;
  kind: "learnings" | "handoffs";
  sha: string;
  at: number;
  subject: string;
}

export type FileContent =
  | { path: string; binary: false; content: string; size: number; commit: string }
  | { path: string; binary: true; content: null; size: number; commit: string };

export class ContextConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextConflictError";
  }
}

/** The original path a conflict copy belongs to, or null when `path` is not a conflict copy. */
export function conflictOriginal(path: string): string | null {
  const m = CONFLICT.exec(path);
  return m ? `${m[1]}${m[3]}` : null;
}

/** True when `text` holds a control character. A message may keep its line breaks and tabs. */
function hasControl(text: string, allowWhitespace = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (allowWhitespace && (c === 9 || c === 10 || c === 13)) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function checkPath(path: string): string {
  const bad =
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.startsWith(":") ||
    hasControl(path) ||
    path.includes("\\") ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git");
  if (bad) throw new ContextInputError(`"${path}" is not a valid path inside a context`);
  return path;
}

function checkMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) throw new ContextInputError("A commit message is required");
  if (hasControl(trimmed, true)) {
    throw new ContextInputError("The commit message holds control characters");
  }
  if (scanForSecrets(trimmed).length > 0) {
    throw new ContextInputError("Not saved: the commit message looks like it holds a credential.");
  }
  if (trimmed.length > MAX_MESSAGE) {
    throw new ContextInputError(`The commit message is longer than ${MAX_MESSAGE} characters`);
  }
  return trimmed;
}

interface Change {
  path: string;
  /** New content, or null to delete the file. */
  content?: string;
  /** An existing blob to put at `path`. */
  blob?: string;
}

export class ContextBrowserService {
  private repo(name: string): string {
    contextService.require(name);
    return contextRepoPath(name);
  }

  /** The commit HEAD points at, or null in a repo with no commits. */
  private async head(repo: string): Promise<string | null> {
    const r = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repo });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async tree(name: string): Promise<{ head: string | null; entries: TreeEntry[] }> {
    const repo = this.repo(name);
    const head = await this.head(repo);
    if (!head) return { head, entries: [] };
    const out = await git(["ls-tree", "-r", "-z", "--long", head], { cwd: repo });
    const entries: TreeEntry[] = [];
    for (const rec of out.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const meta = rec.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") continue;
      const path = rec.slice(tab + 1);
      entries.push({ path, size: Number(meta[3]) || 0, conflictOf: conflictOriginal(path) });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { head, entries };
  }

  async file(name: string, path: string): Promise<FileContent> {
    const repo = this.repo(name);
    checkPath(path);
    const head = await this.head(repo);
    if (!head) throw new ContextInputError(`"${path}" does not exist`);
    const size = await runGit(["cat-file", "-s", `${head}:${path}`], { cwd: repo });
    if (size.code !== 0) throw new ContextInputError(`"${path}" does not exist`);
    const bytes = Number(size.stdout.trim());
    const type = await git(["cat-file", "-t", `${head}:${path}`], { cwd: repo });
    if (type.trim() !== "blob") throw new ContextInputError(`"${path}" is a folder`);
    if (bytes > MAX_FILE_BYTES) {
      return { path, binary: true, content: null, size: bytes, commit: head };
    }
    const content = await git(["cat-file", "blob", `${head}:${path}`], { cwd: repo });
    if (content.includes("\0") || content.includes("�")) {
      return { path, binary: true, content: null, size: bytes, commit: head };
    }
    return { path, binary: false, content, size: bytes, commit: head };
  }

  async log(name: string, path?: string, limit = 50): Promise<CommitInfo[]> {
    const repo = this.repo(name);
    if (path) checkPath(path);
    if (!(await this.head(repo))) return [];
    const args = [
      "--literal-pathspecs",
      "log",
      "--no-color",
      `-n${Math.min(Math.max(limit, 1), LOG_LIMIT)}`,
      "--format=%H%x1f%an%x1f%at%x1f%s%x1e",
    ];
    if (path) args.push("--", path);
    const out = await git(args, { cwd: repo });
    return out
      .split("\x1e")
      .map((rec) => rec.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha = "", author = "", at = "0", subject = ""] = rec.split("\x1f");
        return { sha, author, at: Number(at) * 1000, subject };
      });
  }

  async diff(
    name: string,
    sha: string,
    path?: string,
  ): Promise<{ diff: string; truncated: boolean; files: Array<{ status: string; path: string }> }> {
    const repo = this.repo(name);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ContextInputError("Not a commit id");
    if (path) checkPath(path);
    const exists = await runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: repo });
    if (exists.code !== 0) throw new ContextInputError("No such commit");
    const scope = path ? ["--", path] : [];
    const patch = await git(
      [
        "--literal-pathspecs",
        "show",
        "--root",
        "--format=",
        "--patch",
        "--no-color",
        "-M",
        "--no-ext-diff",
        sha,
        ...scope,
      ],
      { cwd: repo },
    );
    const names = await git(
      [
        "diff-tree",
        "--root",
        "-m",
        "--first-parent",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-M",
        sha,
      ],
      { cwd: repo },
    );
    const files = names
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return { status: parts[0] ?? "M", path: parts[parts.length - 1] ?? "" };
      });
    const patchBytes = Buffer.from(patch);
    const truncated = patchBytes.length > MAX_DIFF_BYTES;
    return {
      diff: truncated ? patchBytes.subarray(0, MAX_DIFF_BYTES).toString("utf8") : patch,
      truncated,
      files,
    };
  }

  /** The newest learnings and handoffs files, one row per file, newest commit first. */
  async recent(name: string, limit = 20): Promise<RecentEntry[]> {
    const repo = this.repo(name);
    if (!(await this.head(repo))) return [];
    const out = await git(
      [
        "log",
        "--no-color",
        "-n300",
        "--name-only",
        "--format=%x1e%H%x1f%at%x1f%s",
        "--",
        "learnings",
        "handoffs",
      ],
      { cwd: repo },
    );
    const seen = new Set<string>();
    const rows: RecentEntry[] = [];
    for (const block of out.split("\x1e")) {
      const [header = "", ...files] = block.split("\n").filter((l, i) => i === 0 || l.trim());
      const [sha = "", at = "0", subject = ""] = header.split("\x1f");
      if (!sha) continue;
      for (const path of files) {
        const kind = path.startsWith("learnings/")
          ? "learnings"
          : path.startsWith("handoffs/")
            ? "handoffs"
            : null;
        if (!kind || path.endsWith(".gitkeep") || seen.has(path)) continue;
        seen.add(path);
        rows.push({ path, kind, sha, at: Number(at) * 1000, subject });
      }
    }
    // A file deleted since is not in the feed.
    const { entries } = await this.tree(name);
    const live = new Set(entries.map((e) => e.path));
    return rows.filter((r) => live.has(r.path)).slice(0, limit);
  }

  /**
   * Saves `content` at `path` as one commit. `base` is the commit the editor
   * loaded: when the file changed since, the save is refused so an edit never
   * overwrites a newer version unseen.
   */
  async write(
    name: string,
    path: string,
    content: string,
    message: string,
    base?: string,
  ): Promise<{ commit: string; changed: boolean }> {
    checkPath(path);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new ContextInputError("The file is larger than 1 MiB");
    }
    const found = scanForSecrets(content);
    if (found.length > 0) {
      const list = found.map((f) => `${f.kind} on line ${f.line}`).join(", ");
      throw new ContextInputError(
        `Not saved: the text looks like it holds a credential (${list}). Remove it first.`,
      );
    }
    return this.commit(name, [{ path, content }], checkMessage(message), { base, guard: path });
  }

  /** Keeps one version of a conflicted file at its original path and deletes the conflict copy. */
  async resolveConflict(
    name: string,
    conflictPath: string,
    keep: "original" | "conflict",
    message?: string,
  ): Promise<{ commit: string; path: string }> {
    checkPath(conflictPath);
    const original = conflictOriginal(conflictPath);
    if (!original) throw new ContextInputError(`"${conflictPath}" is not a conflict copy`);
    const msg = checkMessage(
      message ??
        `Resolve conflict in ${original}: keep ${keep === "conflict" ? "the conflict copy" : "the original"}`,
    );
    const repo = this.repo(name);
    const result = await contextService.exclusive(name, async () => {
      const head = await this.head(repo);
      if (!head) throw new ContextInputError(`"${conflictPath}" does not exist`);
      const blob = await runGit(["rev-parse", "--verify", "-q", `${head}:${conflictPath}`], {
        cwd: repo,
      });
      if (blob.code !== 0) throw new ContextInputError(`"${conflictPath}" does not exist`);
      if (keep === "original") {
        const orig = await runGit(["rev-parse", "--verify", "-q", `${head}:${original}`], {
          cwd: repo,
        });
        if (orig.code !== 0) {
          throw new ContextInputError(
            `"${original}" does not exist, so "${conflictPath}" is not a conflict copy of anything`,
          );
        }
      }
      const changes: Change[] = [{ path: conflictPath }];
      if (keep === "conflict") changes.push({ path: original, blob: blob.stdout.trim() });
      return this.commitLocked(repo, name, head, changes, msg);
    });
    return { commit: result.commit, path: original };
  }

  private commit(
    name: string,
    changes: Change[],
    message: string,
    opts: { base?: string; guard?: string } = {},
  ): Promise<{ commit: string; changed: boolean }> {
    const repo = this.repo(name);
    return contextService.exclusive(name, async () => {
      const head = await this.head(repo);
      if (head && opts.base && opts.guard && head !== opts.base) {
        const at = async (rev: string) => {
          const r = await runGit(["rev-parse", "--verify", "-q", `${rev}:${opts.guard}`], {
            cwd: repo,
          });
          return r.code === 0 ? r.stdout.trim() : "";
        };
        if ((await at(head)) !== (await at(opts.base))) {
          throw new ContextConflictError(
            `"${opts.guard}" changed since you opened it. Reload it to see the newer version.`,
          );
        }
      }
      return this.commitLocked(repo, name, head, changes, message);
    });
  }

  /** Builds the commit in a private index. The caller holds the context's lock. */
  private async commitLocked(
    repo: string,
    name: string,
    head: string | null,
    changes: Change[],
    message: string,
  ): Promise<{ commit: string; changed: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), "band-context-index-"));
    try {
      const env = contextGitEnv({ GIT_INDEX_FILE: join(dir, "index") });
      const opts = { cwd: repo, env };
      if (head) await git(["read-tree", head], opts);
      for (const change of changes) {
        if (change.content === undefined && change.blob === undefined) {
          // `--force-remove` needs a work tree, which a bare repo does not have.
          await git(["update-index", "--index-info"], {
            ...opts,
            input: `0 ${"0".repeat(40)}\t${change.path}\n`,
          });
          continue;
        }
        const oid =
          change.blob ??
          (await git(["hash-object", "-w", "--stdin"], { ...opts, input: change.content })).trim();
        const r = await runGit(
          ["update-index", "--add", "--cacheinfo", `100644,${oid},${change.path}`],
          opts,
        );
        if (r.code !== 0) {
          throw new ContextInputError(
            `Cannot save "${change.path}": ${r.stderr.trim().slice(0, 200)}`,
          );
        }
      }
      const tree = (await git(["write-tree"], opts)).trim();
      if (head) {
        const current = (await git(["rev-parse", `${head}^{tree}`], opts)).trim();
        if (current === tree) return { commit: head, changed: false };
      }
      const commit = (
        await git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], opts)
      ).trim();
      const ref = (await git(["symbolic-ref", "-q", "HEAD"], { cwd: repo })).trim();
      // A push can land between reading the head and moving the ref; the swap then fails.
      const moved = await runGit(["update-ref", "-m", "context browser", ref, commit, head ?? ""], {
        cwd: repo,
      });
      if (moved.code !== 0) {
        throw new ContextConflictError("The context changed while saving. Reload and try again.");
      }
      contextService.syncSoon(name);
      return { commit, changed: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export const contextBrowserService = new ContextBrowserService();
