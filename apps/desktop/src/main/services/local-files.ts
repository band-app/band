/**
 * Read and save one file on this Mac for the renderer: a file opened from
 * Finder (Open With, a drag onto the tab strip) or the Open File picker. The
 * file is on this machine by definition, so the main process reads it and no
 * worker or hub is involved.
 *
 * The renderer names an absolute path, so the limits live here: no symlink on
 * the final component, regular files only, a size cap, binary detection on
 * read, and a save never creates a file. No Electron import, so
 * `node:test` can drive it.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

export const MAX_LOCAL_FILE_SIZE = 1024 * 1024;

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

export type LocalFileResult =
  | { tooLarge: true; size: number }
  | { binary: true; size: number }
  | { content: string; size: number; language: string | undefined };

function mapFsError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new Error("File not found");
  if (code === "ELOOP") return new Error("Symbolic links are not allowed");
  if (code === "EACCES" || code === "EPERM") return new Error("Permission denied");
  if (code === "EISDIR") return new Error("Cannot operate on a directory");
  return err instanceof Error ? err : new Error(String(err));
}

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Absolute path required");
}

export async function readLocalFile(path: unknown): Promise<LocalFileResult> {
  assertPath(path);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW: the kernel refuses a symlink as the final component.
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    throw mapFsError(err);
  }
  try {
    const stats = await fh.stat();
    if (stats.isDirectory()) throw new Error("Cannot operate on a directory");
    if (!stats.isFile()) throw new Error("Not a regular file");
    if (stats.size > MAX_LOCAL_FILE_SIZE) return { tooLarge: true, size: stats.size };
    const sample = Buffer.alloc(Math.min(8192, stats.size));
    if (sample.length > 0) {
      await fh.read(sample, 0, sample.length, 0);
      if (sample.includes(0)) return { binary: true, size: stats.size };
    }
    const buffer = await fh.readFile();
    return {
      content: buffer.toString("utf-8"),
      size: stats.size,
      language: LANG_MAP[extname(path).toLowerCase()],
    };
  } finally {
    await fh.close();
  }
}

/** The largest file a preview reads into memory (PDF, image, video). */
export const MAX_LOCAL_BINARY_SIZE = 100 * 1024 * 1024;

/**
 * The bytes of a file for a preview, with the same limits as `readLocalFile` (no symlink on the
 * final component, regular files only) and a cap of {@link MAX_LOCAL_BINARY_SIZE}.
 */
export async function readLocalBinary(path: unknown): Promise<{ bytes: Uint8Array; size: number }> {
  assertPath(path);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    throw mapFsError(err);
  }
  try {
    const stats = await fh.stat();
    if (stats.isDirectory()) throw new Error("Cannot operate on a directory");
    if (!stats.isFile()) throw new Error("Not a regular file");
    if (stats.size > MAX_LOCAL_BINARY_SIZE) {
      throw new Error(
        `File is too large to preview (${Math.ceil(stats.size / (1024 * 1024))} MB, the limit is ${MAX_LOCAL_BINARY_SIZE / (1024 * 1024)} MB)`,
      );
    }
    const buffer = await fh.readFile();
    return {
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      size: stats.size,
    };
  } finally {
    await fh.close();
  }
}

/** Writes back an existing regular file. Never creates one and never follows a symlink. */
export async function saveLocalFile(path: unknown, content: unknown): Promise<{ ok: true }> {
  assertPath(path);
  if (typeof content !== "string") throw new Error("Content must be a string");
  if (Buffer.byteLength(content, "utf-8") > MAX_LOCAL_FILE_SIZE) throw new Error("File too large");
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // No O_CREAT: a save is a write-back of a file the user opened.
    fh = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    throw mapFsError(err);
  }
  try {
    const stats = await fh.stat();
    if (!stats.isFile()) throw new Error("Not a regular file");
    // Truncate only after the regular-file check, so a refused path keeps its content.
    await fh.truncate(0);
    await fh.writeFile(content, "utf-8");
  } finally {
    await fh.close();
  }
  return { ok: true };
}
