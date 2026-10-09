import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export class PathDeniedError extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(`path ${JSON.stringify(path)} ${why}`);
    this.name = "PathDeniedError";
    this.path = path;
  }
}

const MAX_SYMLINK_HOPS = 40;
/** How long a repo's worktree list is trusted. Creating or removing a worktree through the worker clears it sooner. */
const WORKTREE_CACHE_TTL_MS = 5000;

/** What the policy asks the host about the repos it serves. */
export interface WorktreeSource {
  /** Folders of the repos registered on this worker. */
  repoPaths(): Promise<string[]>;
  /** Paths of the worktrees git has registered for a repo, the main checkout included. */
  worktreePaths(repoPath: string): Promise<string[]>;
}

/**
 * Keeps every path a hub call names inside the worker's roots. A path is
 * checked in canonical form: `..` is folded away and every symlink on the way
 * is resolved, including the dangling ones a write would create the target of.
 *
 * `follow` says whether the call acts on what the final path component points
 * at. `readFile` and `writeFile` follow it, so the target must be inside a
 * root. `rm` and `rename` act on the link itself, so only the parent must be.
 *
 * The check and the use are two steps, so a process on the worker that swaps
 * a directory for a symlink between them can still escape. The policy guards
 * against wrong paths from the hub, not against a hostile local user. It also
 * does not limit what a shell or agent started on the worker does.
 */
