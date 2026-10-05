/**
 * Context repos the hub holds (plan step 5.1): one user context and any number
 * of named ones (mission contexts, step 6.1). Each is a bare git repo at
 * `<BAND_HOME>/context/<name>.git`, served over git smart HTTP by
 * `api/context/git-http.ts`.
 *
 * A context may be linked to an existing remote repo ("bring your own repo").
 * The hub then mirrors both ways: it fetches the remote's branches and pushes
 * the hub's, never forcing. A branch that moved on both sides is left as it is
 * on each side and reported in `syncError`. The remote credential is a vault
 * item and reaches git through its environment, never argv or the repo config.
 *
 * Pushed content cannot run code on the hub: the repo is made from an empty
 * template, `core.hooksPath` points at nothing, and the hub never checks a
 * working tree out.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { ContextInputError, ContextNotFoundError } from "../errors";
import { ContextQueries, type ContextRow } from "../infra/db/queries/contexts";
import { bandHome } from "./state";
import { vaultService } from "./vault-service";

const log = createLogger("context-service");

export const CONTEXT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const USER_CONTEXT_NAME = "user";
const LABEL = /^[^\s=]+=[^\s]*$/;
const MAX_LABELS = 20;
const DEFAULT_POLL_MS = 60_000;
const PUSH_DEBOUNCE_MS = 2_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface ContextView {
  id: string;
  name: string;
  kind: ContextRow["kind"];
  remoteUrl: string | null;
  remoteVaultItemId: string | null;
  labels: string[];
  repos: string[];
  workerAccess: ContextRow["workerAccess"];
  preamble: boolean;
  syncError: string | null;
  lastSyncAt: number | null;
  createdAt: number;
}

export interface SyncResult {
  /** Branches the hub moved forward from the remote. */
  pulled: string[];
  /** Branches the hub pushed to the remote. */
  pushed: string[];
  /** Branches that moved on both sides. Neither side was changed. */
  diverged: string[];
}

function toView(row: ContextRow): ContextView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    remoteUrl: row.remoteUrl,
    remoteVaultItemId: row.remoteVaultItemId,
    labels: row.labels,
    repos: row.repos,
    workerAccess: row.workerAccess,
    preamble: row.preamble,
    syncError: row.syncError,
    lastSyncAt: row.lastSyncAt,
    createdAt: row.createdAt,
  };
}

export function contextRoot(): string {
  return join(bandHome(), "context");
}

export function contextRepoPath(name: string): string {
  return join(contextRoot(), `${name}.git`);
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** The environment every hub-side git call gets: no system or user config, no prompts. */
export function contextGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Band",
    GIT_AUTHOR_EMAIL: "band@localhost",
    GIT_COMMITTER_NAME: "Band",
    GIT_COMMITTER_EMAIL: "band@localhost",
    ...extra,
  };
}

export function runGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? contextGitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? 1,
      });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

