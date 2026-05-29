/**
 * Workspace files service — owns file-system CRUD operations rooted at a
 * workspace's worktree path. Lifted out of `api/workspace/router.ts`
 * (issue #535, follow-up 1) so the router contains validation + delegation
 * only, with the actual `node:fs/promises` calls living behind a single
 * service-tier seam.
 *
 * Every path argument is workspace-relative; the service resolves it
 * against the worktree root and refuses anything that escapes the root
 * (path-traversal guard) or targets `.git` internals (corruption guard).
 *
 * Methods raise plain `Error`s with user-facing messages — the API tier
 * translates them to `TRPCError`s. The service deliberately does not
 * import from `@trpc/server` so it can be reused from CLI / scripts later
 * without dragging tRPC along.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { WorkspaceNotFoundError } from "../errors";
import {
  workspaceService as defaultWorkspaceService,
  type WorkspaceService,
} from "./workspace-service";

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

export class FilesService {
  constructor(private readonly workspaces: WorkspaceService = defaultWorkspaceService) {}

  /**
   * Resolve a workspace-relative path against a worktree root, refusing
   * anything that escapes the root. Optional `allowRoot` toggles whether
   * the root itself is a valid target (`listFiles` allows it; the mutation
   * methods do not).
   */
  private resolveInside(
    workspaceId: string,
    relative: string,
    opts: { allowRoot: boolean },
  ): { root: string; target: string } {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const root = workspace.worktree.path;
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
    return { root, target };
  }

  /**
   * Refuse to touch `.git` internals — corrupting them would wedge the
   * worktree. Shared by `deletePath`, `renamePath`, and `copyPath`.
   */
  private assertNotGitInternals(root: string, target: string, label: string): void {
    const relative = target.slice(root.length + 1);
    if (relative === ".git" || relative.startsWith(`.git${sep}`) || relative.startsWith(".git/")) {
      throw new Error(`Refusing to ${label} .git internals`);
    }
  }

  async listFiles(workspaceId: string, path = ""): Promise<ListFilesResult> {
    const { target } = this.resolveInside(workspaceId, path, { allowRoot: true });
    const dirents = await readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = dirents
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { entries, path };
  }

  async getFile(workspaceId: string, path: string): Promise<GetFileResult> {
    if (!path) throw new Error("Path is required");
    const { target } = this.resolveInside(workspaceId, path, { allowRoot: false });

    const fileStat = await stat(target);
    const size = fileStat.size;

    if (size > MAX_FILE_SIZE) {
      return { tooLarge: true, size };
    }

    const buffer = await readFile(target);

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

  async saveFile(workspaceId: string, path: string, content: string): Promise<{ ok: true }> {
    const { root, target } = this.resolveInside(workspaceId, path, { allowRoot: false });
    // Refuse to write into `.git/*` — overwriting `config`, `HEAD`, or
    // a hook would corrupt the worktree or run attacker-controlled code
    // on the next git invocation. Matches the guard on delete/rename/
    // copy.
    this.assertNotGitInternals(root, target, "write");
    const fileStat = await stat(target);
    if (fileStat.isDirectory()) {
      throw new Error("Cannot write to a directory");
    }
    await writeFile(target, content, "utf-8");
    return { ok: true };
  }

  async createFile(workspaceId: string, path: string, content = ""): Promise<{ ok: true }> {
    const { root, target } = this.resolveInside(workspaceId, path, { allowRoot: false });
    // Same .git guard as saveFile — creating `.git/hooks/pre-commit`
    // would let an attacker run arbitrary code under the user's account
    // the next time git commits inside the worktree.
    this.assertNotGitInternals(root, target, "create");

    if (existsSync(target)) {
      throw new Error("A file or directory already exists at this path");
    }

    const parent = dirname(target);
    if (!existsSync(parent)) {
      throw new Error("Parent directory does not exist");
    }
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error("Parent is not a directory");
    }

    // `wx` flag rejects an existing file at the destination, closing the
    // race between the `existsSync` check above and the write.
    await writeFile(target, content, { encoding: "utf-8", flag: "wx" });
    return { ok: true };
  }

  async createDirectory(workspaceId: string, path: string): Promise<{ ok: true }> {
    const { root, target } = this.resolveInside(workspaceId, path, { allowRoot: false });
    // Same .git guard as createFile / saveFile.
    this.assertNotGitInternals(root, target, "create");

    if (existsSync(target)) {
      throw new Error("A file or directory already exists at this path");
    }

    const parent = dirname(target);
    if (!existsSync(parent)) {
      throw new Error("Parent directory does not exist");
    }
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error("Parent is not a directory");
    }

    await mkdir(target);
    return { ok: true };
  }

  async deletePath(workspaceId: string, path: string): Promise<{ ok: true; kind: FileEntryKind }> {
    const { root, target } = this.resolveInside(workspaceId, path, { allowRoot: false });
    this.assertNotGitInternals(root, target, "delete");

    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(target);
    } catch {
      throw new Error("Path does not exist");
    }

    // `rm` with `recursive` handles both files and directories. We pass
    // it unconditionally so callers don't need to know the entry kind.
    await rm(target, { recursive: true, force: false });

    return {
      ok: true,
      kind: entryStat.isDirectory() ? "directory" : "file",
    };
  }

  async renamePath(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: true; kind: FileEntryKind }> {
    const { root, target: fromTarget } = this.resolveInside(workspaceId, fromPath, {
      allowRoot: false,
    });
    const { target: toTarget } = this.resolveInside(workspaceId, toPath, { allowRoot: false });

    if (fromTarget === toTarget) {
      throw new Error("Source and destination are the same");
    }

    this.assertNotGitInternals(root, fromTarget, "rename");
    this.assertNotGitInternals(root, toTarget, "rename");

    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(fromTarget);
    } catch {
      throw new Error("Source path does not exist");
    }

    if (existsSync(toTarget)) {
      throw new Error("A file or directory already exists at the destination");
    }

    const toParent = dirname(toTarget);
    if (!existsSync(toParent)) {
      throw new Error("Destination parent directory does not exist");
    }
    const toParentStat = await stat(toParent);
    if (!toParentStat.isDirectory()) {
      throw new Error("Destination parent is not a directory");
    }

    await rename(fromTarget, toTarget);

    return {
      ok: true,
      kind: entryStat.isDirectory() ? "directory" : "file",
    };
  }

  async copyPath(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: true; kind: FileEntryKind }> {
    const { root, target: fromTarget } = this.resolveInside(workspaceId, fromPath, {
      allowRoot: false,
    });
    const { target: toTarget } = this.resolveInside(workspaceId, toPath, { allowRoot: false });

    if (fromTarget === toTarget) {
      throw new Error("Source and destination are the same");
    }

    this.assertNotGitInternals(root, fromTarget, "copy");
    this.assertNotGitInternals(root, toTarget, "copy");

    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(fromTarget);
    } catch {
      throw new Error("Source path does not exist");
    }

    // Block copying a directory into itself or any descendant — would
    // either fail mid-copy or produce an infinite tree.
    if (entryStat.isDirectory() && toTarget.startsWith(fromTarget + sep)) {
      throw new Error("Cannot copy a directory into itself");
    }

    if (existsSync(toTarget)) {
      throw new Error("A file or directory already exists at the destination");
    }

    const toParent = dirname(toTarget);
    if (!existsSync(toParent)) {
      throw new Error("Destination parent directory does not exist");
    }
    const toParentStat = await stat(toParent);
    if (!toParentStat.isDirectory()) {
      throw new Error("Destination parent is not a directory");
    }

    // `cp` with `recursive: true` handles both files and directories.
    // `errorOnExist: true` guards against the race between our
    // existsSync check above and the write.
    await cp(fromTarget, toTarget, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    return {
      ok: true,
      kind: entryStat.isDirectory() ? "directory" : "file",
    };
  }
}

/**
 * Process-wide singleton. The service holds no in-memory state; the
 * singleton exists for symmetry with the other service modules so router
 * imports look the same.
 */
export const filesService = new FilesService();
