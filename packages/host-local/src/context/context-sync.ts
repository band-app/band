/**
 * Working copies of the hub's context repos on a host (plan step 5.2).
 *
 * A context lives at `<bandHome>/context/user` or `<bandHome>/context/projects/<name>`,
 * outside every worktree, so personal notes can't be committed to a product
 * repo. `pull` clones or fast-forwards a copy before an agent session starts.
 * `push` runs after each turn: it scans what the agent changed, commits it,
 * rebases on the hub's head and pushes.
 *
 * Conflict policy: `learnings/` and `inbox/` merge with git's union driver, so
 * appends from two hosts both survive. On any other real conflict the rebase is
 * dropped and both versions are kept: the hub's version stays at the path and
 * this host's version goes to `<path>.conflict-<host>-<timestamp>`.
 *
 * A file the redaction scan flags is not pushed. It moves to
 * `<bandHome>/context-quarantine/<context>/<timestamp>/` and the working copy
 * goes back to the hub's version of it.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ContextConflict,
  ContextFinding,
  ContextPullRequest,
  ContextPullResult,
  ContextPushRequest,
  ContextPushResult,
  ContextSpec,
  SecretFingerprint,
} from "@band-app/host-api";
import { scanText } from "./redaction";

/** Where a context is fetched from, and the environment that authenticates the call. */
export interface ContextRemote {
  url: string;
  env?: Record<string, string>;
}

export interface ContextSource {
  /** The host's `BAND_HOME`. The copies go in its `context` directory. */
  bandHome(): string;
  remote(name: string): Promise<ContextRemote>;
}

const DEFAULT_PULL_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 30_000;
const MAX_PUSH_ATTEMPTS = 5;
const APPEND_ONLY = ["learnings/**", "inbox/**"];

interface GitOut {
  stdout: string;
  stderr: string;
  code: number;
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // The worker puts its credential helper in GIT_CONFIG_*. Context git calls carry their own auth.
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_CONFIG_")) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "http:https:file",
    GIT_AUTHOR_NAME: "Band agent",
    GIT_AUTHOR_EMAIL: "agent@band.local",
    GIT_COMMITTER_NAME: "Band agent",
    GIT_COMMITTER_EMAIL: "agent@band.local",
    ...extra,
  };
}

function run(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number; input?: string },
): Promise<GitOut> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: e.message, code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: timedOut
          ? `timed out after ${opts.timeoutMs} ms`
          : Buffer.concat(err).toString("utf8"),
        code: timedOut ? 124 : (code ?? 1),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** The first line of git's complaint, with no URL or credential in it. */
function brief(r: GitOut): string {
  const line = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return (line ?? `git exited with ${r.code}`).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);
}

const refused = (r: GitOut) => /\b40[13]\b|denied|forbidden|not authorized/i.test(r.stderr);

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function safeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "host";
}

