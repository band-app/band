import { extensionToLanguage, filenameToLanguage } from "@band/dashboard-core";

/**
 * Detect the Shiki language identifier from a filename.
 * Tries filename-based match (e.g. "Dockerfile"), then extension-based.
 */
export function detectLanguageFromFilename(filename: string): string {
  const fromName = filenameToLanguage(filename);
  if (fromName) return fromName;

  const dot = filename.lastIndexOf(".");
  if (dot >= 0) {
    const ext = filename.slice(dot).toLowerCase();
    const fromExt = extensionToLanguage(ext);
    if (fromExt) return fromExt;
  }

  return "plaintext";
}

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
]);

/**
 * Returns true if the MIME type represents a text-based file that can be
 * syntax-highlighted and displayed as code.
 */
export function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  return TEXT_APPLICATION_TYPES.has(mediaType);
}

/**
 * Trigger a browser download for a blob or data URL.
 */
export function downloadFile(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
