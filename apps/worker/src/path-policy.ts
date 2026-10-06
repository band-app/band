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
    if (this.roots.includes(canonical)) throw new PathDeniedError(path, "is a root of the worker");
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
    if (!this.contains(canonical)) throw new PathDeniedError(path, "is outside the worker's roots");
    return canonical;
  }

  private contains(canonical: string): boolean {
    for (const root of [...this.roots, ...this.tempDirs]) {
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
