import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bandHome } from "../state";

export interface FilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface SavedFile {
  /** Absolute path on disk where the file was written. */
  path: string;
  /** The leaf filename used on disk (also the URL component under /api/uploads/). */
  storedName: string;
  mediaType: string;
  /** Original filename supplied by the client, if any. */
  originalName?: string;
}

/**
 * Persist data-URL-encoded file uploads to ~/.band/uploads/ and return
 * metadata for each one.
 *
 * Multiple files in the same submission are guaranteed to land on
 * distinct paths even when their original filenames collide (e.g. two
 * clipboard pastes both named "image.png") — we include both the
 * submission timestamp and a per-file index in the on-disk filename.
 */
export async function saveUploadedFilesDetailed(fileParts: FilePart[]): Promise<SavedFile[]> {
  const uploadDir = join(bandHome(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  // Capture the timestamp once for the whole batch — combined with the
  // per-iteration index this gives a unique on-disk name even when
  // two files share the original filename.
  const baseTimestamp = Date.now();
  const saved: SavedFile[] = [];

  for (let i = 0; i < fileParts.length; i++) {
    const part = fileParts[i];
    const dataUrlMatch = part.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!dataUrlMatch) continue;

    const buffer = Buffer.from(dataUrlMatch[1], "base64");
    const filename = part.filename || `file-${baseTimestamp}`;
    const safeOriginal = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storedName = `${baseTimestamp}-${i}-${safeOriginal}`;
    const filePath = join(uploadDir, storedName);

    await writeFile(filePath, buffer);
    saved.push({
      path: filePath,
      storedName,
      mediaType: part.mediaType,
      originalName: part.filename,
    });
  }

  return saved;
}

/**
 * Backwards-compatible thin wrapper that returns just the on-disk paths.
 */
export async function saveUploadedFiles(fileParts: FilePart[]): Promise<string[]> {
  const saved = await saveUploadedFilesDetailed(fileParts);
  return saved.map((f) => f.path);
}
