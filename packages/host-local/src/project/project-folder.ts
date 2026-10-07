/**
 * Project folders on a host (plan step T.1).
 *
 * `<bandHome>/projects/<project>` is the working copy of the project's context repo (the context
 * sync owns it). Under `repos/<repo>/` each project repo has a checkout of its default branch:
 * a git worktree of the repo's clone on the local branch `band/<project>/<default>`, which tracks
 * `origin/<default>` and has `push.default=upstream`, so `git pull` and `git push` work by hand.
 * A project's own branch avoids git's one-checkout-per-branch rule when the clone or another
 * project on the host has the default branch checked out.
 *
 * Freshness never costs local work: a checkout is fast-forwarded only when it is clean and has no
 * local commits, and is otherwise reported as behind or ahead with its dirty flag.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
  ProjectCheckout,
  ProjectCommit,
  ProjectEnsureRequest,
  ProjectEnsureResult,
  ProjectLogRequest,
  ProjectReadRequest,
  ProjectReadResult,
  ProjectRemoveRepoRequest,
  ProjectRepoSpec,
  ProjectSearchMatch,
  ProjectSearchRequest,
} from "@band-app/host-api";
import { brief, type ContextSync, type GitOut } from "../context/context-sync";

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DEFAULT_FETCH_THROTTLE_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 30_000;
const DEFAULT_READ_BYTES = 200_000;
const MAX_READ_BYTES = 1_000_000;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_LINE_CHARS = 300;
const MAX_LOG = 100;
const MAX_DIR_ENTRIES = 500;
const MAX_SEARCH_STDOUT_BYTES = 2_000_000;

/** `BAND_PROJECT_FETCH_THROTTLE_MS` overrides the one-minute spacing of fetches, read on every call. */
function fetchThrottleMs(): number {
  const raw = process.env.BAND_PROJECT_FETCH_THROTTLE_MS;
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FETCH_THROTTLE_MS;
}

/** Plain git against a repo of the user's: the worker's credential helper (GIT_CONFIG_*) stays. */
function repoGit(
  cwd: string,
  args: string[],
  timeoutMs = LOCAL_TIMEOUT_MS,
  /** Stops the command once it has written this many bytes, and keeps what it wrote (exit 0). */
  maxStdoutBytes = Number.POSITIVE_INFINITY,
): Promise<GitOut & { buffer: Buffer }> {
  return new Promise((done) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Band",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "band@band.local",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Band",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "band@band.local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let outBytes = 0;
    let capped = false;
    child.stdout.on("data", (c: Buffer) => {
      if (capped) return;
      out.push(c);
      outBytes += c.length;
      if (outBytes >= maxStdoutBytes) {
        capped = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ stdout: "", stderr: e.message, code: 127, buffer: Buffer.alloc(0) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(out);
      done({
        stdout: buffer.toString("utf8"),
        stderr: timedOut ? `timed out after ${timeoutMs} ms` : Buffer.concat(err).toString("utf8"),
        code: capped ? 0 : timedOut ? 124 : (code ?? 1),
        buffer,
      });
    });
  });
}

function checkProject(name: string): void {
  if (!PROJECT_NAME.test(name)) throw new Error(`Not a project name: ${name.slice(0, 80)}`);
}

function checkRepo(spec: { name: string; defaultBranch?: string }): void {
  if (!REPO_NAME.test(spec.name) || spec.name.includes("..")) {
    throw new Error(`Not a repo name: ${spec.name.slice(0, 80)}`);
  }
  if (spec.defaultBranch !== undefined && !BRANCH_NAME.test(spec.defaultBranch)) {
    throw new Error(`Not a branch name: ${spec.defaultBranch.slice(0, 80)}`);
  }
}

export const projectBranch = (project: string, defaultBranch: string): string =>
  `band/${project}/${defaultBranch}`;

