import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Host } from "@band-app/host-api";
import { hostRegistry } from "../../infra/host/registry";
import { bandHome } from "../state";

export interface FilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface SavedFile {
  /** Absolute path where the file was written, on the machine the worktree lives on. */
  path: string;
  /** The leaf filename used on disk. */
  storedName: string;
  /** What the chat renders the file from: `/api/uploads/<name>`, or `/api/uploads/<worktreeId>/<name>` for a remote worktree. */
  url: string;
  mediaType: string;
  /** Original filename supplied by the client, if any. */
  originalName?: string;
}

interface DecodedPart {
  buffer: Buffer;
  storedName: string;
  mediaType: string;
  originalName?: string;
}

/**
 * Decodes data-URL file parts. Multiple files in the same submission are
 * guaranteed to land on distinct names even when their original filenames
 * collide (e.g. two clipboard pastes both named "image.png"): the name holds
 * the submission timestamp and a per-file index.
 */
function decodeParts(fileParts: FilePart[]): DecodedPart[] {
  // Capture the timestamp once for the whole batch.
  const baseTimestamp = Date.now();
  const decoded: DecodedPart[] = [];
  for (let i = 0; i < fileParts.length; i++) {
    const part = fileParts[i];
    const dataUrlMatch = part.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!dataUrlMatch) continue;
    const filename = part.filename || `file-${baseTimestamp}`;
    const safeOriginal = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    decoded.push({
      buffer: Buffer.from(dataUrlMatch[1], "base64"),
      storedName: `${baseTimestamp}-${i}-${safeOriginal}`,
      mediaType: part.mediaType,
      originalName: part.filename,
    });
  }
  return decoded;
}

/**
 * Persist data-URL-encoded file uploads to ~/.band/uploads/ and return
 * metadata for each one.
 */
export async function saveUploadedFilesDetailed(fileParts: FilePart[]): Promise<SavedFile[]> {
  const uploadDir = join(bandHome(), "uploads");
  await mkdir(uploadDir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const part of decodeParts(fileParts)) {
    const filePath = join(uploadDir, part.storedName);
    await writeFile(filePath, part.buffer);
    saved.push({
      path: filePath,
      storedName: part.storedName,
      url: `/api/uploads/${part.storedName}`,
      mediaType: part.mediaType,
      originalName: part.originalName,
    });
  }
  return saved;
}

/** Where a remote host keeps one worktree's uploads. Rejects when the host declares no directory. */
async function remoteUploadDir(host: Host, worktreeId: string): Promise<string> {
  const dirs = (await host.info()).dirs;
  if (!dirs) throw new Error(`Host ${host.id} has no directory for uploads`);
  return join(dirs.uploads, worktreeId);
}

/**
 * Persist uploads for a worktree on the machine it lives on, so the agent
 * reads them from its own disk. A local worktree uses `~/.band/uploads/`.
 * A remote one gets them written through its host and the hub keeps no copy.
 */
export async function saveWorktreeUploads(
  worktreeId: string,
  fileParts: FilePart[],
): Promise<SavedFile[]> {
  const host = hostRegistry.hostFor(worktreeId);
  if (host.id === hostRegistry.local.id) return saveUploadedFilesDetailed(fileParts);

  const dir = await remoteUploadDir(host, worktreeId);
  await host.fs.mkdir(dir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const part of decodeParts(fileParts)) {
    const filePath = join(dir, part.storedName);
    await host.fs.writeFile(filePath, part.buffer, { exclusive: true, mode: 0o600 });
    saved.push({
      path: filePath,
      storedName: part.storedName,
      url: `/api/uploads/${encodeURIComponent(worktreeId)}/${encodeURIComponent(part.storedName)}`,
      mediaType: part.mediaType,
      originalName: part.originalName,
    });
  }
  return saved;
}

/**
 * The path an upload URL stands for on the worktree's machine, or null when
 * the URL is not an upload URL of this worktree. The result is not checked
 * for containment: pass it to {@link isWithinUploads}.
 */
export async function uploadPathFromUrl(worktreeId: string, url: string): Promise<string | null> {
  const host = hostRegistry.hostFor(worktreeId);
  const match = url.match(/^\/api\/uploads\/(.+)$/);
  if (!match) return null;
  if (host.id === hostRegistry.local.id) return join(bandHome(), "uploads", match[1]);
  const rest = match[1].split("/");
  if (rest.length !== 2) return null;
  try {
    if (decodeURIComponent(rest[0]) !== worktreeId) return null;
    return join(await remoteUploadDir(host, worktreeId), decodeURIComponent(rest[1]));
  } catch {
    return null;
  }
}

/** Whether `path` is inside the directory holding this worktree's uploads. A string check, with no disk access. */
export async function isWithinUploads(worktreeId: string, path: string): Promise<boolean> {
  const host = hostRegistry.hostFor(worktreeId);
  const dir =
    host.id === hostRegistry.local.id
      ? join(bandHome(), "uploads")
      : await remoteUploadDir(host, worktreeId).catch(() => null);
  if (!dir) return false;
  const normalized = resolve(path);
  return normalized === dir || normalized.startsWith(dir + sep);
}

/**
 * Backwards-compatible thin wrapper that returns just the on-disk paths.
 */
export async function saveUploadedFiles(fileParts: FilePart[]): Promise<string[]> {
  const saved = await saveUploadedFilesDetailed(fileParts);
  return saved.map((f) => f.path);
}
