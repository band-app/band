/**
 * What serving a file over HTTP needs, shared by the hub's file routes and a
 * worker's direct listener so both answer the same bytes with the same headers.
 */

import { extname } from "node:path";

export type ByteRange = { start: number; end: number };

/**
 * Reads a single-range `Range: bytes=...` header against a file of `size`
 * bytes. Returns null when there is no usable header (serve the whole file),
 * "unsatisfiable" when the range lies outside the file, else inclusive bounds.
 * A multi-range request is served whole, which the spec allows.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  // RFC 9110: a range whose end precedes its start is invalid and ignored.
  if (match[1] !== "" && match[2] !== "" && Number(match[2]) < Number(match[1])) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // A suffix range: the last N bytes.
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * `Content-Disposition: attachment` for a file name, with an ASCII fallback in
 * `filename` and the real name in the RFC 6266 `filename*` (RFC 5987 encoding),
 * so a quote, CR/LF, `;` or non-ASCII character in a name cannot break the header.
 */
export function attachmentDisposition(filename: string): string {
  // A path separator has no place in a saved file name. The ASCII fallback
  // below also replaces control characters, and the encoded form escapes them.
  const clean = filename.replace(/[/\\]/g, "_") || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ts": "application/typescript",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".zip": "application/zip",
};

/**
 * Return the MIME type for a filename based on its extension.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
export function mimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/** Headers that keep a repo's HTML or SVG from running with the serving origin, and stop type sniffing. */
export function hostedFileHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (/^(text\/html|image\/svg\+xml)\b/.test(contentType)) {
    headers["Content-Security-Policy"] = "sandbox allow-scripts";
  }
  return headers;
}

/**
 * Splits the part of a shared-file URL after `/api/shared/` into its decoded
 * segments: `<worktreeId>/<chatId>/<name>`, or the older `<worktreeId>/<name>`.
 * Returns null for anything else, including a segment that is empty, `.`,
 * `..` or holds a path separator after decoding.
 */
export function parseSharedPath(
  rest: string,
): { worktreeId: string; chatId?: string; name: string } | null {
  const raw = rest.split("?")[0].split("/");
  if (raw.length !== 2 && raw.length !== 3) return null;
  const parts: string[] = [];
  for (const segment of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) return null;
    parts.push(decoded);
  }
  return parts.length === 3
    ? { worktreeId: parts[0], chatId: parts[1], name: parts[2] }
    : { worktreeId: parts[0], name: parts[1] };
}
