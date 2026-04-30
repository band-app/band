import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bandHome } from "./state";

export interface FilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

export async function saveUploadedFiles(fileParts: FilePart[]): Promise<string[]> {
  const uploadDir = join(bandHome(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  const savedPaths: string[] = [];

  for (const part of fileParts) {
    const dataUrlMatch = part.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!dataUrlMatch) continue;

    const buffer = Buffer.from(dataUrlMatch[1], "base64");
    const timestamp = Date.now();
    const filename = part.filename || `file-${timestamp}`;
    const safeName = `${timestamp}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = join(uploadDir, safeName);

    await writeFile(filePath, buffer);
    savedPaths.push(filePath);
  }

  return savedPaths;
}
