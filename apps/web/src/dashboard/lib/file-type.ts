const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv"]);

const PDF_EXTENSIONS = new Set([".pdf"]);

export type FilePreviewType = "markdown" | "image" | "video" | "pdf" | "code";

/**
 * Determines the preview type for a file based on its extension.
 * Returns "markdown", "image", "video", "pdf", or "code" (default for all other files).
 */
export function getFilePreviewType(filePath: string): FilePreviewType {
  const name = filePath.split("/").pop() || filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";

  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  return "code";
}
