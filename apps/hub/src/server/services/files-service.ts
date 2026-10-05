/**
 * Worktree files service — owns file-system CRUD operations rooted at a
 * worktree's worktree path. Lifted out of `api/worktree/router.ts`
 * (issue #535, follow-up 1) so the router contains validation + delegation
 * only, with the actual file calls going through the worktree's host
 * (`host.fs`).
 *
 * Every path argument is worktree-relative; the service resolves it
 * against the worktree root and refuses anything that escapes the root
 * (path-traversal guard) or targets `.git` internals (corruption guard).
 *
 * Methods raise plain `Error`s with user-facing messages — the API tier
 * translates them to `TRPCError`s. The service deliberately does not
 * import from `@trpc/server` so it can be reused from CLI / scripts later
 * without dragging tRPC along.
 */

import { dirname, extname, join, resolve, sep } from "node:path";
import type { FsStat, HostFs } from "@band-app/host-api";
import { WorktreeNotFoundError } from "../errors";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import {
  worktreeService as defaultWorktreeService,
  type WorktreeService,
} from "./worktree-service";

/**
 * 1 MB ceiling on `getFile` reads. Editor surfaces can't usefully render
 * larger files anyway; the caller falls back to a "file too large" panel
 * when we report `tooLarge: true` instead of streaming the bytes.
 */
const MAX_FILE_SIZE = 1024 * 1024;

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".sh": "bash",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".diff": "diff",
};

export type FileEntryKind = "file" | "directory";

export interface FileEntry {
  name: string;
  type: FileEntryKind;
}

export interface ListFilesResult {
  entries: FileEntry[];
  path: string;
}

export type GetFileResult =
  | { tooLarge: true; size: number }
  | { binary: true; size: number }
  | { content: string; size: number; language?: string };

/** Follows symlinks, as the `stat` and `existsSync` calls this replaced did. */
const FOLLOW = { followSymlinks: true } as const;

async function exists(fs: HostFs, path: string): Promise<boolean> {
  return fs.stat(path, FOLLOW).then(
    () => true,
    () => false,
  );
}

/** Throws unless `parent` is an existing directory. `label` names it in the error. */
async function assertParentDirectory(fs: HostFs, parent: string, label: string): Promise<void> {
  if (!(await exists(fs, parent))) {
    throw new Error(`${label} directory does not exist`);
  }
  const parentStat = await fs.stat(parent, FOLLOW);
  if (parentStat.kind !== "directory") {
    throw new Error(`${label} is not a directory`);
  }
}

export class FilesService {
  constructor(private readonly worktrees: WorktreeService = defaultWorktreeService) {}

  /**
   * Resolve a worktree-relative path against a worktree root, refusing
   * anything that escapes the root. Optional `allowRoot` toggles whether
   * the root itself is a valid target (`listFiles` allows it; the mutation
   * methods do not).
   */
  private resolveInside(
    worktreeId: string,
    relative: string,
    opts: { allowRoot: boolean },
  ): { root: string; target: string; fs: HostFs } {
    const worktree = this.worktrees.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    const root = worktree.worktree.path;
    const target = resolve(join(root, relative));
    // Demand a separator after the root prefix so a sibling directory
    // with the same prefix (root=`/tmp/band-ws-abc`, target=`/tmp/band-
    // ws-abc-evil/secret`) can't sneak past the guard. Bare equality
    // covers the worktree root itself, gated on `allowRoot`.
    const insideRoot = target === root || target.startsWith(root + sep);
    if (!insideRoot) {
      throw new Error("Invalid path");
    }
    if (!opts.allowRoot && target === root) {
      throw new Error("Invalid path");
    }
    return { root, target, fs: worktree.host.fs };
  }

  /**
   * Refuse to touch `.git` internals — corrupting them would wedge the
   * worktree. Shared by `deletePath`, `renamePath`, and `copyPath`.
   */
  private assertNotGitInternals(root: string, target: string, label: string): void {
    // Defensive: every current caller passes through `resolveInside`
    // with `allowRoot: false`, which already rejects `target === root`.
    // Guarding here too makes the slice arithmetic obviously safe and
    // stops a future caller from sneaking a worktree-root mutation past.
    if (target === root) {
      throw new Error(`Refusing to ${label} worktree root`);
    }
    const relative = target.slice(root.length + 1);
    if (relative === ".git" || relative.startsWith(`.git${sep}`) || relative.startsWith(".git/")) {
      throw new Error(`Refusing to ${label} .git internals`);
    }
  }