export class ProjectFolder {
  private readonly lastFetch = new Map<string, number>();
  private readonly lastFetchError = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly bandHome: () => string,
    private readonly sync: ContextSync | null,
  ) {}

  folderOf(project: string): string {
    checkProject(project);
    return join(this.bandHome(), "projects", project);
  }

  private checkoutOf(project: string, repo: string): string {
    checkRepo({ name: repo });
    return join(this.folderOf(project), "repos", repo);
  }

  // ---- ensure ------------------------------------------------------------------

  async ensure(req: ProjectEnsureRequest): Promise<ProjectEnsureResult> {
    const folder = this.folderOf(req.project);
    return this.exclusive(req.project, async () => {
      if (!this.sync)
        throw new Error("This host has no context source, so it has no project folder");
      const [context] = await this.sync.pull({
        contexts: [{ name: req.project, kind: "project" }],
        timeoutMs: req.contextTimeoutMs,
      });
      if (!context || context.status === "missing" || context.status === "denied") {
        throw new Error(
          `The context of project "${req.project}" has no working copy on this host${context?.error ? `: ${context.error}` : ""}`,
        );
      }
      const checkouts: ProjectCheckout[] = [];
      for (const repo of req.repos) {
        checkouts.push(await this.ensureCheckout(req.project, repo, req.fetch ?? "throttled"));
      }
      return { folder, context, checkouts };
    });
  }

  private async ensureCheckout(
    project: string,
    repo: ProjectRepoSpec,
    fetchMode: "throttled" | "force" | "never",
  ): Promise<ProjectCheckout> {
    const branch = (() => {
      try {
        checkRepo(repo);
        return projectBranch(project, repo.defaultBranch);
      } catch {
        return projectBranch(project, "?");
      }
    })();
    const path = join(this.folderOf(project), "repos", repo.name);
    const base: ProjectCheckout = {
      repo: repo.name,
      path,
      branch,
      upstream: `origin/${repo.defaultBranch}`,
      status: "error",
      ahead: 0,
      behind: 0,
      dirty: false,
    };
    try {
      checkRepo(repo);
      let fetchError: string | undefined;
      if (fetchMode !== "never") fetchError = await this.fetchClone(repo.clonePath, fetchMode);
      if (!(await exists(join(path, ".git")))) {
        await this.createCheckout(project, repo, path, branch);
      }
      let state = await this.state(path);
      let updated = false;
      if (state.behind > 0 && state.ahead === 0 && !state.dirty) {
        const moved = await repoGit(path, ["merge", "--quiet", "--ff-only", "@{u}"]);
        if (moved.code !== 0) throw new Error(brief(moved));
        state = await this.state(path);
        updated = true;
      }
      const status = updated
        ? "updated"
        : state.behind > 0
          ? "behind"
          : state.ahead > 0 || state.dirty
            ? "ahead"
            : "current";
      return {
        ...base,
        status,
        ahead: state.ahead,
        behind: state.behind,
        dirty: state.dirty,
        ...(fetchError ? { fetchError } : {}),
      };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Fetches the clone's origin, at most once a minute unless forced. Returns the error, if any. */
  private async fetchClone(
    clonePath: string,
    mode: "throttled" | "force",
  ): Promise<string | undefined> {
    const last = this.lastFetch.get(clonePath) ?? 0;
    if (mode === "throttled" && Date.now() - last < fetchThrottleMs()) {
      return this.lastFetchError.get(clonePath);
    }
    // The attempt is recorded before the fetch, so a dead remote is retried once a minute, not every turn.
    this.lastFetch.set(clonePath, Date.now());
    const r = await repoGit(
      clonePath,
      ["fetch", "--quiet", "--no-tags", "origin"],
      FETCH_TIMEOUT_MS,
    );
    if (r.code !== 0) {
      const error = brief(r);
      this.lastFetchError.set(clonePath, error);
      return error;
    }
    this.lastFetchError.delete(clonePath);
    return undefined;
  }

  private async createCheckout(
    project: string,
    repo: ProjectRepoSpec,
    path: string,
    branch: string,
  ): Promise<void> {
    await mkdir(join(this.folderOf(project), "repos"), { recursive: true });
    await repoGit(repo.clonePath, ["worktree", "prune"]);
    const upstream = `origin/${repo.defaultBranch}`;
    const hasUpstream = await repoGit(repo.clonePath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${upstream}`,
    ]);
    if (hasUpstream.code !== 0) {
      throw new Error(`${repo.name} has no ${upstream}. Fetch the repository first.`);
    }
    const hasBranch =
      (await repoGit(repo.clonePath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))
        .code === 0;
    // An existing branch keeps its commits: it is checked out again, never reset.
    const added = hasBranch
      ? await repoGit(repo.clonePath, ["worktree", "add", path, branch])
      : await repoGit(repo.clonePath, ["worktree", "add", "--track", "-b", branch, path, upstream]);
    if (added.code !== 0) throw new Error(brief(added));
    // Per-worktree config, so `git push` goes to the tracked default branch whatever its local name.
    const ext = await repoGit(repo.clonePath, ["config", "extensions.worktreeConfig", "true"]);
    if (ext.code !== 0) throw new Error(brief(ext));
    const pushDefault = await repoGit(path, ["config", "--worktree", "push.default", "upstream"]);
    if (pushDefault.code !== 0) throw new Error(brief(pushDefault));
    if (hasBranch) {
      await repoGit(path, ["branch", "--set-upstream-to", upstream, branch]);
    }
  }

  private async state(path: string): Promise<{ ahead: number; behind: number; dirty: boolean }> {
    const counts = await repoGit(path, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    if (counts.code !== 0) throw new Error(brief(counts));
    const [ahead, behind] = counts.stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number(n) || 0);
    const status = await repoGit(path, ["status", "--porcelain"]);
    if (status.code !== 0) throw new Error(brief(status));
    return { ahead: ahead ?? 0, behind: behind ?? 0, dirty: status.stdout.trim() !== "" };
  }

  // ---- reads -------------------------------------------------------------------

  /** The checkout of a repo, which must exist. */
  private async existingCheckout(project: string, repo: string): Promise<string> {
    const path = this.checkoutOf(project, repo);
    if (!(await exists(join(path, ".git")))) {
      throw new Error(`Repo "${repo}" has no checkout in project "${project}" on this host`);
    }
    return path;
  }

  async read(req: ProjectReadRequest): Promise<ProjectReadResult> {
    const root = await realpath(await this.existingCheckout(req.project, req.repo));
    const wanted = resolve(root, req.path || ".");
    if (wanted !== root && !wanted.startsWith(root + sep)) {
      throw new Error("The path is outside the repo");
    }
    const rel = wanted.slice(root.length + 1);
    if (rel === ".git" || rel.startsWith(`.git${sep}`))
      throw new Error("The path is outside the repo");
    // A symlink may point out of the checkout, so judge the file it resolves to.
    const real = await realpath(wanted).catch(() => {
      throw new Error(`No such file or directory: ${req.path}`);
    });
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error("The path leaves the repo through a symlink");
    }
    const realRel = real.slice(root.length + 1);
    if (realRel === ".git" || realRel.startsWith(`.git${sep}`)) {
      throw new Error("The path is outside the repo");
    }
    const info = await stat(real);
    if (info.isDirectory()) {
      const entries = await readdir(real, { withFileTypes: true });
      return {
        kind: "dir",
        entries: entries
          .filter((e) => e.name !== ".git")
          .slice(0, MAX_DIR_ENTRIES)
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
      };
    }
    const limit = Math.min(Math.max(1, req.maxBytes ?? DEFAULT_READ_BYTES), MAX_READ_BYTES);
    if (!info.isFile()) throw new Error(`Not a regular file: ${req.path}`);
    const handle = await open(real, "r");
    let bytes: Buffer;
    try {
      const buf = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      bytes = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (bytes.subarray(0, 8000).includes(0)) throw new Error("This file is binary");
    return {
      kind: "file",
      content: bytes.toString("utf8"),
      truncated: info.size > limit,
      size: info.size,
    };
  }

  async search(req: ProjectSearchRequest): Promise<ProjectSearchMatch[]> {
    const path = await this.existingCheckout(req.project, req.repo);
    const query = req.query.trim();
    if (!query) throw new Error("The query is empty");
    const max = Math.min(Math.max(1, req.maxResults ?? DEFAULT_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
    const r = await repoGit(
      path,
      ["grep", "--untracked", "-n", "-I", "-i", "-F", "--no-color", "-e", query],
      LOCAL_TIMEOUT_MS,
      MAX_SEARCH_STDOUT_BYTES,
    );
    if (r.code === 1) return [];
    if (r.code !== 0) throw new Error(brief(r));
    const out: ProjectSearchMatch[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      out.push({
        path: m[1] as string,
        line: Number(m[2]),
        text: (m[3] as string).slice(0, MAX_LINE_CHARS),
      });
      if (out.length >= max) break;
    }
    return out;
  }

  async log(req: ProjectLogRequest): Promise<ProjectCommit[]> {
    const path = await this.existingCheckout(req.project, req.repo);
    const n = Math.min(Math.max(1, Math.floor(req.n)), MAX_LOG);
    const r = await repoGit(path, ["log", `-n${n}`, "--format=%H%x1f%an%x1f%aI%x1f%s"]);
    if (r.code !== 0) throw new Error(brief(r));
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", author = "", date = "", subject = ""] = line.split("\x1f");
        return { sha, author, date, subject };
      });
  }

  // ---- remove ------------------------------------------------------------------

  async removeRepo(req: ProjectRemoveRepoRequest): Promise<void> {
    const path = this.checkoutOf(req.project, req.repo);
    await this.exclusive(req.project, async () => {
      if (!(await exists(join(path, ".git")))) {
        await repoGit(req.clonePath, ["worktree", "prune"]);
        return;
      }
      const branch = (await repoGit(path, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
      const state = await this.state(path);
      const reasons: string[] = [];
      if (state.dirty) reasons.push("uncommitted changes");
      if (state.ahead > 0)
        reasons.push(`${state.ahead} unpushed commit${state.ahead === 1 ? "" : "s"}`);
      if (reasons.length > 0) {
        throw new Error(
          `The checkout of "${req.repo}" in ${path} has ${reasons.join(" and ")}. Commit and push or discard them first.`,
        );
      }
      const removed = await repoGit(req.clonePath, ["worktree", "remove", path]);
      if (removed.code !== 0) throw new Error(brief(removed));
      if (branch.startsWith(`band/${req.project}/`)) {
        await repoGit(req.clonePath, ["branch", "-D", branch]);
      }
    });
  }

  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
