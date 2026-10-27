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
