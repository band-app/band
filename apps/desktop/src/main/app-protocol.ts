/**
 * The `app://` scheme that serves the bundled UI.
 *
 * The window loads `app://<host>/` instead of the hub's URL, so the UI works
 * with any hub. Files come from the UI build directory. A path with no file
 * extension that matches no file gets the SPA shell (`_shell.html`), so a
 * reload or a deep link such as `app://band/worktree/<id>` keeps its route,
 * as the hub does for the browser. A missing asset (a path with an extension)
 * is a 404, not the shell, so a stale chunk name fails loudly.
 *
 * This file imports nothing from Electron, so tests drive the handler with a
 * plain `Request`. `index.ts` registers it with `protocol.handle`.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export const APP_SCHEME = "app";

/**
 * Each hub gets its own host, so each has its own origin and its own
 * localStorage, drafts and tabs: `app://local` for the bundled hub and
 * `app://h-<12 hex of sha256(origin)>` for a remote one. State cached for one
 * hub is never uploaded to another after a switch.
 */
export const LOCAL_APP_HOST = "local";
const APP_HOST_PATTERN = /^(local|h-[0-9a-f]{12})$/;

/** The host the UI is served under for a hub (`null`: the bundled one). */
export function appHostForHub(hubOrigin: string | null): string {
  if (hubOrigin === null) return LOCAL_APP_HOST;
  return `h-${createHash("sha256").update(hubOrigin).digest("hex").slice(0, 12)}`;
}

export function isAppHost(host: string): boolean {
  return APP_HOST_PATTERN.test(host);
}

export function appOriginForHost(host: string): string {
  return `${APP_SCHEME}://${host}`;
}

/**
 * Content-Security-Policy for `app://` pages. The page may talk only to
 * itself and to its hub (`connect-src` lists the hub's http and ws origins),
 * and load frames and media from that hub too. Inline scripts are allowed
 * because the SPA shell carries inline bootstrap scripts, and workers and wasm
 * because the editor and syntax highlighter use them. Remote images are
 * allowed for markdown. Plugins, `<base>` and form posts elsewhere are not.
 */
export function buildCsp(hubOrigin: string | null): string {
  const hub = hubOrigin ? [hubOrigin, hubOrigin.replace(/^http/, "ws")] : [];
  const self = (...extra: string[]) => ["'self'", ...extra].join(" ");
  return [
    "default-src 'self'",
    `script-src ${self("'unsafe-inline'", "'wasm-unsafe-eval'")}`,
    `style-src ${self("'unsafe-inline'")}`,
    `img-src ${self("data:", "blob:", "https:", ...(hubOrigin ? [hubOrigin] : []))}`,
    `font-src ${self("data:")}`,
    `connect-src ${self(...hub)}`,
    `worker-src ${self("blob:")}`,
    `media-src ${self("blob:", "data:", ...(hubOrigin ? [hubOrigin] : []))}`,
    `frame-src ${self("blob:", ...(hubOrigin ? [hubOrigin] : []))}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

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

function fileResponse(body: Buffer, file: string, immutable: boolean, csp: string): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      // Hashed assets never change. The shell and the manifest do.
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

const ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".map",
  ".wasm",
  ".json",
  ".webmanifest",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".txt",
]);

export interface AppHandlerOptions {
  /** The host the window is loaded under now. Requests for any other host are refused. */
  host: () => string;
  /** The current hub's origin, for the CSP's `connect-src`. Null before a hub is chosen. */
  hubOrigin: () => string | null;
}

/** The `protocol.handle("app", …)` callback for the UI build in `uiDir`. */
export function createAppHandler(
  uiDir: string,
  opts: AppHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.host !== opts.host()) return new Response("Not found", { status: 404 });
    const csp = buildCsp(opts.hubOrigin());

    const file = resolveInside(uiDir, url.pathname === "/" ? `/${SHELL}` : url.pathname);
    if (!file) return new Response("Bad request", { status: 400 });

    if (await isFile(file)) {
      const immutable = url.pathname.startsWith("/assets/");
      return fileResponse(await readFile(file), file, immutable, csp);
    }
    // A missing asset is a 404. Any other path is a route, including ones whose
    // last segment has a dot (a worktree id like "band-release-1.2").
    if (url.pathname.startsWith("/assets/") || ASSET_EXTENSIONS.has(extname(url.pathname))) {
      return new Response("Not found", { status: 404 });
    }

    const shell = join(uiDir, SHELL);
    try {
      return fileResponse(await readFile(shell), shell, false, csp);
    } catch {
      return new Response("UI build missing", { status: 500 });
    }
  };
}
