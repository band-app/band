import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type {
  EnsureRepoResult,
  EnsureRepoSpec,
  FsBrowseResult,
  HostRepos,
  RepoInspection,
  RepoMapping,
} from "@band-app/host-api";
import { parseRemoteUrl, stripUrlCredentials } from "@band-app/shared/remote-url";
import { execGit } from "../git/git-client";
import { prependBinDirs } from "../process/path";

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface HostReposOptions {
  /** The JSON file that keeps the mappings. */
  mappingsFile: () => string;
  /** The folder new clones go under, as `<dir>/<owner>/<name>`. */
  reposDir: () => string;
}

/** `~/band/repos`, or `BAND_REPOS_DIR` when it is set. */
export function defaultReposDir(): string {
  return process.env.BAND_REPOS_DIR?.trim() || join(homedir(), "band", "repos");
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await execGit(args, cwd)).trim();
  } catch {
    return null;
  }
}

/** The repository `git clone` makes, with the machine's own git credentials and no prompt. */
function clone(url: string, dest: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  env.PATH = prependBinDirs(env.PATH);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["clone", "--", url, dest],
      { env, timeout: CLONE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err)
          reject(
            new Error(
              `git clone ${stripUrlCredentials(url)} failed: ${stderr.trim() || err.message}`,
            ),
          );
        else resolve();
      },
    );
  });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repo-to-folder mapping of one host (`remote URL key -> folder`), and the clone that fills
 * it. A worker keeps it in its state dir, so it knows a repo is already there without asking the hub.
 */
export class LocalRepos implements HostRepos {
  private cache: Record<string, RepoMapping> | null = null;
  /** Clones in flight, so two worktrees for one repo share one clone. */
  private readonly ensuring = new Map<string, Promise<EnsureRepoResult>>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: HostReposOptions) {}

  private async load(): Promise<Record<string, RepoMapping>> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.options.mappingsFile(), "utf8")) as Record<
        string,
        RepoMapping
      >;
      this.cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private save(mappings: Record<string, RepoMapping>): Promise<void> {
    const file = this.options.mappingsFile();
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, `${JSON.stringify(mappings, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return this.writing;
  }

  async addRoot(_path: string): Promise<void> {
    // The machine's own user may reach every folder, so there is no list to add to.
  }

  async list(): Promise<RepoMapping[]> {
    return Object.values(await this.load());
  }

  async map(remoteUrl: string, path: string): Promise<void> {
    const id = parseRemoteUrl(remoteUrl);
    if (!id) throw new Error(`"${stripUrlCredentials(remoteUrl)}" is not a git remote URL`);
    const mappings = await this.load();
    mappings[id.key] = { key: id.key, remoteUrl: id.url, path };
    await this.save(mappings);
  }

  async unmap(remoteUrl: string): Promise<void> {
    const id = parseRemoteUrl(remoteUrl);
    if (!id) return;
    const mappings = await this.load();
    if (!(id.key in mappings)) return;
    delete mappings[id.key];
    await this.save(mappings);
  }

  async inspect(path: string): Promise<RepoInspection> {
    const resolved = await realpath(path).catch(() => {
      throw new Error(`${path} does not exist`);
    });
    if (!(await isDirectory(resolved))) throw new Error(`${resolved} is not a directory`);
    const top = await git(["rev-parse", "--show-toplevel"], resolved);
    if (!top) return { path: resolved, isGit: false, remoteUrl: null, defaultBranch: null };
    const root = await realpath(top);
    const origin = await git(["remote", "get-url", "origin"], root);
    const remoteUrl = origin ? stripUrlCredentials(origin) : null;
    const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
    const current = await git(["symbolic-ref", "--short", "HEAD"], root);
    const defaultBranch = head ? head.replace(/^origin\//, "") : current || null;
    return { path: root, isGit: true, remoteUrl, defaultBranch };
  }

  ensure(spec: EnsureRepoSpec): Promise<EnsureRepoResult> {
    const id = parseRemoteUrl(spec.remoteUrl);
    if (!id) {
      return Promise.reject(
        new Error(`"${stripUrlCredentials(spec.remoteUrl)}" is not a git remote URL`),
      );
    }
    const running = this.ensuring.get(id.key);
    if (running) return running;
    const run = this.doEnsure(id.key, id.url, id.owner, id.name).finally(() =>
      this.ensuring.delete(id.key),
    );
    this.ensuring.set(id.key, run);
    return run;
  }

  private async doEnsure(
    key: string,
    url: string,
    owner: string,
    name: string,
  ): Promise<EnsureRepoResult> {
    const mappings = await this.load();
    const mapped = mappings[key];
    if (mapped && existsSync(mapped.path) && (await isDirectory(mapped.path))) {
      return { path: mapped.path, cloned: false };
    }

    const base = join(this.options.reposDir(), owner, name);
    let dest = base;
    if (existsSync(dest)) {
      // A folder that is this repo already (a clone from an earlier run) is reused. Another
      // repo's folder or an unrelated one is left alone, and the clone goes beside it.
      const origin = await git(["remote", "get-url", "origin"], dest);
      const there = origin ? parseRemoteUrl(origin)?.key : undefined;
      if (there === key) {
        await this.map(url, dest);
        return { path: dest, cloned: false };
      }
      const empty = (await readdir(dest).catch(() => ["x"])).length === 0;
      if (!empty) dest = `${base}-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
    }
    await mkdir(dirname(dest), { recursive: true });
    await clone(url, dest);
    const canonical = await realpath(dest);
    await this.map(url, canonical);
    return { path: canonical, cloned: true };
  }
}

/** Lists the directories in a folder for the picker. */
export async function browseFolder(path: string | undefined): Promise<FsBrowseResult> {
  const home = homedir();
  const target = await realpath(path?.trim() ? path : home).catch(() => {
    throw new Error(`${path} does not exist`);
  });
  if (!(await isDirectory(target))) throw new Error(`${target} is not a directory`);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: FsBrowseResult["entries"] = [];
  for (const d of dirents) {
    const full = join(target, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) isDir = await isDirectory(full);
    if (!isDir) continue;
    entries.push({ name: d.name, path: full, isGit: existsSync(join(full, ".git")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    entries,
    insideRoots: true,
  };
}

/** True when `path` is `dir` or below it. */
export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