export class PathPolicy {
  private readonly roots: string[];
  /** Private directories the worker made itself. Usable like a root, and removable. */
  private readonly tempDirs = new Set<string>();
  /** Folders the worker creates and manages itself (project folders, its clone directory). Served whatever the roots. */
  private readonly managedDirs = new Set<string>();
  private worktrees: WorktreeSource | null = null;
  private readonly worktreeCache = new Map<string, { at: number; paths: string[] }>();

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  /** Creates each root if it is missing, then keeps its canonical path. */
  static async create(roots: string[]): Promise<PathPolicy> {
    const canonical: string[] = [];
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      canonical.push(await realpath(root));
    }
    return new PathPolicy([...new Set(canonical)]);
  }

  get rootPaths(): string[] {
    return [...this.roots];
  }

  /** Serves one more directory, which must exist. Returns its canonical path. */
  async addRoot(dir: string): Promise<string> {
    const canonical = await realpath(dir);
    if (!this.roots.some((r) => canonical === r || canonical.startsWith(r + sep))) {
      this.roots.push(canonical);
    }
    return canonical;
  }

  /**
   * Serves a directory the worker creates and manages itself, so its contents are
   * usable before the worker has made anything in it. The directory is not created
   * here. Its canonical path is kept with a missing tail as written, so a symlink put
   * there later resolves elsewhere and is refused. The directory itself is not
   * reported as a root.
   */
  async allowManaged(dir: string): Promise<string> {
    const canonical = await this.canonical(resolve(dir), 0);
    this.managedDirs.add(canonical);
    return canonical;
  }

  /**
   * Also allows a path that is, or is inside, a git worktree registered by a repo
   * that sits inside a root. Such a worktree may live anywhere on the disk.
   */
  useWorktrees(source: WorktreeSource): void {
    this.worktrees = source;
  }

  /** Forgets the cached worktree lists, after a worktree was created or removed. */
  invalidateWorktrees(): void {
    this.worktreeCache.clear();
  }

  /** Whether a canonical path is in a root, or in a directory the worker made itself. */
  covers(canonical: string): boolean {
    return this.contains(canonical);
  }

  /** Lets later calls use a directory the worker made itself. It is not reported as a root. */
  allow(canonicalDir: string): void {
    this.tempDirs.add(canonicalDir);
  }

  /**
   * Like `resolve` without following, for calls that remove or move the entry.
   * A root itself is refused, so a call cannot delete or relocate what the
   * worker serves.
   */
  async resolveEntry(path: string): Promise<string> {
    const canonical = await this.resolve(path, false);
    if (this.roots.includes(canonical) || this.managedDirs.has(canonical))
      throw new PathDeniedError(path, "is a root of the worker");
    return canonical;
  }

  /** Returns the canonical path to operate on, or throws {@link PathDeniedError}. */
  async resolve(path: string, follow = true): Promise<string> {
    if (typeof path !== "string" || path === "" || path.includes("\0")) {
      throw new PathDeniedError(String(path), "is not a valid path");
    }
    if (!isAbsolute(path)) throw new PathDeniedError(path, "is not absolute");
    const lexical = resolve(path);
    let canonical: string;
    if (follow) {
      canonical = await this.canonical(lexical, 0);
    } else {
      const parent = await this.canonical(dirname(lexical), 0);
      canonical = lexical === parent ? parent : join(parent, basename(lexical));
    }
    if (!this.contains(canonical) && !(await this.inRegisteredWorktree(canonical))) {
      throw new PathDeniedError(path, `is outside the worker's roots${await this.hint(canonical)}`);
    }
    return canonical;
  }

  private async inRegisteredWorktree(canonical: string): Promise<boolean> {
    const source = this.worktrees;
    if (!source) return false;
    let repos: string[];
    try {
      repos = await source.repoPaths();
    } catch {
      return false;
    }
    for (const repo of repos) {
      let repoCanonical: string;
      try {
        repoCanonical = await realpath(repo);
      } catch {
        continue;
      }
      if (!this.contains(repoCanonical)) continue;
      for (const wt of await this.worktreePathsOf(source, repoCanonical)) {
        if (canonical === wt || canonical.startsWith(wt + sep)) return true;
      }
    }
    return false;
  }

  private async worktreePathsOf(source: WorktreeSource, repo: string): Promise<string[]> {
    const cached = this.worktreeCache.get(repo);
    if (cached && Date.now() - cached.at < WORKTREE_CACHE_TTL_MS) return cached.paths;
    const paths: string[] = [];
    try {
      for (const p of await source.worktreePaths(repo)) {
        try {
          paths.push(await realpath(p));
        } catch {
          // A registered worktree whose folder is gone grants nothing.
        }
      }
    } catch {
      return [];
    }
    this.worktreeCache.set(repo, { at: Date.now(), paths });
    return paths;
  }

  /** Says so when the path is a worktree of a repo that is not under a root, because the fix is to add that repo's folder. */
  private async hint(canonical: string): Promise<string> {
    let dir = canonical;
    for (let i = 0; i < 64; i++) {
      try {
        if ((await lstat(dir)).isDirectory()) break;
      } catch {
        // Keep climbing to an existing directory.
      }
      const up = dirname(dir);
      if (up === dir) return "";
      dir = up;
    }
    const rev = (flag: string) =>
      new Promise<string>((done) => {
        execFile(
          "git",
          ["rev-parse", "--path-format=absolute", flag],
          { cwd: dir, timeout: 3000 },
          (err, stdout) => done(err ? "" : stdout.trim()),
        );
      });
    const [common, own] = await Promise.all([rev("--git-common-dir"), rev("--absolute-git-dir")]);
    if (!common || !own) return "";
    // A plain checkout has its own git dir. Only a linked worktree points at another repo's.
    if ((await realpath(common).catch(() => common)) === (await realpath(own).catch(() => own))) {
      return "";
    }
    const repo = basename(common) === ".git" ? dirname(common) : common;
    if (this.contains(await realpath(repo).catch(() => repo))) return "";
    return `. It is a worktree of ${repo}, which is not inside a root, so add that repo's folder as a root`;
  }

  private contains(canonical: string): boolean {
    for (const root of [...this.roots, ...this.tempDirs, ...this.managedDirs]) {
      if (canonical === root || canonical.startsWith(root + sep)) return true;
    }
    return false;
  }

  /** Like `realpath`, but a missing tail is kept as written, and a dangling symlink is followed. */
  private async canonical(path: string, hops: number): Promise<string> {
    if (hops > MAX_SYMLINK_HOPS) throw new PathDeniedError(path, "has too many symlinks");
    try {
      return await realpath(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    const parent = dirname(path);
    if (parent === path) return path;
    let leafIsLink = false;
    try {
      leafIsLink = (await lstat(path)).isSymbolicLink();
    } catch {
      // The leaf does not exist.
    }
    if (leafIsLink) {
      // realpath failed on a link, so its target is missing: follow it by hand.
      const target = await readlink(path);
      return this.canonical(resolve(dirname(path), target), hops + 1);
    }
    return join(await this.canonical(parent, hops + 1), basename(path));
  }
}