export class ContextSync {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly source: ContextSource) {}

  /** The directory of a context's working copy. */
  dirOf(spec: ContextSpec): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(spec.name)) {
      throw new Error(`Not a context name: ${spec.name.slice(0, 80)}`);
    }
    const base = join(this.source.bandHome(), "context");
    return spec.kind === "user" ? join(base, "user") : join(base, "projects", spec.name);
  }

  async pull(request: ContextPullRequest): Promise<ContextPullResult[]> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
    return Promise.all(
      request.contexts.map((spec) =>
        this.withDeadline(
          this.exclusive(spec, () => this.pullOne(spec, timeoutMs)),
          timeoutMs,
        ).catch(
          (err): ContextPullResult => ({
            name: spec.name,
            status: "stale",
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
  }

  async push(request: ContextPushRequest): Promise<ContextPushResult[]> {
    const out: ContextPushResult[] = [];
    for (const spec of request.contexts) {
      out.push(
        await this.exclusive(spec, () => this.pushOne(spec, request)).catch(
          (err): ContextPushResult => ({
            name: spec.name,
            status: "failed",
            conflicts: [],
            blocked: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    }
    return out;
  }

  // ---- pull --------------------------------------------------------------------

  private async pullOne(spec: ContextSpec, timeoutMs: number): Promise<ContextPullResult> {
    const dir = this.dirOf(spec);
    const remote = await this.source.remote(spec.name);
    const opts = { env: remote.env, timeoutMs };
    const exists = await this.isRepo(dir);

    if (!exists) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      const r = await run(["clone", "--quiet", "--", remote.url, dir], opts);
      if (r.code !== 0) {
        await rm(dir, { recursive: true, force: true });
        return {
          name: spec.name,
          status: refused(r) ? "denied" : "missing",
          error: brief(r),
        };
      }
      await this.configure(dir);
      return { name: spec.name, status: "updated" };
    }

    const fetched = await run(["fetch", "--quiet", "--no-tags", "origin"], { cwd: dir, ...opts });
    if (fetched.code !== 0) {
      return {
        name: spec.name,
        status: refused(fetched) ? "denied" : "stale",
        error: brief(fetched),
      };
    }
    const branch = await this.branch(dir);
    const head = (await this.git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const upstream = (await this.git(dir, ["rev-parse", `origin/${branch}`])).stdout.trim();
    if (head === upstream) return { name: spec.name, status: "current" };
    const dirty = (await this.git(dir, ["status", "--porcelain"])).stdout.trim() !== "";
    const ahead = await this.git(dir, ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`]);
    if (dirty || ahead.code !== 0) {
      // Changes of this host that no push has taken yet. The next push rebases them.
      return {
        name: spec.name,
        status: "stale",
        error: "this host has changes that are not pushed yet",
      };
    }
    const moved = await this.git(dir, ["merge", "--quiet", "--ff-only", `origin/${branch}`]);
    if (moved.code !== 0) return { name: spec.name, status: "stale", error: brief(moved) };
    return { name: spec.name, status: "updated" };
  }

  // ---- push --------------------------------------------------------------------

  private async pushOne(spec: ContextSpec, req: ContextPushRequest): Promise<ContextPushResult> {
    const result: ContextPushResult = {
      name: spec.name,
      status: "clean",
      conflicts: [],
      blocked: [],
    };
    const dir = this.dirOf(spec);
    if (!(await this.isRepo(dir))) return result;

    await this.git(dir, ["add", "-A"]);
    const blocked = await this.quarantineFindings(spec, dir, req.secrets);
    result.blocked = blocked.findings;
    if (blocked.dir) result.quarantine = blocked.dir;

    const staged = (await this.git(dir, ["diff", "--cached", "--quiet"])).code !== 0;
    if (staged) {
      const committed = await this.git(dir, ["commit", "--quiet", "-m", req.message]);
      if (committed.code !== 0) return { ...result, status: "failed", error: brief(committed) };
    }
    const branch = await this.branch(dir);
    const unpushed = Number(
      (await this.git(dir, ["rev-list", "--count", `origin/${branch}..HEAD`])).stdout.trim() || "0",
    );
    if (!staged && unpushed === 0) return result;

    const remote = await this.source.remote(spec.name);
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const fetched = await run(["fetch", "--quiet", "--no-tags", "origin"], {
        cwd: dir,
        env: remote.env,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      if (fetched.code !== 0) return { ...result, status: "failed", error: brief(fetched) };

      const upstream = `origin/${branch}`;
      const contains = await this.git(dir, ["merge-base", "--is-ancestor", upstream, "HEAD"]);
      if (contains.code !== 0) {
        const kept = await this.rebaseKeepingBoth(dir, upstream, req.hostLabel);
        if (kept.error) return { ...result, status: "failed", error: kept.error };
        result.conflicts.push(...kept.conflicts);
      }
      const pushed = await run(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], {
        cwd: dir,
        env: remote.env,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      if (pushed.code === 0) return { ...result, status: "pushed" };
      // Another host pushed between the fetch and the push. Rebase again.
      if (!/non-fast-forward|fetch first|rejected/i.test(pushed.stderr)) {
        return { ...result, status: "failed", error: brief(pushed) };
      }
    }
    return { ...result, status: "failed", error: "the hub's head kept moving" };
  }

  /**
   * Replays the local commits on `upstream`. Each time git stops on a conflict, the hub's
   * version stays at the path, this host's version goes beside it as
   * `<path>.conflict-<host>-<timestamp>`, and the rebase goes on. Files that merge cleanly,
   * including `learnings/` and `inbox/` through the union driver, keep both sides' changes.
   */
  private async rebaseKeepingBoth(
    dir: string,
    upstream: string,
    hostLabel: string,
  ): Promise<{ conflicts: ContextConflict[]; error?: string }> {
    const noEditor = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
    const conflicts: ContextConflict[] = [];
    const stamp = `${safeSegment(hostLabel)}-${timestamp()}`;
    let step = await run(["rebase", upstream], {
      cwd: dir,
      env: noEditor,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    for (let guard = 0; step.code !== 0 && guard < 100; guard++) {
      const unmerged = (
        await this.git(dir, ["diff", "--name-only", "-z", "--diff-filter=U"])
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (unmerged.length === 0) {
        await this.git(dir, ["rebase", "--abort"]);
        return { conflicts, error: brief(step) };
      }
      for (const path of unmerged) {
        // While rebasing, stage 2 is the hub's side and stage 3 is this host's commit.
        const mine = await this.git(dir, ["show", `:3:${path}`], true);
        const hasHub = (await this.git(dir, ["cat-file", "-e", `:2:${path}`])).code === 0;
        if (mine.code === 0) {
          const keptAs = `${path}.conflict-${stamp}`;
          await mkdir(dirname(join(dir, keptAs)), { recursive: true });
          await writeFile(join(dir, keptAs), mine.buffer);
          await this.git(dir, ["add", "--", keptAs]);
          conflicts.push({ path, keptAs });
        }
        if (hasHub) {
          await this.git(dir, ["checkout", "--ours", "--", path]);
          await this.git(dir, ["add", "--", path]);
        } else {
          await this.git(dir, ["rm", "-q", "-f", "--", path]);
        }
      }
      const emptied = (await this.git(dir, ["diff", "--cached", "--quiet"])).code === 0;
      step = await run(["rebase", emptied ? "--skip" : "--continue"], {
        cwd: dir,
        env: noEditor,
        timeoutMs: LOCAL_TIMEOUT_MS,
      });
    }
    if (step.code !== 0) {
      await this.git(dir, ["rebase", "--abort"]);
      return { conflicts, error: brief(step) };
    }
    return { conflicts };
  }

  /**
   * Scans the staged files. A file with a finding is copied to the quarantine,
   * unstaged and put back to what the hub's head has (or deleted when it is new).
   */
  private async quarantineFindings(
    spec: ContextSpec,
    dir: string,
    secrets: SecretFingerprint[],
  ): Promise<{ findings: ContextFinding[]; dir?: string }> {
    const listed = (
      await this.git(dir, ["diff", "--cached", "--name-status", "-z", "--no-renames"])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const findings: ContextFinding[] = [];
    for (let i = 0; i + 1 < listed.length; i += 2) {
      if (listed[i] === "D") continue;
      const path = listed[i + 1];
      const blob = await this.git(dir, ["show", `:${path}`], true);
      // A binary file is scanned as latin1, so a NUL byte cannot hide a secret.
      const text = blob.buffer.includes(0)
        ? blob.buffer.toString("latin1")
        : blob.buffer.toString("utf8");
      findings.push(...scanText(path, text, secrets));
    }
    if (findings.length === 0) return { findings };

    const quarantine = join(this.source.bandHome(), "context-quarantine", spec.name, timestamp());
    const paths = [...new Set(findings.map((f) => f.path))];
    for (const path of paths) {
      const blob = await this.git(dir, ["show", `:${path}`], true);
      const target = join(quarantine, "files", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blob.buffer, { mode: 0o600 });
      const inHead = (await this.git(dir, ["cat-file", "-e", `HEAD:${path}`])).code === 0;
      await this.git(dir, ["reset", "--quiet", "HEAD", "--", path]);
      if (inHead) await this.git(dir, ["checkout", "--", path]);
      else await rm(join(dir, path), { force: true });
    }
    await writeFile(join(quarantine, "findings.json"), JSON.stringify(findings, null, 2), {
      mode: 0o600,
    });
    return { findings, dir: quarantine };
  }

  // ---- helpers -----------------------------------------------------------------

  private async isRepo(dir: string): Promise<boolean> {
    try {
      await readFile(join(dir, ".git", "HEAD"));
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps an append from two hosts to the same learnings or inbox file instead of conflicting. */
  private async configure(dir: string): Promise<void> {
    const attributes = APPEND_ONLY.map((glob) => `${glob} merge=union`).join("\n");
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    await writeFile(join(dir, ".git", "info", "attributes"), `${attributes}\n`);
    await this.git(dir, ["config", "rebase.autoStash", "false"]);
    await this.git(dir, ["config", "commit.gpgsign", "false"]);
  }

  private async branch(dir: string): Promise<string> {
    const r = await this.git(dir, ["symbolic-ref", "--short", "HEAD"]);
    return r.stdout.trim() || "main";
  }

  private git(dir: string, args: string[]): Promise<GitOut>;
  private git(dir: string, args: string[], raw: true): Promise<{ buffer: Buffer; code: number }>;
  private async git(dir: string, args: string[], raw?: boolean): Promise<unknown> {
    if (raw) return this.gitBytes(dir, args);
    return run(args, { cwd: dir, timeoutMs: LOCAL_TIMEOUT_MS });
  }

  private gitBytes(dir: string, args: string[]): Promise<{ buffer: Buffer; code: number }> {
    return new Promise((resolve) => {
      const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: dir,
        env: gitEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", () => resolve({ buffer: Buffer.alloc(0), code: 127 }));
      child.on("close", (code) => resolve({ buffer: Buffer.concat(chunks), code: code ?? 1 }));
    });
  }

  /**
   * A pull queues behind a running push of the same context. This bounds the
   * wait for the lock as well as the git calls, so a slow push cannot hold a
   * prompt past the pull timeout (the copy is then reported stale).
   */
  private withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`pull timed out after ${timeoutMs} ms`)),
        timeoutMs + 1000,
      );
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  private async exclusive<T>(spec: ContextSpec, fn: () => Promise<T>): Promise<T> {
    const key = `${spec.kind}:${spec.name}`;
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
