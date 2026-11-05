import { extname, isAbsolute } from "node:path";
import type { HostFs } from "@band-app/host-api";
import { WorktreeNotFoundError } from "../errors";
import { worktreeService } from "./worktree-service";

/**
 * Read and save one file that lies outside a worktree, on the machine the
 * worktree runs on (`band open /etc/hosts`, Quick Open of an absolute path).
 * The bytes go through `worktree.host.fs`, so a remote worker's own path
 * policy (its home and roots) decides what is reachable and the hub's disk is
 * never read. Only a device token reaches it: the relay lists neither
 * procedure.
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

export type ExternalFileResult =
  | { tooLarge: true; size: number }
  | { binary: true; size: number }
  | { content: string; size: number; language: string | undefined };

function hostFor(worktreeId: string) {
  const resolved = worktreeService.resolve(worktreeId);
  if (!resolved) throw new WorktreeNotFoundError(worktreeId);
  return resolved.host;
}

/** Stat that names a missing file in plain words instead of a raw ENOENT. */
async function statFile(fs: HostFs, path: string) {
  try {
    return await fs.stat(path);
  } catch (err) {
    const text =
      err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}` : "";
    if (/ENOENT|no such file|not found/i.test(text)) throw new Error("File not found");
    throw err;
  }
}

function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new Error("Absolute path required");
}

export class ExternalFileService {
  async read(worktreeId: string, absolutePath: string): Promise<ExternalFileResult> {
    assertAbsolute(absolutePath);
    const { fs } = hostFor(worktreeId);
    // No `followSymlinks`: a symlink reports `kind: "symlink"` and is refused.
    const stat = await statFile(fs, absolutePath);
    if (stat.kind === "symlink") throw new Error("Symbolic links are not allowed");
    if (stat.kind === "directory") throw new Error("Cannot operate on a directory");
    if (stat.kind !== "file") throw new Error("Not a regular file");
    if (stat.size > MAX_FILE_SIZE) return { tooLarge: true, size: stat.size };
    const bytes = await fs.readFile(absolutePath);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buffer.subarray(0, 8192).includes(0)) return { binary: true, size: stat.size };
    return {
      content: buffer.toString("utf-8"),
      size: stat.size,
      language: LANG_MAP[extname(absolutePath).toLowerCase()],
    };
  }

  async save(worktreeId: string, absolutePath: string, content: string): Promise<{ ok: true }> {
    assertAbsolute(absolutePath);
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) throw new Error("File too large");
    const { fs } = hostFor(worktreeId);
    // Write back an existing regular file only: never create, never follow a link.
    const stat = await statFile(fs, absolutePath);
    if (stat.kind === "symlink") throw new Error("Symbolic links are not allowed");
    if (stat.kind !== "file") throw new Error("Not a regular file");
    if (absolutePath.split(/[\\/]/).includes(".git")) {
      throw new Error("Refusing to write inside a .git folder");
    }
    await fs.writeFile(absolutePath, content);
    return { ok: true };
  }
}

export const externalFileService = new ExternalFileService();
