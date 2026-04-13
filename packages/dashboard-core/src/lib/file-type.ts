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

const PDF_EXTENSIONS = new Set([".pdf"]);

export type FilePreviewType = "markdown" | "image" | "pdf" | "code";

/**
 * Determines the preview type for a file based on its extension.
 * Returns "markdown", "image", "pdf", or "code" (default for all other files).
 */
export function getFilePreviewType(filePath: string): FilePreviewType {
  const name = filePath.split("/").pop() || filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";

  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  return "code";
}
