/**
 * Shows a local HTML file with the files beside it. The renderer asks for a grant for one file;
 * the main process remembers the file's real folder under a random token and serves that folder
 * at `app://<host>/__local-preview/<token>/<name>`, so relative CSS, images and scripts load.
 *
 * Only that folder is served. A request must be a plain relative path (no `..`, no empty segment,
 * no separator inside a segment), the file must be a regular file and not a link, and its real
 * path must stay inside the folder, so a link inside the folder cannot lead out. No Electron
 * import, so `node:test` can drive it.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { LOCAL_PREVIEW_PREFIX } from "../app-protocol.js";

const GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_GRANTS = 50;
/** A single served file is read whole, so the cap matches the preview read. */
const MAX_SERVED_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

const HEADERS = {
  // The page runs with an opaque origin: no cookies, storage or access to Band's page.
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function notFound(status = 404): Response {
  return new Response(status === 403 ? "Forbidden" : "Not found", { status });
}

export class LocalPreviewRegistry {
  private readonly grants = new Map<string, { dir: string; expiresAt: number }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Grants the folder of an absolute file path. Returns the URL path to load from `app://<host>`. */
  async grant(path: unknown): Promise<{ path: string }> {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
      throw new Error("Absolute path required");
    }
    const info = await lstat(path).catch(() => null);
    if (!info) throw new Error("File not found");
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
    if (!info.isFile()) throw new Error("Not a regular file");
    const dir = await realpath(dirname(path));
    const now = this.now();
    for (const [token, entry] of this.grants) if (entry.expiresAt < now) this.grants.delete(token);
    while (this.grants.size >= MAX_GRANTS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
    const token = randomBytes(16).toString("hex");
    this.grants.set(token, { dir, expiresAt: now + GRANT_TTL_MS });
    const name = path.slice(path.lastIndexOf(sep) + 1);
    return { path: `${LOCAL_PREVIEW_PREFIX}${token}/${encodeURIComponent(name)}` };
  }

  /** The response for a request path under the preview prefix. */
  async serve(pathname: string): Promise<Response> {
    const [token, ...encoded] = pathname.slice(LOCAL_PREVIEW_PREFIX.length).split("/");
    const grant = token ? this.grants.get(token) : undefined;
    if (!grant || grant.expiresAt < this.now()) return notFound();
    const segments: string[] = [];
    try {
      for (const part of encoded) segments.push(decodeURIComponent(part));
    } catch {
      return notFound(400);
    }
    if (
      segments.length === 0 ||
      segments.some(
        (s) =>
          s === "" ||
          s === "." ||
          s === ".." ||
          s.includes("/") ||
          s.includes("\\") ||
          s.includes("\0"),
      )
    ) {
      return notFound(403);
    }
    const target = join(grant.dir, ...segments);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) return notFound(403);
      const real = await realpath(target);
      if (!real.startsWith(grant.dir.endsWith(sep) ? grant.dir : grant.dir + sep)) {
        return notFound(403);
      }
      if (info.size > MAX_SERVED_BYTES) return new Response("Too large", { status: 413 });
      const fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const body = await fh.readFile();
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: {
            ...HEADERS,
            "Content-Type":
              CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
          },
        });
      } finally {
        await fh.close();
      }
    } catch {
      return notFound();
    }
  }
}
