import { extname, isAbsolute } from "node:path";
import type { ExternalFileStat } from "@band-app/host-api";
import { WorktreeNotFoundError } from "../errors";
import { worktreeService } from "./worktree-service";

/**
 * Read and save one file that lies outside a worktree, on the machine the
 * worktree runs on (`band open /etc/hosts`, Quick Open of an absolute path).
 * The bytes go through `worktree.host.external`, so the worker's user decides
 * what is reachable (any regular file it can read or write, outside its roots
 * too) and the hub's disk is never read. Only a device token reaches it: the
 * relay lists neither procedure.
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

function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new Error("Absolute path required");
}

/** Plain-words reason for a path the worker's user cannot use, or null when it is a usable regular file. */
export function externalFileProblem(
  stat: ExternalFileStat,
  path: string,
  need: "read" | "write",
): string | null {
  if (stat.outcome === "missing") return `File not found: ${path}`;
  if (stat.outcome === "denied") return `Permission denied: ${path}`;
  if (stat.kind === "directory") return `Not a regular file (it is a directory): ${path}`;
  if (stat.kind !== "file") return `Not a regular file: ${path}`;
  if (need === "read" && !stat.readable) return `Permission denied: ${path}`;
  if (need === "write" && !stat.writable) return `Permission denied: ${path}`;
  return null;
}

/** The OS error a read or write rejected with, as words. */
function describeIoError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return new Error(`Permission denied: ${path}`);
  if (code === "ENOENT") return new Error(`File not found: ${path}`);
  return err instanceof Error ? err : new Error(String(err));
}

export class ExternalFileService {
  async read(worktreeId: string, absolutePath: string): Promise<ExternalFileResult> {
    assertAbsolute(absolutePath);
    const { external } = hostFor(worktreeId);
    // A symlink is refused, so a tab names the canonical file.
    const stat = await external.stat(absolutePath);
    const problem = externalFileProblem(stat, absolutePath, "read");
    if (problem) throw new Error(problem);
    if (stat.outcome !== "ok") throw new Error("File not found");
    if (stat.symlink) throw new Error("Symbolic links are not allowed");
    if (stat.size > MAX_FILE_SIZE) return { tooLarge: true, size: stat.size };
    let bytes: Uint8Array;
    try {
      bytes = await external.readFile(absolutePath);
    } catch (err) {
      throw describeIoError(err, absolutePath);
    }
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
    const { external } = hostFor(worktreeId);
    // Write back an existing regular file only: never create, never follow a link.
    const stat = await external.stat(absolutePath);
    const problem = externalFileProblem(stat, absolutePath, "write");
    if (problem) throw new Error(problem);
    if (stat.outcome !== "ok") throw new Error("File not found");
    if (stat.symlink) throw new Error("Symbolic links are not allowed");
    if (absolutePath.split(/[\\/]/).includes(".git")) {
      throw new Error("Refusing to write inside a .git folder");
    }
    try {
      await external.writeFile(absolutePath, content);
    } catch (err) {
      throw describeIoError(err, absolutePath);
    }
    return { ok: true };
  }
}

export const externalFileService = new ExternalFileService();