export async function git(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  const r = await runGit(args, opts);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 400) || `exit ${r.code}`}`);
  }
  return r.stdout;
}

const SCAFFOLD: Record<ContextRow["kind"], Array<[string, string]>> = {
  user: [
    ["preferences.md", "# Preferences\n\nHow you like agents to work. Agents read this first.\n"],
    ["skills/.gitkeep", ""],
  ],
  mission: [
    ["notes.md", "# Notes\n\nWritten by the coordinator. Keep it short.\n"],
    ["docs/.gitkeep", ""],
    ["media/.gitkeep", ""],
    ["inbox/.gitkeep", ""],
    ["handoffs/.gitkeep", ""],
    ["learnings/.gitkeep", ""],
  ],
};

function fastImportScaffold(kind: ContextRow["kind"]): string {
  const msg = "Scaffold context";
  const parts = [
    "commit refs/heads/main",
    `committer Band <band@localhost> ${Math.floor(Date.now() / 1000)} +0000`,
    `data ${Buffer.byteLength(msg)}`,
    msg,
  ];
  for (const [path, content] of SCAFFOLD[kind]) {
    parts.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content);
  }
  return `${parts.join("\n")}\n`;
}

function allowLocalRemotes(): boolean {
  return process.env.BAND_CONTEXT_ALLOW_LOCAL_REMOTES === "1";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Checks a remote URL and returns it trimmed. The credential never goes in the URL. */
export function validateRemoteUrl(raw: string): string {
  const url = raw.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!url || url.length > 500 || /[\s\u0000-\u001f]/.test(url) || url.startsWith("-")) {
    throw new ContextInputError("The remote URL is empty, too long or has whitespace");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ContextInputError("The remote URL is not valid");
    }
    const proto = parsed.protocol;
    if (proto === "https:" || proto === "http:") {
      if (parsed.username || parsed.password) {
        throw new ContextInputError("Keep credentials out of the remote URL. Use a vault item.");
      }
      if (proto === "http:" && !LOOPBACK.has(parsed.hostname)) {
        throw new ContextInputError("An http remote must be on loopback. Use https.");
      }
      return url;
    }
    if (proto === "ssh:") return url;
    if (proto === "file:" && allowLocalRemotes()) return url;
    throw new ContextInputError("The remote must be an https, ssh or scp-style URL");
  }
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(url)) return url;
  if (url.startsWith("/") && allowLocalRemotes()) return url;
  throw new ContextInputError("The remote must be an https, ssh or scp-style URL");
}

function validateLabels(labels: string[]): string[] {
  if (labels.length > MAX_LABELS) {
    throw new ContextInputError(`At most ${MAX_LABELS} labels`);
  }
  for (const label of labels) {
    if (!LABEL.test(label) || label.length > 100) {
      throw new ContextInputError(`Label "${label}" must look like key=value`);
    }
  }
  return [...new Set(labels)];
}

/** Whether a host's labels include every label a context asks for. An empty list matches any host. */
export function hostLabelsMatch(required: string[], hostLabels: string[]): boolean {
  return required.every((l) => hostLabels.includes(l));
}

export interface CreateContextInput {
  name: string;
  kind?: ContextRow["kind"];
  labels?: string[];
  repos?: string[];
  workerAccess?: ContextRow["workerAccess"];
  remoteUrl?: string;
  remoteVaultItemId?: string;
}

export class ContextService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly pushTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly queries = new ContextQueries()) {}

  start(): void {
    if (this.pollTimer) return;
    const every = Number(process.env.BAND_CONTEXT_SYNC_POLL_MS) || DEFAULT_POLL_MS;
    this.pollTimer = setInterval(() => void this.syncAll(), every);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.pushTimers.values()) clearTimeout(timer);
    this.pushTimers.clear();
  }

  list(): ContextView[] {
    return this.queries.list().map(toView);
  }

  /** The named context that serves as the project context of a repo's agents, if any. */
  forRepo(repoName: string): ContextRow | undefined {
    return this.queries.list().find((c) => c.kind === "mission" && c.repos.includes(repoName));
  }

  /**
   * The contexts a session of `repo` on a host with `hostLabels` gets (plan step 5.2): the user
   * context and the repo's project context. A context whose labels the host lacks is left out.
   */
  forSession(repo: string, hostLabels: string[]): ContextRow[] {
    return [this.queries.findUser(), this.forRepo(repo)]
      .filter((row): row is ContextRow => row !== undefined)
      .filter((row) => hostLabelsMatch(row.labels, hostLabels));
  }

  /** Records what a host's sync reported. The detail never holds a matched secret. */
  recordEvent(
    context: string,
    hostId: string,
    kind: "conflict" | "blocked",
    detail: unknown,
  ): void {
    const now = Date.now();
    this.queries.insertEvent({
      id: `cev-${randomBytes(6).toString("hex")}`,
      context,
      hostId,
      kind,
      detail,
      at: now,
    });
    this.queries.pruneEvents(now - EVENT_RETENTION_MS);
    log.info(`context ${context}: ${kind} on host ${hostId}`);
  }

  events(limit: number, context?: string) {
    return this.queries.listEvents(limit, context);
  }

  /** The user context, if one exists. */
  userContext(): ContextRow | undefined {
    return this.queries.findUser();
  }

  /** Runs `fn` after every earlier write to the named context's repo has finished. */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.exclusive(name, fn);
  }

  /** The row the git endpoint authorizes against, or undefined. */
  find(name: string): ContextRow | undefined {
    return CONTEXT_NAME.test(name) ? this.queries.find(name) : undefined;
  }

  async create(input: CreateContextInput): Promise<ContextView> {
    const name = input.name.trim();
    if (!CONTEXT_NAME.test(name)) {
      throw new ContextInputError(
        "A context name is lowercase letters, digits, hyphens and underscores",
      );
    }
    const kind = input.kind ?? (name === USER_CONTEXT_NAME ? "user" : "mission");
    if (kind === "user" && name !== USER_CONTEXT_NAME) {
      throw new ContextInputError(`The user context is named "${USER_CONTEXT_NAME}"`);
    }
    if (kind === "mission" && name === USER_CONTEXT_NAME) {
      throw new ContextInputError(`"${USER_CONTEXT_NAME}" is reserved for the user context`);
    }
    if (this.queries.find(name)) throw new ContextInputError(`Context "${name}" already exists`);
    if (kind === "user" && this.queries.findUser()) {
      throw new ContextInputError("There is already a user context");
    }
    const labels = validateLabels(input.labels ?? []);
    const repos = this.checkRepos(name, kind, input.repos ?? []);
    const remoteUrl = input.remoteUrl ? validateRemoteUrl(input.remoteUrl) : null;
    const vaultItemId = this.checkVaultItem(input.remoteVaultItemId, remoteUrl);

    const repo = contextRepoPath(name);
    mkdirSync(contextRoot(), { recursive: true });
    try {
      await this.initBare(repo);
      const row: ContextRow = {
        id: `ctx-${randomBytes(6).toString("hex")}`,
        name,
        kind,
        remoteUrl,
        remoteVaultItemId: vaultItemId,
        labels,
        repos,
        workerAccess: input.workerAccess ?? "read-write",
        preamble: true,
        syncError: null,
        lastSyncAt: null,
        createdAt: Date.now(),
      };
      if (remoteUrl) {
        // Take what the remote has. Only an empty remote gets the scaffold.
        await this.mirror(row, repo, true);
        if ((await this.localBranches(repo)).size === 0) {
          await this.scaffold(repo, kind);
          await this.mirror(row, repo, true);
        }
        row.lastSyncAt = Date.now();
      } else {
        await this.scaffold(repo, kind);
      }
      this.queries.insert(row);
      log.info(`created ${kind} context ${name}${remoteUrl ? " with a remote" : ""}`);
      return toView(row);
    } catch (err) {
      rmSync(repo, { recursive: true, force: true });
      if (err instanceof ContextInputError) throw err;
      throw new ContextInputError(err instanceof Error ? err.message : String(err));
    }
  }

  async remove(name: string): Promise<void> {
    this.require(name);
    const timer = this.pushTimers.get(name);
    if (timer) clearTimeout(timer);
    this.pushTimers.delete(name);
    await this.locks.get(name)?.catch(() => {});
    this.queries.remove(name);
    rmSync(contextRepoPath(name), { recursive: true, force: true });
    log.info(`removed context ${name}`);
  }

  update(
    name: string,
    patch: {
      labels?: string[];
      repos?: string[];
      workerAccess?: ContextRow["workerAccess"];
      preamble?: boolean;
    },
  ): ContextView {
    const row = this.require(name);
    const set: Partial<ContextRow> = {};
    if (patch.labels) set.labels = validateLabels(patch.labels);
    if (patch.repos) set.repos = this.checkRepos(name, row.kind, patch.repos);
    if (patch.workerAccess) set.workerAccess = patch.workerAccess;
    if (patch.preamble !== undefined) set.preamble = patch.preamble;
    if (Object.keys(set).length > 0) this.queries.update(name, set);
    return toView(this.require(name));
  }

  /** Links, relinks or (with a null URL) unlinks the remote, then mirrors once. */
  async linkRemote(
    name: string,
    remoteUrl: string | null,
    vaultItemId?: string | null,
  ): Promise<ContextView> {
    const row = this.require(name);
    if (remoteUrl === null) {
      this.queries.update(name, { remoteUrl: null, remoteVaultItemId: null, syncError: null });
      return toView(this.require(name));
    }
    const url = validateRemoteUrl(remoteUrl);
    const item = this.checkVaultItem(vaultItemId ?? undefined, url);
    this.queries.update(name, { remoteUrl: url, remoteVaultItemId: item, syncError: null });
    const result = await this.sync(name);
    if (result.error) {
      this.queries.update(name, {
        remoteUrl: row.remoteUrl,
        remoteVaultItemId: row.remoteVaultItemId,
        syncError: row.syncError,
      });
      throw new ContextInputError(result.error);
    }
    return toView(this.require(name));
  }

  /** Mirrors with the remote once. A failure is recorded in `syncError` and returned, not thrown. */
  async sync(name: string): Promise<SyncResult & { error?: string }> {
    const row = this.require(name);
    if (!row.remoteUrl) throw new ContextInputError(`Context "${name}" has no remote`);
    return this.exclusive(name, async () => {
      const fresh = this.queries.find(name) ?? row;
      try {
        const result = await this.mirror(fresh, contextRepoPath(name), false);
        const syncError = result.diverged.length
          ? `Moved on both sides, left as is: ${result.diverged.join(", ")}`
          : null;
        this.queries.update(name, { syncError, lastSyncAt: Date.now() });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.queries.update(name, { syncError: message, lastSyncAt: Date.now() });
        log.warn(`sync of context ${name} failed: ${message}`);
        return { pulled: [], pushed: [], diverged: [], error: message };
      }
    });
  }

  async syncAll(): Promise<void> {
    for (const row of this.queries.list()) {
      if (row.remoteUrl) await this.sync(row.name).catch(() => {});
    }
  }

  /** Called after a push to the hub: mirrors to the remote shortly, coalescing bursts. */
  syncSoon(name: string): void {
    const row = this.queries.find(name);
    if (!row?.remoteUrl || this.pushTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.pushTimers.delete(name);
      void this.sync(name).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
    timer.unref();
    this.pushTimers.set(name, timer);
  }

  // ---- internals ---------------------------------------------------------------

  require(name: string): ContextRow {
    const row = this.find(name);
    if (!row) throw new ContextNotFoundError(name);
    return row;
  }

  /** A repo serves one project context. The user context takes none. */
  private checkRepos(name: string, kind: ContextRow["kind"], repos: string[]): string[] {
    const unique = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
    if (unique.length > 0 && kind === "user") {
      throw new ContextInputError("The user context is not tied to repos");
    }
    for (const repo of unique) {
      const other = this.queries.list().find((c) => c.name !== name && c.repos.includes(repo));
      if (other) {
        throw new ContextInputError(`Repo "${repo}" already uses context "${other.name}"`);
      }
    }
    return unique;
  }

  private checkVaultItem(id: string | undefined, remoteUrl: string | null): string | null {
    if (!id) return null;
    if (!remoteUrl) throw new ContextInputError("A credential needs a remote");
    const kind = vaultService.kindOf(id);
    if (!kind) throw new ContextInputError(`No credential with id "${id}"`);
    if (kind === "env") throw new ContextInputError("Use an API key or OAuth credential");
    if (!/^https?:/i.test(remoteUrl)) {
      throw new ContextInputError("A credential works with an https remote only");
    }
    return id;
  }

  /** Runs `fn` after every earlier call for the same context, so writes to one repo never interleave. */
  async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(name, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(name) === next) this.locks.delete(name);
    }
  }

  private async initBare(repo: string): Promise<void> {
    await git(["init", "--bare", "-q", "--template=", "-b", "main", repo]);
    const set = (k: string, v: string) => git(["config", k, v], { cwd: repo });
    await set("core.hooksPath", "/dev/null");
    await set("receive.fsckObjects", "true");
    await set("uploadpack.hideRefs", "refs/band");
    await set("receive.hideRefs", "refs/band");
  }

  private async scaffold(repo: string, kind: ContextRow["kind"]): Promise<void> {
    await git(["fast-import", "--quiet", "--force"], {
      cwd: repo,
      input: fastImportScaffold(kind),
    });
  }

  private async localBranches(repo: string): Promise<Map<string, string>> {
    return this.refs(repo, "refs/heads/");
  }

  private async refs(repo: string, prefix: string): Promise<Map<string, string>> {
    const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
      cwd: repo,
    });
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const [ref, sha] = line.split(" ");
      if (ref && sha) map.set(ref.slice(prefix.length), sha);
    }
    return map;
  }

  private async remoteEnv(row: ContextRow): Promise<NodeJS.ProcessEnv> {
    const protocols = ["http", "https", "ssh", ...(allowLocalRemotes() ? ["file"] : [])];
    const extra: Record<string, string> = { GIT_ALLOW_PROTOCOL: protocols.join(":") };
    if (row.remoteVaultItemId && row.remoteUrl) {
      const cred = await vaultService.getCredential(row.remoteVaultItemId);
      const basic = Buffer.from(`x-access-token:${cred.value}`).toString("base64");
      extra.GIT_CONFIG_COUNT = "1";
      extra.GIT_CONFIG_KEY_0 = `http.${row.remoteUrl}.extraHeader`;
      extra.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return contextGitEnv(extra);
  }

  /** Fetches the remote's branches and moves each side forward when only one moved. Never forces. */
  private async mirror(row: ContextRow, repo: string, initial: boolean): Promise<SyncResult> {
    const url = row.remoteUrl;
    if (!url) return { pulled: [], pushed: [], diverged: [] };
    const env = await this.remoteEnv(row);
    await git(
      ["fetch", "--quiet", "--no-tags", "--prune", "--", url, "+refs/heads/*:refs/band/remote/*"],
      { cwd: repo, env },
    );
    const remote = await this.refs(repo, "refs/band/remote/");
    const local = await this.localBranches(repo);
    const result: SyncResult = { pulled: [], pushed: [], diverged: [] };
    const toPush: string[] = [];

    const isAncestor = async (a: string, b: string) =>
      (await runGit(["merge-base", "--is-ancestor", a, b], { cwd: repo })).code === 0;

    for (const [branch, remoteSha] of remote) {
      const localSha = local.get(branch);
      if (!localSha) {
        await git(["update-ref", `refs/heads/${branch}`, remoteSha, ""], { cwd: repo });
        result.pulled.push(branch);
      } else if (localSha === remoteSha) {
        // In step.
      } else if (await isAncestor(localSha, remoteSha)) {
        await git(["update-ref", `refs/heads/${branch}`, remoteSha, localSha], { cwd: repo });
        result.pulled.push(branch);
      } else if (await isAncestor(remoteSha, localSha)) {
        toPush.push(branch);
      } else {
        result.diverged.push(branch);
      }
    }
    for (const branch of local.keys()) if (!remote.has(branch)) toPush.push(branch);

    if (toPush.length > 0 && !(initial && local.size === 0)) {
      await git(
        ["push", "--quiet", "--", url, ...toPush.map((b) => `refs/heads/${b}:refs/heads/${b}`)],
        { cwd: repo, env },
      );
      result.pushed.push(...toPush);
    }

    // A repo made from a remote follows the remote's usual default branch.
    const heads = await this.localBranches(repo);
    const headRef = (await runGit(["symbolic-ref", "-q", "HEAD"], { cwd: repo })).stdout.trim();
    if (heads.size > 0 && !heads.has(headRef.replace("refs/heads/", ""))) {
      const pick = ["main", "master"].find((b) => heads.has(b)) ?? [...heads.keys()][0];
      await git(["symbolic-ref", "HEAD", `refs/heads/${pick}`], { cwd: repo });
    }
    return result;
  }
}

export const contextService = new ContextService();
