/**
 * The `app://` scheme that serves the bundled UI.
 *
 * The window loads `app://band/` instead of the hub's URL, so the UI works
 * with any hub. Files come from the UI build directory. A path with no file
 * extension that matches no file gets the SPA shell (`_shell.html`), so a
 * reload or a deep link such as `app://band/workspace/<id>` keeps its route,
 * as the hub does for the browser. A missing asset (a path with an extension)
 * is a 404, not the shell, so a stale chunk name fails loudly.
 *
 * This file imports nothing from Electron, so tests drive the handler with a
 * plain `Request`. `index.ts` registers it with `protocol.handle`.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "band";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Privileges for `protocol.registerSchemesAsPrivileged`: only what a standard
 * web page needs (relative URLs, localStorage, `fetch`). No `bypassCSP`, no
 * `corsEnabled`, no service workers.
 */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
} as const;

const SHELL = "_shell.html";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** The file under `root` for a URL path, or null when the path leaves `root`. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = normalize(join(root, decoded));
  const base = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(base) ? target : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function fileResponse(body: Buffer, file: string, immutable: boolean): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      // Hashed assets never change. The shell and the manifest do.
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

/** The `protocol.handle("app", …)` callback for the UI build in `uiDir`. */
export function createAppHandler(uiDir: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    const file = resolveInside(uiDir, url.pathname === "/" ? `/${SHELL}` : url.pathname);
    if (!file) return new Response("Bad request", { status: 400 });

    if (await isFile(file)) {
      const immutable = url.pathname.startsWith("/assets/");
      return fileResponse(await readFile(file), file, immutable);
    }
    if (extname(url.pathname) !== "") return new Response("Not found", { status: 404 });

    const shell = join(uiDir, SHELL);
    try {
      return fileResponse(await readFile(shell), shell, false);
    } catch {
      return new Response("UI build missing", { status: 500 });
    }
  };
}