  async listFiles(worktreeId: string, path = ""): Promise<ListFilesResult> {
    await ephemeralLifecycleService.ensureAwake(worktreeId);
    const { target, fs } = this.resolveInside(worktreeId, path, { allowRoot: true });
    const dirents = await fs.list(target);
    const entries: FileEntry[] = dirents
      .map((d) => ({
        name: d.name,
        type: d.kind === "directory" ? ("directory" as const) : ("file" as const),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { entries, path };
  }

  async getFile(worktreeId: string, path: string): Promise<GetFileResult> {
    await ephemeralLifecycleService.ensureAwake(worktreeId);
    if (!path) throw new Error("Path is required");
    const { target, fs } = this.resolveInside(worktreeId, path, { allowRoot: false });

    const fileStat = await fs.stat(target, FOLLOW);
    const size = fileStat.size;

    if (size > MAX_FILE_SIZE) {
      return { tooLarge: true, size };
    }

    const bytes = await fs.readFile(target);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Cheap binary sniff: a NUL byte in the first 8 KB is the same
    // heuristic git uses. Avoids returning random bytes to a JSON
    // response and an unrenderable editor buffer.
    const sample = buffer.subarray(0, 8192);
    if (sample.includes(0)) {
      return { binary: true, size };
    }

    const ext = extname(target).toLowerCase();
    const language = LANG_MAP[ext];

    return {
      content: buffer.toString("utf-8"),
      size,
      language,
    };
  }

  async saveFile(worktreeId: string, path: string, content: string): Promise<{ ok: true }> {
    await ephemeralLifecycleService.ensureAwake(worktreeId);
    const { root, target, fs } = this.resolveInside(worktreeId, path, { allowRoot: false });
    // Refuse to write into `.git/*` — overwriting `config`, `HEAD`, or
    // a hook would corrupt the worktree or run attacker-controlled code
    // on the next git invocation. Matches the guard on delete/rename/
    // copy.
    this.assertNotGitInternals(root, target, "write");
    const fileStat = await fs.stat(target, FOLLOW);
    if (fileStat.kind === "directory") {
      throw new Error("Cannot write to a directory");
    }
    await fs.writeFile(target, content);
    return { ok: true };
  }

  async createFile(worktreeId: string, path: string, content = ""): Promise<{ ok: true }> {
    await ephemeralLifecycleService.ensureAwake(worktreeId);
    const { root, target, fs } = this.resolveInside(worktreeId, path, { allowRoot: false });
    // Same .git guard as saveFile — creating `.git/hooks/pre-commit`
    // would let an attacker run arbitrary code under the user's account
    // the next time git commits inside the worktree.
    this.assertNotGitInternals(root, target, "create");

    if (await exists(fs, target)) {
      throw new Error("A file or directory already exists at this path");
    }

    await assertParentDirectory(fs, dirname(target), "Parent");

    // `exclusive` rejects an existing file at the destination, closing the
    // race between the `exists` check above and the write.
    await fs.writeFile(target, content, { exclusive: true });
    return { ok: true };
  }

  async createDirectory(worktreeId: string, path: string): Promise<{ ok: true }> {
    const { root, target, fs } = this.resolveInside(worktreeId, path, { allowRoot: false });
    // Same .git guard as createFile / saveFile.
    this.assertNotGitInternals(root, target, "create");

    if (await exists(fs, target)) {
      throw new Error("A file or directory already exists at this path");
    }

    await assertParentDirectory(fs, dirname(target), "Parent");

    await fs.mkdir(target);
    return { ok: true };
  }

  async deletePath(worktreeId: string, path: string): Promise<{ ok: true; kind: FileEntryKind }> {
    const { root, target, fs } = this.resolveInside(worktreeId, path, { allowRoot: false });
    this.assertNotGitInternals(root, target, "delete");

    let entryStat: FsStat;
    try {
      entryStat = await fs.stat(target, FOLLOW);
    } catch {
      throw new Error("Path does not exist");
    }

    // `rm` with `recursive` handles both files and directories. We pass
    // it unconditionally so callers don't need to know the entry kind.
    await fs.rm(target, { recursive: true, force: false });

    return {
      ok: true,
      kind: entryStat.kind === "directory" ? "directory" : "file",
    };
  }

  async renamePath(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: true; kind: FileEntryKind }> {
    const {
      root,
      target: fromTarget,
      fs,
    } = this.resolveInside(worktreeId, fromPath, {
      allowRoot: false,
    });
    const { target: toTarget } = this.resolveInside(worktreeId, toPath, { allowRoot: false });

    if (fromTarget === toTarget) {
      throw new Error("Source and destination are the same");
    }

    this.assertNotGitInternals(root, fromTarget, "rename");
    this.assertNotGitInternals(root, toTarget, "rename");

    let entryStat: FsStat;
    try {
      entryStat = await fs.stat(fromTarget, FOLLOW);
    } catch {
      throw new Error("Source path does not exist");
    }

    if (await exists(fs, toTarget)) {
      throw new Error("A file or directory already exists at the destination");
    }

    await assertParentDirectory(fs, dirname(toTarget), "Destination parent");

    await fs.rename(fromTarget, toTarget);

    return {
      ok: true,
      kind: entryStat.kind === "directory" ? "directory" : "file",
    };
  }

  async copyPath(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: true; kind: FileEntryKind }> {
    const {
      root,
      target: fromTarget,
      fs,
    } = this.resolveInside(worktreeId, fromPath, {
      allowRoot: false,
    });
    const { target: toTarget } = this.resolveInside(worktreeId, toPath, { allowRoot: false });

    if (fromTarget === toTarget) {
      throw new Error("Source and destination are the same");
    }

    this.assertNotGitInternals(root, fromTarget, "copy");
    this.assertNotGitInternals(root, toTarget, "copy");

    let entryStat: FsStat;
    try {
      entryStat = await fs.stat(fromTarget, FOLLOW);
    } catch {
      throw new Error("Source path does not exist");
    }

    // Block copying a directory into itself or any descendant — would
    // either fail mid-copy or produce an infinite tree.
    if (entryStat.kind === "directory" && toTarget.startsWith(fromTarget + sep)) {
      throw new Error("Cannot copy a directory into itself");
    }

    if (await exists(fs, toTarget)) {
      throw new Error("A file or directory already exists at the destination");
    }

    await assertParentDirectory(fs, dirname(toTarget), "Destination parent");

    // `recursive` handles both files and directories. `exclusive` guards
    // against the race between our `exists` check above and the write.
    await fs.copy(fromTarget, toTarget, { recursive: true, exclusive: true });

    return {
      ok: true,
      kind: entryStat.kind === "directory" ? "directory" : "file",
    };
  }
}

/**
 * Process-wide singleton. The service holds no in-memory state; the
 * singleton exists for symmetry with the other service modules so router
 * imports look the same.
 */
export const filesService = new FilesService();
